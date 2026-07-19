import { useState, useCallback, useRef, useEffect } from "react";
import type { SearchTermRow } from "./useCSVParser";
import type { SearchTermAnalysis, SearchTermReport } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueState {
  /** All rows from the uploaded CSV (user-filtered) */
  allRows: SearchTermRow[];
  /** Index of the first unprocessed row */
  currentIndex: number;
  /** Accumulated analysis results across all batches */
  results: SearchTermAnalysis[];
  /** Total rows to process (after user exclusions) */
  totalToProcess: number;
  /** Whether a batch is currently being analyzed */
  isAnalyzing: boolean;
  /** Error message from last batch, if any */
  error: string | null;
  /** Latest quota info from server */
  dailyKeywordCount: number;
  dailyKeywordLimit: number;
  /** Business context (carried from form) */
  businessDirection: string;
  businessType: "B2B" | "B2C";
  clientId: number | null;
  /** Skipped count from last batch (L2 dedup) */
  lastSkippedCount: number;
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
  lastSkippedCount: 0,
};

// ---------------------------------------------------------------------------
// sessionStorage helpers
// ---------------------------------------------------------------------------

/**
 * Per-client, per-page results are stored under:
 *   sem_stq_{clientId}_page_{pageIndex}  →  SearchTermAnalysis[]
 *
 * A manifest key tracks which pages have been saved:
 *   sem_stq_{clientId}_manifest  →  number[]  (array of saved page indices)
 */

function storageKey(clientId: number, pageIndex: number) {
  return `sem_stq_${clientId}_page_${pageIndex}`;
}

function manifestKey(clientId: number) {
  return `sem_stq_${clientId}_manifest`;
}

function savePageResults(clientId: number, pageIndex: number, results: SearchTermAnalysis[]) {
  try {
    sessionStorage.setItem(storageKey(clientId, pageIndex), JSON.stringify(results));
    // Update manifest
    const raw = sessionStorage.getItem(manifestKey(clientId));
    const pages: number[] = raw ? JSON.parse(raw) : [];
    if (!pages.includes(pageIndex)) {
      pages.push(pageIndex);
      sessionStorage.setItem(manifestKey(clientId), JSON.stringify(pages));
    }
  } catch {
    // Ignore quota errors
  }
}

function loadPageResults(clientId: number, pageIndex: number): SearchTermAnalysis[] | null {
  try {
    const raw = sessionStorage.getItem(storageKey(clientId, pageIndex));
    return raw ? (JSON.parse(raw) as SearchTermAnalysis[]) : null;
  } catch {
    return null;
  }
}

