# PA-033 持久化本地媒体验证证据

[English](PA-033.md)

[PA-033](https://github.com/MosBot-AI/dsh-personal-agent/issues/33) · 计划 `2026-11-07-r7` · 初始实现 `740fe3436008fa07e1a5ab0e12864db010484dfb`。集成后的 schema 16 行为记录见下文。

## 已实现

- 可选的常驻服务在 SQLite v16 中排队处理限定范围的图片和视频任务。按模态选择配置的免费本地提供器，固定其配置，检查当前尝试，并限制队列与每次尝试的提交数量。冷启动后保留单个媒体租约。准备阶段遇到限流时先等待，再进入可执行队列按顺序处理。该循环独立于 Worker 槽位运行。
- ComfyUI 0.44.0 适配器接受使用已安装模型的已批准 API 图，并探测本地服务、CPU 或 GPU 和输出文件系统。请求发出前，SQLite 提交客户端分配的 prompt ID、请求与工作流摘要、种子及精确的提供器标识。提交结果不明确时，以同一凭据进入回查。队列与历史都查不到时，结果保持未决并继续占用租约。
- 适配器验证归属绑定后，才调用 ComfyUI 的单任务取消路由。它从已批准的输出节点下载有大小上限的文件，探测媒体类型、尺寸和时长，解码媒体流并计算 SHA-256。任务保存已验证的元数据，文件保留在 ComfyUI 中。 [提供器配置](../../packages/media-comfyui/README-zh.md)
## 媒体回归测试环境

此前媒体回归使用模拟 ComfyUI v0.44.0 HTTP 行为的本地回环服务。该次测试环境没有安装 ComfyUI。模拟服务返回的 PNG 和 MP4 都由 FFmpeg 生成，文中记录的 SHA-256 是这些样本文件的摘要。

- 在 [Issue 评论建议的丢响应场景](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6715554235) 中，模拟服务记录一次 POST，将模拟任务入队，再在响应前关闭套接字。请求到达时，另一条 SQLite 连接已能读到准备记录。调用端重新打开存储与注册表，经历一次空回查，随后核对同一模拟任务的 prompt ID 和样本 PNG 摘要。最终 POST 仍只有一次。
- 在进程崩溃场景中，模拟服务记录提交并挂起响应。测试向自己启动的一次性 dshpa 调用进程发送 `SIGKILL`。SQLite 仍保存 `submitting` 状态和预分配的 prompt ID。另一个进程打开同一数据库，核对模拟任务并验证 FFmpeg 样本摘要。模拟服务总共记录一次 POST。

## 验证

2026-11-08（Asia/Shanghai）在 macOS arm64 本机运行，使用 Node.js 26.13.0、pnpm 11.28.5 和 FFmpeg 9.0.2。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 退出码 0。类型检查、原生包与提供器构建、49 个测试套件中的 282 项测试及计划验证通过。7 个媒体用例涵盖响应丢失、调用进程崩溃、范围隔离与取消竞态、准备限流、拒绝不安全节点及重定向、损坏文件、受控 OOM 状态，以及可解码且摘要一致的 PNG 与 MP4 样本。 |
| `pnpm test:local-flow` | 退出码 0。10 个原生 Web 流程用例通过。 |
| `pnpm test:resident` | 退出码 0。2 个原生常驻宿主用例通过。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'`、`python3 scripts/check_plan.py`、`git diff --check` | 退出码 0。12 个协调用例、双语链接和空白检查通过。 |
| `python3 scripts/check_plan.py --check-sources` | 退出码 1。固定的上游检出路径不可用。PA-033 的清单中没有上游源码路径。 |

2026-11-09，`pnpm check` 通过 49 个套件中的 283 项测试，包括 8 个媒体用例。新增 HTTP 夹具报告任务已完成，随后在连续两次读取输出时分别返回 503 和 404。收到 503 后继续等待收集。收到 404 后任务失败，释放媒体租约，并允许下一个排队任务提交。重试原操作会返回记录中的失败结果，无需第二次 POST。

可显式启用的 `pnpm test:media-live` 入口现可在现有 ComfyUI 实例上验证回执丢失。它从一个进程提交，由本地中继在上游接收后丢弃响应，再启动新进程从同一 SQLite 数据库恢复原 prompt。中继独立计算输出字节的摘要。未设置配置，因此真实用例跳过。另有两个使用模拟上游的回归，分别用 PNG 和 MP4 样本验证该入口，`pnpm check` 通过全部 285 项工作区测试。 [真实后端配置](../../packages/media-comfyui/README-zh.md#使用现有实例验证恢复)

`pnpm test:media-host` 用例在固定版本的原生 DSH Web 宿主上通过，测试启用了常驻模式。DSH Profile 装载独立的 ComfyUI 包，可信探针调用宿主提供的 `dshpaMedia` 服务，并验证旧尝试代次被拒绝。模拟上游断开提交响应后，第一台宿主退出时 SQLite 中的任务仍未解决。第二个就绪的宿主打开同一 WorkStore 并取回原 prompt 对应的样本 PNG。SHA-256 与 FFmpeg 样本一致，模拟上游只收到一次 POST。此检查使用模拟 ComfyUI HTTP 服务。

## 初始回归的验收范围

E06 使用持久化数据库验证受控传输故障与操作系统进程崩溃。E09 覆盖本地队列限制、串行执行与受控限流。E16 覆盖经 FFmpeg 生成及解码的样本、在模拟服务上验证的限定范围取消，以及模拟的后端 OOM 状态。E18 有原生常驻宿主冒烟套件，以及单独的媒体调用端重开验证。E21 有独立构建的提供器与固定配置回查。

这些回归完成时，实际 ComfyUI 图片和视频渲染、真实 GPU 可用性与 OOM、物理宿主运行中任务的取消，以及实际睡眠唤醒后的媒体恢复仍待验收。HTTP 夹具与 FFmpeg 生成样本提供上述已验证范围的证据。 [ComfyUI v0.44.0 路由](https://github.com/Comfy-Org/ComfyUI/blob/v0.44.0/server.py)


## 评审修复：输出中断与持久化 GPU 租约

2026-11-09 的云端 Linux 验证使用 Node.js 24.22.1、pnpm 11.28.5 和 FFmpeg 7.1.5。模拟 HTTP 200 响应仅发送部分 PNG 后断开连接。收集保持可重试且继续持有租约；重新打开 WorkStore 后恢复原输出哈希，渲染提交总共只有一次。独立流测试覆盖响应体超时，以及必须仍判定为无效的超限响应体。`pnpm check` 的类型检查、构建、50 个测试文件中的 288 个测试和计划验证均通过；`git diff --check` 通过。

原生 DSH Web 宿主还在 WorkStore 包含渲染中任务时以关闭媒体的配置启动。GPU 准入拒绝新工作，且不会调用其操作。排队中、不持有租约的任务作为正对照，允许 GPU 工作。`pnpm test:media-host` 的三个用例全部通过。这是使用模拟媒体的原生宿主准入检查，不是物理 GPU 并发验收。

上述传输与租约修复未修改数据库迁移。后续 #71 优先的迁移整合记录见下文。这些修复完成时，真实 ComfyUI、GPU、取消和睡眠/唤醒检查仍待完成。

## 独立集成与取消修复

2026-11-09（UTC），按所有者授权，在 #71 合并后，将 PA-033 变基到实际 main `07579662e0747acdac1ad34f0f823c41e9ec8b0d`。移动端迁移 014 和 015 保持不变，媒体迁移为 016。集成保留两类 WorkStore 服务、关闭媒体配置时的媒体租约准入检查、两类宿主关闭及启动失败清理流程、两项原生 CI 检查和隔离的 Linux 浏览器总线。

通过精确核对媒体表、约束和索引识别原媒体专用 v14。升级前生成私有 v14 备份，保留任务、已准备的提示词及租约，仅补建缺失的移动端表。未知或混合的媒体 v14 结构会失败，不会重新标记来源数据库版本。新存储、v13 及移动端 v14/v15 均可到达 v16；移动端升级保留已注册凭据。回滚使用匹配的来源版本备份，而非用旧构建直接打开 v16。恢复会升级可识别的旧快照、清除移动凭据、禁止派发并保留未决媒体租约。原移动端 v14 测试夹具现移除所有 v14 之后的表；另有真实 DDL 夹具验证兼容性，不依赖这种模拟降级方法。

取消现也会在 collecting 状态持久记录。系统中止可取消的读取，在收集前及提交输出前检查保存的决定。提供器忽略中止时，仍保留租约直到实际操作结束，迟到的成功不会发布输出。冷启动后继续执行取消。取消回执丢失且未能回读终态时，任务保持不确定并持有租约，不重新提交渲染。

验证环境为 Debian 13 x86_64、Node.js 24.14.1、pnpm 11.28.5、DSH 0.2.2-rc.1、Chromium 154.0.8037.92 及 FFmpeg 7.1.5：

- `pnpm check`：在基于实际 main 的集成上，类型检查、构建、53 个套件的 310 项测试及计划校验通过。
- `dbus-run-session -- env DSHPA_CHROME_PATH=/usr/bin/chromium pnpm exec vitest run tests/e2e/local-flow.spec.ts tests/e2e/resident.spec.ts tests/e2e/media-host.spec.ts tests/e2e/mobile.spec.ts`：23 项通过，包括 10 项本地 Web、两项常驻宿主、六项媒体宿主及五项移动端用例。关闭媒体配置后的冷启动检查覆盖 submitting、unknown、rendering、collecting 租约，并以 queued 作为允许执行的正向对照。三项浏览器用例使用真实桌面 Chromium，不是实体手机。
- `python3 -m unittest discover -s tests/coordination -p 'test_*.py'`：12 项通过。`git diff --check` 及中英文链接通过。
- 六项真实 DDL 迁移用例验证旧版任务和租约保留、迁移备份可读、恢复限制、拒绝被改动的媒体 v14 结构，以及 DDL 失败回滚。真实响应体超时后，重开存储可恢复相同输出摘要，渲染仅提交一次。
- `pnpm test:media-live`：因未设置 `DSHPA_COMFYUI_LIVE_CONFIG` 跳过一项；退出码零不代表真实环境验收。固定的本地上游 checkout 不可用，无法完成 `--check-sources`。

此次集成验证完成时，真实 ComfyUI 生成、物理 GPU/OOM 和运行中渲染取消、实际睡眠/唤醒，以及实体手机和已部署 HTTPS 验收仍待完成。此前并发评审负载下曾失败一次的 schedule 恢复用例在本次最终工作区检查中通过；之前的根因尚未证实。测试未使用生产数据或部署。

## 独立真实 ComfyUI CPU 恢复验证（2026-11-09）

所有者指定当前 Linux 笔记本作为开发及验收主机。本次运行使用未修改的 dshpa main `c3c613391be888fffd3885fd955fadc30e337912`，对官方 ComfyUI v0.44.0、提交 `2c75dc1b379a59e0880619d029607af5169a62ef` 独立复现了新报告的无模型 CPU 用例。未修改适配器、测试中继或验收测试源码。

环境：Debian 13 x86_64、Python 3.13.5、PyTorch 2.15.0+cpu、torchvision 0.29.2+cpu、Node.js 24.14.1、pnpm 11.28.5 及 FFmpeg/ffprobe 7.1.5。依赖安装在 `/tmp/dshpa-comfy-live-20261109/venv`，CPU 版本约束避免替换成 CUDA 构建。`pip check` 通过，`torch.version.cuda` 为 `None`，服务只报告 CPU 设备。完整依赖冻结清单及安装日志均已保留。

服务使用临时回环端口、一次性输入／输出／用户／模型目录、`--cpu --offline --disable-all-custom-nodes --disable-auto-launch`，并启用 Hugging Face／Transformers 离线设置。评审后的工作流为内置 `EmptyImage`（64×64、单张、恒定蓝色）-> `SaveImage`，另有未连接的内置 `RandomNoise.noise_seed`，用于满足适配器要求的数字种子绑定。提示词绑定到 `SaveImage.filename_prefix`。未安装模型权重或自定义节点。

固定版本检出目录中的准确应用命令：

```sh
pnpm build
DSHPA_COMFYUI_LIVE_CONFIG=/tmp/dshpa-comfy-live-20261109/provider.json pnpm test:media-live
```

构建通过。现有 live 测试通过一项用例，没有跳过。中继在派发前核对持久化提示 ID／请求，丢弃已接受提交的响应，并验证新调用进程使用同一个提示 ID 恢复输出摘要，且仅发生一次 POST。标准测试报告器隐藏成功用例的控制台输出；下述独立服务／历史／输出读取保留了具体标识。

| 独立观察 | 结果 |
| --- | --- |
| ComfyUI 历史及服务日志 | 一条历史记录、一条 `got prompt` 日志；已完成提示 `b05bb32a-8b2e-41be-8833-1c2c8e8d285e`。 |
| 输出目录 | 恰好一张 PNG，481 字节。 |
| ffprobe | PNG 编码，64×64。 |
| 独立文件 SHA-256 | `f20b2af6d426c86184cb205ca7cadb5fecdf676bfdacfa477d60bfd0fbabc70c`。 |
| 源码／状态隔离 | 测试时 dshpa 检出目录在对应 main 提交上保持干净；全部服务状态均为一次性数据。验证后已停止本次创建的服务。 |

这证明了无模型 CPU 夹具中的真实本地 ComfyUI 传输、输出解码和提交响应丢失恢复。恒定颜色工作流不验证提示词遵循、模型图片／视频质量、实体 GPU／OOM、运行中渲染取消或休眠唤醒。此次运行结束后，这些验收项仍未完成，PA-033 保持 In review。

## 使用真实模型的 CPU 验收（2026-11-12）

Linux 笔记本运行未修改的 dshpa main `917e84efaf26c00f7a62b3b02c6253be72e8b8ed` 和官方 ComfyUI 0.44.0 提交 `2c75dc1b379a59e0880619d029607af5169a62ef`。一次性回环实例使用 PyTorch 2.15.0+cpu 和本机已安装的模型权重。FFmpeg 独立解码生成的产物。

- **图片提交回执丢失。** 将 `DSHPA_COMFYUI_LIVE_CONFIG` 指向一次性提供器配置后，`pnpm exec vitest run tests/e2e/media-live.spec.ts --disableConsoleIntercept --reporter=verbose` 通过一项用例，没有跳过。SD 1.5 图使用内置节点和六步 Euler 采样生成一张 256×256 图片。中继丢弃已接受提交的响应，新 WorkStore 调用进程在一次 POST 后恢复 prompt `2653817e-e205-41a3-b692-97dd77a5bb25`。提供器历史和文件回读确认只生成一张 65,853 字节的 PNG，SHA-256 为 `00221472aa3868d58b118211a94eb73ed2eed11cea806e3449a88ad58e4d1c47`。[图片和取消验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6823972690)
- **运行中任务取消。** 使用两个一次性 WorkStore 时，ComfyUI 记录 SD 1.5 prompt `324d96c2-951e-4eea-866a-b7aa8672e607` 已执行到第 1 步，共 24 步，对照 prompt `8c2a9f24-d405-4af2-acbb-b7a75f5fb742` 仍在排队。中继记录两次提交及一次发给运行中 prompt ID 的取消请求。ComfyUI 记录 `execution_interrupted`。冷重开确认目标 WorkStore 仍记录 `cancelled`，无输出且租约已释放。对照任务完成并生成一张 64×64 PNG，SHA-256 为 `ee3c489b8d2710d6f6b04a54e766b9010ca3f5a8dcebd2b73d33b21e0f8ad161`。[图片和取消验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6823972690)
- **常驻宿主重启。** 对原生媒体宿主测试的临时适配组合了固定版本 DSH 0.2.2-rc.1、真实 SD 1.5 提供器和现有回执丢失中继。中继阻止回读，直至第一个一次性宿主停止。另一个就绪宿主打开同一 WorkStore，恢复 prompt `c5a88c0f-0aee-496f-9551-0a30d99ea3f8`，并在收集输出后释放持久化的未决租约。临时用例 `tests/e2e/media-host-live-local.spec.ts` 在 19.23 秒内通过，提供器仅收到一次 POST。解码的 256×256 PNG 为 52,220 字节。其 SHA-256 `11c109c882e64361aefc601a5073549d04bd6bf092db247a763e143243ca6f09` 与中继和 WorkStore 一致。[常驻宿主和视频验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6824813990)
- **提供器断线后的同实例恢复。** 对原生媒体宿主测试的临时适配先接收 prompt `5c031daf-a163-4749-b455-04cab6906944` 的回执，再断开两次提供器读取请求。SQLite 记录 `unknown/provider_unavailable`，保留原 prompt 和租约。另一条提供器读取请求仍处于挂起状态时，就绪检查和包含测试任务的认证 Inbox 快照均返回 HTTP 200。未认证的 Inbox 请求返回 HTTP 401。连接恢复后，同一常驻实例收集原输出并释放租约。ComfyUI 记录一次 POST 和一个成功的 prompt。FFmpeg 解码了 57,688 字节的 256×256 PNG。其 SHA-256 `3dd0fbe5de6b984723b0ff876a6268a927718d217b5c1bf2a989a59ae591eae6` 与 WorkStore 一致。[提供器断线验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6825566165)
- **较早的视频尝试。** 一次 Wan 尝试在 CPU 文本编码器加载期间使宿主交换空间用量增加约 684 MiB，触发资源保护后停止。SQLite 将已接受的任务保留为 `unknown`。[停止的视频尝试](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6824358063)
- **受资源限制的 Wan 恢复。** 同一真实后端测试命令使用本机 Wan 2.1 1.3B UNet、UMT5 编码器和 VAE，在 312 秒内通过一项用例。中继丢弃已接受提交的响应，新 WorkStore 调用进程在一次提交后恢复同一 prompt `b876c51a-d89e-4e36-880c-edb7a0e25855`。FFmpeg 解码全部 17 帧，各帧摘要互不相同。H.264 MP4 为 256×256、16 fps、1.0625 秒及 36,234 字节。文件 SHA-256 `3cc1fbf6d1970bb740dc7f0257dee251a5ccba3f7a8f737d661bc074356709cb` 与中继和 WorkStore 一致。一次性 cgroup 使用 16 GiB 软限制、18 GiB 硬上限且禁用交换空间。峰值 cgroup 内存计费为 16.00 GiB，宿主最少可用内存为 29.73 GiB。cgroup 采样记录的交换空间用量和 OOM 事件计数均为零。临时提供器在各自测试结束后停止。[常驻宿主和视频验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6824813990)

## CUDA 生成与限额内的分配器 OOM（2026-11-12）

相同的 dshpa 和 ComfyUI 修订使用 PyTorch 2.11.0+cu128 在 RTX 3080 Laptop GPU 上运行。两个一次性回环提供器都使用原生 CUDA 分配器和经核实的进程级分配上限。每次运行期间，NVML 均采样提供器的显存用量和设备剩余显存。

- **受控 CUDA 分配失败。** 使用 `--gpu-only` 和经核实的 128 MiB 原生分配器上限时，内置 `EmptyImage` 工作流尝试为首个通道张量分配 256 MiB。ComfyUI 仅接受一次 prompt `713e0210-fe34-4fc9-9563-a284a227cb8c`，并记录 `torch.OutOfMemoryError`。冷重开后，WorkStore 保留 `failed` 和原因 `provider_failed`，无输出且租约已释放。同一提供器随后收到一次 POST 并完成对照 prompt `dc0a3209-fc48-4a09-ba01-323663be6e93`。FFmpeg 解码其 64×64 PNG，独立计算的 SHA-256 `ee3c489b8d2710d6f6b04a54e766b9010ca3f5a8dcebd2b73d33b21e0f8ad161` 与 WorkStore 一致。提供器采样峰值显存为 188 MiB，设备采样最少剩余显存为 9,628 MiB。
- **SD 1.5 CUDA 提交回执丢失恢复。** 现有 `tests/e2e/media-live.spec.ts` 在原生分配器上限为 2.5 GiB、扩散采样使用 CUDA、文本编码器和 VAE 位于 CPU 的配置下通过。ComfyUI 仅接受一次 prompt `e5b4918f-4bb7-48de-8cc5-aacd76dc92aa`。丢弃已接受提交的响应后，新调用进程恢复了同一 prompt 及原始输出。独立解码验证了 256×256 PNG，文件为 78,333 字节，SHA-256 为 `581b390d3f73991fdb1f004cbcbf1a5990f8d4769ed93ea8b077c1ce613a281c`。提供器采样峰值显存为 2,028 MiB，设备采样最少剩余显存为 7,788 MiB。两个临时提供器均在验证后停止。[GPU 验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6825106305)

## 提供器配置切换（2026-11-12）

临时原生测试使用相同的 dshpa 和 ComfyUI 修订、通往同一 CPU ComfyUI 实例的两条独立审计回环路由，以及每个配置修订各自获准的内置图片工作流。修订 1 的提交已被接受，但中继丢弃了回执。常驻宿主随后重启，仅挂载修订 2。原任务保留修订 1 绑定，进入 `unknown/provider_unavailable` 并继续持有租约。新任务绑定修订 2 并排队。在修订 1 不可用期间，修订 2 路由没有收到请求。

再次重启后，宿主同时挂载两个修订，并为新任务选择修订 2。Prompt `7ce41451-81fa-4300-a4da-93539b75f163` 经修订 1 恢复。排队的 prompt `62b9258d-3b48-4b5a-af34-b7c067f78176` 经修订 2 完成，租约随后释放。每条路由收到一次 POST，只回读各自 prompt 的历史。FFmpeg 独立解码了两张 64×64 PNG。按修订顺序，其 SHA-256 分别为 `ee3c489b8d2710d6f6b04a54e766b9010ca3f5a8dcebd2b73d33b21e0f8ad161` 和 `4dc45eff1ecc24a8d8036f58e59ec0b14e533ec3e5b7a268a952baa6754139bb`，均与 WorkStore 一致。这验证了 E21 的配置路由路径。[配置切换验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6825638729)

## 校验临时存储耗尽后的恢复

回环 HTTP 夹具为一个已完成的 prompt 提供由 FFmpeg 生成的有效 PNG。测试分别在校验器创建私有目录和写入输入文件时注入 `ENOSPC` 与 `EDQUOT`。旧实现的四种情况都以 `invalid_result` 失败。适配器现返回 `busy`，任务保持 `collecting`，并在冷重开 WorkStore 后继续持有租约。存储恢复可用后，FFmpeg 解码 PNG，写入的 SHA-256 与夹具一致。每个用例只提交一次 prompt。

文件写入用例同时验证部分写入文件的清理，以及清理报告错误时原容量错误的保留。另一个用例在清理期间取消，确认提供器返回 `cancelled`。已有的损坏输出测试仍返回 `invalid_result`。这些检查使用故障注入和回环提供器夹具。[恢复工单 #123](https://github.com/MosBot-AI/dsh-personal-agent/issues/123)

## 提供器队列响应超限后的恢复

[工单 #127](https://github.com/MosBot-AI/dsh-personal-agent/issues/127) 使用 ComfyUI HTTP 夹具复现了两种故障。九个无关待处理工作流使队列响应超过 4 MiB 上限。实际已完成但仍处于 `rendering` 的渲染转为 `unknown`，已进入 `collecting` 的任务则在读取输出前失败。

状态查询仍先读取实时队列。队列响应体超限时，适配器可在校验 prompt ID 和归属绑定后，从精确的 prompt 历史恢复终态。输出收集直接读取精确历史，并验证已记录的获准节点的输出。缺失或不匹配的历史不能作为成功依据。取消仍要求实时队列提供归属证据。

两项持久队列用例都恢复了原始 prompt 并核对 PNG 的 SHA-256，只提交一次且未发出取消请求。提供器测试验证了精确历史的作用域、队列超限时的取消，以及可读取的队列拒绝归属或普通队列响应失败时不会回查历史。这些证据来自受控的回环提供器夹具。

## Chromium 工作台关闭时的常驻媒体运行

在已合并的主分支 `1934e34` 上，DSH 0.2.2-rc.1 将构建好的常驻组件和媒体包加载到一次性配置中。Chromium 154.0.8037.92 以已鉴权的所有者身份打开「待办」，并显示测试任务。真实 ComfyUI 0.44.0 使用本地 SD1.5 检查点、PyTorch 2.15.0+cpu 和 24 步 256×256 工作流，在没有外网路由的私有网络命名空间中运行。

准确的提示任务仍在运行且持久租约仍被占用时，Chromium 关闭了工作台标签页。该标签页消失后，原提示任务仍在运行，且常驻服务源上已无任何标签页。标签页保持关闭期间，同一个常驻进程与就绪实例校验了渲染结果。中继只观察到一次提交。提示任务与准备记录和已提交的值一致，租约随后释放。

提供方文件、中继字节和 WorkStore 的 88,439 字节 PNG 的 SHA-256 均为 `61a2c5afcc900baff57b22fa43bee016f8f9ba0de4a7a3e5b93f5bd6cadb1b2c`。FFmpeg 解码了 256×256 PNG。新的 Chromium 标签页在同一常驻服务中打开「待办」，显示了同一任务。浏览器通过鉴权读取的收件箱快照也返回了该任务。测试进程退出后，私有网络中没有残留的 TCP 监听端口。[E18 工作台关闭验收证据](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6856211291)

## 目标设备锁屏与解锁（2026-11-14）

在实体 Linux X11 控制台上，设备所有者进行了锁屏和解锁。DSH 0.2.2-rc.1、ComfyUI 0.44.0 和 Chromium 154.0.8037.92 在一次性测试环境中运行，运行时代码与主分支 `caeca57c899d22adb7947b555e77c702a64b0b06` 一致。ComfyUI 使用本地 SD1.5 检查点和 PyTorch 2.11.0+cu128，以 CPU 模式进行 64 步渲染。

原桌面恢复前，LightDM 登录界面至少持续显示了 33.73 秒。锁屏期间观察到 prompt `2d7a8ea1-ed69-4580-8979-15b5c3f5f7a9` 正在执行并持有渲染租约。锁屏期间和解锁后，同一 DSH 进程均向已鉴权的 Chromium 返回了原任务，HTTP 状态为 200。

ComfyUI 仅收到一次提交并完成了原 prompt，DSH 随后释放租约。FFprobe 确认产物为 98,580 字节、256×256 的 PNG。提供器文件、中继字节和 WorkStore 的 SHA-256 均为 `f8d6dd387d5ef01ac4912a6075de2b4e19479ddb4ba7e92de800233a79edfb6a`。运行前后处于同一次系统启动，采样到的电源设置一致。测试程序正常退出，其私有命名空间内无残留 TCP 监听端口。[E18 实体锁屏验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6877072614)

## PA-033 剩余验收项

真实运行覆盖 E06 和 E16 中的 CPU 与 CUDA 图片生成、CPU 视频生成、提交回执丢失恢复、运行中任务取消及限额内的 CUDA 分配失败。常驻测试覆盖 E18 中的宿主重启恢复、提供器连接中断期间的前台响应、工作台关闭时完成渲染，以及实体设备锁屏和解锁。挂起唤醒、整机离线运行与恢复，以及相应的电源设置对照，仍需在目标宿主上验证。视觉质量和用户指定约束的符合程度属于 PA-034 的验收范围。PA-033 仍为 In review。[CPU 与常驻验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6824813990) · [GPU 验证](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6825106305)
