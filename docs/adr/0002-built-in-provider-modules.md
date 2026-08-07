# Use built-in TypeScript provider modules

Status: accepted

我们不开放第三方插件运行时。每个 Provider 都作为 TypeScript Provider Module 随应用编译发布，新增服务需要通过开发、测试和版本发布流程进入应用。

## Considered Options

- QuickJS 外部插件：方便第三方扩展，但带来沙箱、签名、兼容性和维护成本。
- Rust 原生 Provider：性能强，但扩展门槛高。
- TypeScript 内置模块：实现简单、可测试，符合当前 OpenCode Go + DeepSeek MVP。

## Consequences

- 后续新增 Provider 需要在 `src/providers/` 添加模块并注册。
- 不提供用户侧动态加载或插件市场。
- Provider 逻辑与 UI 类型可以共享，降低跨语言重复。
