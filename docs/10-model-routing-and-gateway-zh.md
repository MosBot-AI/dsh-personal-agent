# 10. 可配置模型调度与 API 网关

[文档索引](README-zh.md) · [English](10-model-routing-and-gateway.md)

2026-11-07 调研。旧 O1 只有显式模型选择，自动调度尚未纳入必做范围。本次将按任务难度选择模型和 reasoning effort、用户模型池及兜底链列为桌面 alpha 必需能力。本文是设计，未安装网关或调用模型。

## 1. 实现比较与选型

| 实现 | 核实的能力 | 对 dshpa 的用途和限制 |
| --- | --- | --- |
| [LiteLLM Router](https://docs.litellm.ai/docs/routing) / [可靠性设计](https://docs.litellm.ai/docs/router/learn/reliability) | 多部署分流、重试、回退和冷却；可结合用量控制 | 优先作为可选自托管网关适配器；不能代替任务难度、数据权限及全局预算判断 |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | 强/弱模型间路由，阈值需要按实际查询校准 | 作为后续可替换 DifficultyEstimator；公开方案聚焦两模型，不能直接等同于多模型额度调度；部分路由器需要额外 embedding 调用 |
| [Portkey](https://portkey.ai/docs/product/ai-gateway/fallbacks) | 有序兜底、按状态码触发和回退链追踪 | 可选外部网关；开放源码、自托管和托管功能范围须在固定版本时另核验，首版不引入托管依赖 |

结论：**原生可配置调度插件 + 默认 DSH 直连执行 + 可选 LiteLLM 网关适配器**。复用现有网关的协议/可靠性能力，不另造完整反向代理平台；也不把缺少任务语义的网关当作主智能体。以上是本项目选型判断，不是对三者做过性能实测。实施时固定版本、许可证、部署依赖与契约证据，不安装未经核验的 latest。

## 2. 插件职责

新增 `model-routing`、`model-gateway-litellm`，扩展 `plugin-api` 的 `ModelRoutingPolicy`、`DifficultyEstimator`、`ModelGatewayProvider`。默认规则评分器无需另起服务；可选语义评分器也有独立费用上限，失败回到确定性规则，不递归调用自己。

```text
任务/当前阶段/用户覆盖
 → 数据与能力过滤 → 难度评估 → 模型及 effort 选择
 → 核心预算原子预留 → DSH 请求组装 → 直连或网关
 → 用量/健康/结果核对 → 完成、升级、兜底或持久等待
```

主 Router 是工作协调者，model-routing 是模型请求策略插件，两者不是同一组件。核心仍拥有权限、预算、任务状态和效果去重。网关不能扩大授权。

## 3. 用户配置

设置页支持添加任意多个模型部署：显示名、provider/model ID、endpoint、CredentialRef、能力、支持的 effort、上下文限制、输出上限、价格/未知价格、账号/额度桶、请求限流、允许的数据范围。一个模型在两个账号下是两个 deployment；同账号多个模型可能共享额度桶，不能假定额度独立。

配置常用池（快速/均衡/复杂任务）、有序备用池及最终兜底池；配置自动/固定模式、按任务覆盖、effort 偏好、升级条件、最大模型切换次数、每任务/每日费用和 token 上限。支持“模拟路由”：展示候选、被排除原因、预估费用及最终选择，不发送真实上下文。

以下为拟议的 dshpa 策略数据，不是 LiteLLM 原生配置；别名需绑定真实部署并通过能力检查：

```yaml
mode: automatic
pools:
  fast: [quick-a, quick-b]
  balanced: [general-a]
  deep: [reasoner-a, reasoner-b]
rules:
  simple: {pool: fast, effort: low}
  standard: {pool: balanced, effort: medium}
  complex: {pool: deep, effort: high}
fallbacks:
  rate_limit: [same-capability-backup]
  quota_exhausted: [alternate-account-model, local-model]
  unavailable: [same-capability-backup, local-model]
terminalFallbacks: [local-model]
onExhausted: wait
maxSwitchesPerTask: 2
```

`low/medium/high` 是本产品逻辑档位，不是通用供应商枚举。每个部署显式映射到其支持值或 thinking token budget；不支持 reasoning 时，按用户配置省略参数或排除该模型。不得把 max output tokens 当作 reasoning effort。未配置有效候选时不自动增加账户、充值或使用未授权模型。

## 4. 如何判断难度

先按工具调用/结构化输出/视觉/上下文容量、隐私目的地、预算、账号可用性筛掉不合格模型，再评估任务。评分特征包括任务类型、约束数量、依赖深度、材料规模、多模态需求、代码范围、验证难度、失败记录和时延目标；长度不能单独代表难度，动作风险也不等于推理难度。

初始规则：简单提取/格式整理用 fast + low；多来源总结/常规代码修改用 balanced + medium；复杂规划、跨模块修复、冲突证据研究用 deep + high。实际模型与 effort 映射全部由用户设置，不能从营销名称推断能力。状态查询等确定性操作不调用模型。

低置信度选用户指定的保守档，或在关键范围不清时澄清。局部验证失败允许有限提升 effort，再提升模型；失败原因若为缺权限/缺资料则等待，不能浪费更贵模型重试。任务创建、阶段变化和明确失败时重评；固定模式默认不自动升级。更换模型后沿用相同验收条件，不能通过降低质量门槛“完成”。

## 5. 额度耗尽与兜底

| 情况 | 处理 |
| --- | --- |
| RPM/TPM 临时限流 | 按 Retry-After/冷却等待或走允许的备用模型；不当成永久额度耗尽 |
| 余额、订阅额度或 token 配额耗尽 | 禁用相应账号/额度桶至可信重置时间或用户修复；按 quota_exhausted 链选择 |
| dshpa 每任务/每日费用硬上限 | 禁止新增收费调用；只能用预先允许且不违反资源预算的本地/零增量成本候选，否则等待 |
| 上下文窗口不够 | 受控压缩或容量足够的模型；不是余额耗尽 |
| 超时/5xx/网络故障 | 有界重试和熔断，允许的备用候选；保留未知费用预留 |
| 无效 key、权限错误、不支持参数 | 标记该部署需修复；仅独立、已授权且兼容的部署可接替，不原样循环重试 |
| 安全拒绝/权限拒绝 | 保留拒绝原因，不以换模型绕过限制 |
| 全部候选不可用 | `waiting_resource`，记录 nextCheckAt、缺失条件；释放执行槽并通知一次 |

供应商剩余额度可能无法查询。用量记录分为本地实测、供应商报告、估算和未知，保留 timestamp/resetAt/confidence；未知不能显示“剩余无限”。API token 计费与聊天订阅额度不一定相通，不假定可读取或使用第三方订阅。额度恢复由可信信号或有界探测触发；不高频调用模型轮询。

所有兜底再次检查能力、effort、数据去向和预算。用户已配置的规则可以覆盖后续匹配动作，无需每次重问；未允许的新目的地或费用突破不能自动执行。保留一个全局 fallback owner；启用网关内部重试时与 dshpa 共用尝试上限，避免双层重试乘法放大。禁止循环链，跨账号切换不得规避服务限制。

## 6. DSH 接入和持久性

固定宿主的 [LlmCallConfig](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/call-config.ts) 已有 reasoningEffort；[模型解析](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/index.ts) 校验模型支持的档位。宿主在 step 前快照模型选择，原生 retry 保留快照，不能在旧 `agent/request` 钩子中随意换模型。[架构](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md)。

PA-040 先验证安全请求边界的配置方式；缺少保证才补最小宿主扩展点。每次重路由创建新 inference attempt/request series，不直接重新执行整个业务 Task。重建符合新模型工具/图像/上下文约束的请求，不能跨提供商转发不兼容的隐藏 reasoning 或加密状态。网关若隐藏实际部署且无法证明能力一致，禁止自动跨模型回退。

流式结果已部分展示时标为中断并开始独立重试，不拼接不同模型文本；只提交完整、验证过的工具调用，不重复已经执行的工具效果。请求超时不证明供应商未计费，保留费用不确定记录。

持久化 ModelDeployment、QuotaBucket、RoutingPolicyRevision、RoutingDecision、InferenceAttempt。记录候选排除原因、难度/置信度、实际模型/effort、回退原因、用量、价格版本及预算预留引用；审计不保存秘密或私有推理。配置更新只影响新的路由决定，撤销即时阻止新派发。

## 7. 验收和阶段

PA-040 接口/DSH 验证，PA-041 难度与 effort 调度，PA-042 配额与兜底，PA-043 网关/UI/评测。桌面 alpha 必须完成；M1 的可靠闭环仍先用固定模型建立基线。

E22 覆盖简单/复杂/短但困难任务、effort 不支持、用户固定覆盖、质量升级；E23 覆盖共享账号配额、临时限流、全部耗尽、本地兜底、预算竞争、流式中断、重启及工具不重复；E24 覆盖用户配置、模拟、网关失败、可观测性和双层重试上限。

至少 60 个中英任务，对比固定强模型、固定经济模型和自动路由，记录验收成功率、费用、时延、误分流和升级次数。初始放行目标为相对固定强模型成功率下降不超过 5 个百分点且实际成本下降；安全/隐私约束不允许退让。没有达到就保留手动模式，调整评分而不宣称自动路由有收益。真实至少两个已授权模型及一个兜底路径验证，模拟测试不等于配额真实可读。
