# 本地 ComfyUI 媒体提供器

[English](README.md) · [插件架构](../../docs/09-plugin-architecture-zh.md)

`@mosbot-ai/dshpa-media-comfyui` 将 dshpa 媒体队列连接到现有的本地 ComfyUI 0.44.0 安装。它使用字面量回环 HTTP 源地址，要求 DSH 进程的 PATH 中有 `ffmpeg` 和 `ffprobe`。请使用可信的 ComfyUI 安装和本地节点、模型。启用前审查导出的 API 工作流及其中的自定义节点。适配器会拒绝 ComfyUI 声明为 API 节点的节点。 [ComfyUI HTTP 路由](https://docs.comfy.org/development/comfyui-server/comms_routes)

构建工作区，并将提供器安装到已包含 dshpa 的命名 Web profile。

```sh
pnpm build
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/media-comfyui"
```

在 Web profile 的 overlay 中设置 `dshpa-media-comfyui` 插件行的以下字段。

| 字段 | 值 |
| --- | --- |
| `instanceId`、`configRevision` | 选择稳定的实例 ID 和正整数修订号。端点或工作流变化时递增修订号。原修订有待结算任务时，保留该修订供任务恢复。 |
| `origin`、`outputDirectory`、`compute` | 字面量回环 HTTP 源地址、ComfyUI 输出目录的绝对路径，以及预期设备类型 `cpu` 或 `gpu`。 |
| `workflows` | 1 至 16 个已批准的 API 图。每项包含 `id`、`version`、`model`、`spec`、`graph`、`prompt`、`seed` 和 `outputs`。使用固定的 `generate` 规格，包含 `modality`、`width`、`height`，视频还需 `durationMs`。图中必须预先设置模型和尺寸。将 `prompt` 和 `seed` 设为 `{ node, input }`，分别绑定到已有的字符串与数字输入。在 `outputs` 中列出已批准的输出节点 ID。 |
| `minFreeDiskBytes`、`minFreeMemoryBytes` | 输出文件系统的最小可用空间和最小可用系统内存。独立 GPU 模式还检查设备可用显存。默认值分别为 512 MiB 和 256 MiB。 |
| `maxOutputBytes`、`timeoutMs` | 单个任务的输出收集总字节数和单次 HTTP 请求的期限。默认值分别为 32 MiB 和 10 秒。 |

在现有 `dshpa` 行的 `config.inbox` 下配置 `media`，启用队列。此示例为两种模态选择同一提供器修订。配置的图必须支持对应模态。

```yaml
media:
  providers:
    image: &local-comfy
      kind: media
      pluginId: '@mosbot-ai/dshpa-media-comfyui'
      pluginVersion: '0.1.0'
      instanceId: local-comfy
      configRevision: 1
    video: *local-comfy
  maxQueued: 16
  maxPerAttempt: 4
  pollMs: 2000
```

可信宿主组件使用 `dshpaMedia.enqueue`、`inspect` 和 `cancel`，并传入精确的当前任务与尝试范围。请求使用已批准的工作流版本、模型、固定输出规格和提示词。此提供器支持基于提示词的生成。参考图片接收、创作界面和产物交付由后续创作工作流实现。

SQLite 在发送前保存预分配的 prompt ID、请求和工作流摘要及种子。断线后，提供器读取固定实例的队列和历史。两者都无法证明结果时，任务会保留媒体租约并等待核对。任务结算前请保留 ComfyUI 历史和输出文件。最终记录包含已验证的输出元数据和 SHA-256，文件字节保留在配置的 ComfyUI 输出目录。视频时长允许与请求规格相差最多 100 ms。

## 使用现有实例验证恢复

请在回环地址上的 ComfyUI 0.44.0、本地模型和已批准工作流就绪后运行。把上表中的提供器配置写入 JSON 文件，仅保留一个工作流，并省略插件行的 `instanceId` 和 `configRevision`。分别使用图片配置和视频配置运行，以验证两种模态。

```sh
pnpm build
DSHPA_COMFYUI_LIVE_CONFIG=/absolute/path/to/provider.json pnpm test:media-live
```

测试使用合成提示词提交一次真实渲染。临时中继会核对已提交到数据库的请求和 prompt ID，等 ComfyUI 确认接收后丢弃响应。提交进程退出后，另一个调用端重新打开同一 WorkStore，对固定的任务回查最多十分钟。测试核对原 prompt ID、单次提交及返回字节的独立 SHA-256，并输出 prompt ID 和经验证的产物元数据。

ComfyUI 保留输出文件。如果提交尝试后测试失败，测试会报告隔离 WorkStore 的位置以便对账。未设置配置时跳过此检查。

## 数据库升级与回滚

集成后的 Core 使用 WorkStore schema 16：移动设备注册保留为迁移 014，移动审批保留为 015，媒体任务为 016。打开 v13 或移动端 v14/v15 存储时，升级前先生成所有者私有的 `.v13.bak`、`.v14.bak` 或 `.v15.bak` 快照。通过精确核对媒体表、约束和索引识别 PR #70 原有的媒体专用 v14；补建缺失的移动端表时，保留任务、已准备的句柄、取消标志及租约。未知或混合的 v14 结构会被拒绝，不会被重新标记数据库版本。请勿修改 `PRAGMA user_version` 绕过检查。

旧构建不能直接打开 v16。回滚须使用匹配的升级前快照与来源构建，并保留备份后外部结果以供对账。常规备份恢复流程将可识别快照升级到新目录，清除原移动设备凭据，并在 restore 模式禁用派发。恢复后的未决媒体租约仍会保留。

输出收集期间的取消决定会持久保存。可取消的读取会被中止，迟到的输出不会使任务变为成功。仅在活动收集器结束后释放媒体租约；结果不确定的渲染仍保留租约，直到提供器回读证明已进入终态。
