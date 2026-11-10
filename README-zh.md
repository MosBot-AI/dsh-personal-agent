# dshpa — DSH Personal Agent

[English](README.md)

dshpa 是基于 DeepSeek Harness 的个人智能体项目，目标是常驻用户自己的电脑，通过原生、可替换的插件协调持续工作，并交付可检查的成果。

**已实现原生 Bundle、工作与安全基础、受限 Worker、可验证交付、本地 Web 收件箱、受控恢复、事件路由、上下文检查点与召回、个人记忆、目标计划、本地知识、GitHub 只读连接、计算与通知控制、持久调度、主动准备、已评审技能、常驻宿主运维及能力插件契约（PA-001 至 PA-016、PA-018–020、PA-021 和 PA-038）。**

[宿主兼容性记录](docs/evidence/host-compatibility-zh.md)说明已验证的原生控制能力，以及后续任务需要处理的边界。
[工作领域证据](docs/evidence/PA-003-zh.md)覆盖记录校验、命令准入和任务状态转换。
[存储证据](docs/evidence/PA-004-zh.md)覆盖原子提交、锁、迁移和故障恢复。
[授权证据](docs/evidence/PA-005-zh.md)覆盖可信身份、精确动作审批、一次性派发和私有 Worker 工具隔离。
[Worker 证据](docs/evidence/PA-006-zh.md)覆盖原生启动与恢复、报告准入、前台控制和资源清理。
[产物与交付证据](docs/evidence/PA-007-zh.md)覆盖不可变内容、可信验收和供应商回执处理。
[本地 Web 收件箱证据](docs/evidence/PA-008-zh.md)覆盖原生会话集成、任务控制、审批和结果验收。
[恢复证据](docs/evidence/PA-009-zh.md)覆盖输入回执、取消代次和备份恢复。
[路由证据](docs/evidence/PA-010-zh.md)覆盖来源准入、订阅、Worker 退回及控制响应。
[上下文证据](docs/evidence/PA-011-zh.md)覆盖原生检查点保存、引用召回、排除规则及输入预算。
[个人记忆证据](docs/evidence/PA-012-zh.md)覆盖所有者操作、提供者快照及在提供者返回旧数据时仍生效的排除规则。
[目标计划证据](docs/evidence/PA-014-zh.md)覆盖修订、Worker 草稿、任务前置依赖及按需回顾。
[本地知识证据](docs/evidence/PA-015-zh.md)覆盖显式目录、增量索引及来源撤权。
[GitHub 只读连接器证据](docs/evidence/PA-016-zh.md)覆盖真实回读、限定范围的游标及 MCP 能力复核。
[草稿审批证据](docs/evidence/PA-017-zh.md)记录本地验证及真实验收条件。
[预算与通知证据](docs/evidence/PA-013-zh.md)覆盖模型领取、资源上限、通知策略及限定范围的用量。
[主动工作证据](docs/evidence/PA-019-zh.md)覆盖规则回放、分阶段评审、私有简报及本地提示限制。
已评审技能的证据涵盖已验收样例、留出评测、确切版本启用、复用及回滚。[PA-020 证据](docs/evidence/PA-020-zh.md)
[调度证据](docs/evidence/PA-018-zh.md)覆盖例行任务意图、原生唤醒对账，以及去重后的提醒和任务唤醒。
[常驻宿主证据](docs/evidence/PA-021-zh.md)覆盖生命周期、诊断、在线备份和恢复。
桌面和浏览器证据覆盖应用与标签页租约、原生 Chrome 验证及待验收的 macOS 输入。[PA-031 证据](docs/evidence/PA-031-zh.md)
[能力插件证据](docs/evidence/PA-038-zh.md)覆盖带版本注册、限定范围的消费者和独立免密钥示例。

原生路由边界证据覆盖固定请求选择、重试保持选择及经预算准入的推理 Session。[PA-040 证据](docs/evidence/PA-040-zh.md)
难度路由证据覆盖配置模型池、强度映射和有限质量升级。[PA-041 证据](docs/evidence/PA-041-zh.md)
配额与推理证据覆盖原子费用占用、有限回退和中断恢复。[PA-042 证据](docs/evidence/PA-042-zh.md)

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

