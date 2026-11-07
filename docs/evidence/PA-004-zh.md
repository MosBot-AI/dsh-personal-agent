# PA-004 SQLite 存储证据

[English](PA-004.md)

[PA-004](https://github.com/MosBot-AI/dsh-personal-agent/issues/4) · 计划 `2026-11-07-r7` · 实施提交 `e01d2a4743452c5a37de3c7ede4d915ca6501643`。

验证于 2026-11-07（Asia/Shanghai）在 macOS arm64 上运行，使用 Node.js 26.7.0、其内置的 SQLite 3.53.4 和 pnpm 11.28.5。存储测试在临时目录中使用真实 SQLite 文件。实现沿用审计原型将工作与副作用分离并事务化的思路。DSH storage-domain API 提供各领域内的文档写入。应用使用独立数据库处理跨表提交，原生会话日志保留在 DSH。[合约](../03-contracts-security-and-tests-zh.md) · [原型存储](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store.ts) · [宿主 storage-domain 审计](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/storage/storage-domain/README.md)

## 已实现边界

- `openWorkStore(directory)` 在私有应用目录中持有一个 SQLite 连接。独立的持久守卫数据库在存储打开期间持有排他事务，进程退出会释放该锁。工作数据库启用 WAL、完整同步和外键。检查 POSIX 文件与目录权限，包括 SQLite 辅助文件。
- 一个同步事务检查命令和来源去重，应用任务版本和 Attempt 代次检查，并提交任务、Attempt、限定范围的工作事件、Effect 准备记录、待投递记录和命令回执。外键将副作用和投递意图绑定到确切的 Attempt 代次。取消可推进任务代次，同时保留退役的 Attempt 供对账。
- 命令重放使用已认证的所有者和客户端键，并对规范化请求及可信路由范围计算指纹。精确重放会在检查当前任务版本之前返回已有回执。请求变更会产生冲突，从存储解码的记录必须与所在范围匹配。每个事务最多接受 64 项副作用与投递意图以及 1 MiB 编码记录。
- 001 迁移初始化空库，将应用标识和模式版本与表一起提交。不受支持的版本与外部数据库原地保留并拒绝打开。检测到损坏时写入持久隔离标记、关闭连接，并阻止正常重开或创建空库替换。数据库保留在原路径。SQLite 正常关闭时可以执行 WAL checkpoint。

## 检查

| 检查 | 退出码 | 观察结果 |
| --- | --- | --- |
| `pnpm exec vitest run tests/storage/atomicity.spec.ts tests/storage/migration.spec.ts` | 0 | 23 项真实 SQLite 测试全部通过。重复意图和延迟外键失败都回滚整次写入。真实子进程退出后，保留 WAL 中已提交的记录并丢弃未提交的记录。 |
| `pnpm check` | 0 | 类型检查、Bundle 构建、44 项 Vitest 测试和计划校验通过。 |
| `python3 scripts/check_plan.py --check-sources` | 0 | 检查计划、链接和两个固定版本的本地源码检出。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'` | 0 | 12 项协调测试全部通过。 |
| `git diff --check` 和双语审查 | 0 | 检查空白、双语文档对和本地链接。 |

## 验收范围与交接

| 场景 | PA-004 已验证行为 | 后续产品工作 |
| --- | --- | --- |
| E03 | 精确命令重放在重开后仍可用。修改命令或可信路由会冲突，重复外部修订会去重，范围错误或版本过期时拒绝写入。 | 真实来源事件和有歧义的追问路由由 PA-010 与 PA-014 处理。 |
| E06 | 工作记录、来源关联、Effect 与发件箱意图以及回执一起提交或回滚。异常退出后重开仅保留已提交记录。过期 Attempt 无法准备新的副作用。 | 供应商派发、不确定结果对账和投递由对应的执行及恢复任务验证。 |
| E11 | 真实 SQLite 容量耗尽会回滚初始模式创建和数据写入。不受支持的文件原地保留。检测到损坏时阻止重开，并保留数据库供恢复。 | 旧备份的仅对账恢复、备份保留和卸载由恢复、运维与打包任务验证。 |

PA-004 提供存储边界及确定性故障证据。经合并验证并完成 Project 状态更新后，PA-005 可在这些事务和持久化规则上实现可信身份、授权和精确动作审批。
