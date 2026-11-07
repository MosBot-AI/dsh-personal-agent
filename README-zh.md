# dshpa — DSH Personal Agent

[English](README.md)

dshpa 是基于 DeepSeek Harness 的个人智能体项目，目标是常驻用户自己的电脑，通过原生、可替换的插件协调持续工作，并交付可检查的成果。

**已实现原生 Bundle、工作与安全基础、受限 Worker、可验证交付、本地 Web 收件箱、受控恢复、事件路由、计算与通知控制及持久调度（PA-001 至 PA-010、PA-013 和 PA-018）。**

[宿主兼容性记录](docs/evidence/host-compatibility-zh.md)说明已验证的原生控制能力，以及后续任务需要处理的边界。
[工作领域证据](docs/evidence/PA-003-zh.md)覆盖记录校验、命令准入和任务状态转换。
[存储证据](docs/evidence/PA-004-zh.md)覆盖原子提交、锁、迁移和故障恢复。
[授权证据](docs/evidence/PA-005-zh.md)覆盖可信身份、精确动作审批、一次性派发和私有 Worker 工具隔离。
[Worker 证据](docs/evidence/PA-006-zh.md)覆盖原生启动与恢复、报告准入、前台控制和资源清理。
[产物与交付证据](docs/evidence/PA-007-zh.md)覆盖不可变内容、可信验收和供应商回执处理。
[本地 Web 收件箱证据](docs/evidence/PA-008-zh.md)覆盖原生会话集成、任务控制、审批和结果验收。
[恢复证据](docs/evidence/PA-009-zh.md)覆盖输入回执、取消代次和备份恢复。
[路由证据](docs/evidence/PA-010-zh.md)覆盖来源准入、订阅、Worker 退回及控制响应。
[预算与通知证据](docs/evidence/PA-013-zh.md)覆盖模型领取、资源上限、通知策略及限定范围的用量。
[调度证据](docs/evidence/PA-018-zh.md)覆盖例行任务意图、原生唤醒对账，以及去重后的提醒和任务唤醒。

