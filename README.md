# SEM Keyword Pro

基于 AI 深度语义分析的 SEM 关键词筛选与否定词管理工具。由 **Hermes + DeepSeek** 驱动，帮助 SEM 优化师精准判断搜索词是否匹配客户业务方向与受众类型。

---

## 功能概览

| 功能 | 说明 |
|---|---|
| **关键词语义分析** | 输入关键词 → LLM 判断 B2B/B2C 属性 + 业务方向匹配度 → 输出保留/排除建议 |
| **搜索字词批量诊断** | 上传 Google Ads CSV 报告 → 三维漏斗自动逐页分析 → 汇总保留/排除/否词分组 |
| **智能否词提取** | 自动按 5 类分组提取词根（竞对公司词 / 无关产品词 / C端个人消费词 / 学术词 / 偏移词） |
| **客户档案管理** | 创建客户 → 绑定业务方向 → 历史词去重 → 配额管控 |
| **Token 用量追踪** | 每次分析展示消耗 token 数，开发模式写日志 |
| **模型切换** | 前端可直接切换 Flash（省 Token）/ Pro（高精度） |

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · Vite 7 · Tailwind CSS 4 · Radix UI · tRPC |
| 后端 | Express · tRPC · Drizzle ORM |
| 数据库 | MySQL / TiDB |
| AI | DeepSeek v4（OpenAI 兼容 API） |
| 认证 | Manus OAuth（生产）/ DEV_MODE（开发） |

---

## 快速开始

### 开发环境

```bash
# 安装依赖
pnpm install

# 配置环境变量（复制 .env.example → .env，填入 DeepSeek API Key + 数据库）
cp .env.example .env

# 开发模式（跳过 OAuth，直接以 admin 登录）
DEV_MODE=true

# 启动
pnpm dev
```

浏览器打开 `http://localhost:3000` 即可使用。

### 生产环境（Manus）

在 Manus 平台配置以下环境变量即可，**无需设置 DEV_MODE**：

```
VITE_APP_ID=<Manus App ID>
OAUTH_SERVER_URL=<Manus OAuth Server>
JWT_SECRET=<密钥>
BUILT_IN_FORGE_API_KEY=<Manus Forge Key>
DATABASE_URL=<MySQL 连接>
```

---

## 使用流程

### 手动关键词分析

1. 输入客户业务方向（如"工业自动化设备制造"）
2. 选择业务类型（B2B / B2C）
3. 选择 AI 模型（Flash / Pro）
4. 输入关键词（逗号或换行分隔，最多 100 个）
5. 点击「开始智能分析」→ 查看保留/排除结果 → 一键复制

### CSV 搜索字词批量诊断

1. 创建客户档案（先有客户才能上传）
2. 点击「导入搜索字词报告」→ 上传 Google Ads CSV
3. 预览清洗后的数据 → 点击「开始分析本页」
4. 系统自动逐页分析 → 完成后显示汇总面板 + 否词分组
5. 一键复制所有否词根

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 开发必填 | DeepSeek API Key |
| `LLM_API_URL` | 否 | API 地址，默认 DeepSeek |
| `LLM_MODEL` | 否 | 默认 `deepseek-v4-flash` |
| `DEV_MODE` | 否 | 设 `true` 跳过 OAuth，注入 mock admin |
| `DATABASE_URL` | 开发必填 | MySQL 连接字符串 |
| `PORT` | 否 | 默认 3000 |

---

## 项目结构

```
├── client/src/          # React 前端
│   ├── pages/           # Home / Admin / Clients
│   ├── components/      # SearchTermResults / Preview / Uploader
│   └── hooks/           # useCSVParser / useSearchTermQueue
├── server/
│   ├── routers/         # keyword / searchTerm / client
│   ├── prompts/         # LLM Prompt 模板
│   └── _core/           # LLM / Auth / Quota / DB
├── shared/types.ts      # 前后端共享类型
├── drizzle/schema.ts    # 数据库 Schema
└── .hermes/             # 项目文档（通过 /docs 路由可浏览）
```

---

## 开发工作流

```
Hermes 写代码 → 预览确认 → git push GitHub → Manus pull 更新
```

- 预览文档：`http://IP:9350/docs/`
- 运行测试：`pnpm test`
- 类型检查：`npx tsc --noEmit`

---

## 致谢

Powered by **Hermes Agent** + **DeepSeek**  
Author: Daniel LI
