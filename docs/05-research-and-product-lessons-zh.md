# 05. Personal agent 调研与架构判断

[文档索引](README-zh.md) · [English](05-research-and-product-lessons.md)

调研日期：2026-11-07，Asia/Shanghai。对象为 xAI 的 **Grok Bot**、Meta 的 **Muse 个人智能体**和 OpenAI 的 **dots**，不是同名模型或其他公司的 Dot。本文区分厂商公开描述、作者分析、本地源码事实和本项目的设计判断。没有实际登录测试这三个商业产品；官网演示不能证明成功率、可用性或内部实现。

## 1. 对用户真正交付什么

| 产品 | 公开产品能力 | 对 DSH 的启发 | 不应照搬 |
| --- | --- | --- | --- |
| Grok Bot | 持续存在的角色；共享云电脑；跨应用工作；角色间协作；把成功流程保存为技能和例行工作 | 重复工作的上下文可以逐步积累；把结果保存在可继续使用的产物中 | 多个 Bot 不是多个安全域；首版不要求用户管理一支 Bot 团队 |
| Muse | 长期主对话、侧对话、目标与行动计划；异步工作；有价值时才打扰；可编辑记忆和丰富产物 | 产品应围绕目标、待决事项和成果组织；允许用户随时补充和改变方向 | 不把“主动”理解为无目标地搜索和不断推送建议 |
| dots | 一个主要 agent 同时推进多个项目；云电脑和连接的应用；跨渠道交流、语音和委派 | 让同一个 agent 承担连续责任，任务状态脱离聊天窗口 | specialist dots、更多 dots 的未来方向不能当作普遍可用的现成功能 |