[实施 Project](https://github.com/orgs/MosBot-AI/projects/3) · [Agent 协作流程](docs/11-github-project-workflow-zh.md)

## 规划能力

- 持续对话、持久任务、目标、提醒及可更正的记忆。
- 本机电脑操作、VNC 实时查看和用户接管。
- 可替换的图片/视频生成与创作工作流。
- 安全的密码/密钥输入及限定用途的凭据使用。
- 可选的远程/移动端访问、连接设备和语音。

请阅读[文档索引](docs/README-zh.md)、[系统架构](docs/01-product-and-architecture-zh.md)和[插件规范](docs/09-plugin-architecture-zh.md)。实施 agent 从[执行指南](docs/06-agent-execution-guide-zh.md)和 [43 项任务清单](docs/implementation-tasks.json)开始。

## 构建工作区

在仓库根目录使用 Node.js 24.9.0 或更高版本、pnpm 11.28.5 和 Python 3。工作区将 DeepSeek Harness 固定为 `0.2.2-rc.1`。

```sh
pnpm install --frozen-lockfile
pnpm check
```

## 启动原生 Profile

构建 Bundle 后，在仓库根目录，用 `sdk` 模板在全新的 `DSH_HOME` 中初始化 `dshpa`，再安装本地 Bundle。初始化命令会替换同名 Profile，因此在这个检出目录中只执行一次。

```sh
export DSH_HOME="$PWD/.dshpa/harness"
export DSH_PERMISSION_MODE=workspace-write
pnpm exec dsh --profile dshpa --from-default-profile sdk --dump-config
pnpm exec dsh plugin --profile dshpa add "link:$PWD/packages/personal-agent"
pnpm exec dsh --profile dshpa
```

`sdk` Profile 通过标准输入和输出提供 JSON-RPC 服务。连接 JSON-RPC 客户端后即可通过这两个流发送请求。前台运行时按 Ctrl+C 停止实例。

## 打开本地 Web 收件箱

构建工作区，并对命名 Web Profile 执行一次初始化。使用 DSH Web 已有的所有者登录流程，并将 Profile 绑定在回环地址。

```sh
export DSH_HOME="$PWD/.dshpa/harness"
export DSH_PERMISSION_MODE=workspace-write
pnpm build
pnpm exec dsh --profile dshpa-web --from-default-profile web --dump-config
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/personal-agent"
```

将以下覆盖配置保存为 `.dshpa/inbox.patch.yml`。把 Worker 的两个路由值替换成 DSH 中已配置的供应商与模型。省略 `worker` 块可在不启动模型工作的情况下打开收件箱。

```yaml
- id: dshpa
  config:
    inbox:
      storageDirectory: !!js dshHomePath('dshpa-inbox')
      workRoot: !!js dshHomePath('dshpa-work')
      worker:
        provider: YOUR_CONFIGURED_PROVIDER
        model: YOUR_CONFIGURED_MODEL
```

```sh
pnpm exec dsh --profile dshpa-web --patch "$PWD/.dshpa/inbox.patch.yml" --host 127.0.0.1
```

打开或新建一条原生对话，然后选择 DSH 侧栏中的 **待办**。创建项目并将任务关联到该对话。明确启动任务，在 Worker 释放后查看候选产物，并在收件箱接受结果。可通过对话链接回到原生记录和输入框。

### 路由可信适配器的事件

本地 Web 宿主为进程内适配器提供 `dshpaRouting` 服务。所有者可以在 `inbox.sourceAccounts` 中声明已经验证的账户，填写 `sourceInstanceId`、`accountId` 和 UTC 时间 `verifiedAt`。适配器须独立于消息内容验证账户，再绑定来源令牌，并提交原始发生时间、稳定的外部事件 ID 和修订。所有者通过已认证收件箱的 `set_subscription` 操作管理带版本的 `work` 或 `context` 订阅。工作事件按来源、账户、线程、项目和任务精确送达。`routed` 回执包含当前的原生输入日志状态。上下文订阅只记录关联，不向 Worker 投递输入或唤醒 Worker。

语义评估为可选能力。可添加 `inbox.routing` 配置块，填写 `provider`、`model` 和允许的 `dataScope` 标签。评估器按有限批次返回供所有者审阅的提议。评估与订阅触发的 Worker 输入均需要已知价格和限额，或明确声明为不计费的路由。通过事件唤醒 Worker 还需要针对当前授权和等待条件的可信策略。供应商账户登记由连接器任务处理。

### 设置计算与通知限额

在同一个 `inbox` 块中，`budget` 将确切的供应商和模型 ID 与价格版本、单次调用上限及其他限额绑定。下列数值仅用于说明配置结构，请使用自身部署的费率。金额使用所配货币单位的百万分之一，以整数填写。

```yaml
budget:
  pricingVersion: owner-quote-1
  routes:
    - provider: YOUR_CONFIGURED_PROVIDER
      model: YOUR_CONFIGURED_MODEL
      currency: USD
      pricing:
        kind: known
        inputMicrosPerMillion: 1000000
        outputMicrosPerMillion: 4000000
        cacheReadMicrosPerMillion: 100000
        cacheWriteMicrosPerMillion: 1000000
        ceilingMicros: 200000
  limits:
    - currency: USD
      ownerDayMicros: 1000000
      taskMicros: 400000
      maxCallsPerDay: 40
      maxCallsPerTask: 8
      maxConcurrent: 2
```

不产生模型费用的路由可在 `worker` 或 `routing` 块中设置 `unmetered: true`。所有者手动启动且未配置价格的 Worker 会按价格未知记录，并受调用次数限制。计算预算按 UTC 日期结算。不确定的预留在重启和跨 UTC 日期后继续保留，直到完成对账。**计算与通知用量**面板展示按配置价格记录的费用、未结算金额上限、价格未知的调用、Token 用量和资源占用。

`inbox.computeLimits` 设置 `maxInputBytes`、`maxOutputTokens`、`maxTurns`、`maxStepsPerTurn` 和 `maxWallTimeMs`。`inbox.gpu` 设置 `concurrency`、`maxQueued` 和 `timeoutMs`。重型 GPU 工作使用独立的进程内队列，默认一个槽位。已安装宿主中的私有 Worker 禁用工具。遇到供应商限流时，Worker 在实际退出后释放，并记录所有者可恢复的时间。

主动通知默认为 `off`。已认证收件箱的 `set_attention_policy` 操作接受 `expectedVersion` 和 `policy`，后者包含 `mode`、`timeZone`、`quietHours` 和 `urgentRules`。默认静默时段为 UTC 22:00–08:00，可使用 IANA 时区指定本地时间。每位所有者每天跨渠道最多预留三个主动通知槽位。显式提醒与必要决策另行处理。日常进展留在任务视图中。可信通知适配器通过 `dshpaAttention` 记录候选，并使用现有 Outbox 交接符合条件的确切交付。

### 调度本地提醒和任务唤醒

在命名本地 Web Profile 的现有 `inbox` 块中设置 `routines: true`。将下列配置加到同一覆盖文件，使原生调度服务在检查到期工作前等待私有 Session 解析器就绪。

```yaml
- id: schedule
  inject: [dshpaScheduleResolverReady]
```

在 **待办** 中打开 **例行任务**，保存草稿后选择 **启用调度**。单次调度使用 UTC 时刻。重复调度使用五字段 Cron 表达式和 IANA 时区。原生日历会跳过春季拨快时缺失的时刻，并在秋季拨慢的重叠时段选择较早的时刻。可选择跳过错过的触发，或只补执行最近一次。编辑会保存新的草稿，需要再次明确启用。

本地提醒直接显示在 **待办** 中，无需 Worker 或模型。任务唤醒先核对已释放的确切等待、当前授权和预算，再将任务排队。要绑定后续任务版本，请编辑草稿并再次启用。**立即运行** 使用独立命令身份，创建与下次定时唤醒相互独立的触发。原生自动化页面显示不透明的唤醒记录，可在 **待办** 管理例行任务并检查业务结果。

## 常驻运行宿主

可使用专用前台 Profile 或选择登录时启动。同一本地收件箱提供健康检查、在线备份和限定范围的审计导出。[常驻运维](docs/operations-zh.md)

## 恢复独立工作备份

使用私有的独立 SQLite 备份和一个尚不存在的绝对目标路径。构建工作区后，在仓库根目录将 `BACKUP_FILE` 和 `RESTORE_DIR` 设为这两个路径，再运行恢复命令。

```sh
node --input-type=module - "$BACKUP_FILE" "$RESTORE_DIR" <<'JS'
import { restoreWorkStoreBackup } from './packages/personal-agent/lib/storage/restore.js'
restoreWorkStoreBackup(process.argv[2], process.argv[3])
JS
```

源备份保持完整。目标以仅对账模式打开，支持限定范围的检查与精确读回。恢复的授权和备份之后的结果待核对期间，新 Worker 输入、动作领取和交付保持禁用。

## 校验计划

需要 Python 3 和 Git，无需应用依赖或模型凭据。

```sh
python3 scripts/check_plan.py
git diff --check
```

仅在任务清单配置的本地路径中存在上游仓库时，使用 `python3 scripts/check_plan.py --check-sources`。这些命令校验计划，不验证产品功能。

## 参与贡献

遵循 [AGENTS.md](AGENTS.md) 中的双语文档、英文协作内容和 Conventional Commits 规范。重要变化记录在[更新日志](CHANGELOG-zh.md)中。

## 许可证

[Apache License 2.0](LICENSE)。
