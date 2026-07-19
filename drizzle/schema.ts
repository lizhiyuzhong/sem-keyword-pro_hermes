import { bigint, index, int, mysqlEnum, mysqlTable, mediumtext, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  /** Daily keyword analysis count (lazy-reset on new day) */
  daily_keyword_count: int("daily_keyword_count").default(0).notNull(),
  /** Daily keyword analysis limit per user (admin has unlimited) */
  daily_keyword_limit: int("daily_keyword_limit").default(1000).notNull(),
  /** Last reset date in YYYY-MM-DD format for lazy-reset logic */
  last_reset_date: varchar("last_reset_date", { length: 10 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Cache table for keyword analysis results.
 * Key is a hash of (businessDirection + businessType + sortedKeywords).
 */
export const analysisCache = mysqlTable("analysis_cache", {
  id: int("id").autoincrement().primaryKey(),
  /** SHA-256 hash of the canonical input for cache lookup */
  cacheKey: varchar("cacheKey", { length: 64 }).notNull().unique(),
  /** Original input snapshot */
  businessDirection: text("businessDirection").notNull(),
  businessType: varchar("businessType", { length: 8 }).notNull(),
  keywords: text("keywords").notNull(), // JSON array string
  /** Full analysis report JSON */
  reportJson: mediumtext("reportJson").notNull(),
  /** Unix timestamp ms when this cache entry was created */
  analyzedAt: bigint("analyzedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AnalysisCache = typeof analysisCache.$inferSelect;
export type InsertAnalysisCache = typeof analysisCache.$inferInsert;

/**
 * Key-value settings table for app configuration (e.g., README content).
 */
export const appSettings = mysqlTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AppSettings = typeof appSettings.$inferSelect;

/**
 * Client profiles — one per advertiser account managed by a SEM user.
 * All operations must filter by userId to enforce account-level isolation.
 */
export const clients = mysqlTable(
  "clients",
  {
    id: int("id").autoincrement().primaryKey(),
    /** FK → users.id */
    userId: int("userId").notNull(),
    /** Display name for the client */
    name: varchar("name", { length: 255 }).notNull(),
    /** Business direction / description */
    businessDirection: text("businessDirection").notNull(),
    /** B2B or B2C */
    businessType: mysqlEnum("businessType", ["B2B", "B2C"]).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [index("idx_clients_userId").on(table.userId)]
);

export type Client = typeof clients.$inferSelect;
export type InsertClient = typeof clients.$inferInsert;

/**
 * Per-keyword analysis history for a client.
 * Used for deduplication: when re-analyzing, only keywords NOT present here
 * are sent to the LLM; existing results are merged in from this table.
 */
export const clientKeywordHistory = mysqlTable(
  "client_keyword_history",
  {
    id: int("id").autoincrement().primaryKey(),
    /** FK → clients.id */
    clientId: int("clientId").notNull(),
    /** The search term string (lowercased for dedup lookup) */
    keyword: varchar("keyword", { length: 500 }).notNull(),
    /** The matched keyword that triggered this search term (lowercased). Null for legacy records. */
    matchedKeyword: varchar("matchedKeyword", { length: 500 }),
    /** Single KeywordAnalysis or SearchTermAnalysis JSON object */
    analysisResultJson: mediumtext("analysisResultJson").notNull(),
    /** Unix timestamp ms when this keyword was analyzed */
    analyzedAt: bigint("analyzedAt", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_ckh_clientId").on(table.clientId),
    uniqueIndex("idx_ckh_unique").on(table.clientId, table.keyword, table.matchedKeyword),
  ]
);

export type ClientKeywordHistory = typeof clientKeywordHistory.$inferSelect;
export type InsertClientKeywordHistory = typeof clientKeywordHistory.$inferInsert;
