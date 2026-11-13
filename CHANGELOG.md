# Changelog

[简体中文](CHANGELOG-zh.md)

Notable changes are recorded here using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Future releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Count Unicode code points in shared task cursor queries so clients receive the pagination restart error for undecodable cursors within the contract limit.

- Confirm prerequisite completion in GitHub Project before promoting dependent tasks to Ready.
- Recover mobile CI from a stalled Chrome handshake with one isolated browser restart.
- Distinguish Chrome startup, DevTools command, and process failures in mobile CI diagnostics.

- Keep mobile tasks and approvals updating on slow connections and after the live event stream reconnects.

- Separate native schedule tamper-recovery fixture timing from real overdue-wakeup recovery, preserving strict uncertainty and no-delivery checks on slower hosts.
- Reject startup of the resident Web profile when the local inbox cannot activate.

- Restore mobile approval controls after an unconfirmed submission and keep responses from retired sessions from interrupting a new pairing.

- Start leased Chromium tasks from a clean tarball installation by sharing the pinned DSH host's MCP and scope packages.
- Retry interrupted media output downloads without rerendering, and preserve GPU exclusion for persisted media jobs even when media configuration is disabled.
- Remove unavailable Today panels when the local Inbox refreshes into restore-only mode.
- Refuse to publish a GitHub test draft when its approved head already exists, including at the same commit.

- Improve local knowledge keyword ranking with stronger document-body matches and priority for exact filenames and relative paths.

### Added
- Add authenticated live shared-task pagination with scope- and device-bound cursors that expire on restart and title previews for long outcomes. Other shared domains remain unavailable.

- Add authenticated shared-client API discovery with pinned Hermes/DSH contract fixtures, explicit unavailable task-list errors, and non-terminal cancellation/reconciliation projections.

- Configure explicit Linux XDG targets separately from macOS grants. Today lists them as unavailable and rejects launch before allocating a desktop lease or Worker.

- Add opt-in mobile task updates and exact approval review with local pairing, device revocation and explicit per-review handoff. The view clears private content when hidden and authenticates again when it becomes visible.
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
- Add exact approval and read-only reconciliation for draft pull requests in an explicitly configured test repository.
- Reserve and reconcile model costs before dispatch, enforce compute limits and a separate heavy GPU queue, and expose scoped usage and attention decisions in the local inbox.
- Reconcile native schedule wakes with versioned routine intent and show deduplicated local reminders and scoped task wakes in the inbox.
- Add opt-in goal-bound proactive rules with replay, owner-reviewed staging, private briefs and granted local notices.
- Add project-scoped Markdown skills with accepted examples, held-out evaluation, explicit version approval and rollback.
- Add opt-in macOS accessibility workflows with exact application leases, owner takeover and explicit continuation in Today.
- Add an optional isolated Chrome provider with explicit browser profile and tab leases, with a network allowlist bound to each task before browser launch.
- Operate a single resident profile with local readiness, diagnostic watchdogs, warm schedule recovery, online backup retention, and metadata audit export.
- Add versioned capability plugin contracts, a lifecycle registry, policy-wrapped consumers, and independently loadable memory and mock media examples.
- Add versioned model-routing contracts and a native DSH boundary for pinned, budget-gated inference attempts.
- Add deterministic task difficulty routing with configured pools, bounded semantic estimation and verified quality escalation.
- Add Core-owned shared inference quotas, bounded fallback, durable resource waits and cold fee recovery.
- Add opt-in durable image and video jobs with a loopback ComfyUI provider, restart reconciliation and verified output metadata. A missing file from a completed render fails the job and releases the media lease.
- Map 43 implementation tasks into GitHub Project and English Issues with native dependencies, reporting protocol, live readiness and acceptance-gated Actions reconciliation.

- Specify configurable model routing with difficulty-based model/effort selection, quota-aware fallbacks, an optional LiteLLM adapter and implementation/evaluation tasks.

- Product research and source audits informing the dshpa architecture, with separate English and Chinese documentation.
- Implementation specifications for resident desktop operation, VNC viewing/takeover, media creation, secure credential intake and replaceable capability plugins. These capabilities remain planned.
- A machine-readable backlog of 43 implementation tasks, 25 acceptance scenarios and a plan validator for dependencies, references and document links.
- Bilingual repository README entry points and English-only agent instructions covering documentation, commits, changelogs and project collaboration.
- Cross-platform ignore rules for operating-system files, editors, Node/package-manager and Vite output, tests, Python caches and local secrets/runtime data.

### Changed

- Make isolated Linux mobile browser checks independent of the desktop keyring and cover pairing, device and approval expiry plus review recall.

- Add WorkStore migration support for scoped mobile device credentials. Restoring an older backup clears mobile pairing codes and credentials.
- Refine the existing DSH-native plan into dependency-driven release stages, keeping local operation central and defining explicit plugin migration and recovery requirements.
- Upgrade the work database to schema 16 for media jobs after the mobile v14/v15 migrations. Preserve source-version backups, support the original media-only v14 without losing jobs or leases, and use the matching pre-upgrade backup to return to an older build.

### Fixed

- Prompt owners to revalidate missing or invalid model credentials and signed-out DeepSeek accounts before resuming a Worker.
- Honor media cancellation before and during output collection, preserve it across restart, and fence late collector results while retaining the lease until physical work settles.
- Build byte-identical Web client bundles across checkout locations by omitting generated source-path debug comments.

[Unreleased]: https://github.com/MosBot-AI/dsh-personal-agent/commits/main
