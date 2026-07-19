# Project TODO

- [x] 苹果科技感主题样式设计（深色/浅色、字体、配色）
- [x] 数据库 schema 设计（分析历史记录表）——暂缓存机制已覆盖此需求
- [x] 后端 tRPC API：关键词语义分析（LLM 判断 B2B/B2C 属性）
- [x] 后端 tRPC API：Google 搜索集成（检索关键词相关内容）
- [x] 后端 tRPC API：综合分析判断（结合语义+搜索结果，输出建议保留/排除）
- [x] 前端表单界面：客户业务方向输入 + 业务类型选择（默认 B2B）
- [x] 前端表单界面：关键词输入（支持单个/多个批量输入）
- [x] 报告展示页面：关键词分析结果、搜索结果、判断依据、总结
- [x] 报告分类展示：建议保留 vs 建议排除
- [x] 一键复制按钮：分别复制建议保留/排除的关键词
- [x] 动画交互：报告生成后输入窗口缩小上升，报告从底部上升至中央
- [x] 底部署名：2026 SEM Keyword Pro. Powered by Manus + Daniel LI
- [x] 界面语言：中文
- [x] 编写 vitest 测试
- [x] 否词匹配模式选择器（完全匹配/词组匹配/广泛匹配）
- [x] 复制逻辑根据所选模式格式化关键词（完全匹配加[]、词组匹配加""、广泛匹配不处理）
-- [x] 后端：AI 分析结果新增 negativeInsights 字段，提取品牌词/无关产品词等广泛匹配否词分类
- [x] 后端：单次分析关键词上限从 20 提升至 100
- [x] 前端：报告末尾新增“智能否词提取”总结区块，展示分类（品牌词、无关产品词等）
- [x] 前端：每个分类提供一键复制按鈕（广泛匹配格式直接导出）
- [x] Bug: tRPC mutation 返回 HTML 而非 JSON（504 Gateway Timeout），已将每个关键词的两次 LLM 调用合并为一次，并发批次提升至 10 个，大幅减少耗时
- [x] 接入真实搜索（DuckDuckGo HTML 版，无需 API Key，禁止 LLM 模拟）
- [x] 修正“建议保留”逻辑：业务方向 AND 业务类型均匹配才保留，任一不匹配则排除
- [x] 新增分析进度条（实时显示批次进度）
- [x] 新增结果缓存机制（MySQL 数据库缓存，相同查询直接返回历史结果）
- [x] Bug: 分析理由和搜索总结有时以英文呈现，已在 LLM prompt 和 system 消息中强制要求中文输出
- [x] Bug: 搜索结果有时少于 2 条，已新增 Bing 备用搜索引擎， DDG 结果 < 2 条时自动切换
- [x] Bug: Vite HMR WebSocket 断线后页面闪回，已将报告和表单收起状态持久化到 sessionStorage
- [x] Bug: 搜索接口不可用，已关闭在线搜索，改为纯 LLM 语义分析模式
- [x] 后端：移除在线搜索逻辑，改为纯 LLM 语义分析模式
- [x] 创建 README.md 使用指引文档（中文，含功能介绍、使用步骤、否词模式说明等）
- [x] 前端：页面右上角新增“使用指引”按鈕，点击弹出 Dialog 渲染 Readme 内容

## 新增功能：在线编辑使用指引

- [x] 后端：新增 README 编辑 API 接口（需要密码验证：daniel）
- [x] 前端：使用指引弹窗右上角新增“编辑”按鈕
- [x] 前端：点击编辑按鈕弹出密码输入框
- [x] 前端：密码验证通过后显示 Markdown 编辑器（可编辑 README 内容）
- [x] 前端：编辑器底部新增“保存”和“取消”按鈕
- [x] 前端：保存时调用后端 API，成功后关闭Edit器并刷新弹窗内容
- [x] 测试验证：密码验证、编辑保存、实时更新等功能，16 项测试全部通过

