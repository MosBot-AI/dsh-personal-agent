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
- Map 43 implementation tasks into GitHub Project and English Issues with native dependencies, reporting protocol, live readiness and acceptance-gated Actions reconciliation.

- Specify configurable model routing with difficulty-based model/effort selection, quota-aware fallbacks, an optional LiteLLM adapter and implementation/evaluation tasks.

- Product research and source audits informing the dshpa architecture, with separate English and Chinese documentation.
- Implementation specifications for resident desktop operation, VNC viewing/takeover, media creation, secure credential intake and replaceable capability plugins. These capabilities remain planned.
- A machine-readable backlog of 43 implementation tasks, 25 acceptance scenarios and a plan validator for dependencies, references and document links.
- Bilingual repository README entry points and English-only agent instructions covering documentation, commits, changelogs and project collaboration.
- Cross-platform ignore rules for operating-system files, editors, Node/package-manager and Vite output, tests, Python caches and local secrets/runtime data.

### Changed

- Refine the existing DSH-native plan into dependency-driven release stages, keeping local operation central and defining explicit plugin migration and recovery requirements.

[Unreleased]: https://github.com/MosBot-AI/dsh-personal-agent/commits/main
