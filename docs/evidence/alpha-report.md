# Foundation Alpha acceptance report

[简体中文](alpha-report-zh.md) · [Documentation index](../README.md)

[PA-027 evaluation](https://github.com/MosBot-AI/dsh-personal-agent/issues/31) · [Release requirements](../07-evaluation-and-release-gates.md#3-release-sets)

The November 16, 2026 evaluation used dshpa main `eb10c69e3a137f82efe3434d467b1777b326be71`, Node.js 24.14.1 and DSH 0.2.2-rc.1 on Debian 13 x86-64. In a clean checkout, `pnpm check` passed type checking, the workspace build, 421 non-E2E tests and plan validation. The 17 coordination tests passed. The native and provider evidence below identifies the test environment and artifact revision where those differ from the source checkout.

The native Web and resident suites passed all 21 tests in a private D-Bus session with Chromium 156.0.8078.79. The three retained Alpha archives from `b94773c1b0370335e3a3b8031d212673b54702a5` passed checksum verification and the packaged startup, removal and reinstallation test.

## Scenario evidence

| Scenario | Observation |
| --- | --- |
| E00 | The pinned [bundle and host tests](PA-002.md) exercise loading, disposal of owned resources, incompatible versions and a missing native dependency. The [retained archives](PA-028.md#local-alpha-archives) carry separate installation, removal and reinstallation evidence. |
| E01 | The [native project fixture](PA-014.md) uses two separate Worker Sessions and sealed artifacts. The dependent remains blocked after the predecessor goes idle and while its outcome awaits owner acceptance. [Live research](PA-028.md#live-research-brief-with-exact-local-sources) reads exact source revisions before generating a brief. |
| E02 | The [executor and routing tests](PA-006.md) query, redirect and cancel while four Workers hold slots. The fifth task stays queued, and cancelling one leaves the others running. The [command-admission benchmark](../../tests/e2e/admission-benchmark.spec.ts) verified all 1,000 accepted commands in SQLite. With four held Workers, p50 was 1.735 ms and p95 was 2.643 ms for serial `create_task` acknowledgments over native Web loopback. This meets the 1-second command-admission target on this host. |
| E03 | [Store and planning tests](PA-014.md) check duplicate commands, ambiguous or stale work, and cross-project scope. In the [GitHub read regression](PA-016.md), replayed historical comments produce no task writes and cursors cannot move between operations. |
| E04 | The [native checkpoint test](../../tests/context/checkpoint.spec.ts) completes ten compactions and resumes the retained revision after a cold restart. The [memory tests](PA-012.md) keep corrections and exclusions effective when provider state is stale. |
| E05 | [Action gate tests](PA-005.md) fence mismatched digests and identity, concurrent claims, expiration, revocation and cancellation races. The native owner flow verifies exact draft approval with a controlled provider. |
| E06 | The [recovery probes](PA-009.md) cut real processes before dispatch and after controlled provider acceptance. Cold lookup preserves uncertainty and records an exact receipt without replay. [Schedule recovery](PA-018.md) verifies a single durable logical occurrence across its crash windows. |
| E07 | The [policy](PA-005.md), [knowledge](PA-015.md) and [GitHub](PA-016.md) cases check that source text cannot authorize effects and reject out-of-scope identity, path and provider results. The exercised carriers include local files, controlled MCP and authenticated native Web. |
| E08 | The [attention and proactive replays](PA-019.md) cover 100 candidate events, duplicate and stale inputs, policy-mode changes, quiet hours and notification caps. Useful-suggestion ratings from a human owner remain open. |
| E09 | The [compute and attention tests](PA-013.md) cover concurrent budget edges, controlled HTTP 429, unknown costs and responsive foreground admission. The [GPU queue tests](../../tests/runtime/gpu-queue.spec.ts) use controlled lease state. |
| E10 | The [live GitHub read](PA-016.md) checked identity and repository scope. The [hosted write and independent readback](PA-017.md#live-github-draft-and-readback-2026-11-16) verified one approved draft, its author, base and head commits, and file SHA-256 in the dedicated private repository. |
| E11 | The [storage and resident cases](PA-021.md) exercise SQLite capacity, backup and restore with old authority fenced. The [packaged upgrade test](PA-028.md#packaged-schema-upgrade-and-restore) passed with current main and the historical schema-15 checkout `07579662e0747acdac1ad34f0f823c41e9ec8b0d`. It verified retained owner data and reconciliation-only startup from the old backup. |
| E12 | The [installed workflow sample](PA-027.md#foundation-sample-for-human-review) ran five executions in each of six journeys using the retained Alpha archives. The review workflow also exercised evaluated skill reuse. There were 28 fixture passes and two retained failures. The 30 human decisions remain pending, so the acceptance rate is unavailable. |

## Sourced retrieval

The [native Web retrieval benchmark](../../tests/e2e/knowledge-retrieval.spec.ts) reran four frozen corpora on the evaluated revision. All 220 returned sources matched their exact revisions and bytes. All 30 no-answer controls returned no hits.

| Corpus | Queries | Sourced hit at rank 1 | Sourced hit within rank 3 |
| --- | ---: | ---: | ---: |
| Original keyword and natural queries | 60 | 36 | 39 |
| Keyword and navigation holdout | 54 | 54 | 54 |
| First natural-language holdout | 54 | 26 | 27 |
| Second natural-language holdout | 36 | 14 | 15 |

The original sample reached 60% at rank 1 and 65% within rank 3. The [80% sourced retrieval target](../07-evaluation-and-release-gates.md#2-quality-latency-and-attention-targets) remains unmet on this sample. The two natural-language holdouts also fall short. [Corpus and scoring details](PA-015.md#natural-question-retrieval)

A subsequent run with the opt-in CPU ranker met the retrieval threshold on a separate three-root corpus. It returned the relevant source first for 46 of 54 questions and within the first three for 47, with all 18 missing-fact controls empty. The same configuration passed the four legacy corpora above. [Packaged retrieval evidence](PA-015.md)

## Owner observations

The [paired comparison](PA-027.md) used the same inputs and, for model journeys, the same model, tool and budget settings across the foreground and Worker runs. It records result checks, scripted command counts, readback times and estimated costs. The effect on human attention remains unmeasured.

The [seven-day trial profile](../../evals/README.md#run-the-owner-trial) is prepared. Its dry run verified startup, journaling and shutdown. The actual owner trial still needs seven complete observation periods with accepted outcomes, avoidable interruptions, intervention time and incidents.
