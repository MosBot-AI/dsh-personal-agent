# 03. Contracts, security, and tests

[Documentation index](README.md) · [简体中文](03-contracts-security-and-tests-zh.md)

**All schemas, endpoint names, and event names in this document are proposed project contracts. They are not advertised as existing DSH APIs.** The native host API evidence is listed separately in [the source audit](04-decisions-and-source-audit.md).

## 1. Durable domain model

| Record | Minimum fields and invariants |
| --- | --- |
| Owner/Profile | Stable owner ID, verified account/device associations, profile isolation, policy version |
| SourceEvent | Source instance + external event ID as unique key; trusted actor metadata separate from untrusted body; occurred/received times; thread and provenance |
| Conversation | Stable user-facing conversation ID, runtime session references, last checkpoint, original delivery destination |
| Project | Owner, title, purpose, resource references, current status; no implicit access to all referenced resources |
| Task | Owner/project, requested outcome, constraints, status, version, next action, deadline/timezone, provenance, acceptance condition |
| Attempt | Task, native agent/session identity, generation, executor, bounded capability/data scope, start/end/heartbeat, outcome, artifact references |
| Grant | Approving principal, action/resource/account/recipient/data scope, limits, expiry, approval evidence, policy version, revocation state |
| Approval/Question | Request ID, task/attempt, type, exact pending action or question, safe display text, expiry, state, response actor; distinct kinds |
| Effect | Stable operation ID, task/attempt/generation, intent and payload digest, grant, provider idempotency key, state, receipt, reconciliation data |
| OutboxItem | Destination, redacted payload/artifact refs, dedupe key, delivery state, receipt, retries, next attempt |
| Artifact | Owner, producing attempt, content hash, storage reference, media type, provenance, visibility and retention |
| MemoryRecord | Owner/scope, fact or reference, source, validity, explicit/inferred, confidence, supersession/deletion version; never authority |
| Schedule | Owner, task/rule reference, timezone, next occurrence, local-time intent, recurrence/missed-run policy, lease and last result |

Use UTC for persisted instants and retain IANA timezones plus original user intent where wall-clock meaning matters. IDs must not encode secrets. Validate schemas at every boundary and keep migrations versioned.

The recommended initial SQLite database is the canonical source for work and effect state. Markdown exports are readable views, not a second competing task database. Indexes and summaries are derived. Credentials live in a separate secret store and never enter a worker context or exported task record.

## 2. Task and attempt state machines

Proposed task states:

```text
queued → running → completed
           ├── waiting_input ──→ queued
           ├── waiting_approval → queued / cancelled
           ├── blocked ───────→ queued / failed
           ├── failed
           └── cancelling ────→ cancelled / reconciliation_required
```

These arrows require explicit validated events. A task may also be cancelled before it runs. A failed task can be retried only through a new attempt and a checked transition; do not erase the prior failure. Completed/cancelled tasks do not restart simply because an external thread gets a new message.

An attempt has its own runtime lifecycle. `agent idle`, transport disconnected, model turn finished, business task completed, and user result delivered are distinct facts. A worker response without the required artifact or receipt cannot satisfy completion criteria.

Use optimistic versions on task updates. Transactionally persist commands, state changes, and effect/outbox intents. A single-process lock is suitable for the first deployment; if distributed executors are added later, require leases and fencing tokens so stale attempts cannot commit new effects.

## 3. Proposed application command and event boundary

Keep domain commands transport-independent. A local DSH tool and a future HTTP adapter should call the same service, not duplicate business logic.

```ts
type CommandEnvelope = {
  commandId: string;          // idempotency scoped to authenticated owner/client
  expectedVersion?: number;
  conversationId?: string;
  taskId?: string;
  type: string;
  payload: unknown;           // validated by command schema
};

type PublicEvent = {
  eventId: string;
  sequence: number;           // monotonic within the authorized feed
  schemaVersion: number;
  occurredAt: string;
  conversationId?: string;
  taskId?: string;
  attemptId?: string;
  type: string;
  payload: unknown;           // allowlisted, redacted view
};
```

The authenticated owner and device come from a trusted adapter, not writable envelope fields. Reusing `commandId` with a different payload is a conflict, not a second action. Event IDs and task IDs are not authorization tokens.

If O10 is selected, the initial HTTP proposal is:

