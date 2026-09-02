---
"ai-usage-tracker": minor
---

新增智谱（GLM）供应商：以 Coding Plan API Key 单凭据追踪订阅配额。
- **Coding Plan 配额**：展示套餐档位（Lite / Pro / Max）与「5 小时窗口 + 周配额」两条进度条，附重置倒计时；周配额为主指标参与耗尽预测
- **凭据管理**：设置页新增「智谱 GLM」页签，仅一枚 Coding Plan API Key（与 Claude Code 里配置的 ANTHROPIC_AUTH_TOKEN 同一枚），带获取指引与一键连通性诊断；数据通道与智谱官方 glm-plan-usage 插件一致
- **用量统计**：统计页新增「智谱 GLM」页签——时间范围内总 Token / 总请求 / 活跃模型 / 日均 Token 概览，日 × 模型 Token 堆叠趋势与占比环图，模型明细与工具（联网搜索 / 网页阅读 MCP / Zread MCP）调用统计；时间范围与 DeepSeek 统计一致（含自定义，上限 30 天）
- **阈值告警**：Coding Plan 配额已用百分比达到阈值时发送系统通知，默认 80%，与其他供应商告警共用边沿触发与冷却策略
- **容错**：兼容国际站 TOKENS_LIMIT / TIME_LIMIT 窗口词汇；配额类型未识别时明确提示而非误报「未订阅」
- **双语支持**：界面文案与英文翻译同步提供；数据来自智谱控制台私有接口，接口变更时错误信息透出服务端返回码
