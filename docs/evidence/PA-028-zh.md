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

## 真实项目简报与澄清流程

加载同一获授权的凭据，并使用同一批本地归档运行虚构的图书馆试点任务：

```sh
DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_BRIEF=1 \
  DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

Worker 询问缺失的受众和启动日期，释放执行资源，并在常驻进程重启后保留同一等待输入状态。已鉴权的收件箱拒绝与问题不匹配的回答引用。匹配的回答使 Worker 进入队列，由所有者再次显式启动。封存的 Markdown 记录了回答中的受众与启动日期，以及原任务中的套件数量与报名截止日。验收后的结果与产物在第二次重启后得以保留。

归档 Bundle 于 2026-11-14 通过此项测试。两次 `deepseek-flash` 调用均已结算，输出分别为 76 和 64 个 token。按配置的高峰费率估算，总费用为 538 微美元。每次调用的输出上限为 256 个 token，测试允许每个任务最多调用两次。[澄清流程验证 #152](https://github.com/MosBot-AI/dsh-personal-agent/issues/152)

## 基于精确版本本地来源的真实研究简报

加载同一获授权的凭据，并选用独立的研究用例：

```sh
DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_RESEARCH=1 \
  DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

在全新安装的 Profile 中，已鉴权的所有者搜索一次性知识库根目录，读回两份虚构的场地记录。Harbor Room 文件更新后，收件箱拒绝旧版本，并用同一来源引用和新的 SHA-256 返回更新后的内容。所有者将两个已核验的摘录及其版本明确放入任务。Worker 比较两个场地，返回带有相对路径和版本前缀的 Markdown 建议。测试逐条核对引用及其对应的容量和费用，并排除旧版数值和无关来源中的细节。已鉴权的所有者验收封存的简报，并在常驻进程重启后读回同一产物。

归档 Bundle 于 2026-11-14 通过此项测试。测试仅结算一次 `deepseek-flash` 调用，输出上限为 256 个 token。通过的运行使用了 161 个输出 token，按配置的高峰费率估算费用为 419 微美元。此轮覆盖由所有者选定并提供来源，以及封存产物中的精确引用。自主选择来源和持久化的知识版本链接不在此轮验收范围内。[研究流程验证 #154](https://github.com/MosBot-AI/dsh-personal-agent/issues/154)

## 打包版本的提醒编辑与冷启动恢复

使用保留的归档运行提醒用例，无需模型凭据：

```sh
DSHPA_INSTALL_REMINDER=1 DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

已鉴权的所有者启用一条单次本地提醒，再编辑提醒文本和时间。编辑使提醒回到草稿状态，之前的版本随之失效。收件箱拒绝重新启用旧版本。所有者显式启用新版本后，原生调度服务取消原调度绑定，并为新版本建立绑定。

测试在两个到期时间之前停止常驻进程，等两个时间均过去后才重启。2026-11-14 的归档测试中，同一已安装的 Profile 只显示了一条版本 4 的提醒，保留了编辑后的文本和修订时指定的到期时间。SQLite 回执记录于该到期时间后 2.469 秒送达，并在第二次冷启动后保留。版本 2 未产生回执。收件箱报告模型调用、占用的 Worker 槽位和主动通知均为零。受控供应商未收到请求。此用例验证了原生本地提醒的投递和冷启动恢复。[提醒流程验证 #156](https://github.com/MosBot-AI/dsh-personal-agent/issues/156)

## 真实评审与经验证的技能复用

加载获授权的凭据，并使用保留的归档：

```sh
DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_REVIEW=1 \
  DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

已安装的 Worker 按同一规则评审三项独立的虚构库存变更。用例逐项核对了符合条件、超出数量上限、缺少支持记录的三项决定和理由，再通过所有者收件箱分别验收三个评审产物。两个产物作为可复用 Markdown 模板的示例，第三个产物具有独立的精确摘要值，用作留出验证。

不匹配的模板未通过验证，收件箱拒绝启用。修订版本与留出产物逐字节一致，经所有者确认后启用。输入新数据后生成有效的 Markdown，并记录一条已接受的反馈。重启后保留启用版本、反馈和三个模型产物。重放相同输入得到相同结果，复用同一运行 ID 提交不同输入则失败。

2026-11-14 的归档测试恰好结算三次 `deepseek-flash` 调用，输出分别为 41、39 和 38 个 token。按配置的高峰费率估算总费用为 914 微美元。复用未产生额外调用。复用模板时，由所有者提供决定字段。[真实评审验证 #158](https://github.com/MosBot-AI/dsh-personal-agent/issues/158)

## 真实代码补丁与可执行验证

在安装了 Git 和 Bubblewrap 的 Linux 上加载获授权的凭据，并使用保留的归档：

```sh
DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_CODE=1 \
  DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

所有者提供一个虚构的读数汇总模块，并指定零是有效读数。原有代码将 `[0, 10]` 的平均值算成 10，预期为 5。应用补丁前三个配套用例通过。已安装的 Worker 提出统一差异补丁，测试仓库仍保持干净。验证器确认差异仅修改 `readings.mjs`，执行 `git apply --check`，再将补丁应用到一次性仓库。四个测试全部通过，测试文件和 README 的内容保持完整。应用补丁后的测试在独立网络命名空间内运行，使用只读测试目录、清理后的环境变量及受限的 Node 权限。

已鉴权的所有者验收封存的补丁建议，并在常驻进程冷启动后读回同一产物。2026-11-14 的归档测试结算一次 `deepseek-flash` 调用，输出 118 个 token，按配置的高峰费率估算费用为 335 微美元。此用例验证在一次性仓库中由所有者应用的补丁建议。[真实代码补丁验证 #160](https://github.com/MosBot-AI/dsh-personal-agent/issues/160)

## 真实文档与数据整理

加载获授权的凭据，并使用保留的归档：

```sh
DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_ORGANIZATION=1 \
  DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
```

已鉴权的收件箱读取三份虚构库存文档，核对其原始字节、来源标识和 SHA-256 版本。所有者将记录提供给 Worker，并规定每个物品使用最新记录。封存结果包含 CSV 表格。测试在所有者侧将其导出到一次性文件，核对三个互不重复的条目、更正后的数量、每行采用的确切来源文件名，以及缺失位置的 `UNKNOWN`。原始文件的字节保持完整。已验收产物在冷启动后原样读回。

2026-11-14 的归档测试结算一次 `deepseek-flash` 调用，输出 61 个 token，按配置的高峰费率估算费用为 314 微美元。导出的 CSV 的 SHA-256 为 `5c5d9f82cabf8202bc7b48522462e2b3554814a43c2015a883508bccf2371d89`。测试用例从封存的 Markdown 产物导出 CSV。[数据整理验证 #162](https://github.com/MosBot-AI/dsh-personal-agent/issues/162)

发布仍需完成真实外部写入、其余工作流评测和七天试用。
