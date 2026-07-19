# SEM Keyword Pro — 数据库结构说明

> 数据库引擎：**MySQL / TiDB**
> ORM：**Drizzle ORM**
> 文档生成日期：2026-06-25

---

## 总览

| 表名 | 说明 |
|------|------|
| `users` | 用户账号与鉴权，含单日额度管控字段 |
| `analysis_cache` | 关键词分析结果全局缓存，按输入哈希命中 |
| `app_settings` | 应用级键值配置（如使用指引内容） |
| `clients` | SEM 用户管理的广告主客户档案 |
| `client_keyword_history` | 客户维度的关键词分析历史，用于去重 |

---

## 表详情

### 1. `users`

核心用户表，支撑 Manus OAuth 登录流程，并记录单日关键词分析额度。

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | `INT` | PK, AUTO_INCREMENT | — | 主键 |
| `openId` | `VARCHAR(64)` | NOT NULL, UNIQUE | — | Manus OAuth 唯一标识 |
| `name` | `TEXT` | — | NULL | 用户显示名 |
| `email` | `VARCHAR(320)` | — | NULL | 登录邮箱 |
| `loginMethod` | `VARCHAR(64)` | — | NULL | 登录方式（如 `google`） |
| `role` | `ENUM('user','admin')` | NOT NULL | `'user'` | 角色；`admin` 不受额度限制 |
| `daily_keyword_count` | `INT` | NOT NULL | `0` | 当日已分析关键词累计个数（懒重置） |
| `daily_keyword_limit` | `INT` | NOT NULL | `1000` | 当日最大可分析关键词个数 |
| `last_reset_date` | `VARCHAR(10)` | — | NULL | 上次重置日期，格式 `YYYY-MM-DD`，用于懒重置判断 |
| `createdAt` | `TIMESTAMP` | NOT NULL | `NOW()` | 账号创建时间 |
| `updatedAt` | `TIMESTAMP` | NOT NULL | `NOW()` ON UPDATE | 最后更新时间 |
| `lastSignedIn` | `TIMESTAMP` | NOT NULL | `NOW()` | 最近登录时间 |

**业务说明**

- **懒重置逻辑**：每次调用 `keyword.analyze` 时，后端比较 `last_reset_date` 与当天日期。若不一致，则将 `daily_keyword_count` 清零并更新 `last_reset_date`，无需 Cron 任务。
- **额度校验**：普通用户（`role = 'user'`）在分析前校验 `daily_keyword_count + 本次词数 <= daily_keyword_limit`，超出则拒绝并返回 `TOO_MANY_REQUESTS`。
- **Admin 豁免**：`role = 'admin'` 的用户跳过所有额度校验。

---

### 2. `analysis_cache`

全局关键词分析结果缓存表。缓存键为输入参数（业务方向 + 业务类型 + 排序后的关键词列表）的 SHA-256 哈希值，命中缓存时直接返回，不调用 LLM。

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | `INT` | PK, AUTO_INCREMENT | — | 主键 |
| `cacheKey` | `VARCHAR(64)` | NOT NULL, UNIQUE | — | SHA-256 哈希，用于缓存命中查询 |
| `businessDirection` | `TEXT` | NOT NULL | — | 输入快照：业务方向 |
| `businessType` | `VARCHAR(8)` | NOT NULL | — | 输入快照：业务类型（`B2B` / `B2C`） |
| `keywords` | `TEXT` | NOT NULL | — | 输入快照：关键词列表（JSON 数组字符串） |
| `reportJson` | `MEDIUMTEXT` | NOT NULL | — | 完整分析报告 JSON（`AnalysisReport` 类型） |
| `analyzedAt` | `BIGINT` | NOT NULL | — | 分析完成时间（Unix 毫秒时间戳） |
| `createdAt` | `TIMESTAMP` | NOT NULL | `NOW()` | 缓存记录创建时间 |

---

### 3. `app_settings`

应用级键值配置表，目前用于存储「使用指引」Markdown 内容，支持管理员在线编辑。

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| `key` | `VARCHAR(64)` | PK | — | 配置键（如 `readme`） |
| `value` | `TEXT` | NOT NULL | — | 配置值 |
| `updatedAt` | `TIMESTAMP` | NOT NULL | `NOW()` ON UPDATE | 最后更新时间 |

---

### 4. `clients`

SEM 优化师管理的广告主客户档案表。每条记录对应一个客户，所有查询均强制过滤 `userId` 以实现账号级数据隔离。

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | `INT` | PK, AUTO_INCREMENT | — | 主键 |
| `userId` | `INT` | NOT NULL, INDEX | — | FK → `users.id`，账号隔离键 |
| `name` | `VARCHAR(255)` | NOT NULL | — | 客户显示名称 |
| `businessDirection` | `TEXT` | NOT NULL | — | 客户业务方向描述 |
| `businessType` | `ENUM('B2B','B2C')` | NOT NULL | — | 业务类型 |
| `createdAt` | `TIMESTAMP` | NOT NULL | `NOW()` | 创建时间 |
| `updatedAt` | `TIMESTAMP` | NOT NULL | `NOW()` ON UPDATE | 最后更新时间 |

**索引**

| 索引名 | 列 | 说明 |
|--------|----|------|
| `idx_clients_userId` | `userId` | 加速按用户过滤的查询 |

---

### 5. `client_keyword_history`

客户维度的关键词分析历史记录表。每条记录存储单个关键词的分析结果 JSON。在重新分析时，系统从此表查询已分析过的词，仅对**差集**（新词）调用 LLM，再将历史结果合并，实现去重节省 API 费用。

| 列名 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | `INT` | PK, AUTO_INCREMENT | — | 主键 |
| `clientId` | `INT` | NOT NULL, INDEX | — | FK → `clients.id` |
| `keyword` | `VARCHAR(500)` | NOT NULL | — | 关键词字符串（小写，用于去重比对） |
| `analysisResultJson` | `MEDIUMTEXT` | NOT NULL | — | 单个 `KeywordAnalysis` 对象 JSON |
| `analyzedAt` | `BIGINT` | NOT NULL | — | 分析完成时间（Unix 毫秒时间戳） |

**索引**

| 索引名 | 列 | 说明 |
|--------|----|------|
| `idx_ckh_clientId` | `clientId` | 加速按客户查询历史词 |

---

## 表关系图

```
users (id)
  │
  ├─── clients (userId → users.id)
  │         │
  │         └─── client_keyword_history (clientId → clients.id)
  │
  └─── [analysis_cache]  ← 全局共享，无 userId 外键
       [app_settings]    ← 全局共享，无 userId 外键
```

---

## 关键设计决策

| 决策 | 说明 |
|------|------|
| **懒重置（Lazy Reset）** | 额度重置在请求时按需触发，避免引入 Cron 任务，降低运维复杂度 |
| **全局缓存 vs 客户历史** | `analysis_cache` 缓存完整报告（跨用户共享）；`client_keyword_history` 存储单词结果（客户专属去重） |
| **账号级隔离** | `clients` 和 `client_keyword_history` 的所有查询均强制 `WHERE userId = ctx.user.id`，后端路由层保证，前端无法绕过 |
| **时间戳存储** | 业务时间戳（`analyzedAt`）使用 Unix 毫秒整数存储，避免时区问题；元数据时间（`createdAt`/`updatedAt`）使用 MySQL `TIMESTAMP` |
