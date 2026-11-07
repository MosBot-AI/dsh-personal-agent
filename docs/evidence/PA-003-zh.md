# PA-003 工作领域证据

[English](PA-003.md)

[PA-003](https://github.com/MosBot-AI/dsh-personal-agent/issues/3) · 计划 `2026-11-07-r7` · 实施提交 `26fe653c116394d48576957e97932413e460224f`。

验证于 2026-11-07（Asia/Shanghai）在 macOS arm64 上运行，使用 Node.js 26.7.0 和 pnpm 11.28.5。领域测试使用确定性的记录和时钟。工作区的宿主检查继续执行发布版 `@deepseek-ai/dsh@0.2.2-rc.1` CLI。领域逻辑沿用固定版本原型中工作、执行和不可变准入引用相分离的设计，并依据应用合约定义自身任务和命令规则。[合约](../03-contracts-security-and-tests-zh.md) · [固定版本原型模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/model.ts)

## 已实现边界

- 严格解码器定义持久记录，以品牌类型区分标识，并要求规范的 UTC 时间。Task、Attempt、Conversation、Effect 和 Delivery 分别建模。Effect 与 Delivery 各自保留不确定状态和供应商回执。
- 所有者命令从调用方取得已认证身份，并检查所有者、Profile，以及调用方提供的可信项目和会话范围。标识分配和 mandate 引用来自调用方。Worker 只可报告就绪或等待，派发版本绑定在已认证的 Attempt 上。
- 状态转换检查版本与代次，在纯逻辑中计算下一状态。它支持精确等待，检查由调度器提供的依赖链，并区分验收验证与 Worker 就绪。取消在触发外部停止前推进任务代次。可信协调器只结算确切的已退役 Attempt。重试和重开分配新 Attempt，并返回原 Attempt 以保留持久历史。
- Task 与 Attempt 的持久化解码会拒绝不匹配的标识、阶段或代次，拒绝绑定运行时但尚未启动的 Attempt，以及缺少必需产物或回执引用的已完成记录。

## 检查

| 检查 | 退出码 | 观察结果 |
| --- | --- | --- |
| 使用现有任务缓存运行 `pnpm install --frozen-lockfile` | 0 | pnpm 供应链策略校验了 722 个锁定条目，并链接锁文件中已有的固定版本 Zod。 |
| `pnpm typecheck` 和 `pnpm build` | 0 | 验证 TypeScript 入口并构建原生 Bundle。 |
| `pnpm exec vitest run tests/domain/transitions.spec.ts` | 0 | 14 项领域测试全部通过，覆盖允许的转换与拒绝的输入。 |
| `pnpm check` | 0 | 类型检查、构建、14 项领域测试、7 项原生 CLI 合约及计划校验通过。 |
| 命名 `dshpa` SDK 冒烟测试 | 0 | 在隔离的原生 SDK 模板中安装本地 Bundle，并在 `workspace-write` 下观察到加载和释放。 |
| `python3 scripts/check_plan.py --check-sources` | 0 | 检查依赖、文档链接和固定版本的本地源码引用。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'` | 0 | 12 项协调测试全部通过。 |
| `git diff --check` 和暂存审查 | 0 | 检查空白，并审查本次变更和双语文档对。 |

## 验收范围与交接

| 场景 | PA-003 已验证行为 | 后续产品工作 |
| --- | --- | --- |
| E01 | 同一会话中的两次分配产生独立的任务和 Attempt，来源使用可信引用。Worker 的 `ready` 报告进入验证，任务完成前须具备两种已配置的必需证据引用。 | PA-006 和 PA-007 运行原生 Worker 并验证真实产物和回执。 |
| E03 | 拒绝错误的所有者、Profile、项目、会话、版本和 Attempt 身份。过期 Worker 无法使用当前派发版本。重开终态任务需要明确的授权命令。 | PA-004 持久化命令幂等与乐观更新。PA-010 和 PA-014 处理事件路由及计划变更。 |
| E05 | Worker 输入无法宣称已验证或已失败结算，也无法指定新的所有者身份。取消使旧 Worker 代次退役。授权与审批记录分别表示限定身份、精确动作摘要、决策和到期时间。 | PA-005 验证身份、评估授权，并在派发时原子预留一次性审批。 |
| E06 | 等待、取消和未决副作用分别建模。外部结果未明时无法进入失败终态。已确认的副作用回执、供应商受理和已投递是不同的事实。 | PA-004 提供持久原子提交，PA-006 释放 Worker 容量，PA-009 验证恢复和实际副作用对账。 |

领域夹具覆盖 PA-003 的应用合约。真实模型、真实供应商、SQLite 故障和投递检查由对应的后续任务完成。经合并验证并完成 Project 状态更新后，PA-004 可在应用事务内使用这些解码器与状态转换结果。
