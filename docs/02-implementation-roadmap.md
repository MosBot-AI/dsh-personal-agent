# 02. Implementation roadmap

[Documentation index](README.md) · [简体中文](02-implementation-roadmap-zh.md)

## 1. How to use this plan

All work packages below are **planned, not implemented**. Milestones express dependencies and acceptance gates, not calendar commitments. A package may be split into issues later; this document does not create or update a GitHub Project.

The baseline product direction is established, but engineering recommendations still need validation. Hermes-specific enhancements O1–O5 and O8–O10 are not selected. Do not mark them as committed scope by placing them in a release checklist.

Recommended path:

```text
M0: compatibility and scope
  → M1: reliable local task vertical slice
  → M2: primary-agent coordination and context continuity
  → M3: connectors, reminders, operational reliability
  → M4: selected memory/client/voice/model enhancements
  → M5: release hardening and documentation
```

Security, data isolation, recovery testing, and observability start in M0/M1 and continue across every milestone.

## 2. M0: Pin the host and prove native integration

**Goal:** select a reproducible DSH baseline and eliminate architecture assumptions before building the product.

| ID | Work package | Deliverable / acceptance |
| --- | --- | --- |
| M0.1 | Pin DSH commit and toolchain; inspect root and nested contributor instructions | Exact lockfile/toolchain record; supported OS matrix explicitly scoped |
| M0.2 | Load a minimal native plugin/bundle | Start, service dependency resolution, configuration validation, unload/shutdown succeed on the pinned host |
| M0.3 | Exercise agent contracts | Create/resume, followup, steer/inject, stream, cancel, idle and terminal-result semantics verified with controlled tools |
| M0.4 | Audit prototype compatibility | Compile/probe the needed parts against current DSH; list direct reuse, adaptation, rejection, and any minimal core patches |
| M0.5 | Prove trusted tool gate placement | Disallowed effects cannot bypass policy via tool aliases, worker paths, MCP, or shell; unknown paths disabled |
| M0.6 | Record scope choices and first deployment | One owner/profile, one supported host target, first connector and enabled optional features recorded |

The inspected upstream harness is `0.2.2-rc.1`; the prototype declares `^0.2.1-alpha.2`. Node/runtime/package-manager requirements also differ. Do not substitute a package version string for a tested compatibility contract.

**Exit gate:** a small real DSH contract suite passes, all needed extension points are identified, and any unresolved unsafe capability stays disabled. If a plugin-only approach fails, provide the smallest core patch and failing/passing reproduction. Do not install arbitrary older dependencies merely to hide incompatibility.

## 3. M1: Reliable local vertical slice

**Goal:** one user can create, inspect, complete, and cancel durable tasks through the primary DSH agent, with a restart-safe result trail.

| ID | Work package | Depends on | Acceptance |
| --- | --- | --- | --- |
| M1.1 | Core schemas and SQLite migrations | M0 | Transactional create/update; version conflicts rejected; backup and restore fixture passes |
| M1.2 | Owner/profile identity and command adapter | M0 | Verified actor context; duplicate input yields one logical command/task |
| M1.3 | Minimal task/project tools | M1.1–2 | Create/list/get/update/complete/cancel with strict arguments and readable errors |
| M1.4 | Attempt-to-native-agent adapter | M0.3, M1.1 | Worker gets scoped task context; result references saved; idle alone never completes task |
| M1.5 | Action/approval/revocation store | M0.5, M1.1–2 | Exact action approval, expiry, denial, stale approval, and revoked grant are tested |
| M1.6 | Effect journal and result outbox | M1.1, M1.5 | Crash/retry does not duplicate a known-completed effect; unknown outcomes stop for reconciliation |
| M1.7 | Restart and cancel reconciliation | M1.4–6 | Running, waiting, cancelled, and ambiguous attempts recovered accurately |

Use fixture/local effects first. Do not connect a privileged real account to compensate for missing tests.

**Demo script:** user creates a project and two tasks; one worker produces a local artifact; the user asks a follow-up while it runs; a second task requests approval; user cancels it; restart the process; inspect the artifact, open task, denied/cancelled effect, and unsent/sent result records. Everything must correspond to persisted evidence.

**Exit gate:** the demo and deterministic fault tests pass. If real model testing is unavailable, label the result “mock/contract verified,” not “usable conversational MVP.”

## 4. M2: Responsive coordination and context continuity

**Goal:** the primary agent handles several ongoing tasks without mixing their state or blocking the user.

- **M2.1 Scheduling and handback:** bound worker concurrency, reserve capacity for user input, prioritize explicit user messages, and apply task deadlines/timeouts. Worker questions return through the primary conversation.
- **M2.2 Follow-up routing:** route owner follow-ups to the correct task; support explicit task references and ask when ambiguous. Subscribed external events add context without becoming new authority.
- **M2.3 Checkpoints and compaction:** persist task/decision/source checkpoints before reducing context; rebuild the current view from canonical state and references.
- **M2.4 Minimal retrieval boundary:** retrieve authorized project/task/history references under a token budget. Distinguish missing records, stale indexes, and “no match.”
- **M2.5 Results and attention:** consolidate updates, show blockers and decisions, provide artifact provenance, and record delivery failure separately from task failure.
- **M2.6 Basic observability:** task/attempt/effect correlation, bounded redacted logs, latency and model usage, source health, queue age, and recovery counts.

**Acceptance:** two concurrent projects and repeated follow-ups remain isolated; a third-party message cannot resume a cancelled task; after multiple compactions and restart the primary agent can report open work and sources correctly. Retrieval may answer “not found”; it must not invent a remembered fact.

