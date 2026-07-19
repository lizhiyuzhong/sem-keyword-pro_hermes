import { useState, useCallback } from "react";
import Papa from "papaparse";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed and cleaned search term row */
export interface SearchTermRow {
  term: string;
  matchedKeyword: string;
  cost: number;
  clicks: number;
  matchType: string;
  adGroup: string;
  /** Whether the user has manually excluded this row in the preview */
  excluded: boolean;
}

export interface CSVParseResult {
  rows: SearchTermRow[];
  totalCost: number;
  rawCount: number;
  /** Rows that were filtered out during cleaning (汇总行、已添加/已排除) */
  filteredCount: number;
}

// ---------------------------------------------------------------------------
// CSV Column names (Google Ads Chinese export, confirmed against actual file)
// ---------------------------------------------------------------------------
const COL_TERM = "搜索字词";
const COL_MATCHED_KEYWORD = "关键字";
const COL_COST = "费用";
const COL_CLICKS = "点击次数";
const COL_MATCH_TYPE = "匹配类型";
const COL_AD_GROUP = "广告组";
const COL_STATUS = "已添加/已排除";

// Rows to skip: summary rows start with "总计："
const isSummaryRow = (term: string) =>
  term.startsWith("总计：") || term.startsWith("总计:");

// Rows to skip: already added or excluded
const isAlreadyProcessed = (status: string) =>
  status === "已添加" || status === "已排除";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseCSVParserReturn {
  parseFile: (file: File) => Promise<CSVParseResult | null>;
  isParsing: boolean;
  error: string | null;
}

export function useCSVParser(): UseCSVParserReturn {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseFile = useCallback(
    async (file: File): Promise<CSVParseResult | null> => {
      setIsParsing(true);
      setError(null);

      return new Promise((resolve) => {
        // Use header:false so we get raw string[][] arrays.
        // This avoids PapaParse's __parsed_extra issue when the first row has
        // fewer columns than subsequent rows (Google Ads exports have 2 metadata
        // rows before the real 38-column header row).
        Papa.parse<string[]>(file, {
          header: false,
          skipEmptyLines: true,
          encoding: "UTF-8",
          complete: (results) => {
            setIsParsing(false);

            try {
              const allRows: string[][] = results.data;

              // -------------------------------------------------------
              // Step 1: Find the real header row
              // It is the first row that contains COL_TERM ("搜索字词")
              // -------------------------------------------------------
              const headerRowIdx = allRows.findIndex((row) =>
                row.includes(COL_TERM)
              );

              if (headerRowIdx < 0) {
                setError(
                  "CSV 格式不正确：未找到「搜索字词」列，请确认上传的是 Google Ads 搜索字词报告。"
                );
                resolve(null);
                return;
              }

              const headers = allRows[headerRowIdx];

              // -------------------------------------------------------
              // Step 2: Build column index map via indexOf
              // -------------------------------------------------------
              const idxTerm = headers.indexOf(COL_TERM);
              const idxMatchedKeyword = headers.indexOf(COL_MATCHED_KEYWORD);
              const idxCost = headers.indexOf(COL_COST);
              const idxClicks = headers.indexOf(COL_CLICKS);
              const idxMatchType = headers.indexOf(COL_MATCH_TYPE);
              const idxAdGroup = headers.indexOf(COL_AD_GROUP);
              const idxStatus = headers.indexOf(COL_STATUS);

              // -------------------------------------------------------
              // Step 3: Process data rows (everything after header row)
              // -------------------------------------------------------
              const dataRows = allRows.slice(headerRowIdx + 1);
              const rawCount = dataRows.length;
              let filteredCount = 0;
              const rows: SearchTermRow[] = [];

              for (const cols of dataRows) {
                const term = idxTerm >= 0 ? (cols[idxTerm] ?? "").trim() : "";
                const status =
                  idxStatus >= 0 ? (cols[idxStatus] ?? "").trim() : "";
                const costStr =
                  idxCost >= 0
                    ? (cols[idxCost] ?? "0").replace(/,/g, "")
                    : "0";
                const clicksStr =
                  idxClicks >= 0
                    ? (cols[idxClicks] ?? "0").replace(/,/g, "")
                    : "0";
                const matchedKeyword =
                  idxMatchedKeyword >= 0
                    ? (cols[idxMatchedKeyword] ?? "")
                        .trim()
                        // Strip surrounding quotes that Google Ads adds for exact match
                        .replace(/^"(.*)"$/, "$1")
                    : "";

                // Skip empty rows
                if (!term) {
                  filteredCount++;
                  continue;
                }

                // Skip summary rows
                if (isSummaryRow(term)) {
                  filteredCount++;
                  continue;
                }

                // Skip already-processed rows
                if (isAlreadyProcessed(status)) {
                  filteredCount++;
                  continue;
                }

                rows.push({
                  term,
                  matchedKeyword: matchedKeyword || term,
                  cost: parseFloat(costStr) || 0,
                  clicks: parseInt(clicksStr, 10) || 0,
                  matchType:
                    idxMatchType >= 0
                      ? (cols[idxMatchType] ?? "").trim()
                      : "",
                  adGroup:
                    idxAdGroup >= 0 ? (cols[idxAdGroup] ?? "").trim() : "",
                  excluded: false,
                });
              }

              // Sort by cost descending (highest cost first)
              rows.sort((a, b) => b.cost - a.cost);

              const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);

              resolve({
                rows,
                totalCost,
                rawCount,
                filteredCount,
              });
            } catch (err) {
              setError(
                `CSV 解析失败：${err instanceof Error ? err.message : String(err)}`
              );
              resolve(null);
            }
          },
          error: (err) => {
            setIsParsing(false);
            setError(`文件读取失败：${err.message}`);
            resolve(null);
          },
        });
      });
    },
    []
  );

  return { parseFile, isParsing, error };
}
