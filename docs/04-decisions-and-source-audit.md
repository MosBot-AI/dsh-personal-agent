# 04. Decisions and source audit

[Documentation index](README.md) · [简体中文](04-decisions-and-source-audit-zh.md)

Audit date: 2026-11-07 UTC. Source inspection is not runtime verification. No DSH installation, plugin execution, or application test suite was run for this documentation-only publication.

## 1. Decision register

| ID | Status | Decision / constraint |
| --- | --- | --- |
| D1 | Confirmed direction | DSH itself is the central personal agent and owns the primary conversation and orchestration. |
| D2 | Confirmed direction | Native plugins/bundles first; small core changes are permitted when an actual missing contract is demonstrated. |
| D3 | Confirmed direction | Coordinate projects, tasks, information, personal affairs, and reminders; support an open connector/MCP system. |
| D4 | Design direction | Preserve continuous conversation through durable work state and bounded context/memory; do not equate the task database with complete personal memory. |
| D5 | Design direction | Eventual remote/mobile and voice access use the same personal agent; exact product scope and provider/interface choices remain pending. |
| D7 | Engineering recommendation | Single owner/profile and single-host reliability first; minimal state/effect/authorization contracts before distributed execution. |
| D8 | Publication scope | Add the implementation plan to this repository's `docs/`; do not claim implementation or change the existing license as part of this publication. |

This register reconciles the current direction with older proposals. The earlier “external personal-assistant controller calling DSH through an SDK” architecture is superseded. An API gateway or speech service may be external infrastructure, but it must not become a second owner of orchestration.

## 2. Hermes comparison options: no implicit selection

The options below remain pending selection, rather than accepted implementation scope. Existing implementation status in Hermes is not DSH implementation status and is not evidence that code is directly portable.

| Option | Candidate refinement | Current DSH planning status | Selection question |
| --- | --- | --- | --- |
| O1 | Separate provider/model/reasoning choice for different workers | Pending | Fixed model first, explicit worker profiles, or automatic routing? |
| O2 | Replaceable memory backends with export/migration compatibility | Pending | Internal seam only, or a supported third-party provider SDK? |
| O3 | Automatic continuous memory extraction/recall and pre-compaction saving | Pending | Which facts may be auto-saved, with what review, privacy, and quality rules? |
| O4 | User commands/conversation to remember, inspect, correct, and forget | Pending | Which explicit operations belong in the first release? |
| O5 | Interchangeable local, hosted, and real-time voice providers | Pending | Text first, one speech path, or provider interchangeability now? |
| O8 | Date-based task views, task detail, project statistics, task operation history | Pending | Which richer views/history are needed beyond baseline task CRUD? |
| O9 | Daily/weekly planning and review templates | Pending | Which templates, and should schedules be explicitly created separately? |
| O10 | Unified mobile/connector API, change log, and reconnect protocol | Pending | Which initial clients and replay/compatibility guarantees are required? |

The underlying DSH vision already included tasks, memory, voice, connectors, and future mobile access. The pending choices concern the detailed refinements above. Safe internal boundaries can be designed now without marking every related feature selected. Privacy, authorization, correctness, and recovery are engineering release requirements rather than optional product embellishments.

## 3. Repository baseline

At inspection, `MosBot-AI/dsh-personal-agent` was public, its default branch was `main`, and its only file was `LICENSE`. No existing application code, documentation, test configuration, or `AGENTS.md` was present in that tree.

- [Pre-documentation repository commit](https://github.com/MosBot-AI/dsh-personal-agent/commit/7b377ca7bc8e97466fb78cac92838b9018a029f6): `7b377ca7bc8e97466fb78cac92838b9018a029f6`.
- [Existing license](https://github.com/MosBot-AI/dsh-personal-agent/blob/7b377ca7bc8e97466fb78cac92838b9018a029f6/LICENSE): Apache License 2.0. This documentation addition preserves it. Any different licensing choice needs a separate explicit maintainer decision and dependency/notice review.

Proposed `packages/`, API endpoints, tool commands, and test directories elsewhere in these documents are future structure, not files that already exist in this repository.

## 4. Pinned upstream source baselines

| Source | Inspected commit | Manifest facts |
| --- | --- | --- |
| DeepSeek Harness | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | Root `0.2.2-rc.1`; Node `>=24.9.0`; pnpm `11.28.5` |
| DSH Superagent Prototype | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | `0.1.0`; DSH dev dependencies `0.2.1-alpha.2`, peers `^0.2.1-alpha.2`; Node `^22.19.0 || >=24.0.0`; pnpm `11.7.0` |

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
| Scope creep from Hermes | Unchosen features displace a reliable core | Pending-option register; explicit feature selection before M4 |
| Premature mobile/voice platform | Multiple inconsistent state machines | One command/domain core; optional adapters; minimal first client |
| License/third-party reuse mistakes | Distribution obligations missed | Preserve current license; review notices before copying upstream code |

## 8. Questions to close before implementation scope is frozen

1. Which of O1–O5 and O8–O10 should be in the first release, later, or excluded?
2. Which first deployment target and connector should prove the vertical slice?
3. What private information may be retained automatically, for how long, and under what review/deletion behavior?
4. What model/tool spending limits, concurrency, and notification preferences should be defaults?
5. Is the existing repository license the intended final choice? Preserve it until that is explicitly decided.

These questions do not block publishing this plan. They do prevent treating unresolved options as authorized implementation scope.
