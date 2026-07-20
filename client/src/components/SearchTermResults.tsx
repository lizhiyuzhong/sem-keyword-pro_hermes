import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronDown,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Loader2,
  SkipForward,
  AlertTriangle,
  Copy,
  Check,
  Lightbulb,
  ShieldAlert,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { SearchTermAnalysis, DimensionVerdict } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe clipboard write with HTTP fallback */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      resolve();
    } catch {
      reject(new Error("Copy failed"));
    }
    document.body.removeChild(ta);
  });
}

function formatNegativeKeyword(keyword: string, mode: "broad" | "phrase" | "exact"): string {
  if (mode === "phrase") return `"${keyword}"`;
  if (mode === "exact") return `[${keyword}]`;
  return keyword;
}

/** The 5 fixed negative category labels in display order */
const CATEGORY_ORDER = ["竞对公司词", "无关业务/产品词", "C端个人消费词", "纯信息/学术词", "触发偏移词"] as const;

const CATEGORY_DESC: Record<string, string> = {
  "竞对公司词": "搜索词包含竞争对手公司名、品牌名，建议全部加入否词",
  "无关业务/产品词": "属于完全不同行业或产品类别，与客户业务无关",
  "C端个人消费词": "个人零售、家用、DIY 等 C 端意图，不符合 B2B 定位",
  "纯信息/学术词": "纯资讯、百科、学术查询，无转化意图",
  "触发偏移词": "与触发关键字存在语义偏移或越级触发",
};

/** Infer negativeCategory from excludeReason label when field is null */
function inferCategory(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("竞对") || r.includes("品牌") || r.includes("公司名")) return "竞对公司词";
  if (r.includes("c端") || r.includes("个人") || r.includes("零售") || r.includes("家用") || r.includes("受众偏差")) return "C端个人消费词";
  if (r.includes("学术") || r.includes("百科") || r.includes("资讯") || r.includes("信息")) return "纯信息/学术词";
  if (r.includes("偏移") || r.includes("越级") || r.includes("语义偏") || r.includes("匹配偏移")) return "触发偏移词";
  return "无关业务/产品词";
}

/** Build smart negative insight groups from negativeCategory (high-level, ≤5 categories) */
function buildInsightGroups(results: SearchTermAnalysis[]): Array<{ category: string; description: string; terms: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const r of results) {
    if (r.suggestion === "排除") {
      const cat = r.negativeCategory ?? inferCategory(r.excludeReason ?? "");
      if (!map.has(cat)) map.set(cat, new Set());
      map.get(cat)!.add(r.term);
    }
  }
  // Return in fixed order, only include categories that have terms
  return CATEGORY_ORDER
    .filter((cat) => map.has(cat))
    .map((cat) => ({
      category: cat,
      description: CATEGORY_DESC[cat] ?? "",
      terms: Array.from(map.get(cat)!),
    }));
}

// ---------------------------------------------------------------------------
// Dimension verdict row
// ---------------------------------------------------------------------------

const DIM_LABELS = [
  { key: "dim1" as const, label: "维度1", desc: "客户类型匹配度" },
  { key: "dim2" as const, label: "维度2", desc: "业务方向匹配度" },
  { key: "dim3" as const, label: "维度3", desc: "触发相关性判定" },
];

