# SEM Keyword Pro — Agent Instructions

> Codex 和 Hermes 共享的项目规则和开发环境说明。

## 项目概述

SEM 关键词筛选工具，帮助 SEM 优化师判断搜索词是否匹配客户业务方向。支持手动输入关键词分析 + CSV 批量搜索字词三维漏斗诊断。

## 技术栈

- 前端：React 19 + Vite 7 + Tailwind CSS 4 + Radix UI + tRPC client
- 后端：Express + tRPC server + Drizzle ORM
- 数据库：MySQL / TiDB（生产）或任意 MySQL（开发）
- AI：DeepSeek v4（OpenAI 兼容 API）
- 包管理：pnpm（必须用 pnpm，不要用 npm/yarn）

## 环境变量

开发环境需创建 `.env` 文件（已 gitignore），参考 `.env.example`。关键变量：

```
DEV_MODE=true                  # 跳过 OAuth，注入 mock admin
LLM_API_KEY=**                 # DeepSeek API Key
LLM_MODEL=deepseek-v4-flash    # 默认模型
DATABASE_URL=mysql://...       # MySQL 连接（开发可空，部分功能不可用）
```

## 本地开发

```bash
pnpm install
pnpm dev          # 启动开发服务器，默认端口 3000
```

打开 `http://localhost:3000` 即可看到页面。`DEV_MODE=true` 时直接以 admin 身份登录，跳过 Manus OAuth。

## 测试与检查

```bash
pnpm test         # 运行全部测试（vitest），预期 34/35 passed（1个DB依赖测试会跳过）
npx tsc --noEmit  # TypeScript 类型检查，必须零错误
```

## 关键文件

| 文件 | 说明 |
|------|------|
| `server/routers/searchTerm.ts` | CSV 批量分析核心逻辑（三维漏斗） |
| `server/routers/keyword.ts` | 手动关键词分析 |
| `server/prompts/search-term-analysis.md` | 三维漏斗 Prompt 模板 |
| `server/routers/client.ts` | 客户档案 CRUD |
| `server/_core/llm.ts` | LLM 调用封装（支持模型切换） |
| `server/_core/env.ts` | 环境变量定义 |
| `client/src/pages/Home.tsx` | 主页面（关键词输入 + 模型选择 + CSV 上传） |
| `client/src/components/SearchTermResults.tsx` | CSV 分析结果展示 |
| `client/src/hooks/useSearchTermQueue.ts` | CSV 批量分析状态管理 |
| `shared/types.ts` | 前后端共享类型定义 |
| `drizzle/schema.ts` | 数据库 Schema |

## 架构约束

1. **System Prompt 必须嵌入 JSON 格式**：DeepSeek 不支持 `json_schema` 类型的 `response_format`，只能用 `json_object`。因此必须在 system prompt 中明确写出期望的 JSON 结构。
2. **所有 LLM 调用必须使用中文输出**（prompt 中用中文撰写，system prompt 中也注明）。
3. **前端类型**：修改 shared/types.ts 后，前后端自动同步类型，无需手动复制。
4. **数据库 migration**：用 `pnpm db:push` 生成和执行迁移，不要手动改 SQL。
5. **否词提取**：3D 漏斗分析的 `negativeCategory` 仅作分类标签，最终的智能否词根提取由独立的 `extractSearchTermNegatives` LLM 调用完成。

## 工作流

```
Codex (本地 Mac) → clone → 改代码 → pnpm test → git push
                                          ↓
Hermes (服务器)  → git pull → 审查 diff → 部署到 hermes-dev → 预览
```

Hermes 负责：需求分析 / SOP 制定 / 代码审查 / 测试 / 部署
Codex 负责：按 SOP 执行编码 / 重构 / 新功能实现

## Commit 规范

Type 只能用：`feat:` `fix:` `refactor:` `docs:` `chore:`

Push 前必须征得用户确认。