**Proposed performance gate:** under a documented local load fixture with four worker jobs, the command API acknowledges a queued user command within one second at p95, excluding model/network latency. Measure first and adjust the target openly if needed; this is not a current benchmark or hardware promise.

## 5. M3: Controlled real-world usefulness

**Goal:** move from local tasks to one real connector and reliable reminders without broadening authority accidentally.

- **M3.1 Connector SDK minimum:** operation schemas, capability list, account identity, health, rate-limit/backoff, stable source IDs, cursor, read/write distinction, and receipt/reconciliation behavior.
- **M3.2 One read-only provider:** owner selects the service and data scope. Replay captured fixtures and validate identity/provenance before using live access.
- **M3.3 One narrowly authorized write path:** prefer a provider operation with idempotency or a queryable receipt. Show exact destination/data to the user when approval is required.
- **M3.4 Durable reminders:** store original local-time intent, IANA timezone, next occurrence, recurrence rules if selected, and missed-run policy. Test daylight-saving boundaries and timezone changes. Acknowledging a reminder schedule is separate from confirming later delivery.
- **M3.5 Observe-mode proactive candidates:** record proposed actions and reasons, deduplicate, honor quiet hours and attention/cost budgets. Automatic execution remains disabled unless a matching grant exists.
- **M3.6 Operational controls:** health endpoint/local command, queue inspection, retry with reconciliation, dead-letter view, safe shutdown, migration rollback strategy, backup/restore drill.

**Exit gate:** the agreed real connector task and reminder complete end-to-end, failure/reconnect paths are demonstrated, and no private data appears in unauthorized outputs or logs. There is no requirement to add email, calendar, messaging, and GitHub simultaneously.

## 6. M4: Optional feature tracks, only after selection

| Option | Track and dependency | Required proof if chosen |
| --- | --- | --- |
| O1 | Per-worker provider/model/reasoning routing; after M2 budgeting | Capability-compatible model selected; explicit provider/data policy; no silent fallback to a more expensive model |
| O2 | Replaceable memory backend; after canonical memory schema | Contract validation, export/import, migration rollback, deletion, degraded mode, and provider isolation |
| O3 | Automatic continuous memory; after context/retrieval and deletion tests | Provenance, confidence, correction, privacy filtering, compaction checkpoints, Chinese/multilingual recall evaluation |
| O4 | Explicit memory management; after memory record schema | Remember/search/correct/forget work end-to-end; deleted facts do not return from derived indexes |
| O5 | Replaceable voice engines; after shared identity/command path | STT/TTS contract, privacy/cost disclosure, interruption/reconnect, text fallback, approval integrity |
| O8 | Rich task views/history; after M1 canonical state | Date queries with timezone, task detail/project counts, immutable event history and pagination |
| O9 | Planning/review templates; after tasks and scheduler | Templates create inspectable plans; no accidental external action or implicit recurring schedule |
| O10 | Unified mobile/connector API and replayable changefeed; after M1–M3 | Auth scopes, versioned commands/events, replay cursor, snapshot recovery, duplicate commands, stale approvals, device isolation |

The broad memory, voice, and mobile directions remain in the product vision. This table deliberately does not convert unselected Hermes refinements into mandatory implementation work.

## 7. M5: Release hardening

Before an alpha is called usable:

1. Pin dependencies and document supported host, OS, and upgrade path.
2. Pass unit, schema, contract, integration, security, restart/fault, migration, and deletion tests for enabled features.
3. Run at least one genuine model-driven task → tool → write → read-back flow, plus cancel, approval, and restart scenarios. Record model/provider/version and actual cost without publishing secrets.
4. Keep fixtures and live test evidence separate. Every advertised feature has a test and an explicit limitation.
5. Verify clean installation, configuration validation, health diagnostics, safe stop/uninstall, data export, backup, and restore.
6. Review dependency licenses and copied code notices. Preserve the repository's existing license unless a separate maintainer decision changes it.
7. Document failure handling, private-data storage, network exposure, credential handling, operator recovery, and how users inspect/correct/delete data.
8. Publish the supported plugin contract and one small example only after the interface is stable enough to support.

## 8. Release decision checklist

- [ ] Product owner has recorded pending option selections or explicitly deferred them.
- [ ] DSH compatibility matrix and native contract tests exist.
- [ ] No full-access executor is presented as a safe default.
- [ ] Authorization is enforced at effect execution and revocation is race-tested.
- [ ] Task outcome and delivery outcome are independently visible.
- [ ] Unknown effect outcome cannot trigger blind retries.
- [ ] Backup/restore and migration failure tests pass.
- [ ] Supported memory behavior survives repeated compaction/restart and honors deletion.
- [ ] Enabled connectors/clients have real end-to-end evidence.
- [ ] Documentation distinguishes implemented, tested, experimental, planned, and unsupported features.

## 9. Resource and schedule discipline

Start with a single owner/profile on a single host and a remote model provider. Local model serving, speech models, browsers, and vector databases have separate resource costs. No RAM or throughput claim is justified until measured on a stated machine and workload.

Track elapsed time, tokens, provider charges, tool charges, concurrent jobs, retry counts, and daily/task budgets. Concurrency and timeout controls do not automatically create a currency ledger. Unknown pricing is “unknown,” not zero. A user request can have priority without authorizing an unlimited spend or a subscription upgrade.

Sequence work by risk: native integration → durable state and authorization → one complete task → multi-task continuity → one real provider → optional product surfaces. Avoid building a large dashboard or interchangeable provider framework before the first reliable vertical slice.