function getSavedPages(clientId: number): number[] {
  try {
    const raw = sessionStorage.getItem(manifestKey(clientId));
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

function clearClientStorage(clientId: number) {
  try {
    const pages = getSavedPages(clientId);
    for (const p of pages) {
      sessionStorage.removeItem(storageKey(clientId, p));
    }
    sessionStorage.removeItem(manifestKey(clientId));
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSearchTermQueueReturn {
  queue: QueueState;
  /** Initialize queue with rows and context */
  initQueue: (params: {
    rows: SearchTermRow[];
    businessDirection: string;
    businessType: "B2B" | "B2C";
    clientId: number;
    initialQuota: { count: number; limit: number };
    /** Current page index being analyzed (0-indexed) */
    pageIndex: number;
  }) => void;
  /** Trigger analysis of the next BATCH_SIZE rows */
  analyzeNextBatch: (
    mutate: (input: {
      businessDirection: string;
      businessType: "B2B" | "B2C";
      clientId: number;
      searchTerms: Array<{ term: string; matchedKeyword: string }>;
    }) => Promise<SearchTermReport & { dailyKeywordCount: number; dailyKeywordLimit: number }>
  ) => Promise<void>;
  /** Reset queue to initial state */
  resetQueue: () => void;
  /** Whether there are more rows to analyze */
  hasMore: boolean;
  /** Remaining quota */
  remainingQuota: number;
  /** Whether quota is sufficient for next batch */
  canContinue: boolean;
  /** Progress percentage 0-100 */
  progressPct: number;
  /** Load previously saved results for a given client + page */
  loadSavedPage: (clientId: number, pageIndex: number) => SearchTermAnalysis[] | null;
  /** Get list of page indices that have been saved for a client */
  getSavedPageList: (clientId: number) => number[];
}

export function useSearchTermQueue(): UseSearchTermQueueReturn {
  const [queue, setQueue] = useState<QueueState>(initialState);
  const queueRef = useRef<QueueState>(initialState);
  // Track which page is currently being analyzed (for sessionStorage writes)
  const currentPageIndexRef = useRef<number>(0);

  // Keep ref in sync for use inside callbacks
  const updateQueue = useCallback((updater: (prev: QueueState) => QueueState) => {
    setQueue((prev) => {
      const next = updater(prev);
      queueRef.current = next;
      return next;
    });
  }, []);

  const initQueue = useCallback(
    ({
      rows,
      businessDirection,
      businessType,
      clientId,
      initialQuota,
      pageIndex,
    }: {
      rows: SearchTermRow[];
      businessDirection: string;
      businessType: "B2B" | "B2C";
      clientId: number;
      initialQuota: { count: number; limit: number };
      pageIndex: number;
    }) => {
      currentPageIndexRef.current = pageIndex;
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
        lastSkippedCount: 0,
      }));
    },
    [updateQueue]
  );

  const analyzeNextBatch = useCallback(
    async (
      mutate: (input: {
        businessDirection: string;
        businessType: "B2B" | "B2C";
        clientId: number;
        searchTerms: Array<{ term: string; matchedKeyword: string }>;
      }) => Promise<SearchTermReport & { dailyKeywordCount: number; dailyKeywordLimit: number }>
    ) => {
      const current = queueRef.current;
      if (current.isAnalyzing) return;
      if (current.currentIndex >= current.totalToProcess) return;
      if (current.clientId === null) return;

      const batch = current.allRows.slice(
        current.currentIndex,
        current.currentIndex + BATCH_SIZE
      );

      updateQueue((prev) => ({ ...prev, isAnalyzing: true, error: null }));

      try {
        const result = await mutate({
          businessDirection: current.businessDirection,
          businessType: current.businessType,
          clientId: current.clientId,
          searchTerms: batch.map((r) => ({
            term: r.term,
            matchedKeyword: r.matchedKeyword,
          })),
        });

        updateQueue((prev) => {
          const newResults = [...prev.results, ...result.results];
          const newIndex = prev.currentIndex + batch.length;
          const isDone = newIndex >= prev.totalToProcess;

          // Persist to sessionStorage when the page batch is fully complete
          if (isDone && prev.clientId !== null) {
            savePageResults(prev.clientId, currentPageIndexRef.current, newResults);
          }

          return {
            ...prev,
            isAnalyzing: false,
            results: newResults,
            currentIndex: newIndex,
            dailyKeywordCount: result.dailyKeywordCount ?? prev.dailyKeywordCount,
            dailyKeywordLimit: result.dailyKeywordLimit ?? prev.dailyKeywordLimit,
            lastSkippedCount: result.skippedCount ?? 0,
            error: null,
          };
        });
      } catch (err: any) {
        const msg =
          err?.message ||
          (typeof err?.data?.message === "string" ? err.data.message : null) ||
          "分析请求失败，请重试";
        updateQueue((prev) => ({
          ...prev,
          isAnalyzing: false,
          error: msg,
        }));
      }
    },
    [updateQueue]
  );

  const resetQueue = useCallback(() => {
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
    ? true // admin: unlimited (limit=0 means unlimited in some configs)
    : remainingQuota >= nextBatchSize;
  const progressPct =
    queue.totalToProcess === 0
      ? 0
      : Math.round((queue.currentIndex / queue.totalToProcess) * 100);

  return {
    queue,
    initQueue,
    analyzeNextBatch,
    resetQueue,
    hasMore,
    remainingQuota,
    canContinue,
    progressPct,
    loadSavedPage,
    getSavedPageList,
  };
}
