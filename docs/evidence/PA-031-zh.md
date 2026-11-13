# PA-031 桌面和浏览器租约证据

[English](PA-031.md)

[PA-031](https://github.com/MosBot-AI/dsh-personal-agent/issues/25) · 计划 `2026-11-07-r7` · 实现截至 `b7a9ce7dbb3bc1680d42509793e3eedcdfb857b0`。

## 已实现边界

- 所有者经认证后，可在今日为一次任务尝试授权精确的 macOS 应用或已配置的浏览器目标。操作系统支持的每用户保留在本地 Profile 之间串行化桌面工作流。浏览器路径将 Profile 租约绑定到新建的精确原生隔离标签页。每项模型操作均重新核对当前租约和原生目标。开始或继续都需要前台授权。
- macOS 路径使用 DSH Computer Use。它在模型调用前探测会话状态和辅助功能权限，然后使用提供者的应用授权与 AX 快照。浏览器路径使用 DSH Session 管理的 MCP 运行时与固定版本的无头 Chrome DevTools。提供者实施已配置的网络白名单，任务进一步将工具调用限定在自己的来源和标签页。操作按结构化页面 ID 路由，且仅接受有限顶层观察中提供的元素 ID。
- 接管会立即阻止新的输入，并保留在途操作的收尾状态。Worker 在原生退出后进入等待并释放计算槽位。继续会创建新租约并要求重新观察。浏览器 Session 退出时清理隔离上下文。
- 专用部署只允许使用受租约保护的模型工具。原生 Shell 和程序执行在此边界禁用。操作系统级沙箱需要另行配置具备强制隔离能力的执行后端。

## 检查

本地验证于 Asia/Shanghai 时区的 2026-11-08 在 macOS 15.7.9 arm64 上运行，使用 Node.js 26.7.0、pnpm 11.28.5、DSH 0.2.2-rc.1、Chrome 157.0.8103.38 和 Chrome DevTools MCP 1.9.0。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 类型检查、构建、263 项非 Web 测试和计划校验通过。 |
| `pnpm test:local-flow` | 11 条原生 Web 流程通过。桌面流程使用确定性提供者，核验模型调用前的权限等待、输入隔离、Worker 释放、新租约继续和并发后台工作。 |
| `pnpm test:resident` | 两条常驻检查通过，覆盖关闭界面时的运行、备份和受控重启。 |
| [Chrome 真实回环测试](../../packages/browser-chrome/README-zh.md) | 真正的隔离标签页接受并保存了精确测试值。白名单外的来源收到零个请求。导航在途时，使用同一浏览器 Profile 的第二个任务被拒绝。接管使任务进入等待，并释放原生 Worker。 |
| `python3 scripts/check_plan.py --check-sources`、协调测试和 `git diff --check` | 核对了固定来源路径、12 项协调测试、双语链接及空白格式。 |

| 场景 | 已验证的 PA-031 范围 |
| --- | --- |
| E02 | 桌面任务持有自己的资源，同时仅使用模型的后台任务完成。已有计算与调度回归测试通过。 |
| E07 | 已安装的 DSH 工具管线在桌面部署中拒绝无租约调用、程序调用和 Shell 调用。浏览器测试拒绝过期快照、被替换的标签页、跨来源导航和文件路径覆盖。真实测试中 Chrome 拒绝了发往白名单外来源的流量。 |
| E14 | 验证了租约到期、在途操作收尾期间的接管和继续前重新观察。隔离 Chrome 测试覆盖真实 Profile 竞争和接管。macOS 真机输入和人工接管仍待验证。 |
| E18 | 常驻回归测试通过。固定版本的 macOS helper 返回真实会话和权限状态。最后一次探测显示会话已锁定，且辅助功能和屏幕录制均未获授权。 |

macOS 真机验收需要所有者解锁会话、为签名的 DSH Computer Use helper 授予辅助功能权限，并批准一次性测试应用。AX 工作流需要辅助功能权限。屏幕录制状态单独记录。

[macOS 配置](../../README-zh.md#运行经授权的-macos-桌面任务) · [Chrome 配置](../../packages/browser-chrome/README-zh.md)

## 独立评审及所有者交接修复（2026-11-09）

独立评审的 PR #66 源提交为 `4fbcedd7f57cf54733d66ab027311e7ae454d0c6`。原有 `pnpm check` 的 263 项测试通过，原生 host、常驻及真实浏览器命令的 14 项测试也通过。但新增双来源用例复现了未获授权的数据披露：两个站点均属于部署目标，任务却只获得 A 的授权；B 仍收到 `GET /frame` 及携带公开测试值 `PA031 verified browser value` 的 `POST /click`，任务还进入了 `verifying`。请求计数及正文捕获的失败运行均作为评审证据保留，未涉及真实账号或用户私有数据。

随后所有者明确把修复交接给本次运行。候选版本集成 main `c3c613391be888fffd3885fd955fadc30e337912`，处理八个冲突文件，保留手机审批、媒体 schema v16 和较新的模型路由／计算边界。未新增数据库迁移，并核对 main 的存储 schema、媒体任务和手机审批实现源文件未被改写。

浏览器提供者现在在私有 Worker 设置阶段，把确切的 Agent 活动实例绑定到所有者批准的来源及租约，之后才启动 MCP 进程或浏览器。每个 MCP 进程只接收一个任务来源，而非整个部署的来源列表。固定版本的 `mountSessionMcp` 辅助函数只接受单一固定参数数组，无法选择逐任务的启动权限，因此适配器直接复用 DSH 的 `SessionResources`、`createScope`、浏览器注册及 `McpClient`。MCP 传输、工具定义和 Session 串行化仍由 DSH 管理，未实现另一套浏览器驱动。租约失效或接管会关闭 MCP 作用域；宿主启动失败时，也会等待桌面操作排空后才关闭存储。缺少绑定或提供者时，任务先进入等待，输入不会送到模型。

真实浏览器回归把两个配置站点分别作为获授权任务的目标：两者均能保存自己的值，而跨 Profile 的 iframe、POST、弹窗及重定向目标均未收到请求。原有的部署外来源拒绝、Profile 争用和接管用例继续保留。原生 Web 夹具还检查缺少浏览器提供者的情况，验证 `worker_inputs.status = not_delivered`。CI 在手机／媒体／常驻套件之外，新增使用明确 Chrome 路径运行的两个浏览器用例。

环境：Debian GNU/Linux 13、Linux 6.12.111 x86_64；Node.js 24.14.1；pnpm 11.28.5；Chromium 154.0.8037.92；DSH 0.2.2-rc.1；Chrome DevTools MCP 1.9.0。在一次性工作树／Profile 的仓库根目录执行命令，测试使用回环端点。

| 准确命令 | 独立结果 |
| --- | --- |
| 在原始 PR 源提交上执行 `pnpm check` | 通过：263 项测试、类型检查、构建及计划校验。 |
| 在原始 PR 源提交上执行 `DSHPA_TEST_CHROME=/usr/bin/chromium pnpm exec vitest run tests/e2e/local-flow.spec.ts tests/e2e/resident.spec.ts tests/e2e/browser-live.spec.ts` | 通过：14 项测试（11 项原生 Web、两项常驻、一项真实浏览器）。 |
| 在原始 PR 源提交及隔离评审夹具上执行 `DSHPA_TEST_CHROME=/usr/bin/chromium pnpm exec vitest run tests/e2e/browser-multiorigin-review.spec.ts` | 按预期失败：只有 A 的任务租约，B 却收到两个请求及测试值。此评审专用文件名不属于交付测试。 |
| 在集成候选版本上执行 `pnpm check` | 通过：319 项测试、类型检查、构建及计划校验。 |
| `DSHPA_TEST_CHROME=/usr/bin/chromium pnpm exec vitest run tests/e2e/browser-live.spec.ts tests/e2e/browser-multiorigin.spec.ts` | 通过：两项真实浏览器用例，包含扩展后的双 Profile 回归。 |
| `DSHPA_TEST_CHROME=/usr/bin/chromium DSHPA_CHROME_PATH=/usr/bin/chromium pnpm exec vitest run tests/e2e/local-flow.spec.ts tests/e2e/resident.spec.ts tests/e2e/media-host.spec.ts tests/e2e/mobile.spec.ts tests/e2e/browser-live.spec.ts tests/e2e/browser-multiorigin.spec.ts` | 通过：26 项测试（11 项原生 Web、两项常驻、六项媒体 host、五项移动测试，其中三项使用桌面 Chromium，以及两项任务浏览器测试）。此命令没有跳过用例。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'` | 原始源提交及集成版本均通过 12 项测试。 |
| `python3 scripts/check_plan.py` 和 `git diff --check` | 通过。缺少本地上游源码检出目录，未重新执行 `--check-sources`。 |

首次集成类型检查因未导入浏览器服务的类型扩展而失败；修正后全量检查通过。离线安装缺少包策略元数据缓存；在线安装保留包策略校验，锁文件记录了适配器直接使用的固定版本 DSH 依赖。

本次评审不能证明实体 macOS 输入／接管、锁屏／休眠唤醒、实体手机、真实 ComfyUI／GPU 或发布验收通过。PA-031 保持审查中，不添加 `acceptance:verified`，直至完成适用的真实桌面验收。当前 GitHub CLI 未登录，插件也无法操作私有 Project 字段；明确交接及进度记录在 Issue #25。用户知识库 `/Users/charleypeng/Documents/llmwiki` 不可用。

## 历史 Linux 原生就绪检查切片

此前仅验证就绪状态的候选版本识别 Linux 上已经挂载的 `cua-driver-native` 提供者，只在现有桌面租约内执行固定版本的只读权限探针。**不开放**应用发现、截图、输入、模型调用或前台重试。未知 OS 锁屏状态报告为 `session_state_unavailable`；不支持的 Wayland 报告为 `unsupported_desktop`。缺少 X11/AT-SPI/输入能力时仍等待权限。部署守卫继续阻止直接调用原始提供者工具。替换提供者、畸形或错误响应、租约丢失均拒绝放行。原生 D-Bus 地址不会返回给 Worker。

合约审计：DSH 提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 的[原生提供者](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/computer-use-cua-driver-native)固定依赖 `@trycua/cua-driver@0.28.0`。SDK 源码标签 `cua-driver-rs-v0.28.0` 对应 [trycua/cua](https://github.com/trycua/cua/tree/1b50c02e2d34734f64d2d22f54eb76cc97b4a663/libs/cua-driver/rust) 提交 `1b50c02e2d34734f64d2d22f54eb76cc97b4a663`。Linux 的 `platform-linux/src/tools/impl_.rs` 为 `check_permissions` 定义严格空参数，返回 X11、Wayland、AT-SPI 和输入能力布尔值；macOS 风格的 `{prompt:false}` 不是 Linux 合约。`cua-driver-contract/src/outputs.rs` 明确说明 `desktop_unlocked` 代表截图范围授权，不是 OS 锁屏探针。`platform-linux/src/input/delivery.rs` 警告 Wayland 后台输入可能发往合成器焦点。这些信号都不足以授权安全的精确窗口输入。

剩余实现：可信 OS 会话锁屏观察、Linux XDG 应用身份（不能假定为 macOS Bundle ID）、精确的存活 PID/窗口绑定、每窗口的新鲜 Token，以及仅后台操作的结果验证。物理锁屏、睡眠/唤醒和原生输入验收仍未验证。仅验证就绪状态的候选版本使用反向域名应用标识，并保留进程和窗口标识的权限边界。未改变权限、电源或安全设置，未调用模型，也未尝试真实原生操作。

验证采用无密钥的确定性能力结果，不是原生设备实测。独立审查未发现此仅就绪边界的阻塞安全问题，建议补充在途接管及宿主准入回归，两项均已补充。变更前基线类型检查和构建通过，但全套中一个既有调度恢复断言失败（328/329）；单独重跑全部六项调度测试通过。该基线波动不归因于 Linux 变更。用户知识库路径不可用；以上源码结论均依据固定上游版本核查。

候选版本验证环境：Linux x86_64、Node.js 24.22.1、pnpm 11.28.5。类型检查和构建通过；12 项 Linux 边界测试与两项原生宿主桌面测试通过（11 项无关 Web 用例按名称过滤，未声称通过）。计划校验、12 项协调测试和空白检查通过。完整 `pnpm check` 的 341 项中通过 340 项，同一个变更前已存在的调度恢复断言失败；限制测试并发也复现。因此完整测试门禁**并非全绿**。不请求自动合并或标记验收完成。本次实验界定了上游能力授权可作为会话锁屏证据的范围。

## 显式 Linux 目标配置

[Issue #77](https://github.com/MosBot-AI/dsh-personal-agent/issues/77) 的配置变更整合了 [#74](https://github.com/MosBot-AI/dsh-personal-agent/pull/74) 和 [#78](https://github.com/MosBot-AI/dsh-personal-agent/pull/78) 已评审的范围。`linuxApplications` 接受精确 XDG ID，与现有 macOS `applications` 列表分离。持久授权使用独立 `linux:` 命名空间。切换提供者不能重新解释既有 macOS 任务授权。仅配置标识不会启动或发现原生应用。

已配置 Linux 目标携带 `unavailableReason=linux_binding_unavailable`。今日页面显示本地化不可用说明并禁用启动；服务端独立拒绝直接启动，发生在上下文、租约和 Worker 设置之前。这取代之前仅就绪的启动路径：Linux 目标配置不会占用 Worker 或调用提供者，去重新发现已知缺失的安全边界。最终运行时移除未使用的就绪探针及其两个专用等待原因。现有 macOS 目标不会选择 Linux 提供者。

固定版本 SDK 的 `platform-linux/src/tools/impl_.rs` 以可执行文件基名和歧义启发式把已安装 XDG 条目关联到进程。其 `bundle_id` 不是可信的应用到进程绑定。官方 [logind 文档](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html) 将 `LockedHint` 定义为桌面环境报告的状态；仅 false 不能证明会话已解锁。不依据这些假设启用发现、快照或输入适配器。进程生命周期/PID 复用保护、精确原生窗口所有权、新鲜 Token 和可信会话/锁屏器集成仍是实现门禁。

历史堆叠验证：35 项桌面单测、两项原生宿主桌面用例和两项双语界面用例通过；类型检查、构建、计划、12 项协调测试和空白检查通过。交叉审查未发现阻塞准入/界面缺陷。精确堆叠候选版本全套通过 360/361，只有此前已复现的 #75 调度竞态失败。临时应用**待合并 PR #76 中仅两个测试文件的变更**后通过 361/361，随后已撤回这些变更，不包含在此 PR 中。组合验证全绿与精确候选仍有基线失败明确区分。在该检查点，两个原 PR 均尚未合并。

整合后的变更让运行时配置与「今日」客户端共用上限：16 个 macOS 应用、16 个 Linux 目标和 8 个浏览器 Profile。固定版本的原生 Web 套件验证了经认证的 24、25 和 40 个目标快照均可读取。实际提供的浏览器 Bundle 拒绝了刻意注入的第 41 个目标。Linux 启动测试验证直接 RPC 返回 `linux_binding_unavailable`，未创建 Worker 输入，且 macOS 授权仍沿原路径处理。实体 Linux 输入、锁屏及睡眠唤醒验收仍由 [Issue #25](https://github.com/MosBot-AI/dsh-personal-agent/issues/25) 跟踪。

## 全新 tarball 安装的浏览器启动（2026-11-13）

[Issue #102](https://github.com/MosBot-AI/dsh-personal-agent/issues/102) 在已合入的 main `917e84e` 上复现了打包安装特有的故障。全新的 DSH Profile 安装了可选浏览器 tarball，也启动了 Chrome DevTools MCP，但持有租约的 Agent 找不到原生工具，任务在 Chromium 启动前进入 `driver_unavailable` 等待。两份 DSH 作用域模块版本和字节均相同，但 Profile 内的副本创建了独立的作用域标识。在一次性诊断副本中复用固定版本宿主的作用域模块后，同一租约工作流恢复运行。

浏览器包现将固定版本的 DSH 作用域和 MCP 客户端声明为宿主 peer。工作区构建完成后，原生回归将核心与浏览器分别打包，并安装到 DSH 生成的全新 Profile，验证两项宿主 peer 均未安装在 Profile 内。通过身份认证的所有者在本地回环测试页启动带租约的任务。测试校验实际保存值、排除来源零流量、所有者显式验收、Profile 争用和接管。在 CI 中设置 `DSHPA_TEST_BROWSER_TARBALL=1`，将此用例和工作区浏览器用例一并执行。

本地回归使用 DSH 0.2.2-rc.1、Chromium 154.0.8037.92、Chrome DevTools MCP 1.9.0、Node.js 24.14.1 和 pnpm 11.28.5，验证了打包版 Chromium 启动及浏览器租约流程。上文的实体桌面验收仍待完成。
