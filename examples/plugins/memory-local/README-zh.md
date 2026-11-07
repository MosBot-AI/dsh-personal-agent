# 本地记忆示例

[English](README.md) · [插件架构](../../../docs/09-plugin-architecture-zh.md)

`@mosbot-ai/dshpa-example-memory` 是一个适配第 1 版 API 的内存提供方，设有容量上限，无需密钥。它演示限定范围的读取和关键词检索、修订检查、替代记录、遗忘，以及保留记录 ID 和来源的快照。提供方重启或卸载时会丢弃其中的数据。试用示例时请使用合成数据。

在工作区根目录构建软件包，并将示例添加到已经安装 dshpa 的命名 DSH 配置中。

```sh
pnpm build
pnpm exec dsh plugin --profile your-profile add "link:$PWD/examples/plugins/memory-local"
```

配置会挂载 `dshpa-example-memory` 插件。可以通过可选的覆盖配置设置实例 ID、配置修订号和记录上限。

```yaml
- id: dshpa-example-memory
  config:
    instanceId: example-memory
    configRevision: 1
    maxRecords: 128
```

`maxRecords` 限制实例内各范围的记录总数。提供方将快照导入相符的空范围，并保留现有范围的数据。注册后，可信核心消费者可以使用该提供方。提供方选择和记忆授权由核心管理。
