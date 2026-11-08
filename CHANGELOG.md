# Changelog

[简体中文](CHANGELOG-zh.md)

Notable changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Future releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add the pinned TypeScript and pnpm workspace and a native bundle that loads through the named `dshpa` profile.
- Add a native DSH agent and session adapter, with real-host contract checks and compatibility evidence for control, persistence, and scheduling.
- Define durable work records, validate owner commands and worker reports, and add deterministic task transitions with version and attempt-generation checks.
- Add a versioned SQLite work store with single-writer locking, atomic command and intent commits, and corruption quarantine.
- Add trusted identity bindings, exact-action review and one-use dispatch claims, and a tool-free private worker runtime.
- Add bounded native Workers with durable input cursors, scoped reports, foreground controls, and verified teardown.
- Seal immutable artifact revisions, commit scoped verification and delivery intents together, and track provider delivery evidence.
- Add a local DSH Web inbox for project work, Worker controls, exact approval, and reviewable results alongside native conversations.
- Journal native inputs and recover exact claims after restart, with generation-fenced cancellation and reconciliation-only backup restore.
- Route authenticated source events through versioned subscriptions and a bounded assessment queue while keeping owner controls responsive.
- Add opt-in checkpoints before native compaction and pruning, scoped reference recall and search, durable context exclusions, and sectioned Worker input budgets.
- Add explicit personal memory controls, an independent SQLite provider with snapshot import and export, and core exclusions that protect corrected or forgotten facts from stale provider data.
- Add versioned goal plans, owner-reviewed Worker drafts, durable task prerequisites and on-demand weekly review.
- Add read-only local knowledge search over configured roots, with bounded incremental indexing and revision-checked source pages.
- Add an owner-bound GitHub read connector with scoped pagination, rate-limit backoff and an optional capability-pinned MCP transport.
- Reserve and reconcile model costs before dispatch, enforce compute limits and a separate heavy GPU queue, and expose scoped usage and attention decisions in the local inbox.
- Reconcile native schedule wakes with versioned routine intent and show deduplicated local reminders and scoped task wakes in the inbox.
- Add opt-in goal-bound proactive rules with replay, owner-reviewed staging, private briefs and granted local notices.
- Add project-scoped Markdown skills with accepted examples, held-out evaluation, explicit version approval and rollback.
- Operate a single resident profile with local readiness, diagnostic watchdogs, warm schedule recovery, online backup retention, and metadata audit export.
- Add versioned capability plugin contracts, a lifecycle registry, policy-wrapped consumers, and independently loadable memory and mock media examples.
- Add versioned model-routing contracts and a native DSH boundary for pinned, budget-gated inference attempts.
- Add deterministic task difficulty routing with configured pools, bounded semantic estimation and verified quality escalation.
- Add Core-owned shared inference quotas, bounded fallback, durable resource waits and cold fee recovery.
- Map 43 implementation tasks into GitHub Project and English Issues with native dependencies, reporting protocol, live readiness and acceptance-gated Actions reconciliation.

- Specify configurable model routing with difficulty-based model/effort selection, quota-aware fallbacks, an optional LiteLLM adapter and implementation/evaluation tasks.

- Product research and source audits informing the dshpa architecture, with separate English and Chinese documentation.
- Implementation specifications for resident desktop operation, VNC viewing/takeover, media creation, secure credential intake and replaceable capability plugins. These capabilities remain planned.
- A machine-readable backlog of 43 implementation tasks, 25 acceptance scenarios and a plan validator for dependencies, references and document links.
- Bilingual repository README entry points and English-only agent instructions covering documentation, commits, changelogs and project collaboration.
- Cross-platform ignore rules for operating-system files, editors, Node/package-manager and Vite output, tests, Python caches and local secrets/runtime data.

### Changed

- Add WorkStore migration support for scoped mobile device credentials. Restoring an older backup clears mobile pairing codes and credentials.
- Refine the existing DSH-native plan into dependency-driven release stages, keeping local operation central and defining explicit plugin migration and recovery requirements.

[Unreleased]: https://github.com/MosBot-AI/dsh-personal-agent/commits/main
