# PA-002 原生宿主合约证据

[English](PA-002.md)

[PA-002](https://github.com/MosBot-AI/dsh-personal-agent/issues/2) · 计划 `2026-11-07-r7` · 实施提交 `bb05f1664510754d57000ff8e4da7ed25d2fddb8`。

验证于 2026-11-07（Asia/Shanghai）在 macOS arm64 上运行，使用 Node.js 26.7.0 和 pnpm 11.28.5。合约执行已安装的 `@deepseek-ai/dsh@0.2.2-rc.1` 发布版，标签 `dsh-v0.2.2-rc.1` 指向 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。计划审计的 harness 检出为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，原型检出为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。安装产物的观察结果及源码差异见[宿主兼容性记录](host-compatibility-zh.md)。

## 实现

- 原生 Bundle 提供 `ctx.dshpa.host`。其适配器创建和恢复原生句柄，并检查原生会话 flush 的结果。运行时和生命周期仍由 DSH CLI 与 Cordis 管理。
- [代理](../../tests/contracts/host.spec.ts)和[调度](../../tests/contracts/schedule-host.spec.ts)合约通过临时命名 Profile 和本地脚本模型启动发布版 CLI。测试读取原生 JSONL 会话日志，并使用同一个测试主目录重启 CLI。测试结束后删除对应 Profile 和数据。

## 检查

| 检查 | 退出码 | 观察结果 |
| --- | --- | --- |
| 使用现有任务缓存运行 `pnpm install --frozen-lockfile` | 0 | pnpm 供应链策略校验全部 722 个锁定条目，并链接固定版本的宿主类型。 |
| `pnpm check` | 0 | 类型检查、Bundle 构建、7 项原生 CLI 合约及计划检查通过。 |
| `pnpm exec vitest run tests/contracts/host.spec.ts tests/contracts/schedule-host.spec.ts` | 0 | PA-002 的 4 项合约全部通过，含跨进程恢复和调度回执故障窗口。 |
| 命名 `dshpa` SDK 冒烟测试 | 0 | 初始化原生 SDK 模板，通过 `dsh plugin add` 安装本地 Bundle，并在 `workspace-write` 下观察到 Bundle 加载和释放。 |
| `python3 scripts/check_plan.py --check-sources` | 0 | 使用两个固定版本的上游检出验证计划及本地引用。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'` | 0 | 12 项协调测试全部通过。 |
| `git diff --check` 和暂存差异审查 | 0 | 检查空白并审查变更。 |

兼容性记录还记录了发布版 Gateway 和结果 codec 的两项本地探针，覆盖进程内分发和 codec 校验。

## 验收范围与交接

| 场景 | PA-002 已验证范围 | 后续产品工作 |
| --- | --- | --- |
| E00 | 原生 Bundle 可加载，卸载时释放所属的活跃代理并移除其注册。E00 基线仍拒绝不兼容版本，并诊断缺少代理服务。 | 发布打包由 PA-028 和 PA-035 负责。 |
| E02 | 在脚本轮次中验证原生追加、引导、上下文注入、中止和空闲结算，并分别检查实时帧和持久最终事件。 | 四作业公平性、前台响应和产品取消由后续 E02 任务负责。 |
| E06 | 原生 Session flush 具有明确的失败语义。一次性 Schedule 回执在重启后保留。在 inbox 持久化后、回执保存前受控退出，复现同一次发生项的重复投递。 | 持久副作用对账和逻辑发生项去重由 PA-009、PA-017、PA-018 和 PA-021 负责。 |

本次合约范围不含真实模型、浏览器、网络传输或设备验收。探针使用确定性输入验证宿主行为。经合并验证并完成 Project 状态更新后，直接后继任务为 PA-003。
