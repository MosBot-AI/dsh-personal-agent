# PA-006 受限原生 Worker 证据

[English](PA-006.md)

[PA-006](https://github.com/MosBot-AI/dsh-personal-agent/issues/6) · 计划 `2026-11-07-r7` · 实施提交 `5a51f2dac4a92975b4c778cf5b3a0806fc2698f2`。

验证于 2026-11-07（Asia/Shanghai）在 macOS arm64 上运行，使用 Node.js 26.7.0、pnpm 11.28.5 和已安装的 `@deepseek-ai/dsh@0.2.2-rc.1`。Worker 合约运行发布版 DSH CLI，并使用脚本模型、原生作业和子 Agent 服务、隔离工作区，以及真实 SQLite 与 JSONL 持久化。[执行合约](../03-contracts-security-and-tests-zh.md) · [固定版本原型执行器](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/dsh.ts)

## 已实现边界

- `ctx.dshpa.host.createWorkerExecutor()` 为每个工作存储协调一个执行器。默认容量为两个 Worker，可配置范围为 1–32。可信的仅模型预设绑定供应商、模型、披露标签，以及工作根目录内的真实目录。Worker 工具保持禁用。槽位被占用时，前台查询、引导和取消仍按当前任务范围执行。
- 执行器在打开原生 Agent 前预留槽位并提交 Attempt 的确切版本、代次、会话、目录、预设和输入游标。恢复时复核持久化路由、工作目录、归属以及原生收件箱为空。Attempt 跨进程重启保留最多 64 个不同的输入游标。原生模型步骤只接收 Worker 签发的消息 ID 和游标。
- 报告使用有界 JSON，包含确切的当前游标以及 `progress`、`waiting`、`blocked`、`ready` 或 `failed` 之一。作用域内观察器选取对应已完成原生轮次的最终文本。进度用于观察。依赖阻塞会检查存储中的依赖链。就绪会持久化候选产物引用并进入验证。验证方应在封存证据前等待原生资源释放。
- 持久停止先推进代次，执行器随后才向所属 Agent 发信号。持久等待期间保留槽位，直至确切归属的作业和子 Agent 清理完成，包括清理期间观察到的晚启动工作。无法核实清理时继续保留槽位。取消结算会检查该 Attempt 的未决副作用。执行器仅使用可信预设与协调器输入执行这些状态转换。

协调器跨两个存储系统提交游标并刷新原生会话事件。释放检查覆盖当前执行器跟踪的句柄。写入间崩溃、供应商结果不明确及仍标记运行中的工作恢复，由 PA-009 对账和处理。

## 检查

| 检查 | 退出码 | 观察结果 |
| --- | --- | --- |
| 使用现有任务缓存运行 `pnpm install --frozen-lockfile` | 0 | 校验 722 个锁定条目，并链接固定版本 DSH LLM 包。 |
| `pnpm exec vitest run tests/runtime/executor.spec.ts` | 0 | 两项原生合约通过，共运行三个隔离 CLI 阶段。 |
| `pnpm check` | 0 | 类型检查、Bundle 构建、65 项 Vitest 测试和计划校验通过。 |
| 命名 `dshpa` SDK 冒烟测试 | 0 | 在 SDK 模板中安装本地 Bundle 并观察到加载和释放。 |
| `python3 scripts/check_plan.py --check-sources` 和 12 项协调测试 | 0 | 计划、本地源码引用和 Project 工作流检查通过。 |
| `git diff --check` 和双语审查 | 0 | 检查空白、双语文档对和链接。 |

## 验收范围与交接

| 场景 | PA-006 已验证行为 | 后续产品工作 |
| --- | --- | --- |
| E01 | 同一会话中的 Worker 拥有独立 Attempt 和原生会话。宿主拒绝未签发的输入和过期报告。就绪携带候选产物引用进入 `verifying`。有效进度报告在原生空闲后仍保持任务运行。 | PA-007 验证实际产物并投递验收结果。 |
| E02 | 四个阻塞的模型流和四个所属作业占用槽位。第五项任务保持排队，查询、引导和取消仍响应。取消一个 Worker 时，其余 Worker 以及无关 Agent 和作业保持原状态。在原生打开前取消时，模型未被调用。 | PA-008、PA-010 和 PA-013 覆盖前台体验、队列公平性及延迟与预算评估。 |
| E06 | 持久等待保留槽位，直到所属作业和子 Agent 清理完成。在新的 DSH 进程中，两个历史游标均被拒绝，同一 Attempt 和会话使用新游标及保存的对话恢复。 | PA-009 验证崩溃窗口中的输入对账、副作用不确定性和重启恢复。 |

本轮在真实原生宿主上运行无凭据夹具。经合并验证并完成 Project 状态更新后，PA-007 可使用 Worker 的验证与释放边界。
