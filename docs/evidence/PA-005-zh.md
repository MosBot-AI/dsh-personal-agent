# PA-005 动作授权证据

[English](PA-005.md)

[PA-005](https://github.com/MosBot-AI/dsh-personal-agent/issues/5) · 计划 `2026-11-07-r7` · 实施提交 `13b1012e58d194d5f50c95146751f5a8bec366c2`。

验证于 2026-11-07（Asia/Shanghai）在 macOS arm64 上运行，使用 Node.js 26.7.0、pnpm 11.28.5 和已安装的 `@deepseek-ai/dsh@0.2.2-rc.1`。授权夹具使用真实 SQLite 和确定性的进程内派发。工具夹具使用脚本模型执行发布版 DSH CLI。[授权合约](../03-contracts-security-and-tests-zh.md) · [固定版本工具管线](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/index.ts)

## 已实现边界

- 可信适配器绑定确切的所有者、Profile、设备、客户端和会话，或特定来源实例的已验证账号。不透明身份句柄根据当前登记和策略复核，适配器可释放句柄。来源句柄提供入口身份。审批响应要求确切的所有者会话和登记记录。
- 动作关卡对照当前 Attempt 检查已注册连接器的确切账号、资源、接收方、载荷校验器与披露范围。符合条件的准备动作生成审批请求，包含不可变预览及有界规范化动作的 SHA-256 摘要。审批绑定摘要、策略、任务、Attempt、代次、登记及期限。观察到的过期状态在重启和时钟回拨后仍保留。
- SQLite 事务复核确切提案、审批、账号与设备登记、当前任务版本与 Attempt 代次、撤销和到期时间。事务原子预留一次性授权，并将 Effect 推进到 `dispatching`。可信连接器在提交后同步开始存储的确切动作。声明失败时没有派发。中断或结果不明确时保留已消费的声明供对账。
- `ctx.dshpa.host.privateWorkers` 在原生创建和恢复的发布前安装作用域内的无工具执行器和仅拒绝守卫。私有 Worker 发布零个工具定义。脚本发起的 Shell、浏览器、网络、文件、MCP、晚注册作用域工具及保留的 PTC 调用均被拒绝。普通 Agent 的工具行为仍可用。夹具凭据标记未进入模型消息或持久会话。
- 模式 002 保留 v1 工作记录，并新增具有确切外键的提案、审批、授权与派发表。受进程锁保护的升级会在增量 DDL 前创建所有者私有的 `state.sqlite.v1.bak`，包含 WAL 中已提交的数据。容量耗尽时保留 v1 数据库及其备份，供重试。

派发能力归可信协调器持有。连接器校验载荷形状、归属和披露，凭据访问保留在可信适配器内。私有 Worker 调用方负责在恢复时验证持久会话的归属和模型路由。可信 DSH 组合回调仍处于宿主信任边界内。

## 检查

| 检查 | 退出码 | 观察结果 |
| --- | --- | --- |
| 使用现有任务缓存运行 `pnpm install --frozen-lockfile` | 0 | 校验 722 个锁定条目，并链接锁文件中已有的固定版本 DSH 工具包。 |
| `pnpm exec vitest run tests/security/authorization.spec.ts tests/security/bypass.spec.ts` | 0 | 14 项 SQLite 授权测试与两项原生工具绕过合约通过。 |
| `pnpm exec vitest run tests/storage/migration.spec.ts` | 0 | 12 项存储与迁移测试通过，含 v1 WAL 备份、回滚、重试及拒绝不安全路径。 |
| `pnpm check` | 0 | 类型检查、Bundle 构建、63 项 Vitest 测试和计划校验通过。 |
| 命名 `dshpa` SDK 冒烟测试 | 0 | 在原生 SDK 模板中安装本地 Bundle 并观察到加载和释放。 |
| `python3 scripts/check_plan.py --check-sources` 和 12 项协调测试 | 0 | 计划、本地源码引用和 Project 工作流检查通过。 |
| `git diff --check` 和双语审查 | 0 | 检查空白、双语文档对和链接。 |

## 验收范围与交接

| 场景 | PA-005 已验证行为 | 后续产品工作 |
| --- | --- | --- |
| E05 | 错误会话、动作或摘要修改、竞争响应、过期、撤销、登记或策略变更、过期版本和已取消代次都会拒绝授权或派发。竞争派发只产生一次不可变动作交付。SQLite 故障回滚声明，重启拒绝重放已消费声明。 | PA-009 对账不确定副作用，PA-017 验证真实供应商写入与读回。 |
| E07 | 原始身份声明和来源令牌无法通过所有者审批。夹具连接器拒绝错误路由、类似路径穿越的资源和不允许的载荷范围。原生私有 Worker 拒绝工具与 PTC 绕过，普通 Agent 的工具继续可用。 | PA-006 将策略接入工作执行。PA-016、PA-017、PA-032 和 PA-040 验证真实连接器、凭据与推理披露。 |

本轮用夹具覆盖策略与原生执行边界。经合并验证并完成 Project 状态更新后，PA-006 和 PA-038 可使用这些合约。