### 启用移动任务视图

在现有本地 Web profile 的 `config.inbox` 下设置 `mobile`。

```yaml
mobile:
  origin: https://mobile.example.com
  port: 18472
```

在反向代理上使用独立的 HTTPS 源地址，并将其转发到 `http://127.0.0.1:18472`。保留配置的 Host 和浏览器 Origin 请求头，关闭 `/v1/events` 的代理缓冲。DSH 原生所有者监听服务继续绑定回环地址并保持在代理之外。移动上游绑定回环地址，提供自身的页面、配对、任务和审批路由，TLS 由反向代理提供。

在已认证的本机 **待办** 面板中打开 **移动访问**，给设备命名并生成配对码。在手机上打开配置的 HTTPS 源地址，五分钟内输入配对码。配对的浏览器可以查看已关联会话的任务，断线后可以重新获取更新。在本机面板选择 **撤销** 可终止对应设备的访问。配对会生成有效期三十天的安全浏览器凭据，恢复 WorkStore 备份会清除旧移动凭据。移动页面提供应用清单，供支持的浏览器添加到主屏幕。

若要在手机上审批精确动作，请在本机 **待办** 的审批卡片选择已注册设备，并选择 **移交到设备**。审批移交期间只有该设备可以答复。手机显示账户、资源、披露范围、摘要及完整载荷。选择 **撤回审批** 可把未决审批交回原本机客户端。批准会为现有动作门禁记录一次性授权，执行由可信协调器负责。 [验证证据](docs/evidence/PA-022-zh.md)
### 运行经授权的 macOS 桌面任务

在本地 Web Profile 中安装固定版本的 DSH 电脑操作服务和 macOS 提供者。

```sh
pnpm exec dsh plugin --profile dshpa-web add @deepseek-ai/dsh-computer-use@0.2.2-rc.1 @deepseek-ai/dsh-experimental-cua-macos@0.2.2-rc.1
```

在 Profile 覆盖文件中，把以下提供者和现有 DSH 基础服务一同挂载。基础 Profile 提供本地子进程服务。

```yaml
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: desktop-cua
      name: '@deepseek-ai/dsh-experimental-cua-macos'
      config:
        agentPreset: false
```

启用 Worker，并在 `config.inbox` 中添加精确的应用白名单。使用专用 Profile，只批准适合已配置模型和桌面范围的应用。

```yaml
desktop:
  applications: [com.apple.TextEdit]
  leaseMs: 300000
```

在**今日**选择待执行任务和应用，然后点击**授权并开始桌面工作**。宿主在调用模型前检查原生驱动、解锁状态和辅助功能权限。DSH 执行应用授权检查。Worker 可以读取所选应用的辅助功能状态，并基于新观察执行 AX 点击或写入值。读取的状态可进入已配置模型的上下文。

**接管桌面**会立即阻止新的自动化输入。已经发出的操作收尾后，原生 Worker 释放计算槽位。**使用新租约继续桌面工作**会取得新授权，并要求重新观察。每位本地用户的共享保留会在不同 Profile 之间串行化桌面工作流。锁屏、缺少权限或驱动不可用时，任务进入环境等待。桌面部署只允许使用获租约的模型工具。操作系统沙箱需要另行配置能够强制隔离的执行后端。

### Linux 原生就绪检查（不代表支持输入）

