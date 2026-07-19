import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTodayDateString, checkQuotaAllowance } from "./quota";
import type { User } from "../../drizzle/schema";

describe("Quota Management", () => {
  describe("getTodayDateString", () => {
    it("should return today's date in YYYY-MM-DD format", () => {
      const result = getTodayDateString();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Verify it's a valid date
      const [year, month, day] = result.split("-").map(Number);
      expect(year).toBeGreaterThan(2000);
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(31);
    });
  });

  describe("checkQuotaAllowance", () => {
    const createMockUser = (overrides?: Partial<User>): User => ({
      id: 1,
      openId: "test-user",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "google",
      role: "user",
      daily_keyword_count: 0,
      daily_keyword_limit: 1000,
      last_reset_date: getTodayDateString(),
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
      ...overrides,
    });

    it("should allow admin users unlimited quota", () => {
      const adminUser = createMockUser({ role: "admin" });
      const result = checkQuotaAllowance(adminUser, 100);

      expect(result.allowed).toBe(true);
      expect(result.remainingQuota).toBe(-1); // -1 means unlimited
    });

    it("should allow regular user within quota", () => {
      const user = createMockUser({
        daily_keyword_count: 500,
        daily_keyword_limit: 1000,
      });
      const result = checkQuotaAllowance(user, 100);

      expect(result.allowed).toBe(true);
      expect(result.remainingQuota).toBe(500);
    });

    it("should reject regular user exceeding quota", () => {
      const user = createMockUser({
        daily_keyword_count: 950,
        daily_keyword_limit: 1000,
      });
      const result = checkQuotaAllowance(user, 100);

      expect(result.allowed).toBe(false);
      expect(result.remainingQuota).toBe(50);
      expect(result.message).toContain("已达单日否词分析上限");
    });

    it("should reject when exactly at quota limit", () => {
      const user = createMockUser({
        daily_keyword_count: 1000,
        daily_keyword_limit: 1000,
      });
      const result = checkQuotaAllowance(user, 1);

      expect(result.allowed).toBe(false);
      expect(result.remainingQuota).toBe(0);
    });

    it("should allow exactly at remaining quota", () => {
      const user = createMockUser({
        daily_keyword_count: 900,
        daily_keyword_limit: 1000,
      });
      const result = checkQuotaAllowance(user, 100);

      expect(result.allowed).toBe(true);
      expect(result.remainingQuota).toBe(100);
    });

    it("should handle zero keyword count", () => {
      const user = createMockUser({
        daily_keyword_count: 0,
        daily_keyword_limit: 1000,
      });
      const result = checkQuotaAllowance(user, 0);

      expect(result.allowed).toBe(true);
      expect(result.remainingQuota).toBe(1000);
    });

    it("should handle custom daily limits", () => {
      const user = createMockUser({
        daily_keyword_count: 400,
        daily_keyword_limit: 500,
      });
      const result = checkQuotaAllowance(user, 100);

      expect(result.allowed).toBe(true);
      expect(result.remainingQuota).toBe(100);
    });
  });
});
