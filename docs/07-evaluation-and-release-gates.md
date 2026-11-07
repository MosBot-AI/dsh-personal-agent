# 07. Evaluation and release gates

[Documentation index](README.md) · [简体中文](07-evaluation-and-release-gates-zh.md)

All thresholds are proposed targets, not measured results. Product test files are future deliverables. Record deterministic fixtures, native-host tests, live models, live providers and human evaluation separately.

## 1. Behavioral catalog

| ID | Scenario | Required observation | Owners |
| --- | --- | --- | --- |
| E00 | Load/unload pinned bundle; wrong version/dependency | Resources released; explicit rejection; no second runtime | PA-001, PA-002 |
| E01 | Project and two tasks with a sourced brief | Separate attempts, real artifacts and verification; idle is not complete | PA-003, PA-006–008, PA-014 |
| E02 | Query, redirect and stop during four background jobs | Responsive input, control priority and fair scheduling | PA-006, PA-008, PA-010, PA-013 |
| E03 | Duplicates, ambiguous followups, project mixing and old comments | Exact routing, no wrong-task mutation or unauthorized resurrection | PA-004, PA-010, PA-014, PA-016 |
| E04 | Ten compactions, restart, correction and forgetting | Commitments/sources retained; superseded/deleted facts stay excluded | PA-011, PA-012, PA-015, PA-020 |
| E05 | Concurrent approvals, altered payload, expiry, revocation/cancel race | One immutable effect per one-use grant; stale dispatch rejected | PA-005, PA-009, PA-017 |
| E06 | Crash before send, after remote acceptance and before local receipt | No repeat of known effects; uncertain outcomes reconciled; waits release slots | PA-009, PA-017, PA-018, PA-021 |
| E07 | Malicious sources/MCP, path escape and private-data disclosure | Content cannot authorize; reject leaks, wrong accounts and bypass paths | PA-005, PA-012, PA-015, PA-016 |
| E08 | One hundred noisy/duplicate/useful events and rule changes | Correct off/observe/prepare/act behavior; notification limits and quiet hours | PA-013, PA-018, PA-019 |
| E09 | Concurrent budget edge, 429, unknown price and GPU queue | Atomic reservations, bounded retry, honest costs and responsive foreground | PA-013, PA-018, PA-021, PA-033 |
| E10 | Live read and test-repository draft PR/readback | Exact identity/scope and provider evidence; missing credentials are live-not-run | PA-016, PA-017, PA-023 |
| E11 | Failed migration, full disk, old backup and uninstall | Recoverable data; reconcile-only restore; no stale authority replay; data retained | PA-004, PA-009, PA-021, PA-028 |
| E12 | Six real workflows, edits and reuse | Useful editable outcomes with sources; tested and reversible skill candidates | PA-008, PA-014, PA-020, PA-027 |
| E13 | Mobile reconnect, expired cursor, revoked device and channel change | Same task and authority; snapshots; origin preserved; revoked access blocked | PA-022, PA-023, PA-029 |
| E14 | Desktop contention/takeover, device loss and expired lease | One controller; human priority; stale leases rejected; re-observe before resume | PA-024, PA-025, PA-031, PA-036 |
| E15 | Voice interruption, ambiguity, disconnect and TTS failure | Text fallback; no implicit task cancellation or ambiguous approval | PA-026 |
| E16 | Image/video generation or composition, disconnect, OOM and cancel | Real decodable output; accurate mode; no duplicate submit or unrelated cancellation | PA-033, PA-034 |
| E17 | Test vault save/generate/login/lock, redirects and trace inspection | No secret in model/log/capture/DOM/clipboard; lock prevents new use | PA-032, PA-036 |
| E18 | Resident operation, closed UI, lock, sleep/wake and offline | Capability-specific waits, recovery, responsive foreground and unchanged power settings | PA-021, PA-031–035 |
| E19 | Live VNC, forged view-only input, takeover, disconnect and revocation | Real frames; server-side input checks; one controller; stale streams closed; private raw ports | PA-036, PA-029 |
| E20 | Secure password/key input, replay, expiry, disconnect and failed save | Direct broker intake, opaque reference, no plaintext trace/context, exact-purpose authority and lease expiry | PA-037, PA-032 |
| E21 | Custom plugins, incompatible versions, media switching and memory migration/rollback | No core edits; existing jobs pinned; records/sources/tombstones preserved; failed migration recovers without reviving forgotten facts | PA-038, PA-039, PA-012, PA-033–034 |
| E22 | Difficulty, unsupported effort, overrides and escalation | Capability-first selection, valid mappings, fixed mode and unchanged acceptance | PA-040, PA-041, PA-043 |
| E23 | Shared quotas, limits, exhaustion, budget races and interrupted recovery | Correct fallback/wait, no extra authority/spend or repeated tools | PA-042 |
| E24 | Settings/dry-run, gateway outage, retry layering and live evaluation | Explainable controls, bounded requests and measured quality/cost | PA-043 |

