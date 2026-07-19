import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";
import { protectedProcedure, router } from "../_core/trpc";
import { invokeLLM, TokenTracker } from "../_core/llm";
import { getDb } from "../db";
import { lazyResetQuota, checkQuotaAllowance, incrementDailyKeywordCount } from "../_core/quota";
import { TRPCError } from "@trpc/server";
import { clientKeywordHistory } from "../../drizzle/schema";
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
  businessType: BusinessType
): Promise<SearchTermAnalysis[]> {
  const searchTermsData = JSON.stringify(terms, null, 2);

  const prompt = PROMPT_TEMPLATE
    .replace("{businessDirection}", businessDirection)
    .replace("{businessType}", businessType)
    .replace("{searchTermsData}", searchTermsData);

  // Retry up to 2 times on transient 5xx upstream errors
  let response: Awaited<ReturnType<typeof invokeLLM>> | undefined;
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const dimSchema = {
        type: "object" as const,
        properties: {
          status: { type: "string" as const, enum: ["pass", "fail", "na"] },
          reason: { type: "string" as const },
        },
        required: ["status", "reason"],
        additionalProperties: false,
      };
      response = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "你是一位专业的 SEM 搜索字词诊断分析师。请严格按照 JSON Schema 返回分析结果，每条记录必须包含 dim1/dim2/dim3 三个独立维度对象字段，每个维度有 status（pass/fail/na）和 reason（中文说明）两个子字段。",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "search_term_analysis",
            strict: true,
            schema: {
              type: "object",
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      term: { type: "string" },
                      score: { type: "integer" },
                      suggestion: { type: "string", enum: ["保留", "排除"] },
                      excludeReason: { type: "string" },
                      extractedNegative: { type: ["string", "null"] },
                      negativeCategory: {
                        type: ["string", "null"],
                        enum: ["竞对公司词", "无关业务/产品词", "C端个人消费词", "纯信息/学术词", "触发偏移词", null],
                      },
                      dim1: dimSchema,
                      dim2: dimSchema,
                      dim3: dimSchema,
                    },
                    required: ["term", "score", "suggestion", "excludeReason", "extractedNegative", "negativeCategory", "dim1", "dim2", "dim3"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["results"],
              additionalProperties: false,
            },
          },
        },
      });
      break; // success
    } catch (err: any) {
      const msg: string = err?.message || "";
      const isTransient = msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("upstream");
      if (isTransient && attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 2000; // 2s, 4s
        console.warn(`[SearchTerm] LLM upstream error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`, msg);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err; // rethrow on final attempt or non-transient error
    }
  }

  if (!response) {
    return terms.map((t) => ({
      term: t.term,
      matchedKeyword: t.matchedKeyword,
      score: 0,
      suggestion: "排除" as const,
      excludeReason: "【请求失败】LLM 服务暂时不可用，请稍后重试。",
      extractedNegative: null,
    }));
  }
  const content = response.choices[0]?.message?.content;
  const raw = typeof content === "string" ? content : (content as any)?.[0]?.text || "[]";

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let parsed: any[];
  try {
    const jsonObj = JSON.parse(cleaned);
    // JSON Schema wraps results in { results: [...] }; also handle bare array fallback
    if (Array.isArray(jsonObj)) {
      parsed = jsonObj;
    } else if (jsonObj && Array.isArray(jsonObj.results)) {
      parsed = jsonObj.results;
    } else {
      throw new Error("Unexpected JSON structure: " + JSON.stringify(jsonObj).slice(0, 200));
    }
  } catch (e) {
    console.error("[SearchTerm] Failed to parse LLM response:", cleaned.slice(0, 500), e);
    // Return fallback results marking all as excluded
    return terms.map((t) => ({
      term: t.term,
      matchedKeyword: t.matchedKeyword,
      score: 0,
      suggestion: "排除" as const,
      excludeReason: "【解析失败】LLM 返回格式异常，请重试。",
      extractedNegative: null,
    }));
  }

  // Map parsed results back, ensuring all required fields exist
  return terms.map((t) => {
    const found = parsed.find(
      (p: any) => p.term?.toLowerCase() === t.term.toLowerCase()
    );
    if (!found) {
      return {
        term: t.term,
        matchedKeyword: t.matchedKeyword,
        score: 0,
        suggestion: "排除" as const,
        excludeReason: "【解析失败】未在 LLM 响应中找到对应词条。",
        extractedNegative: null,
      };
    }
    const isKeep = found.suggestion === "保留";
    // Ensure excludeReason is always a non-empty Chinese string
    let reason = (typeof found.excludeReason === "string" ? found.excludeReason : "").trim();
    if (!reason) {
      reason = isKeep
        ? "三维均匹配：业务方向相符，受众类型匹配，与触发关键字语义一致。"
        : "该搜索词不符合客户业务方向或受众类型，建议排除。";
    }
    // Parse optional per-dimension verdicts (supports pass/fail/na)
    const parseDim = (raw: any): import("../../shared/types").DimensionVerdict | undefined => {
      if (!raw || typeof raw !== "object") return undefined;
      const status = raw.status === "pass" ? "pass" : raw.status === "fail" ? "fail" : "na";
      const dimReason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : "已短路跳过";
      return { status, reason: dimReason };
    };
    // Parse negativeCategory (must be one of 5 fixed labels)
    const VALID_CATEGORIES = ["竞对公司词", "无关业务/产品词", "C端个人消费词", "纯信息/学术词", "触发偏移词"];
    const rawCat = typeof found.negativeCategory === "string" ? found.negativeCategory.trim() : null;
    const negativeCategory = VALID_CATEGORIES.includes(rawCat as string)
      ? (rawCat as import("../../shared/types").NegativeCategory)
      : null;
    let dim1 = parseDim(found.dim1);
    let dim2 = parseDim(found.dim2);
    let dim3 = parseDim(found.dim3);

    // Enforce short-circuit logic: if dim1 fails, dim2/dim3 must be na
    if (dim1?.status === "fail") {
      dim2 = { status: "na", reason: "已短路跳过：客户类型不符，无需继续分析" };
      dim3 = { status: "na", reason: "已短路跳过：客户类型不符，无需继续分析" };
    } else if (dim2?.status === "fail") {
      // dim1 passed but dim2 fails — skip dim3
      dim3 = { status: "na", reason: "已短路跳过：业务方向偏移，无需继续分析" };
    }

    return {
      term: t.term,
      matchedKeyword: t.matchedKeyword,
      score: Math.min(100, Math.max(0, Number(found.score) || 0)),
      suggestion: isKeep ? "保留" : ("排除" as const),
      excludeReason: reason,
      extractedNegative: found.extractedNegative ?? null,
      negativeCategory,
      dim1,
      dim2,
      dim3,
    };
  });
}