依据分别为 [Grok Bot 工作方式](https://docs.x.ai/grok-bot/how-grok-bot-works)、[Muse 产品设计](https://muse.ai/blog/how-we-designed-muse)、[dots 发布介绍](https://openai.com/index/introducing-dots/)。本表是能力归纳，不是产品优劣排名。

## 2. 已公开的技术机制及证据边界

**Grok Bot。** 官方文档描述每位用户一个持久云计算机，多个 Bot 共享文件和浏览器登录；连接器令牌留在服务端，动作可接受 Auto Review 检查。不能据此推断 Bot 间存在隔离，也不能把 Enterprise 的网络策略当成所有套餐默认配置。内部调度器、持久任务事务和记忆检索算法未在这些资料中完整公开。[安全架构](https://docs.x.ai/grok-bot/security)、[FAQ](https://docs.x.ai/grok-bot/faq)。

**Muse。** Meta 描述专属 VM，以及在系统层与执行 agent 隔开的 Sentinel；凭据以模型不可见的方式使用。发布文中的 Confidential VM 属于当时宣布的后续方向，本文未核实其已交付。安全文章正文此次无法打开，因此不进一步推断其网络拦截、密钥管理或隔离实现。[Meta 发布说明](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)。

**dots。** 官方把可执行代码的环境与关键控制系统分离；Auto-review 在动作执行前检查指令和规则。后台 proactive research 的工具由代码限制为只读，后续动作重新走普通动作规则。断开连接不会自动删除已经进入 agent 上下文的信息。这些公开机制不等于本项目可以复制其私有服务。[安全设计](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/)、[隐私 FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)。

**架构判断：** 三者的共同产品基础是持续身份、可操作环境、持久状态和受约束的主动性。DSH 的差异应是可自托管、可检查的工作状态和可替换能力；不应承诺用一个插件复刻厂商的云电脑基础设施。

## 3. 专家与一线设计者的解释

| 作者 / 原始资料 | 有依据的观点 | 本项目采用的设计判断 |
| --- | --- | --- |
| Mona Sarantakos、Christine Awad，[Muse 设计文章](https://muse.ai/blog/how-we-designed-muse)，2026-09-08 | 长期对话需要目标视图、结构化控制及能继续使用的成果 | 主界面优先显示待决事项和结果；复杂结果作为 Artifact |
| Grok Bot 产品团队，[持久 agent 的界面设计](https://x.ai/news/designing-grok-bot)，2026-09-03 | 界面应表达长期存在的工作者，避免暴露过多内部概念 | 隐藏 Session/Attempt，展示“正在做什么、是否需要我” |
| Ethan Mollick，[Real AI Agents and Real Work](https://www.oneusefulthing.org/p/real-ai-agents-and-real-work)，2025-09-29 | 完成有价值的任务与制造更多内容不同；人的判断决定什么值得做 | 用采纳成果和节约注意力评估，不能用 token、任务数或文档数当北极星指标；此文早于三款产品，不作为它们的评测 |
| Simon Willison，[The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)，2025-06-16 | 私有数据、不可信内容、对外通信组合会产生数据外泄风险 | 研究器和动作执行器分权；模型评审是附加判断，不能替代确定性授权 |
| Tyler Hunt、Donald Nguyen、Gurbinder Gill，[The Agent Board](https://arxiv.org/abs/2611.04100)，2026-11-03 | 持久任务及事件唤醒可避免长时间模型轮询；论文也报告语义唤醒遗漏 | 精确 ID/订阅匹配优先，语义路由只处理剩余候选；这是预印本设计证据，不是生产 SLO |

不引用未能打开的 “The Dot and the Swarm” 来归因具体观点；不把聚合网站、Reddit 使用感受或搜索摘要当作内部架构证据。

## 4. Superagent 的理念：从原则变成工程约束

DeepSeek 团队设计文章把目标概括为持续交互、并行产出、主动工作和长期在线；讨论 Router/Worker、事件过滤与订阅、按引用召回、计算/状态/执行环境分离和外部 Watchdog。[原文](https://x.com/DeepSeekHarness/status/2116857257245987236)此次返回 403；阅读了注明机器翻译的[转载](https://threadnavigator.com/thread/2116857257245987236/)，将其作为设计背景，不作为公开原型已实现能力的证据。

实际复用依据是本地固定提交的 [原型理念](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md)、[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)及[执行机制](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)。

| 理念 | 本项目必须做到 | 验收落点 |
| --- | --- | --- |
| 少消耗人的注意力 | 一次接收确认；结果、阻塞、必要决定才通知；详情按需展开 | E08、E12 |
| Router 保持轻量 | 不在主对话执行长 shell、浏览器循环或深度研究；直接控制命令走确定性路径 | PA-010、E02 |
| Worker 对结果负责 | 每任务有范围、验收、产物和结构化回报；需要时内部使用 DSH 子智能体 | PA-006、E01 |
| 事件驱动 | 去重、过滤、批处理、订阅直达；未知归属才做语义判断 | PA-010、E03 |
| 上下文不是数据库 | 当前状态、引用图和来源可重建；压缩不丢承诺 | PA-011、E04 |
| 等待不占计算 | 等人、等事件、等设备时持久化依赖并释放执行槽 | PA-006、PA-018、E06 |
| 主动性有价值门槛 | 先观察，再只读准备；基于明确规则逐项启用 | PA-019、E08 |
| 长期运行可恢复 | 进程监督与语义停滞检测分开；不盲目重复外部动作 | PA-009、PA-021、E06 |

### 不能直接沿用原型的地方

原型服务于可信团队的单仓库编程。个人 agent 涉及跨账户私人数据和多设备，必须增加可信账户关联、动作级授权、删除语义与设备隔离。原型的跨来源身份提示、`danger-full-access`、策略改变后继续执行的假设，以及 PR 关闭即结束任务的业务规则，不适合作为通用个人任务默认行为。源码差异详见 [04](04-decisions-and-source-audit-zh.md)。

## 5. 架构师结论与被否决的路线

1. **做“持续承担责任的个人工作系统”。** 第一阶段证明研究整理、项目推进和提醒三个闭环；每个闭环都交付可检查的结果。聊天是入口，不是唯一的信息结构。
2. **保留一个主 agent，按任务分配执行器。** 未来专业角色先表现为能力、提示和记忆范围的配置；只有重复任务确实有独立上下文需求，才增加用户可见角色。多个角色不会获得独立或更广权限。
3. **保持 DSH 为运行时和编排宿主。** 不另建 LangGraph/Temporal/外部 LLM 控制器。首版单进程事务队列足够；以后只有测量到容量或可用性瓶颈才引入分布式协调。
4. **先交付纵向价值，再增加横向通用性。** 不以插件市场、多租户、复杂向量后端或移动原生应用作为前置依赖。用服务接口保留替换点，用测试决定是否拆包。
5. **能力提升必须带来可量化收益。** 技能沉淀、自动记忆、模型路由和 Watchdog 都必须经过离线回放和真实使用评估；不允许自我修改授权、悄然增加模型费用或安装未知插件。

以上是本项目的工程建议，不是任何商业产品内部实现的复述。默认实施范围、延期项和阻塞条件由 [02](02-implementation-roadmap-zh.md)、[04](04-decisions-and-source-audit-zh.md)规定。

## 6. 证据登记与局限

| ID | 证据 | 类型 / 用途 |
| --- | --- | --- |
| R01 | [Grok Bot 工作方式](https://docs.x.ai/grok-bot/how-grok-bot-works) | 官方，用户流程和角色记忆 |
| R02 | [Grok Bot 安全](https://docs.x.ai/grok-bot/security) | 官方，隔离单位与连接器/网络边界 |
| R03 | [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq) | 官方，区分 Grok 和 Grok Bot、共享电脑 |
| R04 | [Grok Bot 设计](https://x.ai/news/designing-grok-bot) | 一线设计解释，2026-09-03 |
| R05 | [Meta Muse 发布](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) | 官方，2026-09-08，页面标有后续更新 |
| R06 | [Muse 设计](https://muse.ai/blog/how-we-designed-muse) | 一线设计解释，2026-09-08；经官方页面链接打开 |
| R07 | [dots 发布](https://openai.com/index/introducing-dots/) | 官方，2026-09-29；页面含 2026-11-03 模型更新 |
| R08 | [dots 安全](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/) | 官方，动作检查及后台研究隔离 |
| R09 | [dots 隐私 FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs) | 官方，访问、上下文保留与删除区分 |
| R10 | [Mollick](https://www.oneusefulthing.org/p/real-ai-agents-and-real-work) | 作者原文，价值评价，不是三款产品测评 |
| R11 | [Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) | 作者原文，威胁模型 |
| R12 | [Agent Board](https://arxiv.org/abs/2611.04100) | 作者预印本，等待和唤醒设计 |
| R13 | [Superagent 文章转载](https://threadnavigator.com/thread/2116857257245987236/) | 可读的署名转载，原始 X 页面无法访问，可信度低于本地源码 |
| R14 | [04 固定源码](04-decisions-and-source-audit-zh.md) | 当前本地读取，非运行时验证 |

本次没有取得三款产品的内部代码、事务规范或统一基准。未验证付费档位、地区覆盖和端到端成功率，不据此制定商业承诺。指定的 `/Users/charleypeng/Documents/llmwiki` 不存在，因此没有把知识库历史结论混入本计划。全部产品事实在正式实施/发布相关能力前应按同一链接重新核实。
