# 04. 决策与源码审计

[文档索引](README-zh.md) · [English](04-decisions-and-source-audit.md)

审计日期：2026-11-07 UTC。源码检查不等于运行时验证。本次仅发布文档，未安装 DSH、执行插件或运行应用测试套件。

## 1. 决策登记

| ID | 状态 | 决策 / 约束 |
| --- | --- | --- |
| D1 | 已确认方向 | DSH 本身是核心个人智能体，负责主对话和编排。 |
| D2 | 已确认方向 | 原生插件/套件优先；证明实际缺失契约后，允许小范围核心修改。 |
| D3 | 已确认方向 | 协调项目、任务、信息、个人事务和提醒；支持开放连接器/MCP 系统。 |
| D4 | 设计方向 | 通过持久工作状态和受限上下文/记忆保持持续对话；不能将任务数据库等同于完整个人记忆。 |
| D5 | 设计方向 | 最终远程/移动端和语音访问使用同一个个人智能体；精确产品范围及提供商/界面选择仍待决定。 |
| D7 | 工程建议 | 优先实现单一所有者/配置档案和单宿主可靠性；分布式执行前先完成最小状态/效果/授权契约。 |
| D8 | 发布范围 | 将实施计划加入本仓库 `docs/`；本次发布不声称已实现功能，也不更改现有许可证。 |

本登记将当前方向与旧提案作了协调。之前“外部个人助手控制器通过 SDK 调用 DSH”的架构已被取代。API 网关或语音服务可以是外部基础设施，但不能成为第二个编排所有者。

## 2. Hermes 对比选项：不隐式选定

以下选项仍待选择，并非已接受的实施范围。Hermes 中已实现的状态不代表 DSH 已实现，也不能证明代码可直接移植。

| 选项 | 候选细化能力 | 当前 DSH 规划状态 | 选择问题 |
| --- | --- | --- | --- |
| O1 | 不同执行智能体分别选择提供商/模型/推理方式 | 待定 | 先使用固定模型、显式执行智能体配置，还是自动路由？ |
| O2 | 支持导出/迁移兼容性的可替换记忆后端 | 待定 | 仅保留内部替换接口，还是提供受支持的第三方提供商 SDK？ |
| O3 | 自动持续记忆提取/召回及压缩前保存 | 待定 | 哪些事实可自动保存，采用什么审查、隐私和质量规则？ |
| O4 | 用户通过命令/对话记住、查看、更正和遗忘 | 待定 | 哪些显式操作属于首版？ |
| O5 | 可互换的本地、托管和实时语音提供商 | 待定 | 先做文本、一条语音路径，还是现在就支持提供商互换？ |
| O8 | 按日期查看任务、任务详情、项目统计、任务操作历史 | 待定 | 基础任务 CRUD 之外需要哪些更丰富视图/历史？ |
| O9 | 每日/每周计划和复盘模板 | 待定 | 哪些模板，计划时间表是否应单独显式创建？ |
| O10 | 统一移动端/连接器 API、变更日志及重连协议 | 待定 | 需要哪些初始客户端及回放/兼容性保证？ |

DSH 的原始愿景已包含任务、记忆、语音、连接器和未来移动端访问。待定的是上述详细细化能力。现在可以设计安全内部边界，而不必将所有相关功能都标记为已选定。隐私、授权、正确性和恢复是工程发布要求，不是可选的产品装饰。

## 3. 仓库基线

检查时，`MosBot-AI/dsh-personal-agent` 为公开仓库，默认分支为 `main`，唯一文件为 `LICENSE`。该树中没有现有应用代码、文档、测试配置或 `AGENTS.md`。

