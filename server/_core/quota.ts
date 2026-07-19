import { User, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { eq } from "drizzle-orm";

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

/**
 * Lazy-reset quota: if user's last_reset_date != today, reset daily_keyword_count to 0
 * and update last_reset_date to today. Returns the updated user object.
 */
export async function lazyResetQuota(user: User): Promise<User> {
  const today = getTodayDateString();

  // If last_reset_date is already today, no reset needed
  if (user.last_reset_date === today) {
    return user;
  }

  // Reset: clear count and update date
  const db = await getDb();
  if (!db) {
    // DB unavailable, return user as-is (quota check will still apply)
    return user;
  }

  try {
    await db
      .update(users)
      .set({
        daily_keyword_count: 0,
        last_reset_date: today,
      })
      .where(eq(users.id, user.id));

    // Return updated user
    return {
      ...user,
      daily_keyword_count: 0,
      last_reset_date: today,
    };
  } catch (error) {
    console.error("[Quota] Lazy-reset failed:", error);
    // On error, return user as-is; quota check will still apply
    return user;
  }
}

/**
 * Check if user has enough quota for the given keyword count.
 * Admin users have unlimited quota.
 * Returns { allowed: boolean, remainingQuota: number, message?: string }
 */
export function checkQuotaAllowance(
  user: User,
  keywordCount: number
): { allowed: boolean; remainingQuota: number; message?: string } {
  // Admin has unlimited quota
  if (user.role === "admin") {
    return { allowed: true, remainingQuota: -1 }; // -1 means unlimited
  }

  const currentCount = user.daily_keyword_count || 0;
  const limit = user.daily_keyword_limit || 1000;
  const remainingQuota = limit - currentCount;

  if (currentCount + keywordCount > limit) {
    return {
      allowed: false,
      remainingQuota,
      message: `已达单日否词分析上限。今日剩余额度：${remainingQuota}，本次需要：${keywordCount}`,
    };
  }

  return { allowed: true, remainingQuota };
}

/**
 * Increment user's daily_keyword_count by the given amount.
 * Returns the new count.
 */
export async function incrementDailyKeywordCount(
  userId: number,
  increment: number
): Promise<number> {
  const db = await getDb();
  if (!db) {
    console.error("[Quota] DB unavailable for incrementing count");
    return -1;
  }

  try {
    // Fetch current count
    const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const userRow = result.length > 0 ? result[0] : null;

    if (!userRow) {
      console.error(`[Quota] User ${userId} not found`);
      return -1;
    }

    const newCount = (userRow.daily_keyword_count || 0) + increment;

    // Update
    await db
      .update(users)
      .set({ daily_keyword_count: newCount })
      .where(eq(users.id, userId));

    return newCount;
  } catch (error) {
    console.error("[Quota] Failed to increment count:", error);
    return -1;
  }
}
