import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";
import { protectedProcedure, router } from "../_core/trpc";
import { invokeLLM, TokenTracker } from "../_core/llm";
import { getDb } from "../db";
import { lazyResetQuota, checkQuotaAllowance, incrementDailyKeywordCount } from "../_core/quota";
import { TRPCError } from "@trpc/server";
import { clients, clientKeywordHistory } from "../../drizzle/schema";
import type { SearchTermAnalysis, SearchTermReport, BusinessType } from "../../shared/types";

// ---------------------------------------------------------------------------
// Load prompt template from file (loaded once at module init)
// ---------------------------------------------------------------------------
let PROMPT_TEMPLATE: string;
try {
  PROMPT_TEMPLATE = readFileSync(
    join(__dirname, "../prompts/search-term-analysis.md"),
    "utf-8"
  );
} catch {
  // Fallback inline prompt if file not found
  PROMPT_TEMPLATE = `你是一位资深 SEM 分析师。对传入的搜索字词执行三维漏斗诊断，返回严格的 JSON 数组。
输入上下文：
- 客户业务方向：{businessDirection}
- 业务类型：{businessType}
- 待分析数据：{searchTermsData}
输出要求：只返回合法 JSON 数组，每项包含 term, score, suggestion, excludeReason, extractedNegative。`;
}

