# 模拟媒体示例

[English](README.md) · [插件架构](../../../docs/09-plugin-architecture-zh.md)

`@mosbot-ai/dshpa-example-media-mock` 是一个适配第 1 版 API 的测试夹具，无需密钥。它声明 `mock: true`，使用 `mock-job-` 和 `mock-asset-` 开头的 ID，并返回标有 `MOCK FIXTURE` 的固定 SVG 夹具的元数据。它无需网络或图像模型。作业及其夹具元数据存于内存，直至卸载或重启。

在工作区根目录构建软件包，并将示例添加到已经安装 dshpa 的命名 DSH 配置中。

```sh
pnpm build
pnpm exec dsh plugin --profile your-profile add "link:$PWD/examples/plugins/media-mock"
```

配置会挂载 `dshpa-example-media-mock` 插件。可以通过可选的覆盖配置设置实例 ID、配置修订号、作业上限和以毫秒计的模拟延迟。

```yaml
- id: dshpa-example-media-mock
  config:
    instanceId: example-media-mock
    configRevision: 1
    maxJobs: 32
    latencyMs: 0
```

夹具接受分辨率不超过 1024 × 1024 的图像生成请求，并支持取消排队作业。每个句柄都保留原提供方和配置修订号。注册与生命周期测试使用此夹具验证提供方路由和清理。