function DimensionRow({
  label,
  desc,
  verdict,
}: {
  label: string;
  desc: string;
  verdict?: DimensionVerdict;
}) {
  const status = verdict?.status ?? "na";
  const reason = verdict?.reason ?? "—";

  return (
    <div className="flex items-start gap-2.5 text-xs">
      <div className="flex items-center gap-1.5 shrink-0 w-32">
        {status === "pass" ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-apple-green shrink-0" />
        ) : status === "fail" ? (
          <XCircle className="w-3.5 h-3.5 text-apple-red shrink-0" />
        ) : (
          <SkipForward className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
        )}
        <span
          className={`font-medium ${
            status === "pass"
              ? "text-apple-green"
              : status === "fail"
              ? "text-apple-red"
              : "text-muted-foreground/50"
          }`}
        >
          {label}
        </span>
        <span className="text-muted-foreground/50 truncate">{desc}</span>
      </div>
      {status === "na" ? (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/60 text-[10px] font-medium">
          <SkipForward className="w-2.5 h-2.5" />
          已短路跳过
        </span>
      ) : (
        <p
          className={`leading-relaxed ${
            status === "pass"
              ? "text-apple-green/80"
              : "text-apple-red/80"
          }`}
        >
          {reason}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single result card
// ---------------------------------------------------------------------------

function SearchTermCard({
  result,
  negativeMatchMode,
  isSelected,
  onToggleSelect,
}: {
  result: SearchTermAnalysis;
  negativeMatchMode?: "broad" | "phrase" | "exact";
  isSelected?: boolean;
  onToggleSelect?: (term: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isKeep = result.suggestion === "保留";

  const displayTerm =
    !isKeep && negativeMatchMode
      ? formatNegativeKeyword(result.term, negativeMatchMode)
      : result.term;

  return (
    <div
      className={`rounded-xl border transition-all ${
        isKeep
          ? "border-apple-green/20 bg-apple-green/[0.03]"
          : "border-apple-red/20 bg-apple-red/[0.03]"
      }`}
    >
      {/* Header row */}
      <div className="w-full flex items-start p-4 gap-3">
        {/* Checkbox */}
        {onToggleSelect && (
          <div className="mt-0.5 shrink-0">
            <Checkbox
              checked={isSelected ?? false}
              onCheckedChange={() => onToggleSelect(result.term)}
              className={isKeep ? "border-apple-green/50 data-[state=checked]:bg-apple-green data-[state=checked]:border-apple-green" : "border-apple-red/50 data-[state=checked]:bg-apple-red data-[state=checked]:border-apple-red"}
            />
          </div>
        )}

        {/* Expand toggle */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(!expanded)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(!expanded);
            }
          }}
          className="flex-1 flex items-start justify-between cursor-pointer gap-3 min-w-0"
        >
          {/* Left: icon + term + matched keyword */}
          <div className="flex items-start gap-2 min-w-0">
            {isKeep ? (
              <CheckCircle2 className="w-4 h-4 text-apple-green mt-0.5 shrink-0" />
            ) : (
              <XCircle className="w-4 h-4 text-apple-red mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground font-mono truncate">
                {displayTerm}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                触发关键字：<span className="font-mono">{result.matchedKeyword}</span>
              </p>
            </div>
          </div>

          {/* Right: score + chevron */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <div
                className={`h-1.5 rounded-full ${isKeep ? "bg-apple-green" : "bg-apple-red"}`}
                style={{ width: `${Math.max(20, result.score * 0.6)}px` }}
              />
              <span className="text-xs text-muted-foreground">{result.score}%</span>
            </div>
            <ChevronDown
              className={`w-4 h-4 text-muted-foreground transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
            />
          </div>
        </div>
      </div>

      {/* Expanded detail — three dimension rows */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-2.5 border-t border-border/30 pt-3">
              {/* Three dimension verdicts */}
              {DIM_LABELS.map(({ key, label, desc }) => (
                <DimensionRow
                  key={key}
                  label={label}
                  desc={desc}
                  verdict={result[key]}
                />
              ))}

              {/* Fallback: if no dim fields, show combined reason */}
              {!result.dim1 && !result.dim2 && !result.dim3 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-1.5">
                    AI 分析建议理由
                  </h4>
                  <p className="text-xs leading-relaxed text-foreground/80">
                    {result.excludeReason}
                  </p>
                </div>
              )}

              {/* Extracted negative keyword */}
              {result.extractedNegative && (
                <div className="pt-1">
                  <h4 className="text-xs font-medium text-muted-foreground mb-1.5">
                    否词分类汇总
                  </h4>
                  <code className="text-xs bg-muted/50 rounded px-2 py-1 font-mono text-foreground">
                    {result.extractedNegative}
                  </code>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SearchTermResultsProps {
  results: SearchTermAnalysis[];
  currentIndex: number;
  totalToProcess: number;
  isAnalyzing: boolean;
  hasMore: boolean;
  canContinue: boolean;
  remainingQuota: number;
  lastSkippedCount: number;
  error: string | null;
  onContinue: () => void;
  onReset: () => void;
  currentPage: number;
  totalPages: number;
  onNextPage: () => void;
  /** Backend-provided high-level negative keyword groups */
  negativeGroups?: import("../../../shared/types").NegativeGroup[];
  /** Token usage from accumulated batches */
  tokenUsage?: { total_tokens: number };
  /** All batches completed (no more pages, no errors) */
  allDone: boolean;
  /** Current batch number (1-indexed) */
  batchNumber?: number;
  /** Total batches */
  totalBatches?: number;
  /** Current phase */
  phase?: string;
}

export function SearchTermResults({
  results,
  currentIndex,
  totalToProcess,
  isAnalyzing,
  hasMore,
  canContinue,
  remainingQuota,
  lastSkippedCount,
  error,
  onContinue,
  onReset,
  currentPage,
  totalPages,
  onNextPage,
  negativeGroups,
  tokenUsage,
  allDone,
  batchNumber,
  totalBatches,
  phase,
}: SearchTermResultsProps) {
  const keepResults = results.filter((r) => r.suggestion === "保留");
  const excludeResults = results.filter((r) => r.suggestion === "排除");
  const progressPct = totalToProcess === 0 ? 0 : Math.round((currentIndex / totalToProcess) * 100);

  // Use backend-provided groups if available, otherwise fall back to frontend construction
  const insightGroups = negativeGroups ?? buildInsightGroups(results);

  // Selection state
  const [selectedKeep, setSelectedKeep] = useState<Set<string>>(new Set());
  const [selectedExclude, setSelectedExclude] = useState<Set<string>>(new Set());
  const [negativeMatchMode, setNegativeMatchMode] = useState<"broad" | "phrase" | "exact">("broad");

  // Copy state
  const [copiedKeep, setCopiedKeep] = useState(false);
  const [copiedExclude, setCopiedExclude] = useState(false);
  const [copiedRoots, setCopiedRoots] = useState<Record<string, boolean>>({});

  const copyKeep = useCallback(() => {
    const list = keepResults
      .filter((r) => selectedKeep.size === 0 || selectedKeep.has(r.term))
      .map((r) => r.term);
    copyToClipboard(list.join("\n")).then(() => {
      setCopiedKeep(true);
      setTimeout(() => setCopiedKeep(false), 2000);
    });
  }, [keepResults, selectedKeep]);

  const copyExclude = useCallback(() => {
    const list = excludeResults
      .filter((r) => selectedExclude.size === 0 || selectedExclude.has(r.term))
      .map((r) => formatNegativeKeyword(r.term, negativeMatchMode));
    copyToClipboard(list.join("\n")).then(() => {
      setCopiedExclude(true);
      setTimeout(() => setCopiedExclude(false), 2000);
    });
  }, [excludeResults, selectedExclude, negativeMatchMode]);

  const copyRootGroup = useCallback((categoryKey: string, terms: string[]) => {
    copyToClipboard(terms.join("\n")).then(() => {
      setCopiedRoots((prev) => ({ ...prev, [categoryKey]: true }));
      setTimeout(() => setCopiedRoots((prev) => ({ ...prev, [categoryKey]: false })), 2000);
    });
  }, []);

  return (
    <div className="space-y-6">
      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            分析进度
            {totalPages > 1 && (
              <span className="ml-2 text-primary font-medium">
                第 {currentPage + 1} / {totalPages} 页
              </span>
            )}
          </span>
          <span>
            {currentIndex} / {totalToProcess} 词
            {lastSkippedCount > 0 && (
              <span className="ml-2 text-primary">
                （跳过 {lastSkippedCount} 个历史词）
              </span>
            )}
          </span>
        </div>
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-primary rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="text-apple-green">建议保留 {keepResults.length}</span>
          <span className="text-apple-red">建议排除 {excludeResults.length}</span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading state for first batch */}
      {isAnalyzing && results.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm">正在进行三维漏斗诊断...</p>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-6">
          {/* ── Keep Section ── */}
          {keepResults.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-apple-green" />
                  <h3 className="text-sm font-semibold text-foreground">建议保留</h3>
                  <Badge variant="secondary" className="text-apple-green bg-apple-green/10">
                    {keepResults.length}
                  </Badge>
                  {selectedKeep.size > 0 && (
                    <span className="text-xs text-apple-green bg-apple-green/10 px-2 py-0.5 rounded-full">
                      已选 {selectedKeep.size}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (selectedKeep.size === keepResults.length) {
                        setSelectedKeep(new Set());
                      } else {
                        setSelectedKeep(new Set(keepResults.map((r) => r.term)));
                      }
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {selectedKeep.size === keepResults.length ? "取消全选" : "全选"}
                  </button>
                  {selectedKeep.size > 0 && selectedKeep.size < keepResults.length && (
                    <button
                      onClick={() => setSelectedKeep(new Set())}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      取消选择
                    </button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyKeep}
                    className="h-8 text-xs gap-1.5 rounded-lg bg-transparent"
                  >
                    {copiedKeep ? (
                      <><Check className="w-3 h-3" />已复制</>
                    ) : (
                      <><Copy className="w-3 h-3" />{selectedKeep.size > 0 ? `复制所选 (${selectedKeep.size})` : "复制所有"}</>
                    )}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                {keepResults.map((r, i) => (
                  <SearchTermCard
                    key={`keep-${r.term}-${i}`}
                    result={r}
                    isSelected={selectedKeep.has(r.term)}
                    onToggleSelect={(term) => {
                      setSelectedKeep((prev) => {
                        const next = new Set(prev);
                        if (next.has(term)) next.delete(term); else next.add(term);
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Exclude Section ── */}
          {excludeResults.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-apple-red" />
                  <h3 className="text-sm font-semibold text-foreground">建议排除</h3>
                  <Badge variant="secondary" className="text-apple-red bg-apple-red/10">
                    {excludeResults.length}
                  </Badge>
                  {selectedExclude.size > 0 && (
                    <span className="text-xs text-apple-red bg-apple-red/10 px-2 py-0.5 rounded-full">
                      已选 {selectedExclude.size}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (selectedExclude.size === excludeResults.length) {
                        setSelectedExclude(new Set());
                      } else {
                        setSelectedExclude(new Set(excludeResults.map((r) => r.term)));
                      }
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {selectedExclude.size === excludeResults.length ? "取消全选" : "全选"}
                  </button>
                  {selectedExclude.size > 0 && selectedExclude.size < excludeResults.length && (
                    <button
                      onClick={() => setSelectedExclude(new Set())}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      取消选择
                    </button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyExclude}
                    className="h-8 text-xs gap-1.5 rounded-lg bg-transparent"
                  >
                    {copiedExclude ? (
                      <><Check className="w-3 h-3" />已复制</>
                    ) : (
                      <><Copy className="w-3 h-3" />{selectedExclude.size > 0 ? `复制所选 (${selectedExclude.size})` : "复制否词"}</>
                    )}
                  </Button>
                </div>
              </div>

              {/* Negative Match Mode Selector */}
              <div className="flex items-center gap-2 p-3 rounded-xl bg-secondary/40 border border-border/30">
                <span className="text-xs text-muted-foreground shrink-0">否词模式：</span>
                <div className="flex gap-1.5 flex-1">
                  {([
                    { value: "broad", label: "广泛匹配", preview: "abc" },
                    { value: "phrase", label: "词组匹配", preview: '"abc"' },
                    { value: "exact", label: "完全匹配", preview: "[abc]" },
                  ] as const).map((mode) => (
                    <button
                      key={mode.value}
                      onClick={() => setNegativeMatchMode(mode.value)}
                      className={`flex-1 flex flex-col items-center py-1.5 px-2 rounded-lg text-xs transition-all ${
                        negativeMatchMode === mode.value
                          ? "bg-apple-red/10 text-apple-red border border-apple-red/30 font-medium"
                          : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground border border-transparent"
                      }`}
                    >
                      <span className="font-medium">{mode.label}</span>
                      <span className={`mt-0.5 font-mono text-[10px] ${
                        negativeMatchMode === mode.value ? "opacity-80" : "opacity-50"
                      }`}>{mode.preview}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                {excludeResults.map((r, i) => (
                  <SearchTermCard
                    key={`exclude-${r.term}-${i}`}
                    result={r}
                    negativeMatchMode={negativeMatchMode}
                    isSelected={selectedExclude.has(r.term)}
                    onToggleSelect={(term) => {
                      setSelectedExclude((prev) => {
                        const next = new Set(prev);
                        if (next.has(term)) next.delete(term); else next.add(term);
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Smart Negative Insight Groups ── */}
          {insightGroups.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[oklch(0.72_0.18_55)] to-[oklch(0.62_0.2_40)] flex items-center justify-center">
                  <Lightbulb className="w-3.5 h-3.5 text-white" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">智能否词提取</h3>
                <span className="text-xs text-muted-foreground bg-secondary/80 px-2 py-0.5 rounded-full">
                  {insightGroups.length} 个分类
                </span>
              </div>
              <p className="text-xs text-muted-foreground ml-8">
                以下分类建议加入否词列表，可按类批量复制并导入广告账户
              </p>
              <div className="space-y-3">
                {insightGroups.map(({ category, description, terms }) => (
                  <div
                    key={category}
                    className="rounded-xl border border-[oklch(0.72_0.18_55)]/20 bg-[oklch(0.72_0.18_55)]/[0.03] p-4"
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <ShieldAlert className="w-3.5 h-3.5 text-[oklch(0.62_0.2_40)] shrink-0" />
                          <span className="text-sm font-semibold text-foreground">{category}</span>
                          <span className="text-xs text-muted-foreground bg-secondary/80 px-2 py-0.5 rounded-full">{terms.length} 词</span>
                        </div>
                        <p className="text-xs text-muted-foreground ml-5.5">
                          {description}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyRootGroup(category, terms)}
                        className="h-7 text-xs gap-1 rounded-lg bg-transparent shrink-0 border-[oklch(0.72_0.18_55)]/30 text-[oklch(0.55_0.18_45)] hover:bg-[oklch(0.72_0.18_55)]/10"
                      >
                        {copiedRoots[category] ? (
                          <><Check className="w-3 h-3" />已复制</>
                        ) : (
                          <><Copy className="w-3 h-3" />复制否词</>
                        )}
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 ml-5.5">
                      {terms.map((term, tIdx) => (
                        <span
                          key={`${term}-${tIdx}`}
                          className="inline-flex items-center px-2.5 py-1 rounded-lg bg-[oklch(0.72_0.18_55)]/10 border border-[oklch(0.72_0.18_55)]/20 text-xs font-mono text-[oklch(0.5_0.18_45)]"
                        >
                          {term}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Continue / loading / done */}
      <div className="flex items-center justify-between pt-2 border-t border-border/30">
        <Button variant="ghost" size="sm" onClick={onReset} disabled={isAnalyzing}>
          重新上传
        </Button>

        {isAnalyzing ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            {phase === "extracting"
              ? "正在提取智能否词根..."
              : `正在三维漏斗诊断 · 第 ${batchNumber ?? "?"} / ${totalBatches ?? "?"} 批`}
          </div>
        ) : allDone ? (
          <div className="flex items-center gap-2 text-sm text-apple-green">
            <SkipForward className="w-4 h-4" />
            全部 {totalPages} 页已分析完成
          </div>
        ) : !hasMore ? (
          <Button size="sm" onClick={onNextPage} className="gap-2">
            <ArrowRight className="w-4 h-4" />
            分析下一页
          </Button>
        ) : (
          <Button size="sm" onClick={onContinue} disabled={!canContinue} className="gap-2">
            <ArrowRight className="w-4 h-4" />
            继续分析（{Math.min(100, totalToProcess - currentIndex)} 词）
          </Button>
        )}
      </div>

      {/* All-done summary card */}
      {allDone && (
        <div className="mt-4 p-4 rounded-xl bg-apple-green/5 border border-apple-green/20 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-apple-green">
            <CheckCircle2 className="w-4 h-4" />
            分析完成 · 汇总
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-background/50 rounded-lg py-2">
              <div className="text-lg font-bold text-foreground">{results.length}</div>
              <div className="text-[10px] text-muted-foreground">总词数</div>
            </div>
            <div className="bg-background/50 rounded-lg py-2">
              <div className="text-lg font-bold text-apple-green">{keepResults.length}</div>
              <div className="text-[10px] text-muted-foreground">建议保留</div>
            </div>
            <div className="bg-background/50 rounded-lg py-2">
              <div className="text-lg font-bold text-apple-red">{excludeResults.length}</div>
              <div className="text-[10px] text-muted-foreground">建议排除</div>
            </div>
          </div>
          {tokenUsage?.total_tokens ? (
            <div className="text-xs text-muted-foreground text-center">
              累计消耗 {tokenUsage.total_tokens.toLocaleString()} tokens
            </div>
          ) : null}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-apple-red p-3 rounded-lg bg-apple-red/5 border border-apple-red/20">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
