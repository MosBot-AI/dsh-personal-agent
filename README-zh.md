# dshpa — DSH Personal Agent

[English](README.md)

dshpa 是基于 DeepSeek Harness 的个人智能体项目，目标是常驻用户自己的电脑，通过原生、可替换的插件协调持续工作，并交付可检查的成果。

**已实现原生 Bundle、工作与安全基础、受限 Worker、可验证交付、本地 Web 收件箱和受控恢复（PA-001 至 PA-009）。**

[宿主兼容性记录](docs/evidence/host-compatibility-zh.md)说明已验证的原生控制能力，以及后续任务需要处理的边界。
[工作领域证据](docs/evidence/PA-003-zh.md)覆盖记录校验、命令准入和任务状态转换。
[存储证据](docs/evidence/PA-004-zh.md)覆盖原子提交、锁、迁移和故障恢复。
[授权证据](docs/evidence/PA-005-zh.md)覆盖可信身份、精确动作审批、一次性派发和私有 Worker 工具隔离。
[Worker 证据](docs/evidence/PA-006-zh.md)覆盖原生启动与恢复、报告准入、前台控制和资源清理。
[产物与交付证据](docs/evidence/PA-007-zh.md)覆盖不可变内容、可信验收和供应商回执处理。
[本地 Web 收件箱证据](docs/evidence/PA-008-zh.md)覆盖原生会话集成、任务控制、审批和结果验收。
[恢复证据](docs/evidence/PA-009-zh.md)覆盖输入回执、取消代次和备份恢复。

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
