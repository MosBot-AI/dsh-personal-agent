# 04. Decisions and source audit

[Documentation index](README.md) · [简体中文](04-decisions-and-source-audit-zh.md)

Audit date: 2026-11-07, Asia/Shanghai. Source inspection is not runtime verification. No DSH installation, plugin execution, or application test suite was run for this documentation-only publication.

## 1. Decision register

| ID | Status | Decision / constraint |
| --- | --- | --- |
| D1 | Confirmed direction | DSH itself is the central personal agent and owns the primary conversation and orchestration. |
| D2 | Confirmed direction | Native plugins/bundles first; small core changes are permitted when an actual missing contract is demonstrated. |
| D3 | Confirmed direction | Coordinate projects, tasks, information, personal affairs, and reminders; support an open connector/MCP system. |
| D4 | Design direction | Preserve continuous conversation through durable work state and bounded context/memory; do not equate the task database with complete personal memory. |
| D5 | Design direction | Eventual remote/mobile and voice access use the same personal agent; mobile Web precedes voice on the same command path; concrete providers are activation choices. |
| D7 | Engineering recommendation | Single owner/profile and single-host reliability first; minimal state/effect/authorization contracts before distributed execution. |
| D8 | Publication scope | Add the implementation plan to this repository's `docs/`; do not claim implementation or change the existing license as part of this publication. |
| D9 | Engineering default | Lightweight Router, task Workers for long execution, deterministic direct controls. |
| D10 | Engineering default | One composition bundle with cohesive core services and independent media/memory/workflow plugins; no second orchestrator. |
| D11 | Engineering default | Plugin SQLite transactions; DSH retains session logs. |
| D12 | Engineering default | Reuse native schedule; add logical occurrence dedupe and business results. |
| D13 | Engineering default | Goal/task/evidence/feedback loop; reference-first recall; automatic memory off. |
| D14 | Engineering default | off/observe/prepare/act with independent attention and compute budgets. |
| D15 | Engineering default | One owner-facing primary agent; specializations begin as configurations. |
| D16 | Explicit user direction | DSH Personal Agent, abbreviated dshpa. |
| D17 | Explicit user direction | Resident operation on the owner's computer; no mandatory cloud coordinator. |
| D18 | Explicit user direction | Image/video creation through ComfyUI or better-suited replaceable providers. |
| D19 | Explicit user direction | Local credential/password management; reuse mature vaults and a broker. |
| D20 | Explicit user direction | Live VNC desktop viewing and takeover. |
| D21 | Explicit user direction | Dedicated secure password/key intake directly to protected storage and authorized use. |
| D22 | Explicit user direction | Independently replaceable media/workflow and memory plugins, user configuration, public interfaces and migration guarantees. |

This register reconciles the current direction with older proposals. The earlier “external personal-assistant controller calling DSH through an SDK” architecture is superseded. An API gateway or speech service may be external infrastructure, but it must not become a second owner of orchestration.

## 2. Defaults for the earlier options

The request for an implementable plan now resolves these engineering defaults. They do not grant account access, spending or live-resource authority. O identifiers remain for traceability; the blanket pending status is superseded. Hermes source was not re-audited and no new claim is made about its current implementation.

| Option | Default | Delivery / reconsideration |
| --- | --- | --- |
| O1 | Explicit Router/Worker model configuration, initially one model; no silent provider fallback | M2; automatic routing needs evaluation |
| O2 | Explicitly replaceable: public versioned MemoryProvider, default plugin, examples, migration and rollback | PA-038, PA-012, PA-039; required in first complete release |
| O3 | Required pre-compaction checkpoint; automatic extraction off, optional reviewed candidates | M2/M3 after quality/deletion tests |
| O4 | Explicit remember/inspect/correct/forget | Required in foundation alpha |
| O5 | Text first; one STT/TTS pair behind replaceable interfaces | PA-026; provider chosen at activation |
| O8 | Today, project/task detail, history and artifacts | PA-008, PA-014 |
| O9 | On-demand daily/weekly review templates; schedules activated separately | PA-014, PA-018 |
| O10 | Shared domain commands; reuse DSH remote first; mobile Web/reconnect in beta | PA-022 |

