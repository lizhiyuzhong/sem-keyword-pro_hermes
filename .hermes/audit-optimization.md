# SEM Keyword Pro — 全工作流优化审计

> 审计时间：2026-07-19 | 审查范围：全部后端/前端/DB/测试

---

## 高优先级（成本/体验直接改善）

### 1. 批量分析串行改并发 + 流式返回
**现状**：100 个关键词分 10 批，每批 10 个并发，但用户要等全部完成才看到结果。  
**问题**：用户等待时间长，中间无反馈。  
**方案**：tRPC 支持 subscription（WebSocket），可在每批完成时推送增量结果，前端实时渲染。  
**收益**：用户立即看到第一批结果，感知等待时间大幅缩短。

### 2. 减少 LLM 调用次数：合并 summary + negativeInsights 为一个调用
**现状**：N 个关键词产生 N（语义分析）+ 1（总结）+ 1（否词提取）= N+2 次 LLM 调用。  
**问题**：summary 调用本质上就是把结果重新说一遍，负罪感不大但确实浪费 token。  
**方案**：在最后一轮语义分析的 system prompt 中追加"请在最后输出 overallSummary"字段，省掉 1 次独立调用。  
**收益**：每次分析节省约 200-500 tokens。

### 3. 模型名称纠正：`deepseek-chat` → `deepseek-v4-pro`
**现状**：`.env` 配置 `LLM_MODEL=deepseek-chat`，但 DeepSeek API 实际返回的 model 是 `deepseek-v4-flash`。  
**问题**：用户 profile 指定用 `deepseek-v4-pro`，当前实际用了更便宜的 flash 版本，分析质量可能受影响。  
**方案**：改为 `LLM_MODEL=deepseek-v4-pro`。  
**收益**：分析质量提升。

---

## 中优先级（可靠性/可维护性）

### 4. 单个关键词 LLM 失败时自动重试
**现状**：`analyzeKeywordSemantics` 的 catch 块直接返回 fallback 结果，不重试。  
**问题**：偶发性网络错误导致关键词被误判为"排除"。  
**方案**：在 catch 中重试 1 次（与 `invokeLLM` 的 2 次重试互补）。  
**收益**：减少误判，提高可靠性。

### 5. 清理死代码
**现状**：`storage.ts`、`dataApi.ts`、`map.ts` 全部依赖 `BUILT_IN_FORGE_API_URL/KEY`，但项目中没有任何路由引用它们。`test-search.mjs` 是调试脚本。  
**问题**：增加维护负担，且依赖已废弃的 Manus 内部 API。  
**方案**：移除或归档到 `_unused/` 目录。  
**收益**：代码量减少 ~500 行，降低维护成本。

### 6. 缓存键加入 prompt 版本
**现状**：缓存键仅基于输入参数（业务方向+类型+关键词）的 SHA-256。  
**问题**：修改 prompt 后，旧缓存不会自动失效，用户可能看到基于旧 prompt 的分析结果。  
**方案**：在缓存键中加入 prompt 的哈希（或版本号）。  
**收益**：prompt 迭代后缓存自动失效，避免不一致。

### 7. 配额系统：缓存命中的关键词不应计数
**现状**：客户端去重后，`incrementDailyKeywordCount` 仍按全部关键词计数，而非仅计新增部分。  
**问题**：用户重复分析同一批关键词会消耗双倍额度。  
**方案**：配额增量改为 `freshResults.length`（仅实际 LLM 分析的新词数）。  
**收益**：公平计费，鼓励使用缓存。

---

## 低优先级（锦上添花）

### 8. CSV 搜索字词结果也展示 token 用量
**现状**：手动关键词分析已展示，但 CSV 批量分析的 `SearchTermResults` 组件未展示。  
**方案**：`searchTerm.analyzeSearchTerms` 返回已含 `tokenUsage`，前端 `SearchTermResults` 组件读取展示即可。

### 9. DEV_MODE 下的 LLM 调用耗时统计
**现状**：仅记录 token 数，未记录每次调用耗时。  
**方案**：`invokeLLM` 记录 `Date.now()` 差值，追加到 `token-usage.log`。

### 10. 测试覆盖率补充
**现状**：32 项测试，覆盖 auth/client/quota/keyword。  
**缺失**：searchTerm router 无测试、LLM token tracker 无测试、CSV parser 无测试。  
**方案**：按需逐步补充。

---

## 执行建议

| 优先级 | 编号 | 预估改动 | 建议顺序 |
|--------|------|----------|----------|
| 高 | 3 | 1 行 `.env` 改动 | 立即 |
| 高 | 2 | 修改 keyword.ts prompt + 合并调用 | 第二个 |
| 中 | 7 | 修改 keyword.ts 配额增量逻辑 | 第三个 |
| 中 | 4 | 修改 keyword.ts catch 块 | 第四个 |
| 中 | 5 | 删除/归档 4 个文件 | 第五个 |
| 中 | 6 | 修改缓存键生成逻辑 | 第六个 |
| 高 | 1 | 新增 tRPC subscription | 架构变更，延后 |
| 低 | 8-10 | 前端/日志/测试 | 空闲时做 |
