# PA-040 原生模型路由边界证据

[English](PA-040.md)

[PA-040](https://github.com/MosBot-AI/dsh-personal-agent/issues/37) · 计划 `2026-11-07-r7` · 实现 `4e456fffc16d2438d883c82929916c4c28fc2a92`。

## 实现

- 公开契约携带带版本的部署和策略固定引用、账户与配额身份、能力和披露范围、已声明价格及显式强度映射。决策和推理尝试携带相同的 Task 隔离标记及独立的请求序列身份。尝试记录保留预算预留与用量引用。
- 原生适配器校验部署、策略、配额和尝试绑定，解析确切的 DSH 模型元数据，并在 Agent 发布前的 setup 中选择路由。已发布的原生循环在组装提示前捕获模型及推理强度。每次准入流均匹配已捕获的路由、实际强度、输出上限和已授权能力。Core 继续负责路由授权和预算占用，包括每次重试。
- 回退在同一业务 Task 下取得全新的原生 Session 和请求序列。新 Session 使用经授权的输入及独立请求头开始。适配器使用 DSH 现有的模型选择和请求序列 API。

## 验证

本地检查于 Asia/Shanghai 时区的 2026-11-08 在 macOS arm64 上运行，使用 Node.js 26.7.0、pnpm 11.28.5 和已发布的 DSH 0.2.2-rc.1。

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run tests/contracts/model-routing-host.spec.ts` | 已发布的 DSH CLI 运行确定性适配器。测试核对了组装前的选择、实时选择改变时重试仍保留原路由和强度、已记录的请求头，以及回退后的新请求序列。 |
| `pnpm check` | 类型检查、工作区构建、255 项非 Web 测试和计划校验通过。 |
| 计划来源、协调和空白检查 | `python3 scripts/check_plan.py --check-sources`、12 项协调测试和 `git diff --check` 通过。 |

原生测试还验证了拒绝通过旧 `agent/request` 钩子事后修改强度、使用经核对的适配器默认值，以及伪造的原生请求、撤权、Core 预算拒绝和额外工具声明均在供应商派发前被阻止。Core 预算钩子使用确定性准入测试。已有 SQLite 预算测试随回归套件运行。

此处的 E22 覆盖固定模式的路由保护、匹配账户和配额绑定、能力筛选及已支持的推理强度。PA-041 负责难度评分与升级策略。PA-042 负责按配额回退和持久推理对账。[宿主适配器](../../packages/model-routing/README-zh.md) · [路由设计](../10-model-routing-and-gateway-zh.md)
