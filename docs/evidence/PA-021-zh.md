# PA-021 常驻宿主验收证据

[English](PA-021.md)

[PA-021](https://github.com/MosBot-AI/dsh-personal-agent/issues/22) · 计划 `2026-11-07-r7` · 实现提交 `307e39d9d9c4533248f3052adbed4980a7222697`。

本地验证于 2026-11-07 在 Asia/Shanghai 时区进行，使用 macOS arm64、Node.js 26.7.0、pnpm 11.28.5 和 `@deepseek-ai/dsh@0.2.2-rc.1`。隔离常驻测试执行前台部署启动器和原生 Web Profile。Linux CI 关卡运行同一个前台测试并校验生成的 systemd 单元。确切的 Linux 运行证据记录在已验收 Issue 中。[运维指南](../operations-zh.md)

## 已实现的边界

- 单个前台原生 DSH Web 进程先取得 SQLite 写入租约，再启动原生调度解析。本地公开探针区分进程存活与就绪。原生所有者链接使用私有文件和当前进程标识。诊断状态、备份及审计通过已认证收件箱执行。可选的 launchd 和 systemd 描述调用同一个启动器。
- 看门狗观察当前 Attempt 和代次，保留有界诊断元数据，并将进展停滞、重复工具调用、计算及供应商条件与进程健康分开。心跳间隔过长时启动一次有界的暖调度检查。中止限制该次检查继续写入应用状态，确切原生意图或回执仍可用于正常对账。
- 供应商认证、限流、暂时不可用及模型错误具有不同资源条件。已准入且结果不确定的模型调用保留预算证据。执行器在原生退出后释放 Worker 槽位。所有者恢复时重新检查确切等待和预算。已取消任务的迟到结果不会影响其他 Worker 或后续路由授权。
- 在线备份固定已提交的 SQLite 快照，包含封存产物，并发布仅所有者可访问的独立文件。成功发布后，保留策略仅处理受管备份名称。恢复较旧快照时，派发保持仅对账限制。所有者审计通过有界游标导出限定范围的计数和固定元数据。进程内诊断默认保留 14 天、最多 512 条。

## 检查

| 检查 | 退出码 | 观察结果 |
| --- | --- | --- |
| `pnpm check` | 0 | 类型检查、Bundle 构建、178 项 Vitest 测试和计划验证通过。 |
| `pnpm exec vitest run tests/ops/health.spec.ts tests/ops/restore.spec.ts tests/ops/provider.spec.ts tests/security/authorization.spec.ts tests/runtime/schedule.spec.ts tests/recovery/schedule.spec.ts` | 0 | 47 项专项测试通过。 |
| `pnpm test:local-flow` | 0 | 四条原生 Web 流程通过。 |
| macOS 上的 `pnpm test:resident` | 0 | 生成的 LaunchAgent 通过 `plutil`。前台 Profile 拒绝无效启动和第二个写入进程，在 HTTP 连接关闭时处理进程挂起后的唤醒，完成备份与重启，并以限制派发的模式加载恢复副本。 |
| 命名 `dshpa` SDK 冒烟测试 | 0 | 安装本地 Bundle 并观察到加载和卸载。 |
| `python3 scripts/check_plan.py --check-sources`、12 项协调测试、`git diff --check` 及双语审查 | 0 | 固定源码路径、Project 工作流、空白、双语对应文件及链接通过。 |

## 验收范围

| 场景 | 已验证的 PA-021 行为 | 后续产品工作 |
| --- | --- | --- |
| E06 | 真实原生 Profile 重启后保留一条提醒。既有派发、取消与读回测试通过。取消或中止的暖检查保留持久证据，供精确对账。 | PA-035 评估完整的常驻桌面流程。 |
| E09 | 受控原生供应商故障包含认证过期、429、503 和传输失败，均保留范围和不确定性。已释放等待占用零个 Worker 槽位。尚未完成退出的原生工作继续计入资源占用。 | 供应商账户计费及真实媒体硬件有独立验收。 |
| E11 | 实际 SQLite 容量失败和注入的 `ENOSPC` 验证安全拒绝。在线 WAL 备份保留已提交记录。恢复后旧授权与待发送项继续受限。恢复的原生收件箱仍可检查，生成的服务描述可移除而 Profile 继续保留。 | 所有者保留策略及实际服务登记遵循运维指南。 |

生命周期测试使用隔离进程的挂起和恢复，原生暖唤醒测试使用受控的墙钟时间间隔。供应商和交付结果由测试控制。登录登记、物理休眠和更长的常驻试用由部署或发布验收处理。
