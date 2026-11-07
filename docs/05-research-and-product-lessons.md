# 05. Personal agent research and architectural judgment

[Documentation index](README.md) · [简体中文](05-research-and-product-lessons-zh.md)

Researched on 2026-11-07, Asia/Shanghai. The subjects are xAI **Grok Bot**, Meta **Muse the personal agent**, and OpenAI **dots**, not similarly named models or products. Vendor statements, author analysis, local source facts, and our design judgments are distinct. None of the commercial products was tested through a signed-in account; demonstrations do not establish success rates or internal implementation.

## 1. What users receive

| Product | Public capabilities | Lesson for DSH | Avoid copying |
| --- | --- | --- | --- |
| Grok Bot | Persistent roles, a shared cloud computer, application work, coordination, saved skills and routines | Accumulate context for recurring work and deliver reusable artifacts | Treating Bots as security domains or making users manage a Bot team immediately |
| Muse | Main and side conversations, goals, asynchronous work, selective notifications, editable memory and artifacts | Organize around goals, decisions and results; accept input while working | Aimless background research and unsolicited notification volume |
| dots | A primary agent progressing several projects, cloud execution, connected applications, cross-channel conversation, voice and delegation | Continuous responsibility independent of a conversation window | Presenting specialist pilots or future multiple dots as generally available |

