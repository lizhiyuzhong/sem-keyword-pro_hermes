import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  DollarSign,
  Hash,
  X,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { SearchTermRow, CSVParseResult } from "../hooks/useCSVParser";

const PAGE_SIZE = 100;

interface SearchTermPreviewProps {
  parseResult: CSVParseResult;
  /** Called with only the current page's active rows (≤ 100) and the current page index */
  onStartAnalysis: (rows: SearchTermRow[], page: number) => void;
  onCancel: () => void;
  isAnalyzing?: boolean;
  /** Initial page to show (0-indexed), used when returning from results view */
  initialPage?: number;
  /** Client ID for sessionStorage namespacing */
  clientId?: number | null;
  /** Load previously saved results for a given page */
  loadSavedPage?: (clientId: number, pageIndex: number) => import('../../../shared/types').SearchTermAnalysis[] | null;
  /** Get list of page indices that have been saved */
  getSavedPageList?: (clientId: number) => number[];
  /** Called when user wants to view a previously saved page's results */
  onViewSavedPage?: (pageIndex: number, results: import('../../../shared/types').SearchTermAnalysis[]) => void;
}

export function SearchTermPreview({
  parseResult,
  onStartAnalysis,
  onCancel,
  isAnalyzing = false,
  initialPage = 0,
  clientId,
  loadSavedPage,
  getSavedPageList,
  onViewSavedPage,
}: SearchTermPreviewProps) {
  // Compute which pages have saved results
  const savedPages = useMemo(() => {
    if (!clientId || !getSavedPageList) return new Set<number>();
    return new Set(getSavedPageList(clientId));
  }, [clientId, getSavedPageList]);
  // All rows with local excluded state
  const [rows, setRows] = useState<SearchTermRow[]>(parseResult.rows);
  const [sortField, setSortField] = useState<"cost" | "clicks">("cost");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(initialPage); // 0-indexed

  // Sort all rows
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const diff =
        sortDir === "desc"
          ? b[sortField] - a[sortField]
          : a[sortField] - b[sortField];
      return diff;
    });
  }, [rows, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));

  // Clamp page when total changes
  const safePage = Math.min(page, totalPages - 1);

  // Current page slice
  const pageRows = sortedRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Stats across all rows
  const allActiveRows = rows.filter((r) => !r.excluded);
  const excludedCount = rows.filter((r) => r.excluded).length;
  const totalCost = allActiveRows.reduce((s, r) => s + r.cost, 0);

  // Stats for current page
  const pageActiveRows = pageRows.filter((r) => !r.excluded);

  // -------------------------------------------------------------------------
  // Row toggle helpers
  // -------------------------------------------------------------------------
  const toggleRow = (term: string, matchedKeyword: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.term === term && r.matchedKeyword === matchedKeyword
          ? { ...r, excluded: !r.excluded }
          : r
      )
    );
  };

  // Toggle all rows on current page
  const togglePageAll = () => {
    const allPageExcluded = pageActiveRows.length === 0;
    const pageKeys = new Set(pageRows.map((r) => `${r.term}|||${r.matchedKeyword}`));
    setRows((prev) =>
      prev.map((r) => {
        const key = `${r.term}|||${r.matchedKeyword}`;
        if (!pageKeys.has(key)) return r;
        return { ...r, excluded: !allPageExcluded };
      })
    );
  };

  const handleSort = (field: "cost" | "clicks") => {
    if (sortField === field) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const SortIcon = ({ field }: { field: "cost" | "clicks" }) => {
    if (sortField !== field) return null;
    return sortDir === "desc" ? (
      <ChevronDown className="w-3 h-3 inline ml-0.5" />
    ) : (
      <ChevronUp className="w-3 h-3 inline ml-0.5" />
    );
  };

  // -------------------------------------------------------------------------
  // Pagination helpers
  // -------------------------------------------------------------------------
  const goToPrev = () => setPage((p) => Math.max(0, p - 1));
  const goToNext = () => setPage((p) => Math.min(totalPages - 1, p + 1));

  // -------------------------------------------------------------------------
  // Start analysis: only send current page's active rows (≤ PAGE_SIZE)
  // -------------------------------------------------------------------------
  const handleStartAnalysis = () => {
    onStartAnalysis(pageActiveRows, safePage);
  };

  return (
    <div className="space-y-4">
      {/* Insight bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Hash className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">识别词条</p>
            <p className="text-lg font-semibold text-foreground">{rows.length}</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
            <DollarSign className="w-4 h-4 text-amber-500" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">总花费</p>
            <p className="text-lg font-semibold text-foreground">
              {totalCost.toFixed(2)} CNY
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-apple-green/10 flex items-center justify-center shrink-0">
            <ArrowRight className="w-4 h-4 text-apple-green" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">待分析</p>
            <p className="text-lg font-semibold text-foreground">
              {allActiveRows.length}
            </p>
          </div>
        </div>
      </div>

      {/* Filter info */}
      {parseResult.filteredCount > 0 && (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
          已自动过滤 {parseResult.filteredCount} 条汇总行或已处理词条
        </div>
      )}

      {/* Pagination header */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              第 <span className="font-medium text-foreground">{safePage + 1}</span> 页，共{" "}
              <span className="font-medium text-foreground">{totalPages}</span> 页
            </span>
            <Badge variant="secondary" className="text-xs">
              本页 {pageRows.length} 词
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={goToPrev}
              disabled={safePage === 0}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </Button>
            {Array.from({ length: totalPages }, (_, i) => (
              <div key={i} className="relative">
                <button
                  onClick={() => setPage(i)}
                  className={`h-7 w-7 rounded text-xs font-medium transition-colors ${
                    i === safePage
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {i + 1}
                </button>
                {savedPages.has(i) && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-apple-green" title="已分析" />
                )}
              </div>
            ))}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={goToNext}
              disabled={safePage === totalPages - 1}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[auto_1fr_1fr_80px_80px_40px] gap-0 bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground">
          <div className="px-3 py-2.5 flex items-center">
            <Checkbox
              checked={pageActiveRows.length > 0 && pageRows.every((r) => !r.excluded)}
              onCheckedChange={togglePageAll}
              className="w-3.5 h-3.5"
            />
          </div>
          <div className="px-3 py-2.5">搜索字词</div>
          <div className="px-3 py-2.5">触发关键字</div>
          <div
            className="px-3 py-2.5 cursor-pointer hover:text-foreground select-none"
            onClick={() => handleSort("cost")}
          >
            花费 <SortIcon field="cost" />
          </div>
          <div
            className="px-3 py-2.5 cursor-pointer hover:text-foreground select-none"
            onClick={() => handleSort("clicks")}
          >
            点击 <SortIcon field="clicks" />
          </div>
          <div className="px-3 py-2.5" />
        </div>

        {/* Table body */}
        <div className="max-h-[360px] overflow-y-auto divide-y divide-border/50">
          {pageRows.map((row, idx) => (
            <div
              key={`${row.term}-${row.matchedKeyword}-${safePage}-${idx}`}
              className={`grid grid-cols-[auto_1fr_1fr_80px_80px_40px] gap-0 text-xs transition-colors ${
                row.excluded ? "opacity-40 bg-muted/20" : "hover:bg-muted/20"
              }`}
            >
              <div className="px-3 py-2.5 flex items-center">
                <Checkbox
                  checked={!row.excluded}
                  onCheckedChange={() => toggleRow(row.term, row.matchedKeyword)}
                  className="w-3.5 h-3.5"
                />
              </div>
              <div
                className="px-3 py-2.5 font-mono text-foreground truncate"
                title={row.term}
              >
                {row.term}
              </div>
              <div
                className="px-3 py-2.5 text-muted-foreground truncate"
                title={row.matchedKeyword}
              >
                {row.matchedKeyword}
              </div>
              <div className="px-3 py-2.5 text-amber-600 font-medium">
                {row.cost > 0 ? row.cost.toFixed(2) : "—"}
              </div>
              <div className="px-3 py-2.5 text-muted-foreground">
                {row.clicks > 0 ? row.clicks : "—"}
              </div>
              <div className="px-3 py-2.5 flex items-center justify-center">
                {row.excluded && (
                  <button
                    onClick={() => toggleRow(row.term, row.matchedKeyword)}
                    className="text-muted-foreground hover:text-foreground"
                    title="恢复"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Excluded badge */}
      {excludedCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{excludedCount} 条已剔除</Badge>
          <button
            className="underline hover:text-foreground"
            onClick={() => setRows((prev) => prev.map((r) => ({ ...r, excluded: false })))}
          >
            全部恢复
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-between pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isAnalyzing}
        >
          取消
        </Button>
        <div className="flex items-center gap-2">
          {savedPages.has(safePage) && clientId && loadSavedPage && onViewSavedPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const saved = loadSavedPage(clientId, safePage);
                if (saved) onViewSavedPage(safePage, saved);
              }}
              className="gap-2 text-apple-green border-apple-green/30 hover:bg-apple-green/10"
            >
              查看已保存结果
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleStartAnalysis}
            disabled={pageActiveRows.length === 0 || isAnalyzing}
            className="gap-2"
          >
            <ArrowRight className="w-4 h-4" />
            {savedPages.has(safePage) ? `重新分析第 ${safePage + 1} 页` : `开始分析第 ${safePage + 1} 页（${pageActiveRows.length} 词）`}
          </Button>
        </div>
      </div>
    </div>
  );
}
