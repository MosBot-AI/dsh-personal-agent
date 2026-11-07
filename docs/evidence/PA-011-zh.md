# PA-011 上下文检查点与召回证据

[English](PA-011.md)

[PA-011](https://github.com/MosBot-AI/dsh-personal-agent/issues/11) · 计划 `2026-11-07-r7` · 实现提交 `b5bd112ac3b96c39aea444b2028efc9bd61fcef5`。

验证于 2026-11-07 在 Asia/Shanghai 时区的 macOS arm64 上执行，使用 Node.js 26.7.0、pnpm 11.28.5 和已安装的 `@deepseek-ai/dsh@0.2.2-rc.1`。[本地配置](../../README-zh.md#在压缩时保留任务上下文) · [上下文契约](../03-contracts-security-and-tests-zh.md)

## 实现边界

- 可选的上下文配置会检查在线主 Session 是否使用两个支持检查点的 DSH 插件。原生压缩或工具结果剪枝前，限定范围的 SQLite 事务会保存 Task 版本、Attempt、目标、约束、验收条件、当前等待、带来源的所有者回答及证据引用。检查点写入失败会阻止原生修改。受管压缩在本地生成引用摘要。
- 经过认证的所有者可通过 Web 收件箱精确查询 Task、事件或产物引用。UTF-8 分页会逐页核对当前权限、修订和摘要哈希。有限的中英文搜索使用相同的范围校验。证据遗忘和替代在重启后继续生效，并过滤检查点中由该证据派生的内容。
- Worker 上下文组装使用所选路由的窗口、原生令牌估算器、响应预留和分段预算。它原样保留当前指令，并将模型可见输入与准确的证据 ID 一起记入日志。派发前，原生 Worker 检查完整请求预算并重新验证保留输入的来源，包括对升级前日志来源的保守重建。
- 模式 008 增加检查点、排除规则和输入日志来源。迁移创建仅所有者可访问的备份，并保留旧版 Worker 输入记录。

## 检查

| 检查 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --offline` | 0 | 从本地存储安装固定版本的工作区依赖。 |
| `pnpm check` | 0 | 类型检查、构建、205 项非 Web 测试和计划校验通过。 |
| `pnpm exec vitest run tests/context/checkpoint.spec.ts tests/context/recall.spec.ts tests/context/assembler.spec.ts tests/storage/checkpoint.spec.ts tests/storage/migration.spec.ts` | 0 | 38 项针对性测试全部通过，涵盖原生回放、持久排除和 v7 迁移。 |
| `pnpm test:local-flow` | 0 | 五条原生 Web 流程通过。配置后的上下文流程验证在线预设、认证调用、三次 `/compact`、持久化的问题及其关联的所有者回答、Worker 组装和保留来源撤权。 |
| `pnpm test:resident` | 0 | 两条原生常驻回归流程均通过。 |
| 命名 `dshpa` SDK 冒烟测试 | 0 | 安装本地 bundle，观察服务加载与释放，并确认以 0 退出。 |
| `python3 scripts/check_plan.py --check-sources`、协调测试和 `git diff --check` | 0 | 核对固定的本地源码引用、12 项协调测试、双语链接和空白字符。 |

## 验收范围

| 场景 | 已验证的 PA-011 行为 |
| --- | --- |
| E04 | 固定版本的原生测试在十次压缩前均观察到已提交的检查点，冷重启后回放 DSH V4 Session 和 SQLite，并继续会话。真实的 SQLite 写入拒绝保留了原生上下文供重试。限定范围的存储和召回测试在冷重开后核对了由已替代和已遗忘来源派生的内容。Web 流程在真实检查点行中核对了当前未答等待和之后的所有者决定。 |
| E07 | 所有者 RPC 拒绝未认证访问、只读访问和跨任务引用。召回测试覆盖伪造和过期游标、账号和订阅权限变化、封存证据及翻页期间的排除。Web 流程拒绝未安装防护的原生预设，并在已披露的回答被替代后阻止同一 Worker Attempt 派发。限定范围的输入测试将恶意文本作为数据处理，私有 Worker 测试验证工具仍被禁用。 |

原生测试使用真实 DSH Session 和受控的模型适配器，未调用外部账号或付费模型。上下文配置需显式启用。保留证据被撤权的 Worker Session 需要通过新任务继续，排除规则作用于召回和模型披露，来源、Session 和备份文件分别遵循各自的留存规则。PA-012 负责个人记忆管理，发布门禁任务负责完整的 E04 和 E07 流程。