- `POST /v1/commands`: validate/enqueue a command and return its durable identity.
- `GET /v1/tasks` and `GET /v1/tasks/{id}`: authorized task projections.
- `POST /v1/tasks/{id}/cancel`: request cancellation and return the current transition, not a false final result.
- `POST /v1/approvals/{id}/responses`: exact approval response with expected request version.
- `GET /v1/events?cursor=...`: redacted replayable SSE feed.
- `GET /v1/snapshot`: recover after an expired/gapped cursor.

Suggested public events include `task.updated`, `attempt.progress`, `approval.requested`, `question.requested`, `artifact.ready`, `effect.reconciliation_required`, and `delivery.failed`. Streaming token deltas may be ephemeral; canonical task events must be durable. Do not label reconnect as lossless unless retention/cursor behavior is tested.

Use TLS for remote access, explicit authentication, scoped device access, rate limits, and CSRF/origin protections appropriate to the chosen auth mode. Bind local-only services to loopback by default. Default-deny all task/artifact/feed reads outside the authenticated owner/profile.

## 4. Authorization and approval

Separate two gates:

1. **Intake gate:** is this verified actor/source permitted to request or trigger this work?
2. **Action gate:** may this exact action execute now with this account, recipient, resource, data, scope, and current grant?

The LLM proposes actions. Deterministic trusted code checks grants and execution constraints. Tool metadata, retrieved documents, quoted messages, worker handbacks, and memory cannot approve an action.

An approval must bind the approving actor, request/task/attempt, action kind, destination/resource, normalized payload digest, data disclosure, limits, policy version, and expiry. Any material change invalidates the approval or requires reevaluation. An approval from another user/device/session is rejected unless that identity is explicitly authorized.

Dispatch must use the immutable canonical payload whose digest was approved. Atomically reserve or consume a one-shot approval with the unique effect dispatch claim; concurrent responses or retries cannot reuse it for multiple effects. Reject payload mutation between approval and dispatch.

Persist pending approvals and questions, but do not assume an old in-memory host approval promise can survive restart. Recovery must revalidate the pending action, reconstruct a fresh native execution path, and reconcile whether any effect already happened. A clarification response is not approval for an external write.

Revocation takes effect at the execution boundary and invalidates queued effects. Distinguish soft pause, task cancellation, grant revocation, and emergency stop. Trusted in-process code must serialize or fence the final grant check with dispatch sufficiently to avoid a queued stale authorization; record unavoidable in-flight effects honestly.

## 5. Tool, connector, and plugin security

- Keep the primary agent and workers on least-privilege capabilities. A worker inherits a subset of the task grant, never a broader scope.
- Use DSH's native tool guards where they provide the required enforcement; prove coverage rather than assuming a prompt or a tool list is isolation.
- Restricted shell must not bypass a denied connector action by reaching the same API with ambient credentials. Disable general shell for sensitive connector workers unless an actual sandbox and credential boundary exist.
- Treat third-party MCP servers and tools as untrusted. Validate arguments and outputs; cap response size; prevent dynamic tool changes from expanding rights silently.
- Keep account credentials in a broker or secret store. Workers get short-lived/scoped access only when necessary; avoid exposing tokens through logs, process arguments, artifacts, or model prompts.
- Validate URLs and redirects; constrain egress and internal-network access for fetchers; protect file access from traversal and symlink escape; verify upload/download types and sizes.
- Enforce owner/profile/resource labels before retrieval and before output. Correlation between private email and a public repository does not authorize copying the email into a comment.
- A model provider also receives data. Apply destination/data policy before inference, retrieval-context transmission, compaction, and summarization, even on a read-only task. Provider fallback must not silently send personal context to a different provider. This baseline protection does not depend on selecting model-routing option O1.
- Only trusted reviewed plugins run in the DSH process. A plugin manifest or dependency injection boundary cannot constrain malicious code executing as the same OS user.

## 6. Cancellation and external effects

Cancellation flow:

1. Persist `cancel_requested` and advance the task generation/revocation state.
2. Block new dispatch and new effects for that attempt/scope.
3. Invoke the native DSH cancellation path for the bound agent and relevant child work.
4. Reconcile tools/jobs that may still be running and any external side effects.
5. Mark confirmed cancellation only with termination/effect evidence; otherwise expose `cancelling` or `reconciliation_required`.

Native agent cancellation does not undo a sent message, accepted booking, or committed file write. Do not claim rollback where only compensation is possible. Repeated cancel requests should be idempotent and should not cancel unrelated tasks.

Proposed effect state:

```text
prepared → authorized → dispatching → confirmed
                         ├── failed
                         └── uncertain → confirmed / failed / manual_reconciliation
```

