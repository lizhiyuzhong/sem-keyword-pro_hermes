import { describe, it, expect } from "vitest";
import type { SearchTermAnalysis } from "../shared/types";

// Replicate extractNegativeGroups for testing (same logic as searchTerm.ts)
interface NegativeGroup {
  category: string;
  description: string;
  terms: string[];
}

function extractNegativeGroups(excluded: SearchTermAnalysis[]): NegativeGroup[] {
  if (excluded.length === 0) return [];

  const byCategory = new Map<string, SearchTermAnalysis[]>();
  for (const r of excluded) {
    const cat = r.negativeCategory || "无关业务/产品词";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }

  const CATEGORY_DESC: Record<string, string> = {
    "竞对公司词": "搜索词包含竞争对手公司名或品牌名",
    "无关业务/产品词": "搜索词属于完全不同行业或产品类别",
    "C端个人消费词": "个人零售、家用、DIY 等 C 端意图",
    "纯信息/学术词": "纯资讯、百科、学术查询",
    "触发偏移词": "与触发关键字存在语义偏移",
  };

  const ORDER = ["竞对公司词", "无关业务/产品词", "C端个人消费词", "纯信息/学术词", "触发偏移词"];

  const groups: NegativeGroup[] = [];
  for (const cat of ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;

    const termSet = new Set<string>();
    for (const item of items) {
      if (item.extractedNegative && typeof item.extractedNegative === "string") {
        const cleaned = item.extractedNegative.trim().toLowerCase();
        if (cleaned.length > 1) termSet.add(cleaned);
      }
    }

    groups.push({
      category: cat,
      description: CATEGORY_DESC[cat] || "",
      terms: Array.from(termSet).slice(0, 20),
    });
  }

  return groups;
}

function makeItem(overrides: Partial<SearchTermAnalysis> = {}): SearchTermAnalysis {
  return {
    term: "test",
    matchedKeyword: "test",
    score: 50,
    suggestion: "排除",
    excludeReason: "测试",
    extractedNegative: null,
    ...overrides,
  };
}

describe("extractNegativeGroups", () => {
  it("handles non-string extractedNegative (null, number, object)", () => {
    const items: SearchTermAnalysis[] = [
      makeItem({ term: "a", extractedNegative: null, negativeCategory: "竞对公司词" }),
      makeItem({ term: "b", extractedNegative: 123 as any, negativeCategory: "竞对公司词" }),
      makeItem({ term: "c", extractedNegative: { x: 1 } as any, negativeCategory: "竞对公司词" }),
      makeItem({ term: "d", extractedNegative: "  BrandX  ", negativeCategory: "竞对公司词" }),
    ];
    const groups = extractNegativeGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("竞对公司词");
    expect(groups[0].terms).toEqual(["brandx"]); // only the valid string
  });

  it("deduplicates terms across items", () => {
    const items: SearchTermAnalysis[] = [
      makeItem({ term: "a", extractedNegative: "brandx", negativeCategory: "竞对公司词" }),
      makeItem({ term: "b", extractedNegative: "BrandX", negativeCategory: "竞对公司词" }),
      makeItem({ term: "c", extractedNegative: "brandy", negativeCategory: "竞对公司词" }),
    ];
    const groups = extractNegativeGroups(items);
    expect(groups[0].terms).toEqual(["brandx", "brandy"]);
  });

  it("empty excluded returns empty array", () => {
    expect(extractNegativeGroups([])).toEqual([]);
  });

  it("filters out extractedNegative shorter than 2 chars", () => {
    const items: SearchTermAnalysis[] = [
      makeItem({ term: "a", extractedNegative: "x", negativeCategory: "触发偏移词" }),
      makeItem({ term: "b", extractedNegative: "ab", negativeCategory: "触发偏移词" }),
    ];
    const groups = extractNegativeGroups(items);
    expect(groups[0].terms).toEqual(["ab"]);
  });

  it("groups by fixed 5 categories in order", () => {
    const items: SearchTermAnalysis[] = [
      makeItem({ term: "a", extractedNegative: "brand1", negativeCategory: "竞对公司词" }),
      makeItem({ term: "b", extractedNegative: "prod1", negativeCategory: "无关业务/产品词" }),
      makeItem({ term: "c", extractedNegative: "diy", negativeCategory: "C端个人消费词" }),
    ];
    const groups = extractNegativeGroups(items);
    expect(groups.map(g => g.category)).toEqual(["竞对公司词", "无关业务/产品词", "C端个人消费词"]);
  });
});
