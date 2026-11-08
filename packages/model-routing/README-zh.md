# DSHPA 原生模型路由边界

[English](README.md)

此包为 DSH 0.2.2-rc.1 准备一次已获批准的推理尝试。[路由契约](../plugin-api/src/model-routing.ts)描述部署、账户及配额身份、版本化策略、路由决策和推理尝试。

`prepareDshRouting(ctx, plan, core, signal)` 校验计划并解析确切模型的原生推理强度元数据。成功时返回原生 Session ID、Agent 选项和发布前的 Agent setup。发送已获授权的输入前，将这三项传给 `ctx.agents.create`。协调器负责输入、上下文披露、限定范围的工具和 Agent 生命周期。

```ts
const prepared = await prepareDshRouting(ctx, plan, core, signal)
if (prepared.ok) {
  const handle = await ctx.agents.create({ ...prepared.options, signal })
  // The coordinator owns handle disposal and authorized input.
}
```

`core.isCurrent` 核对任务隔离标记、策略与部署版本，以及实际账户、配额和提供者绑定。`core.dispatch` 负责每次原生请求的预算准入、占用和结算，包括重试。适配器将原生流限定在所固定的提供者、模型、实际推理强度和输出上限，并在底层流开始前重新核对授权。

重新路由使用新的推理尝试和请求序列 ID，同时保留业务 Task 身份。用经授权的证据构建新输入。新 Session 有独立的请求头，不继承先前会话内容或适配器回放状态。协调器在不同尝试之间保留已确认的效果和未结算的预算占用。

DSH 支持原生推理强度 ID 和已核对的适配器默认值。契约也为支持该能力的传输记录思考预算映射。原生适配器在准备阶段拒绝这类映射，因为 DSH 请求契约提供的是推理强度 ID。按配额回退与持久尝试对账由 PA-042 跟踪。[路由设计](../../docs/10-model-routing-and-gateway-zh.md)

## 按任务难度选择路由

从 `@mosbot-ai/dshpa-model-routing/policy` 调用 `decideRouting`，传入已批准的 Task 隔离标记、验收摘要、结构化任务及阶段信号、当前策略版本和精确的部署版本。Core 检查回调在策略对任务评分前核对实时目的地、账户、配额及预算。

自动策略将简单、普通和复杂任务映射到可配置的模型池及强度规则。默认分别使用快池低强度、均衡池中强度和深池高强度。低置信度结果至少采用已配置的保守档位。将 `unsupportedEffort` 设置为 `omit` 后，自动路由可以在所请求的强度映射不可用时使用经核对的适配器默认值。固定路由或显式所有者覆盖使用获批准的确切选择。

语义估计器为可选项。其策略声明独立的输入、输出、费用和耗时上限。Core 在估计器收到结构化信号前占用预算，并对 Task 和阶段键去重。估计结束后策略重新核对实时准入。经验证的质量失败可选择更高的配置档位，同时保留同一个 Task 隔离标记和验收摘要。同一部署内的升级要求供应商声明的强度顺序确实上升。Core 记录并限制切换次数。

将准入后的路由决策传给上面的原生推理准备入口。协调器负责权威策略、验收回执和预算状态。