## 完成项：README 使用指南

- [x] 生成完整的 README 使用指南（产品概述、快速开始、分析结果说明、使用技巧、常见问题、最佳实践等）
- [x] 添加 README 内容到项目文件中

## 新增功能：用户登录/注册系统 + Admin 权限控制

- [x] 导航栏右上角添加登录/登出按钮（已登录显示用户名+登出，未登录显示登录按钮）
- [x] 接入 Manus OAuth 登录流程（getLoginUrl + trpc.auth.me）
- [x] 创建 /admin 路由页面（Admin 专属管理页面）
- [x] 前端路由守卫：非 Admin 用户访问 /admin 自动重定向到主页
- [x] 后端 adminProcedure：role !== 'admin' 时返回 FORBIDDEN（已内置于 server/_core/trpc.ts）
- [x] 将 lizhiyuzhong930@gmail.com 账号的 role 设为 admin（数据库中已是 admin）

## 新增功能：主页强制登录验证

- [x] 未登录用户打开主页时弹出提示窗口（说明需要登录）
- [x] 用户点击确认后跳转至登录界面
- [x] 登录完成后自动返回主页（OAuth callback 默认返回 /）

## Epic：客户档案管理与分析引擎联动及历史词去重

### 数据库层
- [x] schema.ts 新增 clients 表（id, userId, name, businessDirection, businessType, createdAt, updatedAt）
- [x] schema.ts 新增 client_keyword_history 表（id, clientId, keyword, analysisResultJson, analyzedAt）
- [x] 生成迁移 SQL 并执行

### 后端层
- [x] 新增 server/routers/client.ts（list, create, update, delete, getById，均为 protectedProcedure）
- [x] 所有 client 操作强制 where userId = ctx.user.id（账号级数据隔离）
- [x] 在 server/routers.ts 中注册 clientRouter
- [x] 重构 keyword.analyze 为 protectedProcedure，新增可选参数 clientId 和 saveAsClient
- [x] 业务链 1：saveAsClient 时先创建 client 记录，取得 clientId
- [x] 业务链 2：有 clientId 时查询历史词，取差集，只对新词调用 LLM，合并结果，异步写回历史表

### 前端层
- [x] 新增 client/src/pages/Clients.tsx（我的客户页面，卡片列表 + CRUD）
- [x] App.tsx 注册 /clients 路由
- [x] 导航栏添加「我的客户」入口（仅登录后显示）
- [x] 重构 Home.tsx 场景 A：URL query 携带 clientId 时，自动填充并禁用业务字段，顶部显示客户名横幅
- [x] 重构 Home.tsx 场景 B：点击分析时拦截，弹出「是否保存为客户档案」Modal
- [x] keyword.analyze 前端调用传入 clientId / saveAsClient 参数
- [x] 新增 client.router.test.ts，24 项测试全部通过


## Epic 2: 单日否词使用额度管控与企业专属邮箱校验机制

### 数据库层
- [x] users 表新增 daily_keyword_count（记录单日已提交分析的关键词个数）
- [x] users 表新增 daily_keyword_limit（每日最大否词限制额度，普通用户默认 1000）
- [x] users 表新增 last_reset_date（记录上次重置额度的日期，YYYY-MM-DD 格式）
- [x] 生成迁移 SQL 并执行

### 后端层
- [x] 创建 server/_core/quota.ts 实现懒重置逻辑
  - [x] getTodayDateString() 获取当前日期
  - [x] lazyResetQuota() 实现懒重置（比较日期自动清零）
  - [x] checkQuotaAllowance() 检查配额是否足够（admin 无限制）
  - [x] incrementDailyKeywordCount() 增加用户配额计数
- [x] 修改 keyword.analyze 接口
  - [x] 在入口处添加懒重置和配额校验逻辑
  - [x] 超额时返回 BAD_REQUEST 错误
  - [x] 分析完成后自动增加用户配额计数
  - [x] 返回响应中附加 dailyKeywordCount 和 dailyKeywordLimit
