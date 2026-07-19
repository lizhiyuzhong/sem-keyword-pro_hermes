# SOP: DEV_MODE Mock 认证 + 完整预览

## 目标
使 Hermes 开发环境能完整预览 SEM Keyword Pro（跳过 Manus OAuth，使用 DeepSeek LLM，连接 TiDB），且对 Manus 端零影响。

## 环境
- Hermes 容器：编写代码 → `/opt/data/projects/sem-keyword-pro`
- hermes-dev 容器：运行 dev server → `/projects/sem-keyword-pro`
- 数据库：TiDB Cloud（已提供连接信息）
- LLM：用户自备 DeepSeek API

## SOP

### 步骤 1：添加 DEV_MODE 环境变量
- 修改 `server/_core/env.ts`，新增 `devMode: process.env.DEV_MODE === "true"`
- 预期：TypeScript 编译通过

### 步骤 2：修改认证中间件，DEV_MODE 下注入 mock admin
- 修改 `server/_core/context.ts`，当 `DEV_MODE=true` 时不调 Manus OAuth，直接注入一个 mock admin User 对象
- 预期：DEV_MODE=true 时 `ctx.user` 始终非 null，角色 admin

### 步骤 3：创建 .env 文件
- 内容：`DEV_MODE=true` + `LLM_API_KEY` + `LLM_MODEL=deepseek-chat` + `LLM_API_URL=https://api.deepseek.com` + `DATABASE_URL`
- 预期：dev server 启动后能连接 TiDB

### 步骤 4：更新 .env.example 记录 DEV_MODE
- 预期：文档齐全

### 步骤 5：代码提交到本地 Git
- 预期：commit 就绪

### 步骤 6：在 hermes-dev 容器内启动 dev server（端口 9350）
- 使用 docker exec -d 在 hermes-dev 内启动
- 命令由用户在宿主机执行
- 预期：hermes-dev 内 9350 监听 0.0.0.0

### 步骤 7：验证
- 浏览器访问 `服务器IP:9350` → 首页直接显示完整表单，无登录弹窗
- 输入业务方向 + 关键词 → 点击分析 → 正常返回结果
- 预期：端到端流程通过

### 步骤 8：用户确认后 push 到 GitHub
- 预期：Manus 端可拉取更新

## 风险
- DEV_MODE 在 Manus 端绝不设置，100% 隔离
- 数据库 TiDB 网络可达性需验证
