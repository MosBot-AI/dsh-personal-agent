# 06. Agent implementation entry point

[Documentation index](README.md) · [简体中文](06-agent-execution-guide-zh.md)

PA-001 provides the native bundle workspace and the initial validation commands. The remaining product paths and test suites become available as their owning tasks land.

Before implementation read the [GitHub Project protocol](11-github-project-workflow.md), use `scripts/project_ready.py` for live candidates, and claim/report in Project/Issues. Execution states below belong to GitHub; manifest status remains a planning snapshot.

## 1. Handoff prompt

For a future explicit implementation request:

```text
Implement dshpa in this repository. Read docs/README.md, 01, 03, 04, 06, 08, 09 and 10,
then docs/implementation-tasks.json. Target desktop-alpha.
Inspect the working tree and upstream AGENTS.md; preserve existing changes.
Choose the first dependency-ready task, starting with PA-001.
Implement target_paths and implementation_steps, create test_files, run applicable
validation_commands and record evidence using document 07.
Only mark done with code and relevant verification. Continue independent work
when live credentials are missing, recording live-not-run for those gates.
Plans, mocks and skipped tests are not live product completion.
Keep the native DSH, resident-local architecture; do not add another orchestrator.
```

This is a future handoff template, not work already executed. A request can target foundation alpha or individual cards; publishing and account actions depend on the actual implementation instruction.

## 2. Execution procedure

1. Inspect branch, worktree, task state and pinned upstream SHAs. On drift record differences and rerun affected contracts.
2. Pick a task in the target dependency closure whose dependencies are done. Resource blockers affect that task, not independent work. Numeric IDs are not execution order.
3. Read `source_refs`; `H:` and `S:` resolve through the manifest. Target paths are proposed and may be refined with synchronized cards/indexes.
4. Mark in_progress and implement observable behavior, inputs/outputs and failure semantics in one reviewable change.
5. Run relevant types/build/behavior checks. Mock hosts cannot replace real host contracts. Update model-visible snapshots and bilingual documentation where affected.
6. Write evidence with actual exit codes, scenarios, artifacts, fixture/live classification and limits; enter review.
7. Review authority, cancellation/recovery, lifecycle, attention and scope; fix defects before done. Missing required acceptance blocks done.
8. Report outcomes, blockers and the next ready task without repeatedly asking permission for ordinary implementation choices.

Preserve cards and evidence across handoffs. Committing the plan does not complete implementation tasks or publish an application release. Project Issues and releases remain separate actions.

## 3. Task index and machine contract

Each card contains stable ID, stage/release, status, dependencies, paths, sources, steps, scenarios, test files, commands and evidence path. The manifest keeps initial planning states. States are planned → in_progress → review → done; blocked records a concrete condition and resumes to in_progress once resolved.

`release` is the first delivery tier. Desktop alpha is PA-035 plus its transitive dependencies; beta is PA-029's closure; v1 is PA-030's closure. PA-036 precedes PA-035 despite its larger number.

