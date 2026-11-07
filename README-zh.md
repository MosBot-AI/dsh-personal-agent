# dshpa — DSH Personal Agent

[English](README.md)

dshpa 是基于 DeepSeek Harness 规划的个人智能体，目标是常驻用户自己的电脑，通过原生、可替换的插件协调持续工作，并交付可检查的成果。

**当前状态：仅有架构和实施计划，应用尚未实现。**

## 规划能力

- 持续对话、持久任务、目标、提醒及可更正的记忆。
- 本机电脑操作、VNC 实时查看和用户接管。
- 可替换的图片/视频生成与创作工作流。
- 安全的密码/密钥输入及限定用途的凭据使用。
- 可选的远程/移动端访问、连接设备和语音。

请阅读[文档索引](docs/README-zh.md)、[系统架构](docs/01-product-and-architecture-zh.md)和[插件规范](docs/09-plugin-architecture-zh.md)。实施 agent 从[执行指南](docs/06-agent-execution-guide-zh.md)和 [39 项任务清单](docs/implementation-tasks.json)开始。

## 校验计划

需要 Python 3 和 Git，无需应用依赖或模型凭据。

```sh
python3 scripts/check_plan.py
git diff --check
```

仅在任务清单配置的本地路径中存在上游仓库时，使用 `python3 scripts/check_plan.py --check-sources`。这些命令校验计划，不验证产品功能。

## 参与贡献

遵循 [AGENTS.md](AGENTS.md) 中的双语文档、英文协作内容和 Conventional Commits 规范。重要变化记录在[更新日志](CHANGELOG-zh.md)中。

## 许可证

[Apache License 2.0](LICENSE)。