Write intent before dispatch and persist receipts after. Prefer provider idempotency keys. If a network timeout occurs after transmission, query the provider by operation/receipt before retrying. When neither idempotency nor reliable lookup exists, stop in an uncertain state. A local dedupe key alone cannot guarantee exactly-once behavior in a remote system.

Outbox acceptance, provider acceptance, actual delivery, and recipient read are separate states. If the provider only reports acceptance, display that fact rather than claiming delivery.

## 7. Recovery, migration, and privacy

At startup: acquire the supported runtime lock; migrate safely; load nonterminal tasks; check native session/agent status; reconcile dispatching effects; recover waiting questions/approvals; then resume eligible schedules and outbox delivery. Do not blindly rerun every task marked running.

Use bounded retries with backoff and jitter. Classify authentication, permanent provider rejection, rate limit, transient network, model failure, corrupt local state, and uncertain external outcome separately. A watchdog may detect a stuck worker but must not widen its authority or restart work the user cancelled.

Backups need encryption/access control, a tested restore path, documented retention, and a deletion strategy. Migrations should preserve receipts and audit history, provide a pre-migration backup, and fail without silently deleting unknown records. For destructive schema changes, document whether rollback needs restore rather than pretending all migrations are reversible.

Restoring an older backup may lose receipts, cancellations, and revocations for actions already executed remotely. Enter reconciliation-only mode after restore: pause external writes, schedules, and outbox dispatch; refresh current authority; and reconcile uncertainty since the snapshot before enabling execution. A restored old grant or pending message must not automatically become active again.

Memory deletion should remove current records, retrieval index entries, and derived facts/summaries or tombstone them so they cannot be reintroduced. Explain backup retention and any audit records that cannot be immediately erased. Never store account secrets in memory.

## 8. Required test matrix

| Area | Failure or scenario | Expected evidence |
| --- | --- | --- |
| Native contracts | Host upgrade, create/resume, cancel/stream/guard hooks | Pinned-version test; incompatible host rejected |
| Identity | Spoofed display name, quoted owner request, wrong profile/device | No owner grant created; cross-profile read/write denied |
| Deduplication | Webhook/poll overlap, duplicate commands, changed payload under same ID | One logical operation or explicit conflict |
| Concurrency | Competing updates and stale worker result | Version/generation fence rejects stale mutation |
| Approval | Deny, expire, change arguments, stale card, restart pending | No action executes under invalid approval |
| One-shot approval | Simultaneous responses/dispatch, payload mutation after approval | One immutable approved effect; duplicate consumption and changed payload rejected |
| Revocation | Revoke between queue and dispatch; stop while worker runs | New effects blocked; in-flight outcome reconciled |
| Tool isolation | Alternate shell/MCP path, secret-bearing environment, path escape | Forbidden effect cannot bypass the trusted gate |
| Crash recovery | Crash before send, after send before receipt, after receipt before task update | No blind replay; consistent task/effect state |
| Delivery | 429, permanent channel failure, accepted-but-unconfirmed delivery | Correct retry policy and honest delivery status |
| Memory/context | Repeated compaction, Chinese queries, correction, deletion, restart | Relevant source-backed recall; deleted facts not resurrected |
| Data sharing | Private source correlated with public task | Output denied/redacted without matching disclosure grant |
| Model disclosure | Context sent for summarization or provider fallback | Destination/data policy enforced before transmission |
| Scheduler | DST, timezone change, missed run, duplicate wakeup | One intended occurrence or documented catch-up behavior |
| Client (if selected) | Reconnect, expired cursor, duplicate approval response | Snapshot recovery, no repeated action, isolated feed |
| Voice (if selected) | Barge-in, STT misrecognition, disconnect, TTS failure | Text fallback and no unintended approval/cancellation |
| Operations | Migration failure, disk full, corrupt index, backup restore | Safe degradation and recoverable authoritative records |
| Old backup restore | Snapshot predates send, revoke, or cancellation | Reconciliation-only startup; no automatic replay or stale-grant reactivation |

Unit tests prove pure transitions; host contract tests prove DSH integration; fault tests prove recovery; live model/provider tests prove the complete path. They are not interchangeable. Record commands, versions, fixture/live classification, results, and untested limits per milestone.

## 9. Definition of a valid completion claim

The primary agent should report what changed, where the result can be inspected, and any remaining uncertainty. “Implemented” requires code. “Tested” requires named executed checks. “Published” requires verified remote state. “Delivered” requires the provider evidence available for that channel. A design document alone satisfies none of the first three implementation claims.
