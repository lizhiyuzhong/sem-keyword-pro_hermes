import { useState, useCallback, useRef } from "react";
import type { SearchTermRow } from "./useCSVParser";
import type { SearchTermAnalysis, SearchTermReport } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueState {
  allRows: SearchTermRow[];
  currentIndex: number;
  /** Accumulated results across ALL batches (not just current page) */
  results: SearchTermAnalysis[];
  totalToProcess: number;
  isAnalyzing: boolean;
  error: string | null;
  dailyKeywordCount: number;
  dailyKeywordLimit: number;
  businessDirection: string;
  businessType: "B2B" | "B2C";
  clientId: number | null;
  model: string;
  lastSkippedCount: number;
  /** Merged negative keyword groups across all batches */
  accumulatedNegativeGroups?: Array<{ category: string; description: string; terms: string[] }>;
  /** Total token usage across all batches */
  totalTokens?: { total_tokens: number };
}

const BATCH_SIZE = 100;

const initialState: QueueState = {
  allRows: [],
  currentIndex: 0,
  results: [],
  totalToProcess: 0,
  isAnalyzing: false,
  error: null,
  dailyKeywordCount: 0,
  dailyKeywordLimit: 1000,
  businessDirection: "",
  businessType: "B2B",
  clientId: null,
  model: "deepseek-v4-flash",
  lastSkippedCount: 0,
};

// ---------------------------------------------------------------------------
// sessionStorage helpers
// ---------------------------------------------------------------------------

function storageKey(clientId: number, pageIndex: number) {
  return `sem_stq_${clientId}_page_${pageIndex}`;
}
function manifestKey(clientId: number) {
  return `sem_stq_${clientId}_manifest`;
}

function savePageResults(clientId: number, pageIndex: number, results: SearchTermAnalysis[]) {
  try {
    sessionStorage.setItem(storageKey(clientId, pageIndex), JSON.stringify(results));
    const raw = sessionStorage.getItem(manifestKey(clientId));
    const pages: number[] = raw ? JSON.parse(raw) : [];
    if (!pages.includes(pageIndex)) {
      pages.push(pageIndex);
      sessionStorage.setItem(manifestKey(clientId), JSON.stringify(pages));
    }
  } catch { /* ignore */ }
}

function loadPageResults(clientId: number, pageIndex: number): SearchTermAnalysis[] | null {
  try {
    const raw = sessionStorage.getItem(storageKey(clientId, pageIndex));
    return raw ? (JSON.parse(raw) as SearchTermAnalysis[]) : null;
  } catch { return null; }
}