- [x] 修改 auth.me 接口
  - [x] 每次调用时执行懒重置，返回最新用户数据
- [x] 创建 server/_core/quota.test.ts 测试配额逻辑（7 项测试通过）

### 前端层
- [x] 创建 client/src/components/EmailGuard.tsx 企业邮箱校验组件
  - [x] 非 admin 用户邮箱不以 @yeehaiglobal.net 结尾时显示不可关闭的 Modal
  - [x] 用户确认后自动登出并跳转登录页
- [x] 在 App.tsx 中集成 EmailGuard 组件
- [x] 在 Home.tsx 主页表单上方添加配额展示
  - [x] admin 用户显示"今日剩余额度：无限制"
  - [x] 普通用户显示"今日剩余否词额度：X / 1000"
  - [x] 当剩余额度 ≤ 0 时显示"已达上限"标签
- [x] 在 Home.tsx 按钮上实现禁用逻辑
  - [x] 当剩余额度 ≤ 0 时按钮置灰且禁用
  - [x] 按钮 title 属性显示 Tooltip："已到达单日否词分析上限，额度次日清零。"
- [x] 每次分析完成后，前端自动刷新用户配额信息

### 测试
- [x] 32 项测试全部通过（包括 7 项新增配额测试）
- [x] TypeScript 0 错误
- [x] Dev server 正常运行

## 新增功能：关键词勾选与选择性复制

- [x] 建议保留区块新增每行 Checkbox 勾选（绿色主题），勾选后标题行显示"已选 N"徽章
- [x] 建议排除区块新增每行 Checkbox 勾选（红色主题），勾选后标题行显示"已选 N"徽章
- [x] 有勾选时标题行显示"取消选择"文字按钮，一键清空当前区块选择
- [x] 复制按钮动态切换：有勾选时显示"复制所选 (N)"，无勾选时显示"复制所有"（建议保留）/ "复制否词"（建议排除）
- [x] 复制逻辑：有勾选时只复制所选关键词，否则复制全部；否词模式格式化逻辑保持不变
- [x] 新分析完成后自动清空两个区块的选择状态
- [x] TypeScript 0 错误，32 项测试全部通过

## Epic 3: 搜索字词报告直读与三维智能分析机制

- [x] DB: client_keyword_history 新增 matchedKeyword varchar(500) 字段（可空，兼容旧数据）
- [x] DB: 新增联合唯一索引 UNIQUE(clientId, keyword, matchedKeyword)
- [x] 后端: shared/types.ts 新增 SearchTermAnalysis、SearchTermReport 类型
- [x] 后端: 保存三维漏斗 Prompt 到 server/prompts/search-term-analysis.md
- [x] 后端: server/routers/searchTerm.ts 新增 analyzeSearchTerms protectedProcedure
- [x] 后端: L2 去重升级为 (clientId, term, matchedKeyword) 联合键
- [x] 后端: 在 server/routers.ts 注册 searchTermRouter
- [x] 前端: pnpm add papaparse @types/papaparse
- [x] 前端: client/src/hooks/useCSVParser.ts CSV 解析 Hook（PapaParse + 清洗管道）
- [x] 前端: client/src/hooks/useSearchTermQueue.ts 队列状态管理 Hook
- [x] 前端: client/src/components/SearchTermUploader.tsx 上传 Modal（防咑拦截 + 拖拽）
- [x] 前端: client/src/components/SearchTermPreview.tsx 数据清洗预览表格（复选框剖除）
- [x] 前端: client/src/components/SearchTermResults.tsx 三维结果列表（进度条 + 续接按钮）
- [x] 前端: Home.tsx 集成上传入口按钮 + SearchTermUploader + SearchTermResults
- [x] 32 项测试全部通过，TypeScript 0 错误

