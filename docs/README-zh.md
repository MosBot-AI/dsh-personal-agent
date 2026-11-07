# dshpa 项目与实施计划

[English](README.md)

**当前状态为 PA-001 原生 Bundle 启动骨架。** 修订 `2026-11-07-r7`，Asia/Shanghai。DSH Personal Agent 简称 **dshpa**。本轮基于现有方案、两个固定版本的本地 DSH 仓库、Grok Bot/Muse/dots 官方资料和作者分析完善计划，并纳入本机常驻、电脑操作、图片/视频、密码库、安全输入和 VNC 要求。

产品定位是：**运行在用户自己电脑上的持续个人工作系统，以一个主 agent 管理目标和任务，按需委派执行，交付可检查成果，同时尽量少消耗人的注意力。** 云服务可选；DSH 本身承担原生运行时和编排，不增加第二个外部主控制器。

## 推荐阅读

| 文档 | 回答的问题 |
| --- | --- |
| [01 产品与架构](01-product-and-architecture-zh.md) | 为什么做、用户得到什么、系统如何分工、哪些不做 |
| [08 本机、媒体、密码库与 VNC](08-local-computer-media-and-vault-zh.md) | 常驻电脑如何运行，如何看桌面、接管、安全输入和使用凭据，以及创作图片/视频 |
| [02 路线图](02-implementation-roadmap-zh.md) | 基础 alpha → 桌面 alpha → beta → v1 的范围与默认选择 |
| [06 Agent 实施入口](06-agent-execution-guide-zh.md) | 交接提示词、执行顺序、43 个任务的索引与证据规则 |
| [03 数据与执行契约](03-contracts-security-and-tests-zh.md) | 状态机、事务、授权、恢复、资源、凭据和媒体记录 |
| [07 验收与发布](07-evaluation-and-release-gates-zh.md) | E00–E24 场景、质量目标、真实验证及发布条件 |
| [04 决策与源码审计](04-decisions-and-source-audit-zh.md) | 已有能力、适配/新增范围、默认决策和未决部署输入 |
| [05 调研与架构判断](05-research-and-product-lessons-zh.md) | 三款产品、专家/设计者分析、Superagent 理念与证据局限 |
| [09 插件规范](09-plugin-architecture-zh.md) | 用户如何更换媒体/记忆实现，插件如何开发、配置、迁移和回滚 |
| [10 模型调度与网关](10-model-routing-and-gateway-zh.md) | 难度/effort 自动选择、模型池、额度和兜底配置及实现比较 |
| [11 Project 执行协议](11-github-project-workflow-zh.md) | GitHub 看板、认领、进度、验收与 Actions 自动化 |

每份文档有对应英文版本。任务定义在 [implementation-tasks.json](implementation-tasks.json)，含依赖、目标文件、源码参考、步骤、测试路径、验收场景和证据路径。任务状态字段是初始 `planned` 快照，实时进度以 GitHub Project 为准；默认实施目标是 **桌面 alpha（PA-035 及其依赖）**，第一项是 PA-001。

## 本轮的关键取舍

- 主 Router 负责连续交流与协调，长任务由 Worker 执行；等待不占计算槽。
- DSH 原生能力优先复用；独立 SQLite 承担跨任务、授权、动作与发件箱事务。
- 本机常驻、VNC、密码/密钥安全输入、凭据代理和媒体创作进入首个完整产品目标。
- 共享桌面只有一个控制者；用户接管优先。媒体/API 工作可以并行。
- ComfyUI 是首个可替换生成后端，视频生成与确定性合成分别标注；不预设用户硬件能运行所有模型。
- 凭据通过可信表单直达成熟密码库，agent 使用受限引用；不自研密码学，不把秘密放进聊天。
- 以可采纳成果、注意力和费用评估价值；不把功能数量当成进展。

## 当前可验证的内容

```sh
python3 scripts/check_plan.py
python3 scripts/check_plan.py --check-sources
git diff --check
```

这些检查验证计划结构、依赖、双语文件、本地链接和源码路径。使用 `pnpm check` 构建工作区并运行无需凭据的 Bundle 契约检查。真实模型、媒体、VNC 和密码库测试在各自任务中执行。

指定的 `/Users/charleypeng/Documents/llmwiki` 本次不存在；没有据此虚构历史结论。计划中的具体账户、预算、硬件和服务选择在相应能力激活时配置，不阻塞无凭据开发。
