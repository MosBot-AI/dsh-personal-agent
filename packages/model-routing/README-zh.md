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

DSH 支持原生推理强度 ID 和已核对的适配器默认值。契约也为支持该能力的传输记录思考预算映射。原生适配器在准备阶段拒绝这类映射，因为 DSH 请求契约提供的是推理强度 ID。难度估计、模型池选择和回退协调由 PA-041 和 PA-042 跟踪。[路由设计](../../docs/10-model-routing-and-gateway-zh.md)
