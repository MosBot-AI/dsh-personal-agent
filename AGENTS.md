# Repository instructions

These instructions apply throughout the dshpa repository. AGENTS.md files are English-only and do not require Chinese counterparts. Follow explicit user instructions when they override a repository convention.

## Project context

- Read [the documentation index](docs/README.md) before project work and consult the relevant architecture, contract and implementation documents.
- For existing projects, people, decisions, research or historical conclusions, consult the user's knowledge base at `/Users/charleypeng/Documents/llmwiki` first. If unavailable, state that limitation and continue with verifiable sources; never invent prior decisions.
- Distinguish planned, implemented, tested and released work. Documentation or passing mocks cannot establish that a product feature works in production.

## Bilingual repository documentation

All authored documentation, READMEs and changelogs, except AGENTS.md instruction files, must have English and Simplified Chinese versions. English uses the base filename; Chinese adds `-zh` immediately before the extension, in the same directory.

| English | Simplified Chinese |
| --- | --- |
| `README.md` | `README-zh.md` |
| `CHANGELOG.md` | `CHANGELOG-zh.md` |
| `CONTRIBUTING.md` | `CONTRIBUTING-zh.md` |
| `docs/architecture.md` | `docs/architecture-zh.md` |

- Create, update, rename or delete both versions in the same change. Translation is part of completion, not a later TODO.
- Match meaning, scope, requirements, examples, versions, dates, task/decision IDs and implementation status. Do not use a placeholder or a shortened summary as the translation.
- Add reciprocal language links near the top. Link to the same language's documents where available; update indexes and incoming links on rename.
- Keep commands, code identifiers, API names, paths and protocol values accurate. Translate explanatory prose without changing executable examples.
- Apply these rules to package READMEs, design documents, ADRs, contributor guides and implementation evidence as well as root documentation.
- Do not translate legal license text, vendored upstream files, generated output or machine-readable schemas/data merely to create pairs. Platform-facing Issue/PR templates and automation text are English, as required below.

## Commits

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). Commit messages, including bodies and footers, are English.

```text
<type>(<optional-scope>): <imperative summary>
```

Repository style: lowercase types/scopes; concise imperative summary without a final period, preferably within 72 characters. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, `revert`. Use `style` only for formatting changes without behavioral changes.

Examples: `docs(architecture): define memory plugin contracts`, `fix(vault): reject expired input requests`.

Mark breaking changes with `!` and describe impact and migration in a `BREAKING CHANGE:` footer. Keep each commit cohesive; inspect the staged diff and preserve unrelated work. Reference only real Issue/PR identifiers.

## Changelog and versions

Maintain `CHANGELOG.md` and `CHANGELOG-zh.md` using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Use an `Unreleased` section, newest releases first and released headings in `[version] - YYYY-MM-DD` form. Use actual release dates, never invented releases or links.

| English category | Chinese category |
| --- | --- |
| Added | 新增 |
| Changed | 变更 |
| Deprecated | 弃用 |
| Removed | 移除 |
| Fixed | 修复 |
| Security | 安全 |

Write concise entries about meaningful user or developer impact, not a copied commit log. Update both unreleased sections for notable capability, behavior, compatibility, configuration, installation or security changes. Pure formatting and typo fixes need no entry. Describe plan changes as documentation changes, not implemented features. Explain breaking changes and migration steps; retain matching versions, dates and references across languages. Omit empty categories.

Use [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) for releases. Document compatibility changes explicitly, including during `0.x`; do not promise stable interfaces before they are declared stable. This convention does not itself request a version bump, tag or release.

## English project coordination

Use English for all authored project-management and collaboration content:

- Projects: names, descriptions, roadmaps, milestones, updates, field names/options and automation text.
- Kanban: board names, columns, statuses, cards and checklists. Prefer `Todo`, `In progress`, `Blocked`, `In review`, `Done` where suitable.
- Issues: titles, descriptions, acceptance criteria, labels and comments.
- Pull requests: titles, descriptions, review comments, checklists and merge/squash commit messages. PR titles follow the commit format above.

Preserve proper names, identifiers and necessary verbatim evidence in their original form, with English explanation. Repository Chinese documentation remains required; these English-only rules do not change the user's preferred chat language.

Issues should state the problem, scope and verifiable acceptance criteria; bug reports include reproduction and expected/actual behavior. PR descriptions lead with the problem and resulting behavior, then relevant validation, compatibility and linked Issues. Keep titles and descriptions aligned with the final diff. Report only checks actually run and explain skipped checks.

## GitHub Project execution

- Use [dshpa Implementation](https://github.com/orgs/MosBot-AI/projects/3) and its linked Issues as the live progress ledger. Read [the execution protocol](docs/11-github-project-workflow.md) and `docs/github-project.json` before implementation.
- Use GitHub CLI for Project, Issue, PR and progress operations. Run `python3 scripts/project_ready.py` to find live dependency-ready work; the task manifest owns scope, not live progress.
- Claim one task before editing: recheck competing claims, self-assign, record the agent/run identity and branch in English, and set In progress. Project fields are not atomic locks; resolve competing claims before proceeding.
- Report meaningful progress and blockers in the Issue, link real evidence, and keep Project fields current. Use In review for reviewable work; never mark a skipped mandatory live check as complete.
- Done requires merged implementation, verified applicable acceptance, an Evidence link, `acceptance:verified`, and Issue closure as completed. Recheck downstream readiness. Do not treat not-planned closure as success.
- Plan validation runs in GitHub Actions. Project reconciliation additionally needs `DSHPA_PROJECT_TOKEN`; never expose tokens in chat, committed files, logs or PR code. Only trusted default-branch code may run with that credential.

## Completion checks

- Review the affected English/Chinese pairs and their links.
- Review changelog impact and update both versions when warranted.
- Verify commit/PR format and English project-management text when creating those artifacts.
- Run relevant checks and `git diff --check`. For plan edits, run `python3 scripts/check_plan.py`; use `--check-sources` when the referenced local upstream checkouts are available.
- Current plan checks do not enforce every rule in this file; manually review uncovered requirements. Do not claim an unexecuted check passed.
