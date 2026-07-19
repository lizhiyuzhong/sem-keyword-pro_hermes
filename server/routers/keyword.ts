import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "crypto";
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
  businessType: BusinessType
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

  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "你是一位专业的 SEM 关键词语义分析师。请严格按照 JSON 格式返回分析结果，不要包含任何其他文字或 markdown 标记。所有文字字段（reasoning、searchSummary）必须使用中文撰写，禁止使用英文。",
        },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "keyword_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              searchSummary: {
                type: "string",
                description: "基于语义知识对该关键词典型搜索场景的总结（中文，50字以内）",
              },
              recommendation: { type: "string", enum: ["keep", "exclude"] },
              businessTypeMatch: { type: "boolean" },
              businessDirectionMatch: { type: "boolean" },
              confidence: {
                type: "integer",
                description: "置信度 0-100，反映分析的确定性",
              },
              reasoning: {
                type: "string",
                description: "详细的中文分析理由，说明匹配或不匹配的原因",
              },
            },
            required: [
              "searchSummary",
              "recommendation",
              "businessTypeMatch",
              "businessDirectionMatch",
              "confidence",
              "reasoning",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    const parsed =
      typeof content === "string"
        ? JSON.parse(content)
        : JSON.parse((content as any)?.[0]?.text || "{}");

    // Enforce AND logic: both must be true for "keep"
    const businessTypeMatch = Boolean(parsed.businessTypeMatch);
    const businessDirectionMatch = Boolean(parsed.businessDirectionMatch);
    const recommendation: Recommendation =
      businessTypeMatch && businessDirectionMatch ? "keep" : "exclude";

    return {
      keyword,
      recommendation,
      businessTypeMatch,
      businessDirectionMatch,
      confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 0)),
      reasoning: parsed.reasoning || "分析完成。",
      searchResults: [],
      searchSummary: parsed.searchSummary || "",
    };
  } catch (error) {
    console.error(`[LLM] Analysis failed for "${keyword}":`, error);
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

// ---------------------------------------------------------------------------
// Overall summary
// ---------------------------------------------------------------------------
async function generateOverallSummary(
  results: KeywordAnalysis[],
  businessDirection: string,
  businessType: BusinessType
): Promise<string> {
  const keepCount = results.filter((r) => r.recommendation === "keep").length;
  const excludeCount = results.filter((r) => r.recommendation === "exclude").length;
  const summaryLines = results
    .map((r) => `"${r.keyword}": ${r.recommendation === "keep" ? "保留" : "排除"}`)
    .join("、");

  try {
    const response = await invokeLLM({
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
  businessType: BusinessType
): Promise<NegativeInsights> {
  const excluded = results.filter((r) => r.recommendation === "exclude");
  if (excluded.length === 0) return { groups: [], hasInsights: false };

  const excludedList = excluded
    .map((r) => `"${r.keyword}"（原因：${r.reasoning.slice(0, 60)}）`)
    .join("\n");

  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "你是一位资深的 Google Ads SEM 优化专家，擅长否词策略分析。请严格按照 JSON 格式返回结果，所有文字使用中文。",
        },
        {
          role: "user",
          content: `分析以下被排除的关键词，提取可用于广泛匹配否词的核心词根，按类别分组。

客户业务：${businessDirection}（${businessType}）

被排除的关键词：
${excludedList}

请识别以下类型（如有）：
1. 竞对品牌词/无关品牌词：关键词中出现的竞争对手或无关品牌名称
2. 无关产品词：与客户业务完全不相关的产品类别词
3. 无关行业词：指向完全不同行业的词汇
4. 其他无关词：其他可批量排除的词根

重要规则（必须严格遵守）：
1. 只提取词根（如从"Siemens PLC"提取"Siemens"），不要包含整个关键词。
2. 严禁翻译：词根必须保持与原关键词完全相同的语言形式。英文关键词只能提取英文词根，中文关键词只能提取中文词根，绝对不允许将英文翻译成中文或将中文翻译成英文。
3. 例如：从"electric bike"只能提取"electric bike"或"electric"，绝不能输出"电动车"；从"逆变器"只能提取"逆变器"，绝不能输出"inverter"。

返回 JSON 格式：
{"groups":[{"category":"分类名","description":"排除原因（20字内）","terms":["词根1","词根2"]}]}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "negative_insights",
          strict: true,
          schema: {
            type: "object",
            properties: {
              groups: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    category: { type: "string" },
                    description: { type: "string" },
                    terms: { type: "array", items: { type: "string" } },
                  },
                  required: ["category", "description", "terms"],
                  additionalProperties: false,
                },
              },
            },
            required: ["groups"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    const parsed =
      typeof content === "string"
        ? JSON.parse(content)
        : JSON.parse((content as any)?.[0]?.text || '{"groups":[]}');

    const groups: NegativeInsightGroup[] = (parsed.groups || [])
      .filter((g: any) => Array.isArray(g.terms) && g.terms.length > 0)
      .map((g: any) => ({
        category: g.category || "其他",
        description: g.description || "",
        terms: g.terms.filter((t: any) => typeof t === "string" && t.trim().length > 0),
      }));

    return { groups, hasInsights: groups.length > 0 };
  } catch (error) {
    console.error("[NegativeInsights] Extraction failed:", error);
    return { groups: [], hasInsights: false };
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
  const canonical = JSON.stringify({
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

/** Fetch all historical keyword analyses for a client (keyed by lowercase keyword) */
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
        const analysis = JSON.parse(row.analysisResultJson) as KeywordAnalysis;
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
            analyzeKeywordSemantics(kw, businessDirection, businessType)
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
      // Summary + negative insights (based on full merged result set)
      // -----------------------------------------------------------------------
      const [overallSummary, negativeInsights] = await Promise.all([
        generateOverallSummary(allResults, businessDirection, businessType),
        extractNegativeInsights(allResults, businessDirection, businessType),
      ]);

      const report: AnalysisReport = {
        input: { businessDirection, businessType, keywords: cleanKeywords },
        results: allResults,
        overallSummary,
        negativeInsights,
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
      // -----------------------------------------------------------------------
      const newCount = await incrementDailyKeywordCount(ctx.user.id, cleanKeywords.length);
      console.log(`[Quota] User ${ctx.user.id}: incremented by ${cleanKeywords.length}, new count: ${newCount}`);

      const tokenUsage = TokenTracker.getTotal();
      TokenTracker.log(`keyword.analyze | ${cleanKeywords.length} keywords`);

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
    try {
      const db = await getDb();
      const rows = await db!
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, "readme"));
      const content = rows[0]?.value ?? "";
      return { content };
    } catch (error) {
      console.error("[README Get] Error:", error);
      throw new Error("Failed to read README");
    }
  }),
});
