# SQLite 记忆提供者

[English](README.md) · [插件架构](../../docs/09-plugin-architecture-zh.md)

`@mosbot-ai/dshpa-memory-sqlite` 实现能力 API 版本 1。它将个人记忆保存到独立的本地 SQLite 文件，并通过公开插件 API 向 dshpa 注册。已认证收件箱负责记忆范围和披露策略。

构建工作区，并将提供者添加到已安装 dshpa 的命名 DSH Profile。

```sh
pnpm build
pnpm exec dsh plugin --profile your-profile add "link:$PWD/packages/memory-sqlite"
```

Bundle 加载 `dshpa-memory-sqlite` 条目，默认目录是 `DSH_HOME` 下的 `dshpa-memory`。如需使用其他位置，将 `directory` 设为绝对路径。默认提供者实例为 `local-memory`，配置修订为 `1`。

```yaml
- id: dshpa-memory-sqlite
  config:
    directory: /absolute/path/to/private-memory
    instanceId: local-memory
    configRevision: 1
```

提供者在仅所有者可访问的目录中打开 `memory.sqlite`。在类 Unix 系统上，目录权限为 `0700`，文件权限为 `0600`。如果该路径已有其他格式的数据库，提供者会拒绝启动。记忆记录严格按所有者、Profile 及所选的 Profile、项目或任务范围隔离。搜索使用规范化文本匹配，返回当前有效的活动记录引用。消费者在显示记录前执行自己的授权检查。

更正在同一个事务中将旧修订标为已取代并插入替代记录。遗忘保存仅含来源和修订元数据的墓碑。SQLite 安全删除适用于当前数据库中被丢弃的数据。先前的导出、文件系统快照和备份副本可能仍保留旧内容，并遵循各自的保留策略。

提供者按单个范围导出规范化的版本 1 快照，其中包含已取代记录和墓碑。每个范围最多保存 512 条记录，且快照必须在 4 MiB 以内。导入要求目标范围为空且与快照范围一致，并在一个事务中应用完整快照。WorkStore 和提供者使用独立文件。需要保留记忆内容的备份流程应包含记忆提供者。