Each scenario needs a normal path and a counterexample; method-call assertions alone are insufficient.

## 2. Quality, latency and attention targets

| Metric | Initial target | Measurement |
| --- | --- | --- |
| Critical authorization/dedupe/cancel invariants | All defined counterexamples pass; no unresolved critical defects | Fault/concurrency tests, not a claim of exhaustive attack coverage |
| Command admission acknowledgment | p95 ≤ 1 second | Recorded machine/data size, four controlled background jobs, ≥1000 commands; excludes model/network time |
| Eventless waiting | No model calls or held worker slots | Virtual-clock tests and real idle observation |
| Conversational response | Report p50/p95 queue/model time before choosing target | API acknowledgment is not natural-language response latency |
| Artifact availability | Every completion has a readable artifact/receipt | Parse/decode files and provider readback |
| Explicit correction/forgetting | 100% defined-rule compliance | Include retrieval when original logs remain |
| Retrieval | ≥80% sourced relevant results | ≥50 annotated Chinese/English/mixed queries; honest misses |
| Accepted outcomes | Initially ≥80% | ≥30 executions, six journey types with five each, human rubric and failure breakdown |
| Useful proactive suggestions | Initially ≥70% | ≥20 owner-reviewed surfaced candidates; smaller samples remain observe |
| Unsolicited frequency | Initially ≤3/day | Aggregate across channels; explicit reminders, required approvals and queries counted separately |
| Attention benefit | Report interventions/minutes; should improve baseline | Same tasks, sources, model/tools; constrain initiative without improvement |
| Resources/cost | Configured ceilings respected; unknowns separate | Reserve before execution, reconcile afterward; report memory/storage/tokens/cost |
| VNC/GPU performance | Report per device, no invented frame-rate/render target | First frame, input latency, recovery, render duration and enforcement on revoke |

Foundation examples cover project brief, research, reminders, reviews, code changes and document/data organization. Desktop alpha adds images and short video after the media implementation. Model judging can assist but cannot replace user acceptance. Router/Worker comparisons hold resources constant and disclose increased cost as well as reduced latency.

## 3. Release sets

- **Foundation alpha (PA-028):** E00–E12, seven-day trial, real model/tool/write/readback and cancellation/restart. This validates the foundation, not the complete desktop assistant.
- **Desktop alpha (PA-035, default first complete product):** foundation plus E14 and E16–E24, including computer operation, VNC, vault, images and playable video; seven-day resident trial.
- **Beta (PA-029):** desktop regression plus E13, live mail/calendar and remote VNC; seven-day remote trial.
- **v1 (PA-030):** E00–E24 and fourteen-day cross-device/voice trial.

Image and generative-video capabilities require separate live-backend evidence. Composition may ship with an accurate label but cannot count as generative video. Missing vault, VNC or hardware validation blocks desktop-alpha release claims.

## 4. Evidence format

Create `docs/evidence/PA-NNN.md` during implementation:

```text
task / plan revision / implementation commit
host commit / OS / hardware / toolchain
changed paths and final behavior
commands actually run with exit codes
scenario IDs and fixture | native-host | live-model | live-provider | human-review
artifact paths / sanitized provider receipts
unexecuted checks and why
known limitations / migration and rollback
review result and next ready task
```

Do not commit secrets, full private messages or sensitive recordings. Use dedicated test accounts; recording is opt-in and sanitized. Release reports link evidence without copying sensitive data.

## 5. Validating this plan

`python3 scripts/check_plan.py` checks fields, dependency cycles, scenario references, bilingual counterparts and local links. `--check-sources` additionally checks audited local source paths. It does not run product tests or change planned tasks to done. `git diff --check` validates whitespace.
