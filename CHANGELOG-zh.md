# 更新日志

[English](CHANGELOG.md)

本文件按 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 记录重要变化，未来发布遵循[语义化版本](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

### 新增

- 为 dshpa 架构提供依据的产品调研和源码审计，分别提供中英文文档。
- 本机常驻、VNC 查看/接管、媒体创作、安全凭据输入和可替换能力插件的实施规范；这些能力仍处于计划阶段。
- 包含 39 个实施任务、22 个验收场景的机器可读清单，以及检查依赖、引用和文档链接的计划校验工具。
- 中英文仓库 README 入口，以及仅英文的 agent 指令，规范文档、提交、更新日志和项目协作。
- 跨平台忽略规则，覆盖系统文件、编辑器、Node/包管理器及 Vite 产物、测试、Python 缓存、本地秘密和运行数据。

### 变更

- 将已有 DSH 原生方案细化为按依赖推进的发布阶段，以本机运行作为核心，明确插件迁移和恢复要求。

[Unreleased]: https://github.com/MosBot-AI/dsh-personal-agent/commits/main