// ---------------------------------------------------------------------------
// L2 history helpers (term + matchedKeyword composite key)
// ---------------------------------------------------------------------------

type HistoryKey = string; // `${term.toLowerCase()}|||${matchedKeyword.toLowerCase()}`

function makeHistoryKey(term: string, matchedKeyword: string): HistoryKey {
  return `${term.toLowerCase()}|||${matchedKeyword.toLowerCase()}`;
}

async function getSearchTermHistory(
  clientId: number
): Promise<Map<HistoryKey, SearchTermAnalysis>> {
  const map = new Map<HistoryKey, SearchTermAnalysis>();
  try {
    const db = await getDb();
    if (!db) return map;
    // Only fetch rows that have a matchedKeyword (search term history)
    const rows = await db
      .select()
      .from(clientKeywordHistory)
      .where(
        and(
          eq(clientKeywordHistory.clientId, clientId),
          // matchedKeyword IS NOT NULL means it's a search term record
        )
      );
    for (const row of rows) {
      if (row.matchedKeyword === null || row.matchedKeyword === undefined) continue;
      try {
        const analysis = JSON.parse(row.analysisResultJson) as SearchTermAnalysis;
        // Only include records that have the SearchTermAnalysis shape
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
    for (const result of results) {
      await db
        .insert(clientKeywordHistory)
        .values({
          clientId,
          keyword: result.term.toLowerCase(),
          matchedKeyword: result.matchedKeyword.toLowerCase(),
          analysisResultJson: JSON.stringify(result),
          analyzedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            analysisResultJson: JSON.stringify(result),
            analyzedAt: now,
          },
        })
        .catch(() => {
          // best-effort: ignore individual insert failures
        });
    }
  } catch (err) {
    console.error("[SearchTermHistory] Failed to save:", err);
  }
}

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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { businessDirection, businessType, clientId, searchTerms } = input;

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
      // L2 Dedup: load history keyed by (term, matchedKeyword)
      // -----------------------------------------------------------------------
      const historyMap = await getSearchTermHistory(clientId);
      const termsToAnalyze = cleanTerms.filter(
        (t) => !historyMap.has(makeHistoryKey(t.term, t.matchedKeyword))
      );
      const skippedCount = cleanTerms.length - termsToAnalyze.length;

      console.log(
        `[SearchTermDedup] Client ${clientId}: ${cleanTerms.length} total, ${skippedCount} cached, ${termsToAnalyze.length} new`
      );

      // -----------------------------------------------------------------------
      // LLM analysis in batches of 10
      // -----------------------------------------------------------------------
      const LLM_BATCH = 10;
      const freshResults: SearchTermAnalysis[] = [];

      for (let i = 0; i < termsToAnalyze.length; i += LLM_BATCH) {
        const batch = termsToAnalyze.slice(i, i + LLM_BATCH);
        const batchResults = await analyzeSearchTermsBatch(
          batch,
          businessDirection,
          businessType
        );
        freshResults.push(...batchResults);
      }

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

      return {
        ...report,
        dailyKeywordCount: newCount >= 0 ? newCount : currentUser.daily_keyword_count,
        dailyKeywordLimit: currentUser.daily_keyword_limit,
        tokenUsage,
      };
    }),
});
