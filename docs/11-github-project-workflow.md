# 11. GitHub Project execution and reporting

[Documentation index](README.md) · [简体中文](11-github-project-workflow-zh.md)

[Project: dshpa Implementation](https://github.com/orgs/MosBot-AI/projects/3) · [Task Issues](https://github.com/MosBot-AI/dsh-personal-agent/issues)

## 1. Sources of truth

Project Status and Issues own live execution progress. `implementation-tasks.json` owns scope, dependencies, acceptance and planning snapshots; never overwrite live progress from its planned values. `github-project.json` maps Project/field/option/Issue/item IDs, not live status.

Each of 43 tasks has an English Issue and stable PA ID; Issue numbers need not match task numbers. Native blocked-by relationships accompany body links. Add/split work by updating bilingual plans/manifest, then Issues, mapping and dependencies; never duplicate a PA ID.

The Project is private and linked to the public repository. Collaborating agents need Project access and repo/project CLI scopes; public repository access does not imply Project access. Other projects and visibility were not changed.

## 2. Status and fields

| Status | Meaning and exit condition |
| --- | --- |
| Backlog | Unclaimed, waiting on ordinary dependencies, not an operational failure |
| Ready | Dependencies closed as completed, Project Done, verification label and evidence linked; available to claim |
| In progress | Claimed with Execution agent, GitHub assignee and Claim comment |
| Blocked | Specific external condition/decision prevents progress; record exact unblock condition |
| In review | Reviewable PR and evidence supplied; review or required live acceptance pending |
| Done | Merged implementation, applicable checks and verified outcome; Issue completed, acceptance:verified label and Evidence linked |

Phase/Release retain planned stage and first-delivery tier. Priority is P0 for foundation alpha, P1 for desktop extensions and P2 for beta/v1. Execution agent identifies a run/chat, assignee identifies a real GitHub actor, Evidence links PR/records, and Last update changes with meaningful progress.

An unmerged PR, not-planned Issue or documentation/mock alone is not Done. Missing mandatory live acceptance remains In review/Blocked. Cancellation records a reason and requires downstream dependency review.

## 3. Agent procedure

1. Inspect local changes before `git pull --ff-only`; preserve others' work. Read AGENTS, the Issue, dependency evidence and relevant docs.
2. Run `python3 scripts/project_ready.py --release desktop-alpha` for the selected release's manifest dependencies. Also check the Project's Ready view for explicitly prioritized maintenance Issues. The command is read-only and fails visibly on permission/network errors.
3. Re-read comments, assignees, Execution agent and Status. Without conflicts, self-assign, post an English Claim, fill Execution agent and set In progress/Last update.
4. Use an isolated `codex/pa-NNN-short-description` branch/worktree. Split work exceeding one reviewable change into coordinated sub-issues rather than silently expanding scope.
5. Report meaningful progress, blockers or handoffs in English with commits/PRs/tests and remaining work; avoid unchanged status spam.
6. Complete the checklist, write bilingual evidence, open an English PR and set In review. Link the Issue; avoid automatic closing keywords when acceptance cannot finish at merge.
7. Verify merge and acceptance, populate Evidence, add `acceptance:verified`, close as completed, set Done and promote eligible direct dependents to Ready. Retain final ownership/history and clear obsolete control markers.

GitHub field updates are not an atomic lock. Re-read after claiming; a later conflicting claimant stops editing and resolves ownership. Staleness alone does not authorize stealing a task; use explicit handoff. Do not automatically rerun unattended blockers.

## 4. English reporting templates

```text
Claim
- Agent/run: <chat or run ID>
- Branch/worktree: <name and location>
- Dependencies checked: <Issue and evidence links>
- Scope: <this work package>
- Next checkpoint: <observable milestone>
```

```text
Progress / Blocked / Ready for review / Completed
- Completed: <observable changes>
- Evidence: <commit, PR, artifacts, commands actually run>
- Remaining: <unchecked acceptance items>
- Blockers: <condition, responsible party, exact unblock condition or none>
- Next step: <action or explicit handoff>
```

Do not invent completion percentages. Claims are not implementation, commits are not tests, and merge alone does not prove live-device/account acceptance.

## 5. GitHub CLI

```sh
gh project view 3 --owner MosBot-AI
gh project item-list 3 --owner MosBot-AI --limit 100 --format json
python3 scripts/project_ready.py --release desktop-alpha --json
gh issue view 1 --repo MosBot-AI/dsh-personal-agent --comments
```

Read actual number/item_id/field/option IDs from `docs/github-project.json` before mutations. Example Issue 1 is only PA-001; do not reuse it for another task.

```sh
gh issue edit 1 --repo MosBot-AI/dsh-personal-agent --add-assignee @me
gh issue comment 1 --repo MosBot-AI/dsh-personal-agent --body-file /tmp/dshpa-progress.md
```

Use `gh project item-edit` with mapped `--id`, `--project-id`, `--field-id` and the appropriate `--single-select-option-id`, `--text` or `--date`. Write exact English comment bodies to files rather than interpolating unescaped shell text.

Two GitHub Actions workflows are included: `Validate implementation plan` checks plans/coordination on pushes and PRs; `Reconcile implementation project` recalculates dependencies on Issue/PR events or manual dispatch. Reconciliation needs repository secret `DSHPA_PROJECT_TOKEN`; without it the run explicitly reports inactive and performs no Project writes. Configure a dedicated minimally scoped credential through repository Secrets or the secure prompt of `gh secret set DSHPA_PROJECT_TOKEN --repo MosBot-AI/dsh-personal-agent`, never through chat.

The synchronizer marks completed + acceptance:verified + Evidence as Done and promotes eligible Backlog items. Unverified closures are not completion; reopened dependencies block active downstream work. Agents still report In progress, Blocked, In review and ownership explicitly; free-text comments are not executable state instructions. PR events trigger reconciliation, not automatic acceptance based on merge. On Issue reopen, the repository GITHUB_TOKEN removes stale acceptance:verified; add it again only after re-verification. The dedicated Project token still only needs repository Issue read access, plus Projects write access.

`python3 scripts/project_sync.py` defaults to a read-only preview of one snapshot. With `--apply`, it reconciles completion statuses first, then reads the Project again before calculating dependent changes. Readiness requires each prerequisite to be closed as completed, Project Done, labeled `acceptance:verified`, and linked to evidence. The readiness command also lists eligible Backlog items. A verified closure awaiting its Done write does not interrupt active downstream work. Both phases re-read before each write. Agents must still inspect evidence and recheck claims.

## 6. Views and maintenance

Delivery board shows all states; Ready to start filters Ready; Desktop alpha shows alpha/desktop-alpha first-delivery work; Needs attention shows Blocked/In review. Release requirements use transitive dependencies: PA-028 / PA-035 / PA-029 / PA-030 are the four gates.

Milestones imply no dates. Closed-Issue counts cannot replace product acceptance; beta/v1 do not block desktop alpha. Scope changes update mapping, native dependencies and Issue bodies. Routine progress stays in Project/Issues rather than generating commits for every status update.