在 Linux 上，宿主可识别已挂载的 `cua-driver-native` 提供者，并在桌面租约内以空参数调用固定版本的 `check_permissions`。缺少 X11/AT-SPI 时等待权限；拒绝 Wayland。即使能力检查成功，仍进入 `session_state_unavailable`：SDK 0.28.0 无法证明操作系统会话已解锁。不会开放截图、原生输入、模型调用或前台重试。现有 macOS 和隔离浏览器路径不变。Linux XDG 身份和可信 OS 锁屏探针仍待实现。[合约审计](docs/evidence/PA-031-zh.md#linux-原生就绪检查切片)

### 运行隔离浏览器任务

可选 Chrome Bundle 为任务提供受租约保护的浏览器 Profile 和标签页。今日会在启动前显示已批准的起始 URL。模型可在所分配的来源内观察和操作隔离标签页。[Chrome 提供者配置](packages/browser-chrome/README-zh.md)

### 路由可信适配器的事件

本地 Web 宿主为进程内适配器提供 `dshpaRouting` 服务。所有者可以在 `inbox.sourceAccounts` 中声明已经验证的账户，填写 `sourceInstanceId`、`accountId` 和 UTC 时间 `verifiedAt`。适配器须独立于消息内容验证账户，再绑定来源令牌，并提交原始发生时间、稳定的外部事件 ID 和修订。所有者通过已认证收件箱的 `set_subscription` 操作管理带版本的 `work` 或 `context` 订阅。工作事件按来源、账户、线程、项目和任务精确送达。`routed` 回执包含当前的原生输入日志状态。上下文订阅只记录关联，不向 Worker 投递输入或唤醒 Worker。

语义评估为可选能力。可添加 `inbox.routing` 配置块，填写 `provider`、`model` 和允许的 `dataScope` 标签。评估器按有限批次返回供所有者审阅的提议。评估与订阅触发的 Worker 输入均需要已知价格和限额，或明确声明为不计费的路由。通过事件唤醒 Worker 还需要针对当前授权和等待条件的可信策略。供应商账户登记由连接器任务处理。

### 在压缩时保留任务上下文

在现有 `dshpa` 条目的 `config.inbox` 下加入 `context: {}`。在同一个 Web 配置覆盖文件中加入以下条目。根级包装器用于私有 Worker。`dshpa-context` 预设在主对话自己的压缩组内安装这两个包装器和 `/compact` 命令。自定义该预设时，请一起保留四个隔离服务键。自动压缩默认启用。工具结果裁剪器使用随附的默认设置。

```yaml
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true
- insert:
    - id: dshpa-checkpoint-compaction
      name: '@mosbot-ai/dshpa/checkpoint-compaction'
    - id: dshpa-checkpoint-pruner
      name: '@mosbot-ai/dshpa/checkpoint-pruner'
    - id: preset-dshpa-context
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dshpa-context
        order: 90
        plugins:
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
              dshpaCheckpointCompactionReady: true
              dshpaCheckpointPrunerReady: true
            config:
              - id: dshpa-checkpoint-compaction
                name: '@mosbot-ai/dshpa/checkpoint-compaction'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: dshpa-checkpoint-pruner
                name: '@mosbot-ai/dshpa/checkpoint-pruner'
```

在 DSH Web 使用 `dshpa-context` 预设新建主对话，再通过收件箱关联任务。启用上下文后，收件箱只列出实际使用 dshpa 压缩和裁剪包装器的在线主 Session。

在 DSH 压缩或裁剪已关联的 Session 前，dshpa 将限定范围的任务检查点保存到 SQLite。检查点记录目标、约束、验收条件、规范的等待状态和来源引用。它还会保存有限数量的明确所有者答复作为有来源依据的决策，并保留任务等待状态中的当前问题或继续条件。dshpa 在本地用检查点引用和简短指引生成替换摘要。未关联任务的 Session 使用原生摘要。

对于 Worker 输入，dshpa 使用已配置模型的上下文窗口和 DSH 的 Token 估算器，预留 `inbox.computeLimits.maxOutputTokens`，并原样保留固定指令和当前输入。剩余预算默认按权威任务状态 30%、近期上下文 25%、召回 25% 和检查点 20% 分配。可在 `inbox.context.weights` 的 `authoritative`、`recent`、`retrieval` 和 `checkpoint` 下设置整数百分比，总和须为 100。`inbox.context.maxInputBytes` 默认为 32 KiB，以字节填写 1–64 KiB 范围内的值，并受 Worker 计算输入限额约束。如果必需输入超出预算，请求会失败。

已认证所有者可通过本地 `dshpa/inbox` RPC 使用以下请求负载。

| 请求 `type` | 负载字段 |
| --- | --- |
| `context_checkpoint` | `taskId`，用于读取限定范围内最新的检查点元数据。 |
| `context_recall` | `taskId`、`ref` 和可选的 `cursor`、`maxBytes`，用于读取一页 UTF-8 文本。 |
| `context_search` | `taskId`、`query` 和可选的 `limit`，用于查找匹配的摘要。 |
| `context_exclude` | `taskId`、事件或产物的 `ref`、当前任务的 `expectedVersion`，以及设为 `forgotten` 或 `superseded` 的 `reason`。 |

`ref` 可为 `{kind: 'task', taskId}`、`{kind: 'event', eventId}` 或 `{kind: 'artifact', artifactId}`。召回每一页时都会检查任务范围和当前授权。每页默认 1,024 字节，可设置为 4–4,096 字节。使用 `nextCursor` 和同一个引用读取下一页。游标绑定内容修订和当前宿主进程。重启后需发起新的查找。

搜索检查任务及每种证据中最多 12 个近期符合条件的候选项，每个候选项最多搜索 8 KiB，最多返回 10 条摘要。支持规范化后的中英文文本。通过精确引用可以召回较早的证据或读取大型产物的后续内容。排除规则对该任务持久生效，也会过滤旧检查点中源自被排除证据的内容。

在 Worker 实际发送模型请求前，dshpa 会按当前授权和排除规则检查其保留输入所记录的来源。如果来源授权被撤销或相关事件被排除，旧 Worker Session 将无法再向模型供应商发送请求。请使用仍获授权的证据创建新任务。SQLite 来源记录、DSH Session 日志和备份副本各自遵循保留规则。DSH 压缩当前上下文时，会在 Session 日志中保留原始事件。

### 管理个人记忆

构建独立的本地记忆 Bundle，并安装到已有的 Web Profile。

```sh
pnpm build
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/memory-sqlite"
```

将以下 `memory` 配置加到 `dshpa` 条目的 `config.inbox` 下。提供者固定引用包含准确的插件版本和配置版本。

```yaml
memory:
  provider:
    kind: memory
    instanceId: local-memory
    pluginId: '@mosbot-ai/dshpa-memory-sqlite'
    pluginVersion: '0.0.0'
    configRevision: 1
```

在**今日**中打开**个人记忆**。选择 Profile、项目或任务范围，再显式保存事实。搜索会核对有效期和准确的所选范围。查看时可检查来源回执、置信度、有效期及修订。更正会创建替代记录并隐藏旧记录。遗忘会立即隐藏记录，再请求提供者删除内容并保留墓碑。提供者变更仍在等待时可点**重试**。经过认证的 `dshpa/inbox` RPC 支持相同操作。对 `memory_remember`、`memory_correct` 和 `memory_forget`，可在重启后重发相同载荷和 `commandId`，继续被中断的变更。

自动提取处于关闭状态。显式操作记录所有者确认的事实，提供者契约另行保留推断记录。记忆内容不携带动作授权。外部知识库 `llmwiki` 保持只读。

记忆提供者在自己的数据库中保存事实内容。核心工作库保存范围、修订、摘要哈希、来源回执和排除规则。备份 Profile 时应同时保留两者。提供者的旧副本无法覆盖核心排除规则。已有的提供者快照或备份文件仍可能含有旧内容，分别遵循各自的留存规则。[SQLite 记忆提供者](packages/memory-sqlite/README-zh.md)

### 跟踪目标与回顾计划

在**今日**中打开**目标与计划**，创建带有成功标准、里程碑、可选回顾周期和优先级的目标。保存修订时记录理由。可以把历史修订用作可编辑草稿，并另存为新修订。关联到目标的任务沿用常规的 Worker 执行和产物验收流程。

在任务的**任务计划与依赖**中，可以查看该任务对应的 Worker 草稿，并把审核后的步骤创建为同项目的普通任务。可给排队或阻塞的任务设置前置任务。前置任务必须属于同一项目，系统会拒绝环形依赖。所有前置任务完成后，下游任务才能就绪。重新打开前置任务会再次阻塞排队中的下游任务。已运行的尝试沿用原有授权继续执行。

选择**周回顾**，查看可启动和等待中的任务、近期已验收结果及即将到来的里程碑。项目按配置的优先级和到期时间排序。若同级项目争用下一批可用 Worker 名额，回顾会提示选择优先推进的项目。回顾和周期属于计划元数据，重复调度需另行启用。

### 搜索本地知识

在 `dshpa` 条目的 `config.inbox` 下添加 `knowledge` 配置。在 macOS 或 Linux（arm64 或 x64）上使用规范绝对路径。连接器只读取你列出的目录。

```yaml
knowledge:
  roots:
    - id: llmwiki
      directory: /absolute/path/to/llmwiki
      include: ['**/*.md']
      exclude: ['private/**']
    - id: notes
      directory: /absolute/path/to/notes
      types: ['.md', '.txt']
      maxFileBytes: 131072
      maxFiles: 256
```

在**今日**中打开**本地知识**，选择**检查来源**或输入关键词。缺失的目录显示为不可用，搜索仍可使用其他已配置目录。可以混合输入中英文关键词，结果显示相对于各目录的路径。打开结果即可查看有大小上限的文本页和来源引用。每个引用包含稳定 ID 和文档的 SHA-256 修订。

内存索引复用未变化的记录，并在返回结果前核对当前文件。文件和目录必须能从已配置目录直接到达，路径中不得经过符号链接。隐藏条目、硬链接、二进制内容及超限文件会被跳过。内置类型白名单为 `.md`、`.markdown`、`.txt`、`.rst`、`.csv` 和 `.json`，默认使用 Markdown 和纯文本。每个目录有 4 MiB 的派生文本预算。标为部分可用的目录可能只返回部分结果。

来源文本作为证据展示，与 Worker 自动输入、个人记忆和原生压缩摘要分开。来源目录保持只读，索引在重启后按需重建。

### 只读访问一个 GitHub 仓库

在 `dshpa` 条目的 `config.inbox` 下添加 `githubRead`。填写实际的 GitHub 用户和仓库数字 ID，以及当前名称。若指定准确的 dshpa `projectId`，所配置的项目必须处于活跃状态。未绑定项目时，读取归属本地所有者 Profile。

```yaml
githubRead:
  binding:
    account: { id: 12345, login: your-login }
    repository: { id: 123456, owner: your-org, name: your-repository }
  transport:
    kind: github
```

从秘密存储将 `DSHPA_GITHUB_READ_TOKEN` 注入受信任的宿主环境。使用范围仅覆盖所选仓库读取的凭据。在**今日**的 **GitHub 只读**面板中验证连接，并读取 Issue 和评论页。连接器使用固定的 GET 端点，在每页前核对账号和仓库，并遵循提供者的限流退避。分页游标绑定原始操作和 Issue。历史正文保持为只读证据。[GitHub REST 分页](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) · [GitHub REST 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

经过审查的 MCP 门面可以替换 REST 传输。将 `kind` 设为 `mcp`，`url` 填写字面回环 HTTP 端点，`fingerprint` 填写已批准的 SHA-256 能力指纹。门面使用无状态的 MCP 2025-06-18。构建工作区后，可用以下命令仅发现指纹：

```sh
node --input-type=module -e 'import { inspectMcpReadFingerprint } from "./packages/personal-agent/lib/connectors/mcp.js"; console.log(await inspectMcpReadFingerprint(process.argv[1]))' http://127.0.0.1:39017/mcp
```

门面公开 `dshpa_github_inspect`、`dshpa_github_issues` 和 `dshpa_github_comments`。检查工具接收空参数，并在 `structuredContent` 中返回独立绑定的 `binding`。分页工具接收 `binding`、`operation`、`page`、`limit`，评论还接收 `issue`。它们返回结构化的 `binding`、`operation`、`page`、`items`、`hasNext`，评论还返回 `issue`。每行包含数字 `id` 和 `number`、`kind`（`issue`、`pull` 或 `comment`）、`author`、可选的数字 `authorId`、UTC 毫秒格式的 `createdAt` 和 `updatedAt`、`text`，Issue 和 PR 还包含 `title`。门面的 GitHub 账号和权限应限制在所选仓库。连接器不会向 MCP 发送 GitHub 凭据，并在调用前后核对工具指纹。[MCP 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) · [MCP 工具](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

### 审批专用 GitHub 测试仓库的草稿

在 `dshpa` 条目的 `config.inbox` 下配置 `githubDraft`。填写准确的测试仓库和账号 ID、一个活跃的 dshpa 项目及允许的基准分支。

```yaml
githubDraft:
  dedicatedTestRepository: true
  binding:
    account: { id: 12345, login: your-test-login }
    repository: { id: 123456, owner: your-test-org, name: your-dedicated-test-repository }
  projectId: your-dshpa-project-id
  base: main
```

从秘密存储将 `DSHPA_GITHUB_WRITE_TOKEN` 注入受信任的宿主。权限必须仅覆盖专用测试仓库，并允许创建分支和草稿 PR。宿主需要可用的 Git。连接器核对 API 账号和仓库，并在私有裸 Git 工作区中准备一个新 Markdown 文件。[GitHub HTTPS 认证](https://docs.github.com/en/get-started/git-basics/about-remote-repositories) · [GitHub 草稿 PR API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request)

隔离 Git 传输保留主机的代理路由和 CA 信任环境配置，不继承其他凭据、任意 Git 配置或禁用 TLS 验证的选项。

选中配置项目中一个排队任务，打开 **GitHub 测试草稿**，准备标题、正文和文件。在**今日**核对准确的仓库、基准和源分支及提交、内容和 SHA-256 摘要。审批准确动作，刷新草稿状态，再选择**发布已批准的测试草稿**。一次性授权控制一个新分支和一个草稿 PR。提供者回执会成为可验收的任务产物。

若派发中断，使用**查找提供者回执**。查证核对不可变标记、仓库、账号、批准的分支和提交、标题与正文。查无确证或结果有歧义时，状态仍不确定。连接器不会重放该操作，也不会删除远端分支。

真实验收需显式设置 `DSHPA_GITHUB_DRAFT_LIVE=1`，在 `DSHPA_GITHUB_DRAFT_LIVE_CONFIG` 中以 JSON 提供同一配置，并加载范围受限的写入凭据。只有获准在该仓库保留一个测试分支和草稿时，才执行 `pnpm exec vitest run tests/e2e/github-live.spec.ts`。该显式开启的测试会拒绝项目仓库。

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

### 主动准备工作

设置 `config.inbox.proactive: true`，并配置有价格或明确免计费的路由模型及已验证来源账号。在**今日**打开**主动建议**。规则绑定一个活跃目标、一个锚定任务、一个已验证账号和线程，以及必需关键词。规则初始关闭。**回放来源历史**核对最多 100 条准确的已存事件，不调用模型。

回放后选择**开始观察**，并将全局主动模式上限设为至少观察。路由器在评估前核对范围、来源时效、关键词、去重、冷却和模型预算。观察会记录建议及被抑制的结果供评审。至少评审 20 条建议且其中至少 70% 被标为有用后，才能授权读取来源并私有准备。私有简报保留来源引用，供所有者查看。

评审一份有用的私有简报后，可以单独授权本地简报提示。规则和全局策略都设为行动时，获准的本地提示可以出现在**今日**。提示与其他渠道共用每位所有者每个本地日最多三条主动通知的额度，并遵守静默时段。目标修订、来源登记或模型路由变化时，规则需要重新验证。评估没有有用建议时保持静默。

### 复用已评审技能

在**今日**打开**已评审技能**并选择项目。验收两个 Markdown 或纯文本任务结果后，将它们选作候选技能的样例。编写带有命名字段的 Markdown 模板，例如 `## {{topic}}`。选择另一个已验收任务的产物作为留出样例的预期结果，并以 JSON 对象输入该样例的值，例如 `{"topic":"North"}`。评测器只替换一轮字段，然后将结果的 UTF-8 字节与已验收产物逐字节比较。

查看模式、来源和评测结果，随后批准并启用通过评测的确切版本。输入新值即可生成可复制的本地 Markdown，并可为该版本记录接受或需要纠正。起草新版本时，当前版本继续生效，直至你批准替换。若旧版本的证据仍可用，可选择曾获批准的版本进行回滚。

技能仅在显式请求时运行，并在本地生成文本。来源不可用或被排除后，受影响的版本将无法继续使用。技能流程与个人记忆和调度相互独立。[PA-020 证据](docs/evidence/PA-020-zh.md)

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
