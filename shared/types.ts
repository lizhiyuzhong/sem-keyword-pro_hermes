/**
 * Unified type exports
 * Import shared types from this single entry point.
 */

export type * from "../drizzle/schema";
export * from "./_core/errors";

/** Business type: B2B or B2C */
export type BusinessType = "B2B" | "B2C";

/** Input for keyword analysis */
export interface AnalysisInput {
  businessDirection: string;
  businessType: BusinessType;
  keywords: string[];
}

/** A single Google search result snippet */
export interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

/** Recommendation for a single keyword */
export type Recommendation = "keep" | "exclude";

/** Analysis result for a single keyword */
export interface KeywordAnalysis {
  keyword: string;
  recommendation: Recommendation;
  businessTypeMatch: boolean;
  businessDirectionMatch: boolean;
  confidence: number;
  reasoning: string;
  searchResults: SearchResult[];
  searchSummary: string;
}

/** A group of negative keywords extracted by category (e.g. competitor brands, irrelevant products) */
export interface NegativeInsightGroup {
  /** Category name, e.g. "竞对品牌词" or "无关产品词" */
  category: string;
  /** Short description of why these terms should be excluded */
  description: string;
  /** The extracted root terms (broad match, no formatting) */
  terms: string[];
}

/** Negative keyword insights extracted from the full analysis */
export interface NegativeInsights {
  groups: NegativeInsightGroup[];
  /** Whether any insights were found */
  hasInsights: boolean;
}

/** Per-dimension verdict for a single search term */
export interface DimensionVerdict {
  /** Pass / Fail / N/A */
  status: "pass" | "fail" | "na";
  /** Short explanation for this dimension */
  reason: string;
}

/** The 5 fixed high-level negative keyword categories */
export type NegativeCategory =
  | "竞对公司词"
  | "无关业务/产品词"
  | "C端个人消费词"
  | "纯信息/学术词"
  | "触发偏移词";

/** Analysis result for a single search term (3-dimension funnel) */
export interface SearchTermAnalysis {
  term: string;
  matchedKeyword: string;
  score: number;            // 0-100
  suggestion: "保留" | "排除";
  excludeReason: string;    // e.g. "【维度1-受众偏差】..."
  extractedNegative: string | null;
  /** High-level category for the excluded term (one of 5 fixed labels) */
  negativeCategory?: NegativeCategory | null;
  /** Optional per-dimension verdicts (populated by newer LLM responses) */
  dim1?: DimensionVerdict;  // 维度1：客户类型匹配度
  dim2?: DimensionVerdict;  // 维度2：业务方向匹配度
  dim3?: DimensionVerdict;  // 维度3：触发相关性判定
}

/** Full search-term analysis report */
export interface SearchTermReport {
  businessDirection: string;
  businessType: BusinessType;
  results: SearchTermAnalysis[];
  totalCount: number;       // total terms in this batch
  skippedCount: number;     // terms skipped due to L2 history dedup
  analyzedAt: number;
}

/** Full analysis report */
export interface AnalysisReport {
  input: AnalysisInput;
  results: KeywordAnalysis[];
  overallSummary: string;
  negativeInsights: NegativeInsights;
  analyzedAt: number;
}

/** LLM token usage summary */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
