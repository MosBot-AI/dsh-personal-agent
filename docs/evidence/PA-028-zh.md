# PA-028 打包后的原生 Worker 预检

[English](PA-028.md) · [文档索引](../README-zh.md)

本检查覆盖 alpha 包的全新安装和原生 Worker 调度。发布门槛及剩余验收由 [PA-028](https://github.com/MosBot-AI/dsh-personal-agent/issues/32) 跟踪。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:install
```

测试将核心包及其两个工作区依赖打成归档。固定版本的 DSH CLI 初始化一个全新的命名 Web Profile，再安装核心归档。测试保留 DSH 生成的 `nodeLinker: hoisted` 和 `autoInstallPeers: false`，并追加两个工作区依赖的本地归档引用以及 Koffi 的构建许可。安装从包注册表解析已发布的依赖。DSH 在运行时提供共享的宿主包。如果 Profile 安装了第二份 `@deepseek-ai/dsh-llm`，该模块内部记录的请求标记会与原生 Agent Loop 的请求标记分离。

已安装的包通过常驻启动器运行。测试检查收件箱是否要求认证，以及所有者是否能够创建并显式启动 Worker。固定版本的原生供应商向回环端点发送恰好一次请求，该端点返回 HTTP 400。Worker 释放并进入预期的供应商等待状态，常驻宿主正常退出。运行使用模拟凭据和本地供应商端点。

主分支 `917e84e` 和九个 PR 的组合代码树 `7d08796` 均通过直装的 HTTP 400 对照，结果 SHA-256 一致，为 `baeeb36b4f99fee4cada60151f261699141e8be1ab7d627c542c8684f98ef479`。发布 Issue 记录了安装设置和单独的凭据恢复结果。 [验证记录](https://github.com/MosBot-AI/dsh-personal-agent/issues/32#issuecomment-6831354517)

完整发布门槛仍须完成适用的升级、恢复和卸载检查、真实供应商验收及七天试用。参见[评估与发布门槛](../07-evaluation-and-release-gates-zh.md)。
