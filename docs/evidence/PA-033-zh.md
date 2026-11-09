# PA-033 持久化本地媒体验证证据

[English](PA-033.md)

[PA-033](https://github.com/MosBot-AI/dsh-personal-agent/issues/33) · 计划 `2026-11-07-r7` · 初始实现 `740fe3436008fa07e1a5ab0e12864db010484dfb`。集成后的 schema 16 行为记录见下文。

## 已实现

- 可选的常驻服务在 SQLite v16 中排队处理限定范围的图片和视频任务。按模态选择配置的免费本地提供器，固定其配置，检查当前尝试，并限制队列与每次尝试的提交数量。冷启动后保留单个媒体租约。准备阶段遇到限流时先等待，再进入可执行队列按顺序处理。该循环独立于 Worker 槽位运行。
- ComfyUI 0.44.0 适配器接受使用已安装模型的已批准 API 图，并探测本地服务、CPU 或 GPU 和输出文件系统。请求发出前，SQLite 提交客户端分配的 prompt ID、请求与工作流摘要、种子及精确的提供器标识。提交结果不明确时，以同一凭据进入回查。队列与历史都查不到时，结果保持未决并继续占用租约。
- 适配器验证归属绑定后，才调用 ComfyUI 的单任务取消路由。它从已批准的输出节点下载有大小上限的文件，探测媒体类型、尺寸和时长，解码媒体流并计算 SHA-256。任务保存已验证的元数据，文件保留在 ComfyUI 中。 [提供器配置](../../packages/media-comfyui/README-zh.md)
## 媒体回归测试环境

媒体回归使用模拟 ComfyUI v0.44.0 HTTP 行为的本地回环服务。测试环境没有安装 ComfyUI。模拟服务返回的 PNG 和 MP4 都由 FFmpeg 生成，文中记录的 SHA-256 是这些样本文件的摘要。

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

## 验收范围

E06 使用持久化数据库验证受控传输故障与操作系统进程崩溃。E09 覆盖本地队列限制、串行执行与受控限流。E16 覆盖经 FFmpeg 生成及解码的样本、在模拟服务上验证的限定范围取消，以及模拟的后端 OOM 状态。E18 有原生常驻宿主冒烟套件，以及单独的媒体调用端重开验证。E21 有独立构建的提供器与固定配置回查。

实际 ComfyUI 图片和视频渲染、真实 GPU 可用性与 OOM、物理宿主运行中任务的取消，以及实际睡眠唤醒后的媒体恢复仍待验收。HTTP 夹具与 FFmpeg 生成样本提供上述已验证范围的证据。 [ComfyUI v0.44.0 路由](https://github.com/Comfy-Org/ComfyUI/blob/v0.44.0/server.py)


## 评审修复：输出中断与持久化 GPU 租约

2026-11-09 的云端 Linux 验证使用 Node.js 24.22.1、pnpm 11.28.5 和 FFmpeg 7.1.5。模拟 HTTP 200 响应仅发送部分 PNG 后断开连接。收集保持可重试且继续持有租约；重新打开 WorkStore 后恢复原输出哈希，渲染提交总共只有一次。独立流测试覆盖响应体超时，以及必须仍判定为无效的超限响应体。`pnpm check` 的类型检查、构建、50 个测试文件中的 288 个测试和计划验证均通过；`git diff --check` 通过。

原生 DSH Web 宿主还在 WorkStore 包含渲染中任务时以关闭媒体的配置启动。GPU 准入拒绝新工作，且不会调用其操作。排队中、不持有租约的任务作为正对照，允许 GPU 工作。`pnpm test:media-host` 的三个用例全部通过。这是使用模拟媒体的原生宿主准入检查，不是物理 GPU 并发验收。

上述传输与租约修复未修改数据库迁移。后续 #71 优先的迁移整合记录见下文。真实 ComfyUI、GPU、取消和睡眠/唤醒检查仍待完成。

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

真实 ComfyUI 生成、物理 GPU/OOM 和运行中渲染取消、实际睡眠/唤醒，以及实体手机和已部署 HTTPS 验收仍待完成。此前并发评审负载下曾失败一次的 schedule 恢复用例在本次最终工作区检查中通过；之前的根因尚未证实。测试未使用生产数据或部署。