## Bug 修复 + 功能：CSV 分析截断 + 分页展示

- [x] Bug: SearchTermPreview 点击「开始智能分析前 100 词」时，initQueue 传入全部 rows 而非前 100 词，导致后端实际收到全部词
- [x] 功能: 预览表格改为分页展示（每页 100 词），顶部显示页码和总页数，支持翻页
- [x] 功能: 每页对应一个分析批次，点击「开始分析本页」只分析当前页的 100 词
- [x] 功能: 分析完成后显示「分析第 N 页」按钮，回到预览并自动跳至下一页

## Bug 修复 + 功能：三维分析逻辑 + 未提供理由 + 跨客户缓存 + sessionStorage

- [x] Bug: 搜索字词 Prompt 的 excludeReason 字段有时返回空字符串，导致前端显示“未提供理由”
- [x] Bug: 后端 searchTerm.ts 的 fallback 写死了“未提供理由”，已改为语义清晰的中文备用理由
- [x] Bug: 切换客户时 CSV 分析状态没有重置，导致上一个客户的分析结果污染到新客户
- [x] 功能: useSearchTermQueue 分页结果持久化到 sessionStorage，以 clientId + pageIndex 为 key
- [x] 功能: 已分析页码在分页导航中显示绿色圆点标记
- [x] 功能: 预览页对已保存页显示「查看已保存结果」按钮，点击可直接查看历史结果而无需重新分析

## Bug 修复：缓存命中 excludeReason + 前往分析后旧 report 残留

- [x] Bug: 搜索字词分析命中缓存时，从数据库取出的 analysisResultJson 里 excludeReason 为空，导致前端显示“未提供理由”；已在 merge 阶段加入 sanitizeReason 修复
- [x] Bug: 在客户页面点击“前往分析”后，页面默认显示上一次的分析结果；已在客户切换 useEffect 中同时清除 report 和 keywordInput

## Bug 修复：CSV 模式切回手动分析后结果板块不显示

- [x] Bug: 在 CSV 分析后点击“修改条件”，再手动输入关键词点击“开始智能分析”，建议排除/保留/智能否词提取板块不显示；已在 analyzeMutation onSuccess 中清除 CSV 模式状态

## 功能改造：CSV 搜索字词分析模块三项改造

- [x] 修改1: CSV 分析开始时自动折叠输入表单，缩小「开始智能分析」按钮，以三维漏斗结果为主视图
- [x] 修改2: 三维漏斗诊断结果加入建议排除/保留列表 + 智能否词提取功能（完全对齐手动分析结果页）
- [x] 修改3: 三维漏斗诊断结果拆分为三个独立维度展示，而非仅一个“AI 分析建议理由”

## 功能改造：三维漏斗诊断 Prompt 重写

- [x] 改造点1: 三维真正独立分析，每个维度有各自的 status + reason，而非三维共用同一句话
- [x] 改造点2: 优先级短路逻辑：客户类型 -> 业务方向 -> 触发相关性，前序维度严重不符则直接排除并跳过后续维度
- [x] 改造点3: 智能否词提取改为高维度分组（竞对公司词、无关业务/产品词等），不超过 5 类，不再按词根零碑分组
## Bug 修复：三维漏斗 dim1/dim2/dim3 全部显示相同 fallback 文案

- [x] 根本原因：invokeLLM 调用缺少 response_format，LLM 未受 JSON Schema 约束，dim1/dim2/dim3 字段有时被省略或格式不符
- [x] 修复1：给 invokeLLM 加上完整 JSON Schema（results 数组包裹，每项必须含 dim1/dim2/dim3 对象字段）
- [x] 修复2：解析逻辑从 parsed.results 取数组（兼容裸数组 fallback）
- [x] 修复3：Prompt 输出示例改为 { "results": [...] } 格式，与 JSON Schema 保持一致
- [x] 清除数据库旧缓存，强制下次走新 Prompt 重新生成
