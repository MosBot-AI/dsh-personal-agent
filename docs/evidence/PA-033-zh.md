# PA-033 持久化本地媒体验证证据

[English](PA-033.md)

[PA-033](https://github.com/MosBot-AI/dsh-personal-agent/issues/33) · 计划 `2026-11-07-r7` · 实现 `740fe3436008fa07e1a5ab0e12864db010484dfb`。

## 已实现

- 可选的常驻服务在 SQLite v14 中排队处理限定范围的图片和视频任务。按模态选择配置的免费本地提供器，固定其配置，检查当前尝试，并限制队列与每次尝试的提交数量。冷启动后保留单个媒体租约。准备阶段遇到限流时先等待，再进入可执行队列按顺序处理。该循环独立于 Worker 槽位运行。
- ComfyUI 0.44.0 适配器接受使用已安装模型的已批准 API 图，并探测本地服务、CPU 或 GPU 和输出文件系统。请求发出前，SQLite 提交客户端分配的 prompt ID、请求与工作流摘要、种子及精确的提供器标识。提交结果不明确时，以同一凭据进入回查。队列与历史都查不到时，结果保持未决并继续占用租约。
- 适配器验证归属绑定后，才调用 ComfyUI 的单任务取消路由。它从已批准的输出节点下载有大小上限的文件，探测媒体类型、尺寸和时长，解码媒体流并计算 SHA-256。任务保存已验证的元数据，文件保留在 ComfyUI 中。 [提供器配置](../../packages/media-comfyui/README-zh.md)
- [Issue 评论](https://github.com/MosBot-AI/dsh-personal-agent/issues/33#issuecomment-6715554235) 建议的回归用例使用真实的 SQLite 存储和模拟 v0.44.0 行为的回环 HTTP 夹具。提交到达时，另一条 SQLite 连接已能读到准备记录。夹具先将任务入队，再在响应前关闭套接字。测试关闭并重开存储，重建调用端和注册表，确认回查暂时缺失也不会重新提交，随后恢复原 prompt ID 与 SHA-256，全程恰好一次 POST。

## 验证

2026-11-08（Asia/Shanghai）在 macOS arm64 本机运行，使用 Node.js 26.13.0、pnpm 11.28.5 和 FFmpeg 9.0.2。

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 退出码 0。类型检查、原生包与提供器构建、49 个测试套件中的 281 项测试及计划验证通过。6 个媒体用例涵盖响应丢失、范围隔离与取消竞态、准备限流、拒绝不安全节点及重定向、损坏文件、受控 OOM 状态，以及可解码且摘要一致的 PNG 与 MP4。 |
| `pnpm test:local-flow` | 退出码 0。10 个原生 Web 流程用例通过。 |
| `pnpm test:resident` | 退出码 0。2 个原生常驻宿主用例通过。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'`、`python3 scripts/check_plan.py`、`git diff --check` | 退出码 0。12 个协调用例、双语链接和空白检查通过。 |
| `python3 scripts/check_plan.py --check-sources` | 退出码 1。固定的上游检出路径不可用。PA-033 的清单中没有上游源码路径。 |

## 验收范围

E06 使用持久化数据库验证受控传输故障与调用端重建。E09 覆盖本地队列限制、串行执行与受控限流。E16 覆盖经 FFmpeg 解码的夹具输出、限定范围的取消与受控后端 OOM 状态。E18 有原生常驻宿主冒烟套件，以及单独的媒体调用端重开验证。E21 有独立构建的提供器与固定配置回查。

实际 ComfyUI 图片和视频渲染、真实 GPU 可用性与 OOM、物理宿主运行中任务的取消，以及实际睡眠唤醒后的媒体恢复仍待验收。HTTP 夹具与 FFmpeg 生成样本提供上述已验证范围的证据。 [ComfyUI v0.44.0 路由](https://github.com/Comfy-Org/ComfyUI/blob/v0.44.0/server.py)