function getSavedPages(clientId: number): number[] {
  try {
    const raw = sessionStorage.getItem(manifestKey(clientId));
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch { return []; }
}

/** Merge two negative groups: union terms per category */
function mergeGroups(
  a?: Array<{ category: string; description: string; terms: string[] }>,
  b?: Array<{ category: string; description: string; terms: string[] }>,
): Array<{ category: string; description: string; terms: string[] }> {
  const map = new Map<string, { description: string; terms: Set<string> }>();
  for (const g of [a, b]) {
    if (!g) continue;
    for (const item of g) {
      if (!map.has(item.category)) {
        map.set(item.category, { description: item.description, terms: new Set() });
      }
      for (const t of item.terms) map.get(item.category)!.terms.add(t);
    }
  }
  const ORDER = ["竞对公司词", "无关业务/产品词", "C端个人消费词", "纯信息/学术词", "触发偏移词"];
  return ORDER
    .filter((cat) => map.has(cat))
    .map((cat) => {
      const entry = map.get(cat)!;
      return { category: cat, description: entry.description, terms: Array.from(entry.terms) };
    });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSearchTermQueueReturn {
  queue: QueueState;
  initQueue: (params: {
    rows: SearchTermRow[];
    businessDirection: string;
    businessType: "B2B" | "B2C";
    clientId: number;
    initialQuota: { count: number; limit: number };
    pageIndex: number;
  }) => void;
  /** Start auto-analysis: loops through all pages until done or error/out of quota */
  startAutoAnalysis: (
    mutate: (input: {
      businessDirection: string;
      businessType: "B2B" | "B2C";
      clientId: number;
      model?: string;
      searchTerms: Array<{ term: string; matchedKeyword: string }>;
    }) => Promise<SearchTermReport & { dailyKeywordCount: number; dailyKeywordLimit: number; negativeGroups?: any; tokenUsage?: any }>
  ) => Promise<void>;
  resetQueue: () => void;
  hasMore: boolean;
  remainingQuota: number;
  canContinue: boolean;
  progressPct: number;
  loadSavedPage: (clientId: number, pageIndex: number) => SearchTermAnalysis[] | null;
  getSavedPageList: (clientId: number) => number[];
}

export function useSearchTermQueue(): UseSearchTermQueueReturn {
  const [queue, setQueue] = useState<QueueState>(initialState);
  const queueRef = useRef<QueueState>(initialState);
  const currentPageIndexRef = useRef<number>(0);
  const abortRef = useRef(false);

  const updateQueue = useCallback((updater: (prev: QueueState) => QueueState) => {
    setQueue((prev) => {
      const next = updater(prev);
      queueRef.current = next;
      return next;
    });
  }, []);

  const initQueue = useCallback(
    ({ rows, businessDirection, businessType, clientId, initialQuota, pageIndex }: {
      rows: SearchTermRow[];
      businessDirection: string;
      businessType: "B2B" | "B2C";
      clientId: number;
      initialQuota: { count: number; limit: number };
      pageIndex: number;
    }) => {
      currentPageIndexRef.current = pageIndex;
      abortRef.current = false;
      const activeRows = rows.filter((r) => !r.excluded);
      updateQueue(() => ({
        allRows: activeRows,
        currentIndex: 0,
        results: [],
        totalToProcess: activeRows.length,
        isAnalyzing: false,
        error: null,
        dailyKeywordCount: initialQuota.count,
        dailyKeywordLimit: initialQuota.limit,
        businessDirection,
        businessType,
        clientId,
        model: "deepseek-v4-flash",
        lastSkippedCount: 0,
        accumulatedNegativeGroups: undefined,
        totalTokens: undefined,
      }));
    },
    [updateQueue]
  );

  const startAutoAnalysis = useCallback(
    async (mutate: any) => {
      abortRef.current = false;

      const runBatch = async (): Promise<void> => {
        const current = queueRef.current;
        if (abortRef.current) return;
        if (current.isAnalyzing) return;
        if (current.currentIndex >= current.totalToProcess) return;
        if (current.clientId === null) return;
        if (current.error) return; // stop on error

        const batch = current.allRows.slice(current.currentIndex, current.currentIndex + BATCH_SIZE);

        updateQueue((prev) => ({ ...prev, isAnalyzing: true, error: null }));

        try {
          const result = await mutate({
            businessDirection: current.businessDirection,
            businessType: current.businessType,
            clientId: current.clientId,
            model: current.model,
            searchTerms: batch.map((r: SearchTermRow) => ({ term: r.term, matchedKeyword: r.matchedKeyword })),
          });

          updateQueue((prev) => {
            const newResults = [...prev.results, ...result.results];
            const newIndex = prev.currentIndex + batch.length;
            const isDone = newIndex >= prev.totalToProcess;

            if (isDone && prev.clientId !== null) {
              savePageResults(prev.clientId, currentPageIndexRef.current, newResults);
            }

            // Merge negative groups across batches
            const mergedGroups = mergeGroups(prev.accumulatedNegativeGroups, (result as any).negativeGroups);
            const totalToks = {
              total_tokens: (prev.totalTokens?.total_tokens ?? 0) + ((result as any).tokenUsage?.total_tokens ?? 0),
            };

            return {
              ...prev,
              isAnalyzing: false,
              results: newResults,
              currentIndex: newIndex,
              dailyKeywordCount: result.dailyKeywordCount ?? prev.dailyKeywordCount,
              dailyKeywordLimit: result.dailyKeywordLimit ?? prev.dailyKeywordLimit,
              lastSkippedCount: result.skippedCount ?? 0,
              accumulatedNegativeGroups: mergedGroups,
              totalTokens: totalToks,
              error: null,
            };
          });

          // Auto-continue if more pages, quota ok, no error, not aborted
          const updated = queueRef.current;
          if (!abortRef.current && !updated.error && updated.currentIndex < updated.totalToProcess) {
            const rem = updated.dailyKeywordLimit - updated.dailyKeywordCount;
            const nextSize = Math.min(BATCH_SIZE, updated.totalToProcess - updated.currentIndex);
            if (rem >= nextSize || updated.dailyKeywordLimit === 0) {
              setTimeout(() => runBatch(), 300);
            }
          }
        } catch (err: any) {
          const msg = err?.message || (typeof err?.data?.message === "string" ? err.data.message : null) || "分析请求失败，请重试";
          updateQueue((prev) => ({ ...prev, isAnalyzing: false, error: msg }));
        }
      };

      await runBatch();
    },
    [updateQueue]
  );

  const resetQueue = useCallback(() => {
    abortRef.current = true;
    updateQueue(() => initialState);
  }, [updateQueue]);

  const loadSavedPage = useCallback(
    (clientId: number, pageIndex: number) => loadPageResults(clientId, pageIndex),
    []
  );

  const getSavedPageList = useCallback(
    (clientId: number) => getSavedPages(clientId),
    []
  );

  const hasMore = queue.currentIndex < queue.totalToProcess;
  const remainingQuota = queue.dailyKeywordLimit - queue.dailyKeywordCount;
  const nextBatchSize = Math.min(BATCH_SIZE, queue.totalToProcess - queue.currentIndex);
  const canContinue = queue.dailyKeywordLimit === 0
    ? true
    : remainingQuota >= nextBatchSize;
  const progressPct = queue.totalToProcess === 0
    ? 0
    : Math.round((queue.currentIndex / queue.totalToProcess) * 100);

  return {
    queue,
    initQueue,
    startAutoAnalysis,
    resetQueue,
    hasMore,
    remainingQuota,
    canContinue,
    progressPct,
    loadSavedPage,
    getSavedPageList,
  };
}
