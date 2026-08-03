import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { invokeLLM, TokenTracker } from "../_core/llm";
import { getDb } from "../db";
import { lazyResetQuota, checkQuotaAllowance, incrementDailyKeywordCount } from "../_core/quota";
import { TRPCError } from "@trpc/server";
import { analysisCache, appSettings, clients, clientKeywordHistory } from "../../drizzle/schema";
import type {
  AnalysisReport,
  KeywordAnalysis,
  NegativeInsights,
  NegativeInsightGroup,
  BusinessType,
  Recommendation,
} from "../../shared/types";

// ---------------------------------------------------------------------------
// Pure LLM semantic analysis (no external search)
// ---------------------------------------------------------------------------
async function analyzeKeywordSemantics(
  keyword: string,
  businessDirection: string,
  businessType: BusinessType,
  model?: string
): Promise<KeywordAnalysis> {
  const targetAudience = businessType === "B2B" ? "企业/B端客户" : "个人消费者/C端用户";
  const audienceCheck =
    businessType === "B2B"
      ? "判断该关键词是否具有B端（企业级、批发、工业、商业采购、企业服务）属性"
      : "判断该关键词是否具有C端（个人消费、零售、日常生活、个人使用）属性";

  const prompt = `你是一位资深的 Google Ads SEM 优化专家，拥有丰富的关键词语义分析经验。请用中文进行所有分析，所有文字输出必须为中文。

请对关键词 "${keyword}" 进行深度语义分析，判断其是否适合用于以下客户的广告投放：
- 客户业务方向: ${businessDirection}
- 业务类型: ${businessType}（目标受众: ${targetAudience}）

分析维度：
1. **业务类型匹配度（businessTypeMatch）**: ${audienceCheck}。请从关键词的搜索意图、使用场景、目标受众等角度综合判断。
2. **业务方向匹配度（businessDirectionMatch）**: 关键词的语义是否与"${businessDirection}"的核心业务相关。请考虑行业归属、产品/服务类别、用户需求等。
3. **综合建议**: 只有当业务类型和业务方向两个维度都匹配时，才给出"keep"（建议保留）；任意一个不匹配，则给出"exclude"（建议排除）。

请在 reasoning 字段中详细说明分析理由，包括：
- 该关键词的典型搜索意图是什么
- 为什么匹配或不匹配客户的业务类型
- 为什么匹配或不匹配客户的业务方向
- 置信度评分依据

重要：reasoning 和 searchSummary 字段必须使用中文撰写，不得使用英文。`;

  const systemMsg = {
    role: "system" as const,
    content:
      "你是一位专业的 SEM 关键词语义分析师。你必须返回严格 JSON：{\"searchSummary\":\"中文50字\",\"recommendation\":\"keep|exclude\",\"businessTypeMatch\":true|false,\"businessDirectionMatch\":true|false,\"confidence\":0-100,\"reasoning\":\"中文理由\"}。只输出 JSON，不要 markdown 标记。所有文字必须中文。",
  };
  const userMsg = { role: "user" as const, content: prompt };
  const respFmt = {
    type: "json_schema" as const,
    json_schema: {
      name: "keyword_analysis",
      strict: true,
      schema: {
        type: "object",
        properties: {
          searchSummary: { type: "string", description: "基于语义知识对该关键词典型搜索场景的总结（中文，50字以内）" },
          recommendation: { type: "string", enum: ["keep", "exclude"] },
          businessTypeMatch: { type: "boolean" },
          businessDirectionMatch: { type: "boolean" },
          confidence: { type: "integer", description: "置信度 0-100" },
          reasoning: { type: "string", description: "详细的中文分析理由" },
        },
        required: ["searchSummary","recommendation","businessTypeMatch","businessDirectionMatch","confidence","reasoning"],
        additionalProperties: false,
      },
    },
  };

  const doCall = async () => invokeLLM({ modelOverride: model, messages: [systemMsg, userMsg], response_format: respFmt });

  const parseResult = (response: Awaited<ReturnType<typeof invokeLLM>>): KeywordAnalysis => {
    const rawContent = response.choices[0]?.message?.content;
    // Defensive: handle null/undefined/empty content (e.g. Gemini web search mode)
    const contentStr = typeof rawContent === "string" ? rawContent : (rawContent as any)?.[0]?.text || "";
    if (!contentStr || contentStr.trim().length === 0 || contentStr === "```" || contentStr === "```json") {
      throw new Error(`LLM returned empty or malformed content: "${String(contentStr).slice(0, 50)}"`);
    }
    const parsed = JSON.parse(contentStr);
    const bt = Boolean(parsed.businessTypeMatch);
    const bd = Boolean(parsed.businessDirectionMatch);
    return {
      keyword,
      recommendation: bt && bd ? "keep" : "exclude",
      businessTypeMatch: bt,
      businessDirectionMatch: bd,
      confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 0)),
      reasoning: parsed.reasoning || "分析完成。",
      searchResults: [],
      searchSummary: parsed.searchSummary || "",
    };
  };

  try {
    return parseResult(await doCall());
  } catch (error) {
    console.warn(`[LLM] First attempt failed for \"${keyword}\", retrying...`, String(error).slice(0, 100));
    try {
      return parseResult(await doCall());
    } catch (retryError) {
      console.error(`[LLM] Analysis failed for \"${keyword}\" after retry:`, retryError);
      return {
        keyword,
        recommendation: "exclude",
        businessTypeMatch: false,
        businessDirectionMatch: false,
        confidence: 0,
        reasoning: "分析过程中出现错误，建议手动检查该关键词。",
        searchResults: [],
        searchSummary: "",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Overall summary
// ---------------------------------------------------------------------------
async function generateOverallSummary(
  results: KeywordAnalysis[],
  businessDirection: string,
  businessType: BusinessType,
  model?: string
): Promise<string> {
  const keepCount = results.filter((r) => r.recommendation === "keep").length;
  const excludeCount = results.filter((r) => r.recommendation === "exclude").length;
  const summaryLines = results
    .map((r) => `"${r.keyword}": ${r.recommendation === "keep" ? "保留" : "排除"}`)
    .join("、");

  try {
    const response = await invokeLLM({
      modelOverride: model,
      messages: [
        {
          role: "system",
          content:
            "你是一位专业的 SEM 优化顾问。请用简洁的中文撰写总结，不要使用 markdown 格式，直接输出纯文本，100字以内。",
        },
        {
          role: "user",
          content: `客户业务：${businessDirection}（${businessType}）。共 ${results.length} 个关键词，${keepCount} 个建议保留，${excludeCount} 个建议排除。明细：${summaryLines}。请写一段简洁的分析总结和优化建议。`,
        },
      ],
    });
    const content = response.choices[0]?.message?.content;
    return (
      (typeof content === "string"
        ? content.trim()
        : ((content as any)?.[0]?.text || "").trim()) ||
      `共分析 ${results.length} 个关键词，${keepCount} 个建议保留，${excludeCount} 个建议排除。`
    );
  } catch {
    return `共分析 ${results.length} 个关键词，其中 ${keepCount} 个建议保留，${excludeCount} 个建议排除。`;
  }
}

// ---------------------------------------------------------------------------
// Negative keyword insight extraction
// ---------------------------------------------------------------------------
async function extractNegativeInsights(
  results: KeywordAnalysis[],
  businessDirection: string,
  businessType: BusinessType,
  clientBrand: string,
  model?: string
): Promise<NegativeInsights & { overallSummary: string }> {
  const excluded = results.filter((r) => r.recommendation === "exclude");
  const keepCount = results.filter((r) => r.recommendation === "keep").length;
  const excludeCount = excluded.length;

  if (excluded.length === 0) {
    const fallbackSummary = `共分析 ${results.length} 个关键词，全部建议保留。`;
    return { groups: [], hasInsights: false, overallSummary: fallbackSummary };
  }

  // Group excluded keywords with their reasoning
  const excludedList = excluded
    .map((r) => `- "${r.keyword}"（原因：${r.reasoning.slice(0, 80)}）`)
    .join("\n");

  const summaryLines = results
    .map((r) => `"${r.keyword}": ${r.recommendation === "keep" ? "保留" : "排除"}`)
    .join("、");

  const systemPrompt = `你是 SEM 否词策略分析师，专精 Google Ads 否定关键词配置。你的任务是基于已排除的关键词，提取可复用的否定关键词词根，并撰写分析总结。

# 词根提取规则（必须严格遵守）

1. 词根是可用于否定关键词匹配的**核心词或短语**，长度通常 2-8 个中文字或 1-3 个英文词。
2. **严禁提取客户业务核心词**：客户业务方向是「${businessDirection}」，提取的词根绝对不能包含客户业务的核心关键词。例如客户做锂电池，词根不能包含"锂电池"、"电池"、"lithium"、"battery"——否则会误杀正常流量。
3. **严禁提取客户品牌名**：客户品牌/公司名是「${clientBrand}」，词根中绝对不能出现客户品牌名或其变体。
4. 词根提取目标：用一个词根覆盖尽可能多的同类排除词。例如排除词包含"tesla battery""byd energy""catl supplier"，应提取"tesla""byd""catl"而非"battery""energy""supplier"。
5. 词根要具体、可操作，不是泛化描述。好词根："diy""home use""recycling"；坏词根："不相关""其他"。
6. 每类最多 15 个词根，去重，不翻译英文。
7. 只输出 JSON，无任何其他文字。

# 否词分类
1. 竞对品牌词/无关品牌词：竞争对手或无关品牌名称
2. 无关产品词：与客户业务完全不相关的产品类别词
3. 无关行业词：指向完全不同行业的词汇
4. 其他无关词：其他可批量排除的词根

# 输出格式
返回 JSON：{"groups":[{"category":"分类名","description":"20字内描述","terms":["词根1","词根2"]}],"overallSummary":"100字以内的优化总结，说明哪些方向需要重点加否词"}

# Few-Shot 示例

输入：客户锂电池 B2B 业务，品牌「海辰能源」，排除词：
- "tesla powerwall battery"（竞对品牌）
- "byd energy storage"（竞对品牌）
- "diy battery pack"（C端个人消费）

输出：
{"groups":[{"category":"竞对品牌词","description":"排除竞品品牌名，防止竞品截流","terms":["tesla","byd","powerwall"]},{"category":"C端个人消费词","description":"排除C端DIY场景词根","terms":["diy","for home"]}],"overallSummary":"共分析N个关键词，M个建议保留，K个建议排除。建议重点对竞品品牌词和C端个人消费词添加广泛匹配否词，避免无效点击。"}`;

  try {
    const response = await invokeLLM({
      modelOverride: model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `客户业务：${businessDirection}（${businessType}）
客户品牌：${clientBrand}
共 ${results.length} 个关键词，${keepCount} 个建议保留，${excludeCount} 个建议排除。明细：${summaryLines}

被排除的关键词：
${excludedList}

请根据上述词根提取规则，提取否定关键词词根并撰写总结。`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const respContent = response.choices[0]?.message?.content;
    const raw = typeof respContent === "string" ? respContent : (respContent as any)?.[0]?.text || '{"groups":[],"overallSummary":""}';
    // Strip markdown code fences
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);

    const groups: NegativeInsightGroup[] = (parsed.groups || [])
      .filter((g: any) => Array.isArray(g.terms) && g.terms.length > 0)
      .map((g: any) => ({
        category: g.category || "其他",
        description: g.description || "",
        terms: g.terms.filter((t: any) => typeof t === "string" && t.trim().length > 0),
      }));

    const overallSummary: string = parsed.overallSummary?.trim() ||
      `共分析 ${results.length} 个关键词，${keepCount} 个建议保留，${excludeCount} 个建议排除。`;

    return { groups, hasInsights: groups.length > 0, overallSummary };
  } catch (error) {
    console.error("[NegativeInsights] Extraction failed:", error);
    const fallbackSummary = `共分析 ${results.length} 个关键词，其中 ${keepCount} 个建议保留，${excludeCount} 个建议排除。`;
    return { groups: [], hasInsights: false, overallSummary: fallbackSummary };
  }
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
function buildCacheKey(
  businessDirection: string,
  businessType: string,
  keywords: string[]
): string {
  // Include prompt version in cache key so prompt changes auto-invalidate cache
  const PROMPT_VERSION = "v3";
  const canonical = JSON.stringify({
    v: PROMPT_VERSION,
    bd: businessDirection.trim().toLowerCase(),
    bt: businessType,
    kw: [...keywords].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function getCachedReport(cacheKey: string): Promise<AnalysisReport | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select()
      .from(analysisCache)
      .where(eq(analysisCache.cacheKey, cacheKey))
      .limit(1);
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].reportJson) as AnalysisReport;
  } catch {
    return null;
  }
}

async function setCachedReport(
  cacheKey: string,
  report: AnalysisReport
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db
      .insert(analysisCache)
      .values({
        cacheKey,
        businessDirection: report.input.businessDirection,
        businessType: report.input.businessType,
        keywords: JSON.stringify(report.input.keywords),
        reportJson: JSON.stringify(report),
        analyzedAt: report.analyzedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          reportJson: JSON.stringify(report),
          analyzedAt: report.analyzedAt,
        },
      });
  } catch (err) {
    console.error("[Cache] Failed to save:", err);
  }
}

// ---------------------------------------------------------------------------
// Client keyword history helpers
// ---------------------------------------------------------------------------

/** Fetch all historical keyword analyses for a client (keyed by lowercase keyword).
 * Handles both KeywordAnalysis (manual) and SearchTermAnalysis (CSV) shapes. */
async function getClientHistory(
  clientId: number
): Promise<Map<string, KeywordAnalysis>> {
  const map = new Map<string, KeywordAnalysis>();
  try {
    const db = await getDb();
    if (!db) return map;
    const rows = await db
      .select()
      .from(clientKeywordHistory)
      .where(eq(clientKeywordHistory.clientId, clientId));
    for (const row of rows) {
      try {
        const raw = JSON.parse(row.analysisResultJson);
        let analysis: KeywordAnalysis;
        // Detect shape: SearchTermAnalysis has "term", KeywordAnalysis has "keyword"
        if (raw.term !== undefined && raw.suggestion !== undefined) {
          // Convert SearchTermAnalysis → KeywordAnalysis
          const isKeep = raw.suggestion === "保留";
          analysis = {
            keyword: raw.term || row.keyword,
            recommendation: isKeep ? "keep" : "exclude",
            businessTypeMatch: raw.dim1?.status === "pass",
            businessDirectionMatch: raw.dim2?.status === "pass",
            confidence: raw.score ?? (isKeep ? 80 : 20),
            reasoning: raw.excludeReason || (isKeep ? "三维漏斗分析通过" : "三维漏斗分析未通过"),
            searchResults: [],
            searchSummary: "",
          };
        } else if (raw.keyword !== undefined) {
          // Native KeywordAnalysis shape
          analysis = raw as KeywordAnalysis;
        } else {
          continue; // unknown shape, skip
        }
        map.set(row.keyword.toLowerCase(), analysis);
      } catch {
        // skip malformed rows
      }
    }
  } catch (err) {
    console.error("[ClientHistory] Failed to fetch:", err);
  }
  return map;
}

/** Persist new keyword analysis results to client_keyword_history (async, non-blocking) */
async function saveClientHistory(
  clientId: number,
  results: KeywordAnalysis[]
): Promise<void> {
  if (results.length === 0) return;
  try {
    const db = await getDb();
    if (!db) return;
    const now = Date.now();
    // Insert one row per keyword; ignore duplicates (keyword already in history)
    for (const result of results) {
      await db
        .insert(clientKeywordHistory)
        .values({
          clientId,
          keyword: result.keyword.toLowerCase(),
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
    console.error("[ClientHistory] Failed to save:", err);
  }
}

// ---------------------------------------------------------------------------
// tRPC router
// ---------------------------------------------------------------------------
export const keywordRouter = router({
  analyze: protectedProcedure
    .input(
      z.object({
        businessDirection: z.string().min(1, "请输入客户业务方向").max(500),
        businessType: z.enum(["B2B", "B2C"]),
        keywords: z
          .array(z.string().min(1).max(200))
          .min(1, "请至少输入一个关键词")
          .max(100, "单次最多分析 100 个关键词"),
        forceRefresh: z.boolean().optional().default(false),
        /** Per-request model override (e.g., "deepseek-v4-flash" or "deepseek-v4-pro") */
        model: z.string().optional(),
        /** If provided, load history for this client and deduplicate */
        clientId: z.number().int().positive().optional(),
        /** If provided, create a new client profile before analyzing */
        saveAsClient: z
          .object({ name: z.string().min(1).max(255) })
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { businessDirection, businessType, keywords, forceRefresh } = input;
      let { clientId } = input;
      const { model } = input;

      // Reset token tracker for this request
      TokenTracker.reset();

      const cleanKeywords = Array.from(
        new Set(keywords.map((k) => k.trim()).filter((k) => k.length > 0))
      );

      // -----------------------------------------------------------------------
      // Quota Management: Lazy-reset + check allowance
      // -----------------------------------------------------------------------
      let currentUser = ctx.user;
      
      // Lazy-reset: if today != last_reset_date, reset count to 0
      currentUser = await lazyResetQuota(currentUser);
      
      // Check quota allowance
      const quotaCheck = checkQuotaAllowance(currentUser, cleanKeywords.length);
      if (!quotaCheck.allowed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: quotaCheck.message || "已达单日否词分析上限",
        });
      }

      // -----------------------------------------------------------------------
      // Business chain 1: saveAsClient — create client profile first
      // -----------------------------------------------------------------------
      if (input.saveAsClient) {
        const db = await getDb();
        if (db) {
          const result = await db.insert(clients).values({
            userId: ctx.user.id,
            name: input.saveAsClient.name,
            businessDirection,
            businessType,
          });
          const insertId = (result as any)[0]?.insertId ?? (result as any).insertId;
          clientId = Number(insertId);
        }
      }

      // -----------------------------------------------------------------------
      // Business chain 2: deduplication against client history
      // -----------------------------------------------------------------------
      let historicalResults = new Map<string, KeywordAnalysis>();
      let keywordsToAnalyze = cleanKeywords;

      if (clientId) {
        historicalResults = await getClientHistory(clientId);
        // Only analyze keywords NOT already in history
        keywordsToAnalyze = cleanKeywords.filter(
          (kw) => !historicalResults.has(kw.toLowerCase())
        );
        console.log(
          `[Dedup] Client ${clientId}: ${cleanKeywords.length} total, ${historicalResults.size} cached, ${keywordsToAnalyze.length} new`
        );
      }

      // -----------------------------------------------------------------------
      // Try global analysis cache for the new keywords subset (if no clientId)
      // -----------------------------------------------------------------------
      let freshResults: KeywordAnalysis[] = [];

      if (!clientId) {
        const cacheKey = buildCacheKey(businessDirection, businessType, cleanKeywords);
        if (!forceRefresh) {
          const cached = await getCachedReport(cacheKey);
          if (cached) {
            return { ...cached, fromCache: true, clientId: clientId ?? null };
          }
        }
      }

      // -----------------------------------------------------------------------
      // LLM semantic analysis for new keywords (batches of 10)
      // -----------------------------------------------------------------------
      const LLM_BATCH = 10;
      for (let i = 0; i < keywordsToAnalyze.length; i += LLM_BATCH) {
        const batch = keywordsToAnalyze.slice(i, i + LLM_BATCH);
        const batchResults = await Promise.all(
          batch.map((kw) =>
            analyzeKeywordSemantics(kw, businessDirection, businessType, model)
          )
        );
        freshResults.push(...batchResults);
      }

      // -----------------------------------------------------------------------
      // Merge: historical results + fresh LLM results, preserving input order
      // -----------------------------------------------------------------------
      const allResults: KeywordAnalysis[] = cleanKeywords.map((kw) => {
        const fromHistory = historicalResults.get(kw.toLowerCase());
        if (fromHistory) return fromHistory;
        return freshResults.find((r) => r.keyword.toLowerCase() === kw.toLowerCase())!;
      }).filter(Boolean);

      // -----------------------------------------------------------------------
      // Summary + negative insights (single combined LLM call, saves tokens)
      // -----------------------------------------------------------------------
      // Fetch client brand name for negative keyword extraction
      let clientBrand = businessDirection; // fallback
      if (clientId) {
        try {
          const db = await getDb();
          if (db) {
            const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1);
            if (client?.name) clientBrand = client.name;
          }
        } catch { /* best-effort */ }
      }

      const combined = await extractNegativeInsights(allResults, businessDirection, businessType, clientBrand, model);

      const report: AnalysisReport = {
        input: { businessDirection, businessType, keywords: cleanKeywords },
        results: allResults,
        overallSummary: combined.overallSummary,
        negativeInsights: { groups: combined.groups, hasInsights: combined.hasInsights },
        analyzedAt: Date.now(),
      };

      // -----------------------------------------------------------------------
      // Persist: save to global cache (non-client) OR client history (client)
      // -----------------------------------------------------------------------
      if (clientId) {
        // Async, non-blocking — save only the freshly analyzed keywords
        void saveClientHistory(clientId, freshResults);
      } else {
        const cacheKey = buildCacheKey(businessDirection, businessType, cleanKeywords);
        await setCachedReport(cacheKey, report);
      }

      // -----------------------------------------------------------------------
      // Quota: Increment daily_keyword_count after successful analysis
      // Quota: only count newly analyzed keywords (not cached/deduped)
      const newCount = await incrementDailyKeywordCount(ctx.user.id, freshResults.length);
      console.log(`[Quota] User ${ctx.user.id}: incremented by ${freshResults.length} (${cleanKeywords.length} total, ${keywordsToAnalyze.length} new), new count: ${newCount}`);

      const tokenUsage = TokenTracker.getTotal();
      TokenTracker.log(`keyword.analyze | ${freshResults.length} keywords analyzed`);

      return {
        ...report,
        fromCache: false,
        clientId: clientId ?? null,
        dailyKeywordCount: newCount >= 0 ? newCount : currentUser.daily_keyword_count,
        dailyKeywordLimit: currentUser.daily_keyword_limit,
        tokenUsage,
      };
    }),

  editReadme: publicProcedure
    .input(
      z.object({
        password: z.string(),
        content: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const ADMIN_PASSWORD = "daniel";
      if (input.password !== ADMIN_PASSWORD) {
        throw new Error("Invalid password");
      }

      try {
        const db = await getDb();
        await db!
          .insert(appSettings)
          .values({ key: "readme", value: input.content })
          .onDuplicateKeyUpdate({ set: { value: input.content } });
        return { success: true, message: "README updated successfully" };
      } catch (error) {
        console.error("[README Edit] Error:", error);
        throw new Error("Failed to update README");
      }
    }),

  getReadme: publicProcedure.query(async () => {
    // Try DB first
    try {
      const db = await getDb();
      if (db) {
        const rows = await db
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, "readme"));
        const dbContent = rows[0]?.value ?? "";
        if (dbContent) {
          console.log('[getReadme] Serving from DB');
          return { content: dbContent };
        }
      }
    } catch (dbError) {
      console.warn('[getReadme] DB read failed, falling back to file:', dbError);
    }
    // Fallback: read from local file
    try {
      const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const filePath = join(__dirname, "../prompts/usage-guide.md");
      const fileContent = readFileSync(filePath, "utf-8");
      console.log('[getReadme] Serving from file:', filePath);
      return { content: fileContent };
    } catch (fileError) {
      console.error('[getReadme] File read also failed:', fileError);
      return { content: "" };
    }
  }),
});
