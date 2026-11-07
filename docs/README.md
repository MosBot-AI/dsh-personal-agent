# dshpa product and implementation plan

[简体中文](README-zh.md)

**The native bundle, work and security foundations, bounded Workers, verifiable delivery, local Web inbox, guarded recovery, event routing, context checkpoints and recall, personal memory, compute and attention controls, durable schedules, resident host operations, and capability plugin contracts are implemented (PA-001 through PA-013, PA-018, PA-021, and PA-038).** Revision `2026-11-07-r7`, Asia/Shanghai. DSH Personal Agent is abbreviated **dshpa**. This revision combines the earlier plan, two pinned local DSH repositories, official Grok Bot/Muse/dots material and original analysis, incorporating resident operation, computer use, media, vaults, secure input and VNC.

Build a **persistent personal work system on the owner's computer**: one primary agent coordinates goals and tasks, delegates execution and returns inspectable outcomes while conserving human attention. Cloud services are optional. DSH remains the native runtime and orchestration host.

## Reading guide

| Document | Purpose |
| --- | --- |
| [01 Product and architecture](01-product-and-architecture.md) | Value, user outcomes, responsibilities and non-goals |
| [08 Local computer, media, vault and VNC](08-local-computer-media-and-vault.md) | Resident execution, viewing/takeover, secure intake, credential use and creation |
| [02 Roadmap](02-implementation-roadmap.md) | Foundation alpha → desktop alpha → beta → v1 and defaults |
| [06 Agent execution guide](06-agent-execution-guide.md) | Handoff prompt, execution procedure, 43-task index and evidence |
| [03 Contracts](03-contracts-security-and-tests.md) | States, transactions, authorization, recovery and resource/media/secret records |
| [07 Evaluation](07-evaluation-and-release-gates.md) | E00–E24, quality targets, live evidence and release gates |
| [04 Decisions/source audit](04-decisions-and-source-audit.md) | Existing versus new capabilities, defaults and activation inputs |
| [05 Research](05-research-and-product-lessons.md) | Products, expert/designer analysis, Superagent principles and evidence limits |
| [09 Plugin architecture](09-plugin-architecture.md) | Replaceable media/memory, development, configuration, migration and rollback |
| [10 Model routing and gateway](10-model-routing-and-gateway.md) | Difficulty/effort, user pools, quotas, fallback configuration and implementation comparison |
| [11 Project workflow](11-github-project-workflow.md) | GitHub board, claims, reporting, acceptance and Actions automation |
| [Resident host operations](operations.md) | Foreground profile, optional user services, health, backup and audit |
| [Host compatibility evidence](evidence/host-compatibility.md) | Installed DSH agent, session, schedule, and remote access boundaries |
| [Work domain evidence](evidence/PA-003.md) | Record validation, scoped command admission, and task transitions |
| [SQLite storage evidence](evidence/PA-004.md) | Atomic work commits, one-writer ownership, and failure recovery |
| [Action authorization evidence](evidence/PA-005.md) | Verified identities, one-use claims, and private worker tool isolation |
| [Native Worker evidence](evidence/PA-006.md) | Bounded launch, scoped controls and reports, and verified release |
| [Artifact and delivery evidence](evidence/PA-007.md) | Sealed revisions, trusted verification, and ordered delivery receipts |
| [Local Web inbox evidence](evidence/PA-008.md) | Native conversation, scoped work controls, and owner acceptance |
| [Recovery evidence](evidence/PA-009.md) | Input journaling, exact readback, cancellation, and guarded restore |
| [Routing evidence](evidence/PA-010.md) | Authenticated intake, subscriptions, bounded assessment, and foreground control |
| [Context checkpoint evidence](evidence/PA-011.md) | Native compaction, scoped recall, persistent exclusions, and Worker context budgets |
| [Personal memory evidence](evidence/PA-012.md) | Explicit owner controls, SQLite provider snapshots, and durable exclusions |
| [Budget and attention evidence](evidence/PA-013.md) | Model claims, resource limits, notification policy, and usage |
| [Schedule evidence](evidence/PA-018.md) | Versioned routine intent, native wake reconciliation, and logical occurrences |
| [Resident host evidence](evidence/PA-021.md) | Startup and shutdown, health, provider waits, backup and restore |
| [Capability plugin evidence](evidence/PA-038.md) | Public API, lifecycle registry, policy consumers and local examples |

Each document has a Chinese counterpart. [implementation-tasks.json](implementation-tasks.json) owns dependencies, target paths, sources, steps, tests, acceptance IDs and evidence paths. Task statuses are initial `planned` snapshots; GitHub Project owns live progress. The default target is **desktop alpha: PA-035 and its dependency closure**, starting at PA-001.

## Key choices

- Lightweight Router and task Workers; waiting releases compute.
- Reuse native DSH; plugin SQLite owns transactional work/authority/effect/outbox state.
- Resident operation, VNC, secure password/key input, credential brokerage and media belong in the first complete product.
- One desktop controller, with human takeover; API and media work may run concurrently.
- ComfyUI is the first replaceable generation adapter; distinguish generated from composited video and validate actual hardware.
- Secure forms feed mature vaults directly; agents use scoped references. No custom cryptography or secrets in chat.
- Evaluate accepted outcomes, attention and cost rather than feature volume.

## Current verification

```sh
python3 scripts/check_plan.py
python3 scripts/check_plan.py --check-sources
git diff --check
```

These checks validate plan structure, dependencies, bilingual files, local links and source paths. Run `pnpm check` for the workspace build and keyless bundle contract checks. Live model, media, VNC and vault checks belong to their task cards.

The specified `/Users/charleypeng/Documents/llmwiki` path was absent; no historical conclusions were invented. Concrete accounts, budgets, hardware and providers are activation inputs, not blockers for keyless development.