// ---------------------------------------------------------------------------
// LLM: analyze a batch of search terms with 3-dimension funnel
// ---------------------------------------------------------------------------
async function analyzeSearchTermsBatch(
  terms: Array<{ term: string; matchedKeyword: string }>,
  businessDirection: string,
  businessType: BusinessType,
  clientBrand: string,
  model?: string
): Promise<SearchTermAnalysis[]> {
  const searchTermsData = JSON.stringify(terms, null, 2);

  let basePrompt = PROMPT_TEMPLATE
    .replace("{businessDirection}", businessDirection)
    .replace("{businessType}", businessType)
    .replace("{clientBrand}", clientBrand)
    .replace("{searchTermsData}", searchTermsData);

  const systemPrompt = `你是 Google Ads SEM 优化师。你必须返回一个 JSON 对象：{"results":[{ "term":"原词","score":0-100,"suggestion":"保留|排除","excludeReason":"","negativeCategory":"竞对公司词|无关业务/产品词|C端个人消费词|纯信息/学术词|触发偏移词|null","dim1":{"status":"pass|fail|na","reason":"中文"},"dim2":{"status":"pass|fail|na","reason":"中文"},"dim3":{"status":"pass|fail|na","reason":"中文"}}]}。dim1/2/3 的 reason 必须各不相同。dim fail 时后续 dim 设为 na、reason 为"已短路跳过"。保留词 excludeReason 为空字符串 ""。排除词以【维度N-标签】开头。score：dim1 fail→0-20，dim2 fail→20-40，dim3 fail→40-60，全pass一般→60-80，全pass优质→80-100。自有品牌词（{clientBrand}）判定 pass。只输出 JSON，无其他文字。`;

  // ---- Quality retry loop (max 2 attempts: initial + 1 retry on duplicate reasons) ----
  const MAX_QUALITY_ATTEMPTS = 2;
  for (let qualityAttempt = 0; qualityAttempt < MAX_QUALITY_ATTEMPTS; qualityAttempt++) {
    const userPrompt = qualityAttempt === 0
      ? basePrompt
      : basePrompt + "\n\n⚠️ 上一轮输出中，多个搜索词的 dim1/dim2/dim3 的 reason 字段完全相同。这是严重错误：每个维度必须从不同角度独立分析，三个 reason 严禁雷同。请重新分析，确保每个 dim 的 reason 各不相同。";

    // Retry up to 2 times on transient 5xx upstream errors
    let response: Awaited<ReturnType<typeof invokeLLM>> | undefined;
    const MAX_NET_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_NET_RETRIES; attempt++) {
      try {
        response = await invokeLLM({
          modelOverride: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        });
        break;
      } catch (err: any) {
        const msg: string = err?.message || "";
        const isTransient = msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("upstream");
        if (isTransient && attempt < MAX_NET_RETRIES) {
          const delay = (attempt + 1) * 2000;
          console.warn(`[SearchTerm] LLM upstream error (attempt ${attempt + 1}/${MAX_NET_RETRIES + 1}), retrying in ${delay}ms...`, msg);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    if (!response) {
      return terms.map((t) => ({
        term: t.term, matchedKeyword: t.matchedKeyword, score: 0,
        suggestion: "排除" as const,
        excludeReason: "【请求失败】LLM 服务暂时不可用，请稍后重试。",
        extractedNegative: null,
      }));
    }

    const respContent = response.choices[0]?.message?.content;
    const raw = typeof respContent === "string" ? respContent : (respContent as any)?.[0]?.text || "[]";
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let parsed: any[];
    try {
      const jsonObj = JSON.parse(cleaned);
      if (Array.isArray(jsonObj)) parsed = jsonObj;
      else if (jsonObj && Array.isArray(jsonObj.results)) parsed = jsonObj.results;
      else throw new Error("Unexpected JSON structure: " + JSON.stringify(jsonObj).slice(0, 200));
    } catch (e) {
      console.error("[SearchTerm] Failed to parse LLM response:", cleaned.slice(0, 500), e);
      return terms.map((t) => ({
        term: t.term, matchedKeyword: t.matchedKeyword, score: 0,
        suggestion: "排除" as const,
        excludeReason: "【解析失败】LLM 返回格式异常，请重试。",
        extractedNegative: null,
      }));
    }

    // Map parsed results and check for duplicate dim reasons
    let hasDuplicateReasons = false;
    const mapped = terms.map((t) => {
      const found = parsed.find((p: any) => p.term?.toLowerCase() === t.term.toLowerCase());
      if (!found) {
        return {
          term: t.term, matchedKeyword: t.matchedKeyword, score: 0,
          suggestion: "排除" as const,
          excludeReason: "【解析失败】未在 LLM 响应中找到对应词条。",
          extractedNegative: null,
        };
      }

      const parseDim = (raw: any): import("../../shared/types").DimensionVerdict | undefined => {
        if (!raw || typeof raw !== "object") return undefined;
        const status = raw.status === "pass" ? "pass" : raw.status === "fail" ? "fail" : "na";
        const dimReason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : "已短路跳过";
        return { status, reason: dimReason };
      };
      let dim1 = parseDim(found.dim1);
      let dim2 = parseDim(found.dim2);
      let dim3 = parseDim(found.dim3);

      const VALID_CATEGORIES = ["竞对公司词", "无关业务/产品词", "C端个人消费词", "纯信息/学术词", "触发偏移词"];
      const rawCat = typeof found.negativeCategory === "string" ? found.negativeCategory.trim() : null;
      const negativeCategory = VALID_CATEGORIES.includes(rawCat as string)
        ? (rawCat as import("../../shared/types").NegativeCategory)
        : null;

      // Enforce short-circuit
      if (dim1?.status === "fail") {
        dim2 = { status: "na", reason: "已短路跳过：客户类型不符，无需继续分析" };
        dim3 = { status: "na", reason: "已短路跳过：客户类型不符，无需继续分析" };
      } else if (dim2?.status === "fail") {
        dim3 = { status: "na", reason: "已短路跳过：业务方向偏移，无需继续分析" };
      }

      // Compute suggestion from dims (P1-3: force correct, don't trust LLM)
      const dim1Pass = dim1?.status === "pass";
      const dim2Pass = dim2?.status === "pass";
      const dim3Pass = dim3?.status === "pass";
      const computedKeep = dim1Pass && dim2Pass && dim3Pass;

      // Detect duplicate reasons: any 2+ active dims with identical reason
      const reasons = [dim1, dim2, dim3].filter(d => d?.status !== "na").map(d => d?.reason);
      if (new Set(reasons).size < reasons.length && reasons.length >= 2) {
        hasDuplicateReasons = true;
        console.warn(`[SearchTerm] Duplicate reasons for "${t.term}" — dims not independently analyzed. Reasons: ${JSON.stringify(reasons)}`);
      }

      // P1-4: keep items MUST have empty excludeReason
      let reason = computedKeep
        ? ""
        : ((typeof found.excludeReason === "string" ? found.excludeReason : "").trim() || "该搜索词不符合客户业务方向或受众类型，建议排除。");

      // Ensure exclude reason starts with 【维度N-...】 for excluded items
      if (!computedKeep && reason && !reason.startsWith("【维度")) {
        // Try to infer which dimension failed
        if (dim1?.status === "fail") reason = "【维度1-受众偏差】" + reason;
        else if (dim2?.status === "fail") reason = "【维度2-业务无关】" + reason;
        else if (dim3?.status === "fail") reason = "【维度3-匹配偏移】" + reason;
      }

      return {
        term: t.term, matchedKeyword: t.matchedKeyword,
        score: Math.min(100, Math.max(0, Number(found.score) || 0)),
        suggestion: (computedKeep ? "保留" : "排除") as "保留" | "排除",
        excludeReason: reason,
        extractedNegative: found.extractedNegative ?? null,
        negativeCategory, dim1, dim2, dim3,
      };
    });

    // If no duplicate reasons detected, return results
    if (!hasDuplicateReasons) {
      return mapped;
    }

    // Duplicate reasons found — retry once with stronger prompt
    if (qualityAttempt < MAX_QUALITY_ATTEMPTS - 1) {
      console.warn(`[SearchTerm] Quality retry ${qualityAttempt + 1}/${MAX_QUALITY_ATTEMPTS - 1}: duplicate dim reasons detected, retrying with warning...`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    // Final attempt, return whatever we have (with duplicates logged)
    console.warn(`[SearchTerm] Quality retry exhausted, returning results with duplicate dim reasons.`);
    return mapped;
  }

  // Unreachable, but satisfy TypeScript
  return terms.map((t) => ({
    term: t.term, matchedKeyword: t.matchedKeyword, score: 0,
    suggestion: "排除" as const,
    excludeReason: "【请求失败】LLM 服务暂时不可用，请稍后重试。",
    extractedNegative: null,
  }));
}

// ---------------------------------------------------------------------------
// High-level negative keyword group extraction (LLM-powered)
// ---------------------------------------------------------------------------
interface NegativeGroup {
  category: string;
  description: string;
  terms: string[];
}

async function extractSearchTermNegatives(
  excluded: SearchTermAnalysis[],
  businessDirection: string,
  businessType: BusinessType,
  clientBrand: string,
  model?: string
): Promise<NegativeGroup[]> {
  if (excluded.length === 0) return [];

  // Group terms by their pre-classified negativeCategory, max 50 total
  const MAX_TERMS = 50;
  const sample = excluded.slice(0, MAX_TERMS);

  // Build category-grouped input for LLM
  const categoryMap = new Map<string, string[]>();
  for (const r of sample) {
    const cat = r.negativeCategory || "无关业务/产品词";
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(r.term);
  }

  const groupedInput = Array.from(categoryMap.entries())
    .map(([cat, terms]) => `【${cat}】
${terms.map((t) => `- ${t}`).join("\n")}`)
    .join("\n\n");

  const systemPrompt = `你是 SEM 否词策略分析师，专精 Google Ads 否定关键词配置。你的任务是基于已分类的排除词，提取可复用的否定关键词词根。

# 输入格式
输入已按分类分组，每个分类下列出原始搜索词。分类标签由上游 3D 漏斗分析完成，你无需重新分类，直接使用这些标签。

# 输出格式
返回 JSON：{"groups":[{"category":"分类名","description":"该类词根的一句话描述","terms":["词根1","词根2"]}]}

# 词根提取规则（必须严格遵守）

1. 词根是可用于否定关键词匹配的**核心词或短语**，长度通常 2-8 个中文字或 1-3 个英文词。
2. 词根不能包含客户业务核心词（客户业务方向：${businessDirection}），例如客户做锂电池，词根不能包含"锂电池"、"电池"——否则会误杀正常流量。
3. 词根不能包含客户品牌名（${clientBrand}）。
4. 词根提取目标：用一个词根覆盖尽可能多的同类排除词。例如排除词包含"tesla battery""byd energy""catl supplier"，应提取"tesla""byd""catl"而非"battery""energy""supplier"。
5. 词根要具体、可操作，不是泛化描述。好词根："diy""home use""recycling"；坏词根："不相关""其他"。
6. 每类最多 15 个词根，去重，不翻译英文。
7. 只输出 JSON，无任何其他文字。

# Few-Shot 示例

输入：
【竞对公司词】
- tesla powerwall battery
- byd energy storage
- catl lithium battery supplier
【C端个人消费词】
- diy battery pack for home
- cheap 12v battery for car

输出：
{"groups":[{"category":"竞对公司词","description":"排除竞品品牌名，防止竞品截流","terms":["tesla","byd","catl","powerwall"]},{"category":"C端个人消费词","description":"排除C端个人消费场景的通用词根","terms":["diy","for home","cheap","for car"]}]}

# 关键约束
- 不要重复分类，直接使用输入中的分类标签。
- 词根不可包含客户业务关键词（${businessDirection}）和客户品牌名（${clientBrand}）。
- 每类词根数 ≤15，超过则保留最高频/最通用的。
- 分类标签必须使用以下 5 种之一：竞对公司词、无关业务/产品词、C端个人消费词、纯信息/学术词、触发偏移词。`;

  try {
    const response = await invokeLLM({
      modelOverride: model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `客户业务：${businessDirection}（${businessType}）
客户品牌：${clientBrand}
排除词共 ${excluded.length} 条，分析前 ${sample.length} 条（已按分类分组）：

${groupedInput}

请根据上述词根提取规则，为每个分类提取否定关键词词根。`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const respContent = response.choices[0]?.message?.content;
    const raw = typeof respContent === "string" ? respContent : (respContent as any)?.[0]?.text || '{"groups":[]}';
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("[SearchTermNegatives] Failed to parse LLM response:", cleaned.slice(0, 300), e);
      return [];
    }
    return (parsed.groups || [])
      .filter((g: any) => Array.isArray(g.terms) && g.terms.length > 0)
      .map((g: any) => ({
        category: g.category || "无关业务/产品词",
        description: g.description || "",
        terms: (g.terms as string[]).filter((t: any) => typeof t === "string" && t.trim().length > 0).slice(0, 15),
      }));
  } catch (error) {
    console.error("[SearchTermNegatives] LLM extraction failed:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// L2 history helpers (term + matchedKeyword composite key)
// ---------------------------------------------------------------------------

type HistoryKey = string; // `${term.toLowerCase()}|||${matchedKeyword.toLowerCase()}`

function makeHistoryKey(term: string, matchedKeyword: string): HistoryKey {
  return `${term.toLowerCase()}|||${matchedKeyword.toLowerCase()}`;
}

async function getSearchTermHistory(
  clientId: number,
  keywords?: string[]
): Promise<Map<HistoryKey, SearchTermAnalysis>> {
  const map = new Map<HistoryKey, SearchTermAnalysis>();
  try {
    const db = await getDb();
    if (!db) return map;
    // Only fetch rows that have a matchedKeyword (search term history)
    const conditions = [eq(clientKeywordHistory.clientId, clientId)];
    // If keywords provided, filter to only those — avoids full-table scan on large histories
    if (keywords && keywords.length > 0) {
      const lowerKeywords = Array.from(new Set(keywords.map(k => k.toLowerCase())));
      conditions.push(inArray(clientKeywordHistory.keyword, lowerKeywords));
    }
    const rows = await db
      .select()
      .from(clientKeywordHistory)
      .where(and(...conditions));
    for (const row of rows) {
      if (row.matchedKeyword === null || row.matchedKeyword === undefined) continue;
      try {
        const analysis = JSON.parse(row.analysisResultJson) as SearchTermAnalysis;
        if (analysis.suggestion !== undefined) {
          const key = makeHistoryKey(row.keyword, row.matchedKeyword);
          map.set(key, analysis);
        }
      } catch {
        // skip malformed rows
      }
    }
  } catch (err) {
    console.error("[SearchTermHistory] Failed to fetch:", err);
  }
  return map;
}

async function saveSearchTermHistory(
  clientId: number,
  results: SearchTermAnalysis[]
): Promise<void> {
  if (results.length === 0) return;
  try {
    const db = await getDb();
    if (!db) return;
    const now = Date.now();
    // Batch insert — much faster than N individual INSERTs
    await db
      .insert(clientKeywordHistory)
      .values(
        results.map((result) => ({
          clientId,
          keyword: result.term.toLowerCase(),
          matchedKeyword: result.matchedKeyword.toLowerCase(),
          analysisResultJson: JSON.stringify(result),
          analyzedAt: now,
        }))
      )
      .onDuplicateKeyUpdate({
        set: {
          analysisResultJson: sql`VALUES(analysisResultJson)`,
          analyzedAt: now,
        },
      })
      .catch(() => {
        // best-effort: ignore insert failures
      });
  } catch (err) {
    console.error("[SearchTermHistory] Failed to save:", err);
  }
}


// ---------------------------------------------------------------------------
// Progress tracker for real-time frontend polling
// ---------------------------------------------------------------------------
interface AnalysisProgress {
  requestId: string;
  phase: "analyzing" | "extracting" | "done";
  totalTerms: number;
  analyzedTerms: number;
  totalLLMBatches: number;
  completedLLMBatches: number;
  /** Per-batch detail: [batchIndex, status] */
  batchStatus: Array<{ index: number; status: "pending" | "running" | "done" }>;
  startedAt: number;
}

const progressMap = new Map<string, AnalysisProgress>();

function setProgress(requestId: string, update: Partial<AnalysisProgress>) {
  const existing = progressMap.get(requestId);
  if (existing) {
    progressMap.set(requestId, { ...existing, ...update });
  } else {
    progressMap.set(requestId, {
      requestId,
      phase: "analyzing",
      totalTerms: 0,
      analyzedTerms: 0,
      totalLLMBatches: 0,
      completedLLMBatches: 0,
      batchStatus: [],
      startedAt: Date.now(),
      ...update,
    });
  }
}

// Cleanup stale progress entries after 10 minutes
setInterval(() => {
  const now = Date.now();
  progressMap.forEach((val, key) => {
    if (now - val.startedAt > 600_000) progressMap.delete(key);
  });
}, 60_000).unref();

// ---------------------------------------------------------------------------
// tRPC router
// ---------------------------------------------------------------------------
export const searchTermRouter = router({
  analyzeSearchTerms: protectedProcedure
    .input(
      z.object({
        businessDirection: z.string().min(1, "请输入客户业务方向").max(500),
        businessType: z.enum(["B2B", "B2C"]),
        /** Must be bound to a client profile for L2 dedup */
        clientId: z.number().int().positive(),
        /** Batch of search terms with their matched keywords */
        searchTerms: z
          .array(
            z.object({
              term: z.string().min(1).max(500),
              matchedKeyword: z.string().min(1).max(500),
            })
          )
          .min(1, "请至少提供一个搜索字词")
          .max(100, "单次最多分析 100 个搜索字词"),
        /** Per-request model override */
        model: z.string().optional(),
        /** Skip history cache, force fresh LLM analysis */
        forceRefresh: z.boolean().optional().default(false),
        /** Request ID for progress tracking (auto-generated if not provided) */
        requestId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { businessDirection, businessType, clientId, searchTerms } = input;
      const { model, forceRefresh, requestId: inputRequestId } = input;
      const requestId = inputRequestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Fetch client name for brand-aware analysis
      let clientBrand = businessDirection; // fallback
      try {
        const db = await getDb();
        if (db) {
          const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1);
          if (client?.name) clientBrand = client.name;
        }
      } catch { /* best-effort: fallback to businessDirection */ }

      // Reset token tracker for this request
      TokenTracker.reset();

      // Deduplicate input by composite key
      const seen = new Set<string>();
      const cleanTerms = searchTerms.filter((t) => {
        const key = makeHistoryKey(t.term, t.matchedKeyword);
        if (seen.has(key)) return false;
        seen.add(key);
        return t.term.trim().length > 0;
      });

      // -----------------------------------------------------------------------
      // Quota Management
      // -----------------------------------------------------------------------
      let currentUser = ctx.user;
      currentUser = await lazyResetQuota(currentUser);
      const quotaCheck = checkQuotaAllowance(currentUser, cleanTerms.length);
      if (!quotaCheck.allowed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: quotaCheck.message || "已达单日否词分析上限",
        });
      }

      // -----------------------------------------------------------------------
      // L2 Dedup: load history (skip if forceRefresh)
      // -----------------------------------------------------------------------
      const historyMap = forceRefresh ? new Map() : await getSearchTermHistory(clientId, cleanTerms.map(t => t.term));
      const termsToAnalyze = forceRefresh
        ? cleanTerms
        : cleanTerms.filter((t) => !historyMap.has(makeHistoryKey(t.term, t.matchedKeyword)));
      const skippedCount = forceRefresh ? 0 : cleanTerms.length - termsToAnalyze.length;

      console.log(
        `[SearchTermDedup] Client ${clientId}: ${cleanTerms.length} total, ${skippedCount} cached, ${termsToAnalyze.length} new`
      );

      // LLM batch config
      const LLM_BATCH = 10;
      const CONCURRENCY = 3;

      // Initialize progress tracking
      const totalLLMBatches = Math.ceil(termsToAnalyze.length / LLM_BATCH);
      setProgress(requestId, {
        phase: "analyzing",
        totalTerms: termsToAnalyze.length,
        analyzedTerms: 0,
        totalLLMBatches,
        completedLLMBatches: 0,
        batchStatus: Array.from({ length: totalLLMBatches }, (_, i) => ({ index: i, status: "pending" as const })),
      });

      // -----------------------------------------------------------------------
      // LLM analysis: batches of 10, 2 concurrent for speed
      // -----------------------------------------------------------------------
      const freshResults: SearchTermAnalysis[] = [];

      let llmBatchIndex = 0;
      for (let i = 0; i < termsToAnalyze.length; i += LLM_BATCH * CONCURRENCY) {
        const concurrentBatches: Array<typeof termsToAnalyze> = [];
        const batchIndices: number[] = [];
        for (let j = 0; j < CONCURRENCY && i + j * LLM_BATCH < termsToAnalyze.length; j++) {
          concurrentBatches.push(termsToAnalyze.slice(i + j * LLM_BATCH, i + (j + 1) * LLM_BATCH));
          batchIndices.push(llmBatchIndex + j);
        }

        // Mark concurrent batches as running
        for (const idx of batchIndices) {
          const status = progressMap.get(requestId)?.batchStatus;
          if (status && status[idx]) status[idx] = { index: idx, status: "running" };
        }
        setProgress(requestId, {
          analyzedTerms: i,
          completedLLMBatches: llmBatchIndex,
        });

        const batchResults = await Promise.all(
          concurrentBatches.map(batch =>
            analyzeSearchTermsBatch(batch, businessDirection, businessType, clientBrand, model)
          )
        );
        freshResults.push(...batchResults.flat());

        // Mark concurrent batches as done
        for (const idx of batchIndices) {
          const status = progressMap.get(requestId)?.batchStatus;
          if (status && status[idx]) status[idx] = { index: idx, status: "done" };
        }
        llmBatchIndex += concurrentBatches.length;
        setProgress(requestId, {
          analyzedTerms: Math.min(i + LLM_BATCH * CONCURRENCY, termsToAnalyze.length),
          completedLLMBatches: llmBatchIndex,
        });
      }

      // -----------------------------------------------------------------------
      // Post-analysis: extract high-level negative keyword groups via LLM
      // -----------------------------------------------------------------------
      setProgress(requestId, { phase: "extracting" });
      const negativeGroups = await extractSearchTermNegatives(
        freshResults.filter(r => r.suggestion === "排除"),
        businessDirection,
        businessType,
        clientBrand,
        model
      );

      // -----------------------------------------------------------------------
      // Merge: historical + fresh, preserving input order
      // -----------------------------------------------------------------------

      /** Ensure excludeReason is always a non-empty Chinese string and dim fields are populated */
      function sanitizeReason(result: SearchTermAnalysis): SearchTermAnalysis {
        const isKeep = result.suggestion === "保留";
        let reason = (typeof result.excludeReason === "string" ? result.excludeReason : "").trim();
        if (!reason || reason === "未提供理由") {
          reason = isKeep
            ? "三维均匹配：业务方向相符，受众类型匹配，与触发关键字语义一致。"
            : "该搜索词不符合客户业务方向或受众类型，建议排除。";
        }

        // If dim fields are missing (legacy cache), generate fallback from excludeReason label
        if (!result.dim1 && !result.dim2 && !result.dim3) {
          // Detect which dimension failed from the 【维度N-...】 label pattern
          const failedDim = reason.match(/【维度([123])/)?.[1];
          const buildDim = (dimNum: string): import("../../shared/types").DimensionVerdict => {
            if (!failedDim) {
              // No label — all pass (keep) or generic fail
              return isKeep
                ? { status: "pass", reason: reason }
                : { status: "fail", reason: reason };
            }
            if (dimNum === failedDim) return { status: "fail", reason: reason };
            return { status: "pass", reason: "该维度符合要求。" };
          };
          return { ...result, excludeReason: reason, dim1: buildDim("1"), dim2: buildDim("2"), dim3: buildDim("3") };
        }

        // Enforce short-circuit on legacy cache results too
        let { dim1, dim2, dim3 } = result;
        if (dim1?.status === "fail") {
          dim2 = { status: "na", reason: "已短路跳过：客户类型不符，无需继续分析" };
          dim3 = { status: "na", reason: "已短路跳过：客户类型不符，无需继续分析" };
        } else if (dim2?.status === "fail") {
          dim3 = { status: "na", reason: "已短路跳过：业务方向偏移，无需继续分析" };
        }

        // Infer negativeCategory for legacy cache if missing
        let negativeCategory = result.negativeCategory;
        if (!negativeCategory && result.suggestion === "排除") {
          const r = reason.toLowerCase();
          if (r.includes("竞对") || r.includes("品牌") || r.includes("公司名")) negativeCategory = "竞对公司词";
          else if (r.includes("c端") || r.includes("个人") || r.includes("零售") || r.includes("家用")) negativeCategory = "C端个人消费词";
          else if (r.includes("学术") || r.includes("百科") || r.includes("资讯") || r.includes("信息")) negativeCategory = "纯信息/学术词";
          else if (r.includes("偏移") || r.includes("越级") || r.includes("语义偏")) negativeCategory = "触发偏移词";
          else negativeCategory = "无关业务/产品词";
        }

        return { ...result, excludeReason: reason, dim1, dim2, dim3, negativeCategory };
      }

      const allResults: SearchTermAnalysis[] = cleanTerms.map((t) => {
        const histKey = makeHistoryKey(t.term, t.matchedKeyword);
        const fromHistory = historyMap.get(histKey);
        if (fromHistory) return sanitizeReason(fromHistory);
        const fresh = freshResults.find(
          (r) => r.term.toLowerCase() === t.term.toLowerCase() &&
                 r.matchedKeyword.toLowerCase() === t.matchedKeyword.toLowerCase()
        );
        return fresh ? sanitizeReason(fresh) : null;
      }).filter(Boolean) as SearchTermAnalysis[];

      // -----------------------------------------------------------------------
      // Persist fresh results to history (async, non-blocking)
      // -----------------------------------------------------------------------
      void saveSearchTermHistory(clientId, freshResults);

      // -----------------------------------------------------------------------
      // Quota: increment by actual new terms analyzed
      // -----------------------------------------------------------------------
      const newCount = await incrementDailyKeywordCount(ctx.user.id, termsToAnalyze.length);
      console.log(
        `[Quota] User ${ctx.user.id}: incremented by ${termsToAnalyze.length}, new count: ${newCount}`
      );

      const report: SearchTermReport = {
        businessDirection,
        businessType,
        results: allResults,
        totalCount: cleanTerms.length,
        skippedCount,
        analyzedAt: Date.now(),
      };

      const tokenUsage = TokenTracker.getTotal();
      TokenTracker.log(`searchTerm.analyze | ${cleanTerms.length} terms`);

      setProgress(requestId, { phase: "done" });
      return {
        ...report,
        negativeGroups,
        dailyKeywordCount: newCount >= 0 ? newCount : currentUser.daily_keyword_count,
        dailyKeywordLimit: currentUser.daily_keyword_limit,
        tokenUsage,
      };
    }),

  /** Poll current analysis progress by requestId */
  getAnalysisProgress: protectedProcedure
    .input(z.object({ requestId: z.string() }))
    .query(({ input }) => {
      const progress = progressMap.get(input.requestId);
      if (!progress) return { phase: "done" as const, totalTerms: 0, analyzedTerms: 0, totalLLMBatches: 0, completedLLMBatches: 0, batchStatus: [] };
      return progress;
    }),
});
