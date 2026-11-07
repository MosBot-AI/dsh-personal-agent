# PA-016 GitHub 只读连接器证据

[English](PA-016.md)

[PA-016](https://github.com/MosBot-AI/dsh-personal-agent/issues/17) · 计划 `2026-11-07-r7` · 实现提交 `ae1373112bb80109ddf704b8f0f40b54b565d59d`。

验证于 2026-11-08 在 Asia/Shanghai 时区的 macOS arm64 上执行，使用 Node.js 26.7.0、pnpm 11.28.5 和 `@deepseek-ai/dsh@0.2.2-rc.1`。[本地配置](../../README-zh.md) · [连接器安全](../03-contracts-security-and-tests-zh.md)

## 实现边界

- 本地所有者授权准确的单一 GitHub 账号和仓库，也可绑定一个活跃的 dshpa 项目。REST 每次读取分页前核对数字 ID 和当前名称。连接器使用固定的已认证 GET 端点、有大小上限的 JSON，以及绑定准确操作和 Issue 的进程内不透明游标。
- 注册表执行本地并发与速率限制，并遵循 GitHub 的退避要求。跨账号、仓库和项目的数据在披露前被拒绝。来源正文与 Worker 输入、路由准入及动作权限分开。[GitHub REST 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- 经审查的回环 MCP 门面可提供相同的只读 DTO。桥接层在调用前后比较配置指纹与发现结果。它使用三个准确的工具名称、有大小上限的 JSON 或 SSE 响应，并且不向 MCP 发送 GitHub 凭据。门面负责自身在提供者端的读取权限。[MCP 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) · [MCP 工具](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- 认证后的 Web 面板可以验证连接状态并读取 Issue 与评论页。提供者正文按字面展示，链接只为配置的仓库生成。

## 检查

| 检查 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm check` | 0 | 类型检查、Bundle 构建、241 项非 Web 测试及计划校验通过。 |
| GitHub、MCP、客户端及插件策略针对性测试 | 0 | 33 项通过，覆盖错误账号、被替换仓库、游标混用、撤权、输出上限、退避及 MCP 能力漂移。 |
| `pnpm test:local-flow` | 0 | 九条原生 Web 流程通过。连接器流程访问了真实的回环 MCP 端点，并在调用工具前拒绝变更后的工具清单。 |
| `pnpm test:resident` 和命名 SDK 冒烟测试 | 0 | 两条原生常驻流程通过，安装后的 SDK Bundle 正常加载和释放。 |
| 固定源码检查、协调测试及 `git diff --check` | 0 | 核对源码路径、12 项协调测试、双语链接和空白字符。 |
| 通过构建后的 REST 连接器真实读取 | 0 | 核对账号 `charleypeng`（2144710）和仓库 `MosBot-AI/dsh-personal-agent`（1448962460）。读取两页各 20 条且互不重复的 Issue，以及 Issue 17 的一条评论。输出仅包含身份、范围和计数。 |

## 验收范围

| 场景 | 已验证的 PA-016 行为 |
| --- | --- |
| E03 | 跨页的重复提供者 ID 被抑制。游标无法用于其他 Issue 或操作，错误项目在访问提供者前被拒绝。历史评论只展示，不会引起任务变更。 |
| E07 | 错误账号或仓库身份、所有者撤权、超限响应及传输重定向均受限制。认证的原生 Web 测试拒绝未认证和只读访问。MCP 测试拒绝工具漂移和跨范围响应，原始工具输出不会直接向所有者展示。 |
| E10 | 构建后的连接器在短生命周期宿主进程中使用既有认证 GitHub CLI 会话核对身份并读取真实数据。草稿 PR 创建和提供者写回属于 PA-017。 |

真实验收显式选择当前工作区仓库。MCP 验收使用遵守文档门面契约的本地测试端点。外部知识库路径仍不可用。