| ID | Stage / first release | Work package | Direct dependencies |
| --- | --- | --- | --- |
| PA-001 | M0 / alpha | Bootstrap a pinned native bundle | — |
| PA-002 | M0 / alpha | Prove host seams and choose adapters | PA-001 |
| PA-003 | M1 / alpha | Define commands and durable work states | PA-002 |
| PA-004 | M1 / alpha | Persist command, state and outbox atomically | PA-003 |
| PA-005 | M1 / alpha | Enforce identity, grants and action review | PA-004 |
| PA-006 | M1 / alpha | Run bounded native DSH workers | PA-005 |
| PA-007 | M1 / alpha | Deliver verifiable artifacts and results | PA-006 |
| PA-008 | M1 / alpha | Ship the first usable conversation and inbox | PA-007 |
| PA-009 | M1 / alpha | Recover safely from restart and cancellation | PA-006, PA-007 |
| PA-010 | M2 / alpha | Route events without blocking the primary agent | PA-008, PA-009 |
| PA-011 | M2 / alpha | Preserve context through checkpoints and recall | PA-010 |
| PA-012 | M2 / alpha | Make personal memory explicit and correctable | PA-011, PA-005, PA-038 |
| PA-013 | M2 / alpha | Budget compute and human attention | PA-010, PA-007 |
| PA-014 | M2 / alpha | Track goals and changing plans | PA-011, PA-013 |
| PA-015 | M3 / alpha | Connect local knowledge and documents | PA-012, PA-014 |
| PA-016 | M3 / alpha | Integrate one real read-only connector | PA-010, PA-013, PA-015 |
| PA-017 | M3 / alpha | Add one reviewable external write path | PA-016, PA-009, PA-005 |
| PA-018 | M3 / alpha | Bridge durable schedules into event intake | PA-002, PA-010, PA-013 |
| PA-019 | M3 / alpha | Prepare useful work proactively | PA-016, PA-018, PA-014, PA-013 |
| PA-020 | M3 / alpha | Turn repeated success into reviewed skills | PA-012, PA-019 |
| PA-021 | M3 / alpha | Operate an always-on single host | PA-009, PA-013, PA-018 |
| PA-022 | M4 / beta | Expose the same agent securely on mobile web | PA-008, PA-021, PA-005 |
| PA-023 | M4 / beta | Add personal communication workflows | PA-022, PA-019 |
| PA-024 | M4 / v1 | Extend isolation and hosted execution options | PA-031, PA-032, PA-022 |
| PA-025 | M4 / v1 | Connect intermittently available personal devices | PA-024, PA-009 |
| PA-026 | M4 / v1 | Add voice without a second agent loop | PA-022, PA-013 |
| PA-027 | M5 / alpha | Evaluate complete user outcomes | PA-015, PA-017, PA-018, PA-019, PA-020, PA-021 |
| PA-028 | M5 / alpha | Package and document a reproducible alpha | PA-027 |
| PA-029 | M5 / beta | Validate remote and personal workflows | PA-035, PA-022, PA-023 |
| PA-030 | M5 / v1 | Validate distributed execution and voice | PA-029, PA-024, PA-025, PA-026 |
| PA-031 | M3 / desktop-alpha | Operate the owner desktop with resource leases | PA-009, PA-013, PA-021 |
| PA-032 | M3 / desktop-alpha | Integrate a local credential broker and vault | PA-005, PA-031, PA-037 |
| PA-033 | M3 / desktop-alpha | Run durable image and video provider jobs | PA-007, PA-013, PA-021, PA-038 |
| PA-034 | M3 / desktop-alpha | Deliver editable image and video creation workflows | PA-031, PA-033 |
| PA-035 | M5 / desktop-alpha | Validate a resident personal-computer release | PA-028, PA-031, PA-032, PA-033, PA-034, PA-036, PA-039, PA-043 |
| PA-036 | M3 / desktop-alpha | Provide authenticated VNC viewing and takeover | PA-008, PA-031, PA-032 |
| PA-037 | M3 / desktop-alpha | Accept secrets through a dedicated secure user channel | PA-005, PA-008, PA-031 |
| PA-038 | M1 / alpha | Define public capability plugin contracts and examples | PA-002, PA-003, PA-005 |
| PA-039 | M3 / desktop-alpha | Let users configure and safely replace providers | PA-008, PA-012, PA-033, PA-034, PA-038, PA-037 |
| PA-040 | M3 / desktop-alpha | Define routing contracts and verify DSH selection boundaries | PA-002, PA-013, PA-038 |
| PA-041 | M3 / desktop-alpha | Route difficulty to model and reasoning effort | PA-040 |
| PA-042 | M3 / desktop-alpha | Manage quota buckets and bounded fallback chains | PA-040, PA-041, PA-009 |
| PA-043 | M3 / desktop-alpha | Configure model pools and integrate an optional gateway | PA-042, PA-039 |

## 4. Toolchain and commands

The workspace provides pinned scripts: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:contracts`, `pnpm test:recovery`, `pnpm test:e2e`, `pnpm check`. Per-card Vitest commands target behavior; empty test files do not satisfy acceptance. Live tests require explicit activation, budget and scoped accounts; otherwise report skipped.

See the [workspace README](../README.md#start-the-native-profile) for the named DSH profile commands.

Currently executable:

```sh
python3 scripts/check_plan.py
python3 scripts/check_plan.py --check-sources
git diff --check
```

## 5. Decisions and exceptions

Agents can resolve internal interfaces and rollback mechanics within the plan. Before changing public behavior, adding infrastructure, building vault cryptography, switching canonical storage or changing release sets, write an ADR with evidence, alternatives, choice, migration and verification. An ADR cannot create credentials, spending authority or consent.

Resolve stale source references against the pinned checkout. Prototype tests explain semantics; copied code retains license notices and replaces unsuitable assumptions. Delivery requires code, docs, tests and evidence, not an agent's self-report alone.