- [加入文档前的仓库提交](https://github.com/MosBot-AI/dsh-personal-agent/commit/7b377ca7bc8e97466fb78cac92838b9018a029f6)：`7b377ca7bc8e97466fb78cac92838b9018a029f6`。
- [现有许可证](https://github.com/MosBot-AI/dsh-personal-agent/blob/7b377ca7bc8e97466fb78cac92838b9018a029f6/LICENSE)：Apache License 2.0。本次文档增加保留它。任何其他许可证选择都需要维护者另行明确决定，并审查依赖和声明。

这些文档其他部分提议的 `packages/`、API 端点、工具命令和测试目录均为未来结构，而非仓库已有文件。

## 4. 固定的上游源码基线

| 来源 | 检查的提交 | 清单事实 |
| --- | --- | --- |
| DeepSeek Harness | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | 根版本 `0.2.2-rc.1`；Node `>=24.9.0`；pnpm `11.28.5` |
| DSH Superagent Prototype | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | `0.1.0`；DSH 开发依赖 `0.2.1-alpha.2`、peer 依赖 `^0.2.1-alpha.2`；Node `^22.19.0 || >=24.0.0`；pnpm `11.7.0` |

证据：[Harness package.json](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/package.json)、[原型 package.json](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/package.json)。

原型是研究产物，不是完整个人助手。其 README 区分了公开实现、内部版本和更广泛的设计讨论。应通过源码和测试确定能力，而不是依赖产品对比或新闻报道。[原型 README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md)。

## 5. 原生 DSH 已提供的能力

### 5.1 插件与套件

配置档案声明 `dsh.profile.bundles`；套件声明 `dsh.bundle.patch`。套件补丁组合插件行。配置替换会替换整个配置，不能假设是递归合并。原型本身已经是原生套件，使用 `name`、`inject`、`Config` 和 `apply(ctx, config)`，运行时清理与 Cordis 生命周期绑定。

来源：[基础套件](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/base/README.md)、[原型入口](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/index.ts)、[原型补丁](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/cordis.patch.yml)。

**结论：** 实现原生 personal-agent 配置档案/套件和服务。不要将原型误述为外部 SDK 控制器。

### 5.2 原生智能体控制与流式输出

`ctx.agents.create()` 和 `resume()` 提供带生命周期所有权的智能体句柄。原生 Agent 支持 `followup`、`steer`、`inject`、`cancel` 和 `whenIdle`。`inject` 增加上下文但不唤醒工作。`whenIdle` 表示整个智能体静止，而非某个请求任务完成。

`agent/assistant-stream` 提供有序、进程本地的 start/chunk/end 帧。持久化落定使用 `assistant/message` 或 `assistant/attempt`；临时展示块不是持久回放日志。

来源：[智能体控制方法](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L203-L270)、[流式帧](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L150-L191)、[流式事件](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L391-L399)。

SDK 客户端缺少运行时取消 RPC，是该接口层面的局限，不是进程内智能体运行时的局限。[SDK 限制](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/README.md)。

**结论：** 原生插件集成可使用原生取消/流式能力。仍需构建业务级取消、效果核对和客户端回放语义。工具取消是协作式的；同进程代码不会因为希望它停止，就能被安全地强制终止。

### 5.3 会话与下属任务看板

DSH 会话记录为仅追加。只有组合了持久化能力时，`ctx.sessions.flush(session)` 才是持久性屏障。新外部插件的产品数据库应避免使用已弃用的同步事件 API 和实验性插件记录存储。

Agent Teams 已提供持久化的比较并交换任务看板，具备依赖、归属、修订和根会话持久化，范围限于子智能体树。任务变化不会自动唤醒智能体。这是有用的协作机制，不是已有的、跨无关对话和渠道的长期个人任务系统。

来源：[会话契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/README.md)、[Agent Teams](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/README.md)。

**结论：** 保留权威个人 Task/Attempt 记录，并在其下适配原生会话/团队任务；不要再创造第二个智能体运行时。

### 5.4 工具 guard 与审批边界

已检查的工具管线包括可扩展的执行前策略、单调生效的已注册 guard、派发，以及执行后/最终结果处理。`ctx.tools.guard` 是限定作用域、仅能拒绝的**同步** guard，签名为 `(execution: Readonly<ToolExecution>) => string | undefined`。

它适合检查当前范围/撤销状态，但本身不是异步持久化审批工作流。操作绕过模型工具调用时，连接器侧派发也必须检查授权。工具必须监听/传递 `exec.signal`；仅声明超时仍需相应超时策略包装器来执行。

来源：[guard 实现](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/index.ts#L379-L401)、[工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts)。

原生用户审批为一次性、绑定到尚未结束的轮次，并记录 asked/decided 事件。其请求不包含精确工具参数。它不提供持久化待办工作队列、持久授权/撤销存储，或轮次外的个人审批工作流。没有响应处理器时默认拒绝；`never` 会拒绝需要审批的动作，而不是自动批准。

来源：[审批生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/user-approval/src/index.ts#L227-L259)、[审批限制](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/user-approval/README.md)。

**结论：** 持久化的精确动作 Approval/Grant/Effect 记录是项目新增工作。保留原生强制执行和默认拒绝行为，同时验证个人工作流如何在审批或重启后恢复新的执行。

## 6. 保留的原型模式与替换的假设

| 主题 | 有用模式 | 个人智能体所需变化 |
| --- | --- | --- |
| 工作模型 | 分离 Trigger/Thread/Ticket/Assignment | 跨项目及非编程工作的个人 Project/Task/Attempt |
| 准入 | 确定性关卡和不可变任务授权快照 | 已验证所有者/账户身份，加动作级授权 |
| 路由 | 订阅、仅提供上下文的交付、引用 | 第三方上下文不能授予或恢复权限 |
| 持久性 | SQLite 事务、效果队列、发件箱、恢复 | 每提供商的回执/核对；不对任意 shell 效果声称恰好执行一次 |
| 执行器 | 原生 DSH 会话/智能体集成 | 重新验证当前宿主契约；最小权限和受控凭据 |
| 范围 | GitHub/可选飞书的团队编程流程 | 通用连接器/产物接口和私有数据边界 |
| 暂停/停止 | 暂停和原生智能体取消 | 区分软暂停、硬撤销、取消和外部结果未知 |
| 预算 | 并发/超时/提供商重试健康 | 任务/所有者/提供商用量及货币预算策略 |
| 记忆 | 引用图谱和近期任务/事件状态 | 个人事实、来源、有效性、更正、删除和检索评估 |

具体源码警告：

- `Sessions.ensure` 选择 `danger-full-access`。不要将其作为安全的个人数据默认配置复用。[sessions.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts#L137-L154)。
- 面向编程的预设移除或限制了若干通用能力。应有意识地重建个人智能体能力策略。[cordis.patch.yml](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/cordis.patch.yml)。
- 执行器已在停止/清理时使用原生取消。[executor/dsh.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/dsh.ts#L354-L398)。
- `RetryHealth` 观察提供商预算耗尽重试；它不是货币账本。[retry-health.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/retry-health.ts)。
- `src/core/memory.ts` 实现内存仓储，不是已完成的个人记忆产品。[memory.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/memory.ts)。
- 原生进程本地部署假设不能证明具有安全的分布式租约或操作系统级执行智能体隔离。[部署指南](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md)。

其他实现参考：[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)、[核心端口](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/ports.ts)、[存储](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store.ts)、[发件箱](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/outbox.ts)、[原型测试](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/tests)。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 / 关卡 |
| --- | --- | --- |
| 宿主/原型版本漂移 | 编译失败或生命周期缺陷 | 固定双方版本；M0 原生契约测试套件；不作未经测试的兼容性声明 |
| 将插件误当沙箱 | 私有数据或凭据暴露 | 进程内仅允许可信插件；隔离执行器和代理式凭据 |
| 从记忆/内容推断授权 | 未批准的消息或修改 | 已验证操作者、独立授权、动作关卡、注入测试 |
| 远程副作用后崩溃 | 重复发送/写入 | 意图/回执日志、幂等、重试前查询、不确定状态 |
| 取消竞争条件 | 用户停止后效果继续发生 | 代次/撤销隔离、原生取消、提供商核对 |
| 上下文丢失或虚假记忆 | 错误决策和重复工作 | 权威任务、有来源的检查点、更正/删除测试 |
| 主动服务过载/费用 | 通知疲劳和支出浪费 | 观察模式、免打扰时段、去重、明确预算和实测价值 |
| Hermes 带来的范围膨胀 | 未选功能挤占可靠核心 | 待选项登记；M4 前明确选择功能 |
| 过早构建移动/语音平台 | 多套不一致状态机 | 单一命令/领域核心；可选适配器；最小首个客户端 |
| 许可证/第三方复用错误 | 遗漏分发义务 | 保留现有许可证；复制上游代码前审查声明 |

## 8. 冻结实施范围前需要解决的问题

1. O1–O5 和 O8–O10 中，哪些进入首版、推迟或排除？
2. 用哪个首个部署目标和连接器证明纵向切片？
3. 哪些私有信息可以自动保留，保留多久，采用何种审查/删除行为？
4. 模型/工具支出限制、并发和通知偏好的默认值应是什么？
5. 现有仓库许可证是否是最终预期选择？明确决定之前保留它。

这些问题不阻碍发布本计划，但会阻止将未决选项视为已获授权的实施范围。
