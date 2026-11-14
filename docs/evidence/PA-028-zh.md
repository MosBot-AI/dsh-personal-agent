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

## 插件卸载和重装

同一打包测试先停止常驻宿主，再用固定版本的 DSH CLI 从一次性命名 Profile 中卸载 dshpa。已安装的 Bundle 随后消失。独立的 WorkStore 数据库、所有者身份文件以及所有者工作目录中的一个文件均保留原始内容。

测试在原 Profile 中重装同一个归档，通过新的常驻进程登录，读回原任务 ID、版本和资源等待状态。Worker 保持未运行，受控供应商在两次进程运行期间总共只收到原始的一次 POST。测试使用隔离的 DSH Home 和返回 HTTP 400 的模拟供应商。[卸载验证 #144](https://github.com/MosBot-AI/dsh-personal-agent/issues/144)

## 打包版本的数据库升级和恢复

历史源码检查点 `07579662e0747acdac1ad34f0f823c41e9ec8b0d`（schema 15）和当前运行时 `02ec24eec147a0277e19bf9bea2b83d34f1559b6`（schema 16）分别构建并打包。两者未发布的核心包版本均为 `0.0.0`。测试在 Debian 13 上使用独立归档、固定版本的 DSH 0.2.2-rc.1 宿主及 Node.js 24.14.1。[升级验证 #146](https://github.com/MosBot-AI/dsh-personal-agent/issues/146)

旧版已安装 Bundle 通过已鉴权的原生收件箱创建项目并启动 Worker。模拟供应商返回一次 HTTP 400 后，任务进入供应商等待。固定版本的 DSH CLI 将当前归档安装到原有 Profile。新版首次启动将数据库升级到 schema 16，保留原项目与任务记录，并生成包含升级前记录、仅所有者可访问的 `state.sqlite.v15.bak`。所有者身份文件和工作文件保持完整。

将该备份恢复到新目录后，原备份和已升级的数据库均保持完整。恢复环境的就绪探针返回 HTTP 503，已鉴权的所有者可以读取原任务，派发则返回 `recovery_required`。旧版、升级后及恢复后的宿主合计只向供应商发送了一次请求。三个数据库和备份均通过 SQLite 完整性与外键检查。

在当前检出目录构建两个修订，并把 `DSHPA_INSTALL_UPGRADE_FROM` 指向已构建的历史检出目录：

```sh
previous="$(mktemp -d)"
git worktree add --detach "$previous" 07579662e0747acdac1ad34f0f823c41e9ec8b0d
pnpm -C "$previous" install --frozen-lockfile
pnpm -C "$previous" build
pnpm install --frozen-lockfile
pnpm build
DSHPA_INSTALL_UPGRADE_FROM="$previous" pnpm test:install
git worktree remove "$previous"
```

升级用例、默认安装用例和 35 项 SQLite 迁移测试均通过。完整发布门槛仍须完成发布产物的适用验证、真实供应商验收及七天试用。参见[评估与发布门槛](../07-evaluation-and-release-gates-zh.md)。

## 本地 alpha 归档

使用固定版本的工作区工具链构建干净的检出目录，然后将三个归档保存在一次性安装 Profile 之外。这些归档供本地验证。[归档验证 #148](https://github.com/MosBot-AI/dsh-personal-agent/issues/148)

```sh
pnpm install --frozen-lockfile
pnpm build
archives="$(mktemp -d)"
for package in personal-agent plugin-api model-routing; do
  pnpm -C "packages/$package" pack --pack-destination "$archives"
done
cp LICENSE "$archives/LICENSE"
git rev-parse HEAD > "$archives/source-commit.txt"
(cd "$archives" && sha256sum ./*.tgz LICENSE > SHA256SUMS && sha256sum -c SHA256SUMS)
DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

`DSHPA_INSTALL_ARCHIVES` 使用绝对路径下的三个指定文件，运行已鉴权的启动、卸载与重装检查。此轮运行请省略 `DSHPA_INSTALL_UPGRADE_FROM`。固定源码 `b94773c1b0370335e3a3b8031d212673b54702a5` 使用 Node.js 24.14.1、pnpm 11.28.5 和 DSH 0.2.2-rc.1 打包。三个归档均包含 Apache-2.0 许可证，核心包与路由包的清单已将工作区引用解析为具体版本。归档原件通过了使用模拟供应商的本机原生测试。

## DeepSeek Worker 真实调用冒烟测试

从本机密钥存储加载获授权的 `DEEPSEEK_API_KEY` 后，指定当前归档目录，并显式启用真实调用测试：

```sh
DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

测试在全新 DSH Profile 中执行一项合成任务，预算为一次调用，输出上限为 256 个 token。已安装的 Worker 通过 DeepSeek 官方端点调用 `deepseek-flash`。所有者鉴权后读取并验收封存的 Markdown 结果，常驻进程重启后读回同一产物。测试验证仅有一条已结算的用量记录，并按配置的高峰费率估算费用。[真实 Worker 验证 #150](https://github.com/MosBot-AI/dsh-personal-agent/issues/150) · [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing/)

此结果覆盖使用本地 alpha 归档完成的一项真实模型任务。发布仍需完成真实外部写入、完整工作流评测和七天试用。
