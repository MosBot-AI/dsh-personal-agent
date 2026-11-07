# PA-001 原生 Bundle 验收证据

[English](PA-001.md)

[PA-001](https://github.com/MosBot-AI/dsh-personal-agent/issues/1) 的实现提交为 `94c70aafcc0a5a43cdb144647a6e429d09e3f915`。本地验证在 Asia/Shanghai 的 2026-11-07 执行，环境为 macOS arm64、Node.js 26.7.0、pnpm 11.28.5 及已发布的 `@deepseek-ai/dsh@0.2.2-rc.1`。工作区要求 Node.js 24.9.0 或更高版本，CI 使用 Node.js 24.9.0。

上游审计源码为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，已发布版本的标签指向 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。锁文件记录软件包产物的完整性值。契约测试运行实际安装的发布产物，其兼容性检查会禁用不兼容的插件项。PA-002 会继续针对安装的发布版本核对其余宿主 API。

| 检查 | 退出码 | 观察结果 |
| --- | --- | --- |
| 使用已有任务缓存运行 `pnpm install --frozen-lockfile --offline` | 0 | 解析提交的锁文件并执行已审阅的 PTY 辅助程序权限修复。 |
| `pnpm check` | 0 | 类型检查与构建通过。三个 E00 契约用临时具名 Profile 启动真实 DSH CLI，验证服务加载和卸载、缺少 `agents` 的诊断及版本拒绝。 |
| 具名 `dshpa` SDK 冒烟验证 | 0 | 在隔离的 DSH home 创建 `sdk` Profile，通过 `dsh plugin add` 安装本地 Bundle，并在真实 SDK Profile 中观察到服务加载和卸载。验证使用 `workspace-write`。 |
| `python3 scripts/check_plan.py --check-sources` | 0 | 校验 43 个任务、25 个场景、依赖关系、文档链接与本地源码路径。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'` | 0 | 12 个协作流程测试全部通过。 |
| `env -u DEEPSEEK_API_KEY pnpm test:e2e` | 0 | 报告 `SKIPPED live E2E`。真实模型验收仍未验证。 |

启动骨架工作区排除了上游可选 Office 引擎产物。项目接入 Office provider 时可重新评估这项安装选择。恢复与真实模型验收由后续任务负责。