Resident operation, media, credentials, VNC and secure input follow explicit user additions. [08](08-local-computer-media-and-vault.md) specifies them as first-class capabilities, not cloud-platform afterthoughts.

## 3. Repository baseline

The earlier plan recorded a LICENSE-only pre-documentation tree. This revision began at local HEAD `8928cd989d76db55bb1a5f30efcf37f099d7c4ed` with ten bilingual plan documents and a clean worktree, but no application/package setup. This pass verified both local upstream SHAs, retained the source audit and added task data and a plan checker.

- [Pre-documentation repository commit](https://github.com/MosBot-AI/dsh-personal-agent/commit/7b377ca7bc8e97466fb78cac92838b9018a029f6): `7b377ca7bc8e97466fb78cac92838b9018a029f6`.
- [Existing license](https://github.com/MosBot-AI/dsh-personal-agent/blob/7b377ca7bc8e97466fb78cac92838b9018a029f6/LICENSE): Apache License 2.0. This documentation addition preserves it. Any different licensing choice needs a separate explicit maintainer decision and dependency/notice review.

Proposed `packages/`, API endpoints, tool commands, and test directories elsewhere in these documents are future structure, not files that already exist in this repository.

## 4. Pinned upstream source baselines

| Source | Inspected commit | Manifest facts |
| --- | --- | --- |
| DeepSeek Harness | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | Root `0.2.2-rc.1`; Node `>=24.9.0`; pnpm `11.28.5` |
| DSH Superagent Prototype | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | `0.1.0`; DSH dev dependencies `0.2.1-alpha.2`, peers `^0.2.1-alpha.2`; Node `^22.19.0` or `>=24.0.0`; pnpm `11.7.0` |

Evidence: [Harness package.json](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/package.json), [prototype package.json](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/package.json).

The prototype is a research artifact, not a finished personal assistant. Its README distinguishes the public implementation from the internal version and broader design discussion. Use source and tests to establish capabilities, not product comparisons or news coverage. [Prototype README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/README.md).

## 5. What native DSH already provides

### 5.1 Plugins and bundles

A profile declares `dsh.profile.bundles`; a bundle declares `dsh.bundle.patch`. Bundle patches compose plugin rows. Configuration replacement replaces a whole configuration, not an assumed recursive merge. The prototype itself is already a native bundle, using `name`, `inject`, `Config`, and `apply(ctx, config)` with runtime disposal tied to the Cordis lifecycle.

Sources: [base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/base/README.md), [prototype entry](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/index.ts), [prototype patch](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/cordis.patch.yml).

**Implication:** implement a native personal-agent profile/bundle and services. Do not misdescribe the prototype as an external SDK controller.

### 5.2 Native agent control and streaming

`ctx.agents.create()` and `resume()` provide an agent handle with lifecycle ownership. Native Agent supports `followup`, `steer`, `inject`, `cancel`, and `whenIdle`. `inject` adds context without waking work. `whenIdle` means whole-agent quiescence, not completion of one requested task.

`agent/assistant-stream` provides ordered process-local start/chunk/end frames. Durable settlement uses `assistant/message` or `assistant/attempt`; transient presentation chunks are not a persistent replay log.

Sources: [agent control methods](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L203-L270), [stream frames](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L150-L191), [stream event](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L391-L399).

The SDK client's missing runtime-cancel RPC is a limitation of that surface, not of the in-process agent runtime. [SDK limitations](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/README.md).

**Implication:** native plugin integration can use native cancel/stream. Still build business-level cancellation, effect reconciliation, and client replay semantics. Tool cancellation is cooperative; same-process code cannot be safely hard-killed by wishing it stopped.

### 5.3 Sessions and subordinate task boards

DSH session records are append-only. `ctx.sessions.flush(session)` is a durability barrier only when the persistence capability is composed. Avoid deprecated synchronous event APIs and experimental plugin-record storage for a new external plugin's product database.

Agent Teams already provide a durable compare-and-swap task board with dependencies, ownership, revisions, and root-session persistence, scoped to a subagent tree. Task changes do not automatically wake an agent. This is useful collaboration machinery, not an existing lifetime personal-task system across unrelated conversations and channels.

Sources: [session contract](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/README.md), [Agent Teams](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/README.md).

**Implication:** keep canonical personal Task/Attempt records and adapt native sessions/team tasks underneath them; do not invent a second agent runtime.

### 5.4 Tool guard and approval boundary

The inspected tool pipeline includes extensible pre-execute policy, monotonic registered guards, dispatch, and post-execute/final-result handling. `ctx.tools.guard` is a scoped, deny-only **synchronous** guard. Its signature is `(execution: Readonly<ToolExecution>) => string | undefined`.

It is suitable for checking current scope/revocation but is not itself an asynchronous durable approval workflow. Connector-side dispatch must also check authorization when an operation bypasses a model tool call. Tools must observe/forward `exec.signal`; a declared timeout alone requires the relevant timeout policy wrapper to enforce it.

Sources: [guard implementation](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/index.ts#L379-L401), [tool contracts](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts).

Native user approval is one-shot, tied to an open turn, and records asked/decided events. Its request does not contain exact tool arguments. It does not supply a durable pending-work queue, remembered grant/revocation store, or out-of-turn personal approval workflow. Missing answerers fail closed; `never` rejects approval-requiring actions rather than automatically approving them.

Sources: [approval lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/user-approval/src/index.ts#L227-L259), [approval limitations](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/user-approval/README.md).

**Implication:** durable exact-action Approval/Grant/Effect records are new project work. Preserve native enforcement and fail-closed behavior while validating how the personal workflow resumes a fresh execution after approval or restart.

### 5.5 New audit: schedules and transactions

Native schedule already persists instructions, supports timezone/Cron/RRULE, destinations and receipts. It needs an online host and collapses missed recurring occurrences. Session flush and schedule acknowledgment are separate commits, so crashes can duplicate delivery; receipts establish inbox persistence, not business completion. PA-018 reuses scheduling and adds logical occurrence deduplication. [Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/schedule/schedule/README.md).

Storage-domain explicitly lacks cross-table transactions and secondary indexes. Its SQLite document-row provider does not establish an atomic Task + Approval + Effect + Outbox API. Use plugin-owned tables/database rather than modifying host storage. [Domain limits](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/storage/storage-domain/README.md), [SQLite](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/storage/storage-sqlite/README.md).

### 5.6 New audit: remote access, desktop and credentials

Native remote-access protects declared Remote resources/actions. Extend it before introducing another identity stack; Task/Artifact/desktop-session resources still require their own checks. [Remote access](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/remote-access/README.md).

Computer/browser-use registries select providers, not a universal operation implementation. Shared desktops lack cross-session arbitration, and SSH file sandboxing does not restrict networking. PA-031 adds leases/isolation checks; PA-036 supplies VNC transport. [Computer](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/computer-use/computer-use/README.md), [browser](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/browser-use/browser-use/README.md), [SSH sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/ssh/sandbox-ssh/README.md).

Credentials supplies references and records, but credentials-local is readable by same-UID processes and explicitly defers an OS keychain provider. PA-032/037 are new broker/intake work; the existing file provider cannot substantiate vault isolation. [Service](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/credentials/credentials/README.md), [local limits](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/credentials/credentials-local/README.md).

### 5.7 New audit: media delivery

Attachment supports images and generic files without a dedicated audio/video lifecycle. The session-controller file route returns entire files, ignores Range and uses image-size limits. Large-video playback, previews, media job recovery and generation require new work. [Attachments](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/attachment/attachment/README.md), [file route](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/README.md).

## 6. Prototype patterns to retain and assumptions to replace

| Topic | Useful pattern | Required personal-agent change |
| --- | --- | --- |
| Work model | Trigger/Thread/Ticket/Assignment separation | Personal Project/Task/Attempt across projects and non-coding work |
| Admission | Deterministic gate and immutable mandate snapshot | Verified owner/account identity plus action-level authorization |
| Routing | Subscriptions, context-only delivery, references | Third-party context cannot grant or revive authority |
| Durability | SQLite transactions, effect queue, outbox, recovery | Per-provider receipts/reconciliation; no exactly-once claim for arbitrary shell effects |
| Executor | Native DSH session/agent integration | Revalidate current host contracts; least privilege and controlled credentials |
| Scope | GitHub/optional Feishu team coding flow | Generic connector/artifact interfaces and private-data boundaries |
| Pause/stop | Pause and native agent cancellation | Separate soft pause, hard revoke, cancellation, and unknown external outcome |
| Budget | Concurrency/timeouts/provider retry health | Task/owner/provider usage and currency budget policy |
| Memory | Reference graph and recent task/event state | Personal facts, provenance, validity, correction, deletion, retrieval evaluation |

Specific source warnings:

- `Sessions.ensure` selects `danger-full-access`. Do not reuse that as a safe personal-data default. [sessions.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts#L137-L154).
- Coding-oriented presets remove or limit several general capabilities. Rebuild the personal-agent capability policy deliberately. [cordis.patch.yml](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/cordis.patch.yml).
- The executor already uses native cancel for stop/cleanup. [executor/dsh.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/dsh.ts#L354-L398).
- `RetryHealth` observes provider budget-exhaustion retries; it is not a money ledger. [retry-health.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/retry-health.ts).
- `src/core/memory.ts` implements in-memory repositories, not a completed personal-memory product. [memory.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/memory.ts).
- Native process-local deployment assumptions do not establish safe distributed leases or OS-level worker isolation. [deployment guide](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md).

Additional implementation references: [domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md), [core ports](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/ports.ts), [store](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store.ts), [outbox](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/outbox.ts), [prototype tests](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/tests).

## 7. Risks and mitigation

| Risk | Impact | Mitigation / gate |
| --- | --- | --- |
| Host/prototype version drift | Compile failures or lifecycle bugs | Pin both; M0 native contract suite; no untested compatibility claim |
| Plugin mistaken for sandbox | Private-data or credential exposure | Trusted plugins only in process; isolated executor and brokered credentials |
| Authorization inferred from memory/content | Unapproved messages or changes | Verified actor, separate grants, action gate, injection tests |
| Crash after remote side effect | Duplicate send/write | Intent/receipt journal, idempotency, query-before-retry, uncertain state |
| Cancellation race | Effects continue after user stop | Generation/revocation fence, native cancel, provider reconciliation |
| Context loss or false memory | Wrong decisions and repeated work | Canonical tasks, source-backed checkpoints, correction/deletion tests |
| Proactivity overload/cost | Notification fatigue and wasted spend | Observe mode, quiet hours, dedupe, explicit budgets and measured usefulness |
| Scope growth | Features displace reliable outcomes | Release closures and separate local-capability gates; no premature learning/cloud expansion |
| Premature mobile/voice platform | Multiple inconsistent state machines | One command/domain core; optional adapters; minimal first client |
| License/third-party reuse mistakes | Distribution obligations missed | Preserve current license; review notices before copying upstream code |

## 8. Remaining activation inputs

Concrete accounts/scopes, target hardware/OS, model/budget, actual media models, vault provider, VNC server, remote domain and voice service remain deployment inputs. They do not reopen the whole architecture. Missing resources allow keyless development but block corresponding live gates. Do not invent hardware performance, pricing, vault state or historical knowledge.

Defaults are in [02](02-implementation-roadmap.md), task details in [06](06-agent-execution-guide.md). This task does not change licensing, connect accounts or upload private data.