Sources: [Grok Bot workflow](https://docs.x.ai/grok-bot/how-grok-bot-works), [Muse design](https://muse.ai/blog/how-we-designed-muse), [dots introduction](https://openai.com/index/introducing-dots/). This is a capability summary, not a comparative benchmark.

## 2. Published mechanisms and limits of the evidence

**Grok Bot.** Documentation describes one persistent computer per user shared by their Bots, server-held connector tokens, and Auto Review. Enterprise network controls are not universal defaults. The material does not disclose a complete scheduler, transactional task protocol, or retrieval algorithm. [Security](https://docs.x.ai/grok-bot/security), [FAQ](https://docs.x.ai/grok-bot/faq).

**Muse.** Meta describes a dedicated VM, a system-separated Sentinel and credentials used without model visibility. Confidential VM was a future announcement in the launch material; delivery was not verified. The dedicated security article could not be opened, so no additional implementation claims are made. [Meta announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/).

**dots.** Published safeguards separate executable environments from enforcement systems. Auto-review checks actions; proactive research uses code-enforced read-only tools, with subsequent actions separately checked. Disconnecting a service does not erase previously acquired context. These mechanisms do not expose a reusable implementation of the private service. [Safety design](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/), [privacy FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs).

**Our judgment:** durable identity, an actionable environment, persistent state and bounded initiative form the common product foundation. DSH should differentiate through self-hosting, inspectable work and replaceable capabilities, without promising that one plugin recreates a managed cloud platform.

## 3. Expert and practitioner explanations

| Author / original source | Supported observation | Our design consequence |
| --- | --- | --- |
| Mona Sarantakos and Christine Awad, [Muse design](https://muse.ai/blog/how-we-designed-muse), 2026-09-08 | Long conversations need goals, deterministic controls and durable outputs | Prioritize decisions and artifacts in the UI |
| Grok Bot team, [persistent-agent design](https://x.ai/news/designing-grok-bot), 2026-09-03 | Represent persistent workers without exposing every internal concept | Hide Session/Attempt; show activity and required attention |
| Ethan Mollick, [Real AI Agents and Real Work](https://www.oneusefulthing.org/p/real-ai-agents-and-real-work), 2025-09-29 | Valuable work differs from producing more content; judgment determines usefulness | Measure accepted outcomes and attention saved, not token or artifact volume; this predates the three products |
| Simon Willison, [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), 2025-06-16 | Private data, untrusted content and outbound communication combine into an exfiltration risk | Separate research and action capabilities; model review cannot grant authority |
| Tyler Hunt, Donald Nguyen and Gurbinder Gill, [The Agent Board](https://arxiv.org/abs/2611.04100), 2026-11-03 | Durable tasks and event wakeups avoid model polling; semantic wakeups can miss events | Exact identifiers and subscriptions first; semantic routing handles residual candidates; a preprint is not a production SLO |

The inaccessible “The Dot and the Swarm” is not used to attribute specific claims. Aggregators, Reddit anecdotes and search snippets are not evidence of internal architecture.

## 4. Translating Superagent principles into engineering

The DeepSeek team's essay discusses continuous interaction, concurrent output, initiative and persistent availability, using Router/Worker separation, event routing, reference-based recall, separated compute/state/environments and an external Watchdog. The [original X page](https://x.com/DeepSeekHarness/status/2116857257245987236) returned 403. An attributed [machine-translated mirror](https://threadnavigator.com/thread/2116857257245987236/) supplied design background, not proof of public implementation.

Implementation evidence comes from the pinned local [philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md), [domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md) and [execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md) documents.

| Principle | Required behavior | Acceptance |
| --- | --- | --- |
| Conserve human attention | One acknowledgment; notify for results, blockers or decisions; expandable detail | E08, E12 |
| Lightweight Router | No long shell, browser loops or deep research in the primary conversation; deterministic control commands | PA-010, E02 |
| Accountable Worker | Scope, acceptance criteria, artifacts and structured reports per task; native subagents where needed | PA-006, E01 |
| Event-driven work | Deduplicate, filter, batch and pass subscribed events directly; semantically route ambiguous work | PA-010, E03 |
| Context is not the database | Rebuild current state and evidence through references; preserve commitments across compaction | PA-011, E04 |
| Waiting releases compute | Persist dependencies while waiting for people, events or devices; release execution slots | PA-006, PA-018, E06 |
| Initiative needs value | Observe first, then prepare privately under explicit rules | PA-019, E08 |
| Recoverable operation | Separate process supervision from semantic stall detection; reconcile external effects | PA-009, PA-021, E06 |

### Prototype assumptions to replace

The prototype targets trusted team work in one repository. Personal operation requires verified account binding, action-level grants, deletion semantics and device isolation. Identity hints in prompts, full-access execution, continuing under changed policies and PR-close completion rules are not appropriate general defaults. See [04](04-decisions-and-source-audit.md).

## 5. Architectural conclusions and rejected directions

1. **Build a personal work system that owns ongoing responsibilities.** Prove research, project progress and reminders through inspectable outcomes. Chat is an entry point, not the entire information model.
2. **Keep one primary agent with task-specific executors.** Future specialties start as capability, prompt and memory configurations. Add visible roles only when repeated work justifies separate context; roles confer no extra authority.
3. **Keep DSH as the runtime and orchestration host.** Do not add another LLM controller or require LangGraph/Temporal. Begin with a transactional single-host queue; introduce distributed coordination only for demonstrated requirements.
4. **Deliver vertical value before general infrastructure.** A marketplace, multi-tenancy, vector backend framework and native mobile clients are not prerequisites. Preserve replaceable service interfaces and split packages only when justified.
5. **Require evidence for capability growth.** Skills, automatic memory, model routing and Watchdog changes need replay and real-use evaluation. They cannot modify authority, increase spending silently or install unknown plugins.

These are our engineering recommendations. [02](02-implementation-roadmap.md) and [04](04-decisions-and-source-audit.md) specify defaults, deferrals and blockers.

## 6. Source register and limitations

| ID | Evidence | Type / use |
| --- | --- | --- |
| R01 | [Grok Bot workflow](https://docs.x.ai/grok-bot/how-grok-bot-works) | Official workflow and role memory |
| R02 | [Grok Bot security](https://docs.x.ai/grok-bot/security) | Official isolation and connector/network boundaries |
| R03 | [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq) | Official product identity and shared computer |
| R04 | [Grok Bot design](https://x.ai/news/designing-grok-bot) | Product designers, 2026-09-03 |
| R05 | [Muse launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) | Official, 2026-09-08 with later updates |
| R06 | [Muse design](https://muse.ai/blog/how-we-designed-muse) | Product designers, 2026-09-08; opened through the official link |
| R07 | [dots launch](https://openai.com/index/introducing-dots/) | Official, 2026-09-29; includes a 2026-11-03 model update |
| R08 | [dots safety](https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/) | Official action checks and research restrictions |
| R09 | [dots privacy FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs) | Official access versus retained context |
| R10 | [Mollick](https://www.oneusefulthing.org/p/real-ai-agents-and-real-work) | Original analysis of value; not a three-product review |
| R11 | [Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) | Original threat analysis |
| R12 | [Agent Board](https://arxiv.org/abs/2611.04100) | Author preprint on waiting and wakeups |
| R13 | [Superagent mirror](https://threadnavigator.com/thread/2116857257245987236/) | Attributed translation; original unavailable; lower confidence than local source |
| R14 | [Pinned source audit](04-decisions-and-source-audit.md) | Current local inspection, not runtime validation |

Internal commercial code, transaction protocols and comparable benchmarks were unavailable. Pricing, regional availability and end-to-end success rates were not verified and do not underpin release promises. `/Users/charleypeng/Documents/llmwiki` was absent, so historical knowledge-base conclusions were not incorporated. Recheck product facts before implementing or advertising related capabilities.
