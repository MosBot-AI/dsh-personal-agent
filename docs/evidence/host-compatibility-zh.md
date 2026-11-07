# PA-002 固定版本 DSH 宿主兼容性

[English](host-compatibility.md)

合约在临时命名 Profile 中运行发布版 `@deepseek-ai/dsh@0.2.2-rc.1` CLI，并注入本地脚本模型适配器。命令和验收范围见 [PA-002 证据](PA-002-zh.md)。

## 代理生命周期与结果结算

- `ctx.dshpa.host.agents.create()` 和 `resume()` 通过 Bundle 的 Cordis 上下文调用原生注册表。调用方取得原生句柄，可以单独释放。卸载 Bundle 会以 `{ kind: 'disposed' }` 中止正在执行的恢复代理，并移除其 Agent 和 Session 注册。
- 空闲时调用 `inject()` 会追加上下文而不启动轮次。`followup()` 启动推理。在工具调用流阻塞期间发出的 `steer()` 和 `inject()` 均进入同一轮次的下一次模型请求。`cancel()` 向活跃流发出信号，轮次随后结算为已中止。`whenIdle()` 表示运行时空闲。业务完成仍需应用层结果及其证据。
- 实时 `agent/assistant-stream` 按开始帧、带序号的分片、结束帧顺序到达。提交成功的结束帧引用最终 `assistant/message` 的序号，其压缩流展开后与观察到的分片一致。取消夹具已输出部分文本时，宿主持久化带中断标记的 `assistant/message` 和已中止的 `turn/end`。使用持久结算事件回放，用进程内帧呈现实时进度。

PA-006 复用原生句柄，PA-007 接收原生结算事件。进程内取消无法证明所有外部工具都会配合取消、副作用可以回滚，或多作业运行时的前台公平性。

## 工具策略与持久化

- 作用域内的 `tools.guard()` 在允许执行的前置钩子之后拒绝了工具。原生流水线持久化带拒绝原因的错误工具结果，工具函数体未被调用。原作用域释放后，恢复的代理可执行该工具。守卫接收不可变的执行视图，同步返回拒绝原因或 `undefined`。持久审批、授权和撤销流程由 PA-005 实现。
- `ctx.dshpa.host.flush(session)` 要求存在原生 Session 服务，并在原生 flush 报告无参与监听器时拒绝。监听器故障原样传播。组合 JSONL 持久化后，测试在释放代理前读回了事件序列，并在新的 DSH 进程中恢复。依赖此屏障前需组合实际持久化后端。监听器参与本身无法证明指定后端已写入数据。
- 会话持久化负责原生对话记录。storage-domain 文档行 API 无法为 Task、Approval、Effect 和 Outbox 提供跨记录事务。该原子边界由 PA-004 在应用 SQLite 中实现。[Storage-domain 合约](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/storage/storage-domain/README.md)

## 调度投递

正常路径在计划提醒进入 inbox 后暂停 Session flush 屏障。测试通过原生 JSONL 后端读回消息，此时计划仍为活跃状态，尚无回执或助手最终消息。释放屏障后，调度保存该消息的回执并结束这条一次性计划。此时立即请求 Run Now 会收到 `schedule_execution_pending`。启动新进程后仍保留一条消息和一份回执。

故障路径在原生后端已能读到 inbox 消息、调度尚未完成 flush 屏障时，以退出码 86 终止 DSH 进程。重启时使用同一命名 Profile 并注册 `schedule/resolve-agent` 解析器，原生超期投递会重放相同计划 ID 和发生时间。日志中因此出现两个不同的消息 ID，唯一保存的回执指向第二条消息。

PA-018 复用原生调度计时及回执查询，并以逻辑发生项标识对应用入口去重，避免重放再次分发副作用。原生投递回执证明消息已进入 inbox。业务完成和任意外部副作用需各自的证据。[原生调度合约](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/schedule/schedule/README.md)

## 远程访问控制

已安装的 `@deepseek-ai/dsh@0.2.2-rc.1` 基础 Bundle 组合了 Typert Gateway 和 Remote Access。Web app Bundle 增加 Connection 传输层以及 Session 和 Workspace 控制器。发布源码 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` 与审计源码 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 的 `packages/api/gateway`、`packages/api/remote-access` 和 `packages/api/workspace-controller` 一致。 [基础 Bundle](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/base/cordis.patch.yml) · [Web app Bundle](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/cordis.patch.yml)

| 接口 | 原生控制与边界 |
| --- | --- |
| Remote 方法分发 | Gateway 使用传输层准入的 Peer。对于非 owner，Gateway 从已校验的线上参数解析资源，再查找接收者并分发方法。同类资源的解析优先级依次为方法或作用域显式读取器、lookup 或 Context 的资源标识、已注册的默认规则。每项解析出的资源都需要允许精确 `namespace/method` 动作的绑定。未解析出资源的调用只检查 `global`。`global` 绑定不授予 Session 或 Workspace 访问权限。缺少授权、资源标识无效或策略执行失败时，Gateway 拒绝分发。owner 绕过策略检查，各 Peer 均可订阅自己的权限快照。 [Gateway 分发](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/gateway/src/index.ts#L793) · [资源解析](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/gateway/src/access.ts#L40) · [策略](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/remote-access/README.zh.md) |
| 集合与事件 | Session 和 Workspace 的列表或订阅方法在控制器实现过滤的位置通过 `allows()` 检查各项是否可见。权限快照和这些逐项检查均无调用参数，所以调用条件仍可能拒绝快照显示可用的操作。对转发通知，Gateway 根据已声明资源上的 `event:<name>` 权限整条投递或丢弃。只有 owner 能回答转发的交互。Connection 的精确 Fetch 路由不经过 Gateway 策略，共用处理器向非 owner 返回 403。 [策略与限制](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/remote-access/README.zh.md) · [Fetch 处理器](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/connection/src/rpc-host.ts#L221) |
| 图片与文件 | `session/attachment` 先对传入的 Session 标识做授权检查，再读取宿主共用的附件存储。读取时不检查 Session 是否存在，也不检查图片是否属于该 Session。授予此方法的权限无法按 Session 隔离图片。`workspaceFiles` 查找时使用 Session 资源，直接读取文件则遵循所组合文件系统的读取权限，可能涵盖工作区以外的路径。目录列表与变更监听限定在工作区内。 [附件处理器](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/src/commands.ts#L365) · [文件控制器](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/workspace-files/src/index.ts) |
| 终端与作业 | 终端方法使用 Session 标识或 Agent lookup。创建终端会启动用户 shell，其执行不受 Agent 的沙箱或审批限制。作业控制器检查调用方 Session 在注册表中的可见范围，其中包括无所有者的作业。任务级授权只有在应用能落实预期执行和数据边界时才可纳入这些能力。 [终端控制器](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/terminal-controller/src/index.ts) · [作业控制器](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/job-controller/src/index.ts) |

安装版的 `session/prompt` 要求非空文本或附件，并根据运行中 inbox 及已接受的用户消息按请求 ID 去重。审计检出还允许符合条件的空内容续跑，并在 inbox 项移除后识别首次插入记录。安装版转发允许列表也缺少审计检出中的 `web/providers-changed`。dshpa 在自身持久状态中管理命令和副作用幂等性。 [提示词准入](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/src/index.ts#L464) · [请求 ID 查询](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/src/commands.ts#L542) · [转发事件](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/remotes/src/remote-events.ts)

两项本地探针以 `env -i PATH="$PATH" node --input-type=module` 运行，通过 `node_modules/.pnpm/node_modules` 解析发布模块，退出码均为 0。第一项在 Cordis 下挂载已安装的 `@deepseek-ai/dsh-typert-registry`、`@deepseek-ai/dsh-api-remote-access` 和 `@deepseek-ai/dsh-api-gateway`。它用来自 `@deepseek-ai/dsh-client-connection` 的 `Peer` 调用一个测试用 Remote 方法，指定两项 Session 资源。owner 可以调用。缺少策略、仅有全局授权、缺少第二项资源授权、资源列表为空以及策略卸载，均在方法执行前拒绝调用。两项 Session 均有授权时，非 owner 可以调用。

第二项探针注册安装版 `@deepseek-ai/dsh-api-remote-access/typert`（`lib/typert.host.js`）的 `TYPERT`。进程内 `remoteAccess/follow` 输出了自定义 `task` 类型的绑定。发布版 `remoteAccess/follow` 结果 codec 经 `descriptor.result.create().safeParse(frame)` 拒绝了该帧。此 codec 枚举 `global`、`session` 和 `workspace`。PA-022 若依赖该快照支持新增的 Task、Artifact 或桌面资源类型，须先验证编译后的客户端链路。探针覆盖进程内分发及直接 codec 校验。浏览器、网络传输层和真实设备认证仍由 PA-022 验证。

在原生 Gateway 和 Remote Access 策略覆盖已声明资源和动作的场景复用两者。可信入口、任务和产物授权、精确动作审批，以及进行中业务工作的撤销，仍由 dshpa 负责。新增资源需声明明确的读取器并验证交付边界。
