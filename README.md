# dshpa — DSH Personal Agent

[简体中文](README-zh.md)

dshpa is a personal-agent project built on DeepSeek Harness. It is designed to run persistently on an owner's computer, coordinate ongoing work and deliver inspectable results through native, replaceable plugins.

**The native bundle, work and security foundations, bounded Workers, verifiable delivery, local Web inbox, guarded recovery, event routing, context checkpoints and recall, personal memory, goal planning, local knowledge, read-only GitHub, compute and attention controls, durable schedules, proactive preparation, reviewed skills, resident host operations, and capability plugin contracts are implemented (PA-001 through PA-016, PA-018–020, PA-021, and PA-038).**

The [host compatibility record](docs/evidence/host-compatibility.md) describes the verified native controls and the boundaries that later tasks must handle.
The [work domain evidence](docs/evidence/PA-003.md) covers record validation, command admission, and task transitions.
The [storage evidence](docs/evidence/PA-004.md) covers atomic commits, locking, migration, and fault recovery.
The [authorization evidence](docs/evidence/PA-005.md) covers trusted identity, exact-action review, one-use dispatch, and private worker tool isolation.
The [Worker evidence](docs/evidence/PA-006.md) covers native launch and resume, report admission, foreground control, and teardown.
The [artifact and delivery evidence](docs/evidence/PA-007.md) covers immutable content, trusted verification, and provider receipt handling.
The [local Web inbox evidence](docs/evidence/PA-008.md) covers native conversation integration, task controls, approval, and result acceptance.
The [recovery evidence](docs/evidence/PA-009.md) covers input acknowledgments, cancellation fences, and backup restore.
The [routing evidence](docs/evidence/PA-010.md) covers source intake, subscriptions, Worker handbacks, and responsive controls.
The [context evidence](docs/evidence/PA-011.md) covers native checkpoint capture, reference recall, exclusions, and input budgets.
The [personal memory evidence](docs/evidence/PA-012.md) covers owner controls, provider snapshots, and exclusions that survive stale provider data.
The [goal planning evidence](docs/evidence/PA-014.md) covers revisions, Worker drafts, task prerequisites and on-demand review.
The [local knowledge evidence](docs/evidence/PA-015.md) covers explicit roots, incremental indexing and source revocation.
The [GitHub read connector evidence](docs/evidence/PA-016.md) covers live readback, scoped cursors, and MCP capability revalidation.
The [budget and attention evidence](docs/evidence/PA-013.md) covers model claims, resource ceilings, notification policy, and scoped usage.
The [proactive evidence](docs/evidence/PA-019.md) covers rule replay, staged review, private briefs and local notice limits.
The reviewed skills evidence covers accepted examples, held-out evaluation, exact activation, reuse and rollback. [PA-020 evidence](docs/evidence/PA-020.md)
The [schedule evidence](docs/evidence/PA-018.md) covers routine intent, native wake reconciliation, and deduplicated reminders and task wakes.
The [resident host evidence](docs/evidence/PA-021.md) covers lifecycle, diagnostics, online backups, and restore.
The [capability plugin evidence](docs/evidence/PA-038.md) covers versioned registration, scoped consumers, and independent keyless examples.

The native routing boundary evidence covers fixed request selection, retry pinning, and budget-gated inference Sessions. [PA-040 evidence](docs/evidence/PA-040.md)

[Implementation Project](https://github.com/orgs/MosBot-AI/projects/3) · [Agent workflow](docs/11-github-project-workflow.md)

## Planned capabilities

- Continuous conversation, durable tasks, goals, reminders and correctable memory.
- Local computer operation with live VNC viewing and human takeover.
- Replaceable image/video generation and creation workflows.
- Secure password/key intake and purpose-limited credential use.
- Optional remote/mobile access, connected devices and voice.

Read the [documentation index](docs/README.md), [architecture](docs/01-product-and-architecture.md) and [plugin specification](docs/09-plugin-architecture.md). Implementation agents should start with the [execution guide](docs/06-agent-execution-guide.md) and [43-task manifest](docs/implementation-tasks.json).

## Build the workspace

From the repository root, use Node.js 24.9.0 or later, pnpm 11.28.5 and Python 3. The workspace pins DeepSeek Harness to `0.2.2-rc.1`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

## Start the native profile

From the repository root after building the bundle, initialize `dshpa` in a fresh `DSH_HOME` from the `sdk` template and install the local bundle. The initialization command replaces a profile with the same name, so use it once for this checkout.

```sh
export DSH_HOME="$PWD/.dshpa/harness"
export DSH_PERMISSION_MODE=workspace-write
pnpm exec dsh --profile dshpa --from-default-profile sdk --dump-config
pnpm exec dsh plugin --profile dshpa add "link:$PWD/packages/personal-agent"
pnpm exec dsh --profile dshpa
```

The `sdk` profile serves JSON-RPC over standard input and output. Connect a JSON-RPC client to those streams for requests. Press Ctrl+C to stop a foreground instance.

## Open the local Web inbox

Build the workspace and initialize the named Web profile once. Use the existing DSH Web owner sign-in and keep the profile bound to loopback.

```sh
export DSH_HOME="$PWD/.dshpa/harness"
export DSH_PERMISSION_MODE=workspace-write
pnpm build
pnpm exec dsh --profile dshpa-web --from-default-profile web --dump-config
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/personal-agent"
```

Save the following overlay as `.dshpa/inbox.patch.yml`. Replace the two Worker route values with a provider and model already configured in DSH. Omit the `worker` block to open the inbox without starting model work.

```yaml
- id: dshpa
  config:
    inbox:
      storageDirectory: !!js dshHomePath('dshpa-inbox')
      workRoot: !!js dshHomePath('dshpa-work')
      worker:
        provider: YOUR_CONFIGURED_PROVIDER
        model: YOUR_CONFIGURED_MODEL
```

```sh
pnpm exec dsh --profile dshpa-web --patch "$PWD/.dshpa/inbox.patch.yml" --host 127.0.0.1
```

Open or create a native conversation, then select **Today** in the DSH sidebar. Create a project and attach tasks to the conversation. Start work explicitly, review the candidate artifact after the Worker releases, and accept the result in the inbox. Use the conversation link to return to the native transcript and composer.

### Route events from trusted adapters

The local Web host publishes the `dshpaRouting` service for in-process adapters. The owner can declare previously verified accounts in `inbox.sourceAccounts` with `sourceInstanceId`, `accountId` and the UTC `verifiedAt` instant. An adapter authenticates the account independently of message content before binding its source token. It submits the original occurrence time and a stable external event ID and revision. The owner manages versioned `work` or `context` subscriptions through the authenticated inbox `set_subscription` operation. Work delivery uses the exact source, account, thread, project and task. A `routed` receipt includes the current native input journal status. Context subscriptions record the association without feeding or waking a Worker.

Semantic assessment is optional. Add an `inbox.routing` block with `provider`, `model` and permitted `dataScope` labels. The assessor evaluates bounded batches and returns proposals for owner review. Both assessments and subscribed Worker input require known pricing with limits or an explicitly unmetered route. An event-triggered Worker wake also requires a trusted policy for the current grant and wait condition. Provider account enrollment belongs to the connector tasks.

### Preserve task context through compaction

Add `context: {}` under `config.inbox` in the existing `dshpa` row. Add the following rows to the same Web profile overlay. The root wrappers cover private Workers. The `dshpa-context` preset installs the wrappers and `/compact` inside the primary conversation's own compaction group. Keep the four isolated service keys together when customizing the preset. Automatic compaction is enabled by default. The pruner uses the shipped defaults.

```yaml
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true
- insert:
    - id: dshpa-checkpoint-compaction
      name: '@mosbot-ai/dshpa/checkpoint-compaction'
    - id: dshpa-checkpoint-pruner
      name: '@mosbot-ai/dshpa/checkpoint-pruner'
    - id: preset-dshpa-context
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dshpa-context
        order: 90
        plugins:
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
              dshpaCheckpointCompactionReady: true
              dshpaCheckpointPrunerReady: true
            config:
              - id: dshpa-checkpoint-compaction
                name: '@mosbot-ai/dshpa/checkpoint-compaction'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: dshpa-checkpoint-pruner
                name: '@mosbot-ai/dshpa/checkpoint-pruner'
```

In DSH Web, create a primary conversation using the `dshpa-context` preset, then attach a task through the inbox. With context enabled, the inbox offers only live primary Sessions whose effective compaction engine and pruner are both dshpa wrappers.

Before DSH compacts or prunes an attached Session, dshpa saves a scoped task checkpoint to SQLite. It records the objective, constraints, acceptance criteria, canonical wait and source references. It includes a bounded set of explicit owner answers as source-backed decisions and retains the current question or continuation condition from the task's wait. dshpa generates the replacement summary locally from checkpoint references and brief guidance. Sessions without attached work use native summarization.

For Worker input, dshpa uses the configured model's context window and DSH's token estimator. It reserves the configured `inbox.computeLimits.maxOutputTokens` and keeps the fixed instructions and current input verbatim. The remaining budget defaults to 30% authoritative task state, 25% recent context, 25% retrieval and 20% checkpoint context. Optional `inbox.context.weights` uses integer percentages under `authoritative`, `recent`, `retrieval` and `checkpoint` totaling 100. `inbox.context.maxInputBytes` defaults to 32 KiB, accepts 1–64 KiB in bytes, and is capped by the Worker compute input limit. If required input exceeds the budget, the request fails.

The authenticated owner can use these request payloads through the local `dshpa/inbox` RPC.

| Request `type` | Payload fields |
| --- | --- |
| `context_checkpoint` | `taskId` for the latest scoped checkpoint metadata. |
| `context_recall` | `taskId`, `ref`, and optional `cursor` and `maxBytes` for one UTF-8 page. |
| `context_search` | `taskId`, `query`, and optional `limit` for matching excerpts. |
| `context_exclude` | `taskId`, an event or artifact `ref`, the current task `expectedVersion`, and `reason` set to `forgotten` or `superseded`. |

A `ref` is `{kind: 'task', taskId}`, `{kind: 'event', eventId}` or `{kind: 'artifact', artifactId}`. Recall checks the task scope and current authorization for each page. A page defaults to 1,024 bytes and accepts 4–4,096 bytes. Use `nextCursor` with the same reference for the next page. Cursors are bound to the content revision and current host process. After a restart, begin a fresh lookup.

Search checks the task and up to 12 recent eligible candidates of each evidence type. It searches up to 8 KiB per candidate and returns up to 10 excerpts. It supports normalized Chinese and English text. Use an exact reference to retrieve older evidence or the rest of a large artifact. An exclusion is a durable recall rule for that task and filters old checkpoint material derived from the excluded evidence.

Before a Worker sends its actual model request, dshpa checks the sources recorded for its retained inputs against current authorization and exclusions. If a source is revoked or a relevant event is excluded, the old Worker Session is fenced from the provider. Start a fresh task with the evidence still authorized. SQLite source records, DSH Session logs and backup copies have separate retention rules. DSH keeps the original events in its Session log when it compacts the active context.

### Manage personal memory

Build and install the independent local memory bundle in the existing Web profile.

```sh
pnpm build
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/memory-sqlite"
```

Add this `memory` block under `config.inbox` on the `dshpa` row. The exact provider pin includes the plugin and configuration versions.

```yaml
memory:
  provider:
    kind: memory
    instanceId: local-memory
    pluginId: '@mosbot-ai/dshpa-memory-sqlite'
    pluginVersion: '0.0.0'
    configRevision: 1
```

Open **Personal memory** in **Today**. Select a profile, project or task scope, then save a fact explicitly. Search checks validity and the exact selected scope. Inspect shows the source receipt, confidence, validity and revision. Correction creates a replacement and hides the old record. Forgetting hides the record immediately, then asks the provider to remove its value and retain a tombstone. Use **Retry** when the provider change is pending. The authenticated `dshpa/inbox` RPC supports the same operations. For `memory_remember`, `memory_correct` and `memory_forget`, resend the identical payload and `commandId` to retry an interrupted change after a restart.

Automatic extraction is off. The explicit controls record owner-confirmed facts, while the provider contract preserves inferred records separately. Memory content carries no action authority. The external `llmwiki` knowledge base remains read-only.

The memory provider stores fact values in its own database. The core work database stores scope, revisions, digests, source receipts and exclusions. Keep both when backing up a profile. A stale provider copy cannot override core exclusions. Existing provider snapshots or backup files can still contain earlier values and follow their own retention rules. [SQLite memory provider](packages/memory-sqlite/README.md)

### Track goals and review plans

Open **Goals and plans** in **Today** to create a goal with success criteria, milestones, an optional review cadence and priority. Save each revision with its rationale. You can reuse a previous revision as an editable draft and save it as a new revision. Tasks linked to the goal follow the usual Worker and artifact acceptance flow.

In a Task, **Task plan and dependencies** shows Worker drafts for that exact Task and lets you turn a reviewed step into an ordinary Task in the same project. Set prerequisites on queued or blocked Tasks. A prerequisite must belong to the same project, and cycles are rejected. A dependent becomes ready only after all its prerequisites are completed. Reopening a prerequisite blocks queued dependents again. Already-running attempts continue under their existing authorization.

Select **Weekly review** to inspect ready and waiting Tasks, recently accepted results and upcoming milestones. Projects are ordered by the configured priority and due time. The review calls out a priority choice if equally ranked projects compete for the next available Worker slots. The review and cadence are planning metadata, and recurring schedules are armed separately.

### Search local knowledge

Add a `knowledge` block under `config.inbox` on the `dshpa` row. Use canonical absolute paths on macOS or Linux (arm64 or x64). The connector reads only the roots you list.

```yaml
knowledge:
  roots:
    - id: llmwiki
      directory: /absolute/path/to/llmwiki
      include: ['**/*.md']
      exclude: ['private/**']
    - id: notes
      directory: /absolute/path/to/notes
      types: ['.md', '.txt']
      maxFileBytes: 131072
      maxFiles: 256
```

In **Today**, open **Local knowledge** and select **Check sources** or enter keywords. A missing root appears as unavailable and the search continues with other configured roots. Search matches Chinese and English terms together and shows paths relative to each root. Open a result to see bounded text pages and its source reference. A reference pairs a stable ID with the SHA-256 revision of the document.

The in-memory index reuses unchanged entries and checks current files before returning results. Files and directories must be reachable from their configured root without symlinks. Hidden entries, hard links, binary content and files over the configured limits are skipped. The built-in type allowlist is `.md`, `.markdown`, `.txt`, `.rst`, `.csv` and `.json`. The default types are Markdown and plain text. Each root has a 4 MiB derived text budget. Limited roots may show partial results.

Source text is displayed as evidence. The connector keeps it out of automatic Worker input, personal memory and native compaction summaries. The source root stays read-only, and the index is rebuilt on demand after restart.

### Read one GitHub repository

Add `githubRead` under `config.inbox` on the `dshpa` row. Enter the actual numeric GitHub user and repository IDs and their current names. If you add an exact dshpa `projectId`, the configured project must be active. Without a project binding, the read belongs to the local owner profile.

```yaml
githubRead:
  binding:
    account: { id: 12345, login: your-login }
    repository: { id: 123456, owner: your-org, name: your-repository }
  transport:
    kind: github
```

Load `DSHPA_GITHUB_READ_TOKEN` into the trusted host environment from your secret store. Use a credential scoped to read the selected repository. **GitHub read-only** in **Today** verifies the connection and reads issue and comment pages. The connector uses fixed GET endpoints, checks the account and repository before each page, and honors provider backoff. The page cursor stays with its original operation and issue. Historical text remains read-only evidence. [GitHub REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) · [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

A reviewed MCP facade can replace the REST transport. Set `kind: mcp`, `url` to its literal loopback HTTP endpoint and `fingerprint` to its approved SHA-256 capability fingerprint. The facade uses stateless MCP 2025-06-18. Discover the fingerprint without invoking a tool from a built workspace:

```sh
node --input-type=module -e 'import { inspectMcpReadFingerprint } from "./packages/personal-agent/lib/connectors/mcp.js"; console.log(await inspectMcpReadFingerprint(process.argv[1]))' http://127.0.0.1:39017/mcp
```

The facade exposes `dshpa_github_inspect`, `dshpa_github_issues` and `dshpa_github_comments`. Inspect receives empty arguments and returns its independently bound `binding` in `structuredContent`. Page tools receive `binding`, `operation`, `page`, `limit`, and `issue` for comments. They return structured `binding`, `operation`, `page`, `items`, `hasNext`, and `issue` for comments. Rows carry numeric `id` and `number`, `kind` (`issue`, `pull`, or `comment`), `author`, optional numeric `authorId`, UTC millisecond `createdAt` and `updatedAt`, `text`, and `title` for issues and pulls. Use a facade whose own GitHub account and permissions are restricted to the selected repository. The connector sends no GitHub credential to MCP and checks the tool fingerprint before and after calls. [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) · [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

### Set compute and attention limits

In the same `inbox` block, `budget` binds exact provider and model IDs to a pricing version, per-call ceiling, and limits. The following values illustrate the shape. Use the rates for your own deployment. Monetary values are integer millionths of the configured currency.

```yaml
budget:
  pricingVersion: owner-quote-1
  routes:
    - provider: YOUR_CONFIGURED_PROVIDER
      model: YOUR_CONFIGURED_MODEL
      currency: USD
      pricing:
        kind: known
        inputMicrosPerMillion: 1000000
        outputMicrosPerMillion: 4000000
        cacheReadMicrosPerMillion: 100000
        cacheWriteMicrosPerMillion: 1000000
        ceilingMicros: 200000
  limits:
    - currency: USD
      ownerDayMicros: 1000000
      taskMicros: 400000
      maxCallsPerDay: 40
      maxCallsPerTask: 8
      maxConcurrent: 2
```

For a route that incurs no model charges, use `unmetered: true` in its `worker` or `routing` block. Owner-started Workers without pricing are recorded as unknown and use bounded call counts. Budget days use UTC. Uncertain claims remain held across restarts and UTC day boundaries until reconciled. The **Compute and attention usage** panel shows recorded costs at configured rates, outstanding ceilings, unknown calls, token counts, and resource occupancy.

`inbox.computeLimits` sets `maxInputBytes`, `maxOutputTokens`, `maxTurns`, `maxStepsPerTurn` and `maxWallTimeMs`. `inbox.gpu` sets `concurrency`, `maxQueued` and `timeoutMs`. Heavy GPU work uses a separate in-process queue with one slot by default. The installed host's private Workers have no tools, and a provider rate limit releases the Worker after teardown and records when the owner can resume.

Proactive notifications default to `off`. The authenticated inbox `set_attention_policy` operation takes `expectedVersion` and a `policy` with `mode`, `timeZone`, `quietHours` and `urgentRules`. The default quiet interval is 22:00–08:00 UTC. Use an IANA zone for local time. Unsolicited notifications reserve up to three slots per owner and local day across channels. Explicit reminders and required decisions have separate rules. Routine progress stays in the task view. Trusted carriers use `dshpaAttention` to record a candidate and hand off an eligible exact delivery through the existing Outbox.

### Prepare work proactively

Set `config.inbox.proactive: true` and configure a priced or explicitly unmetered routing model and verified source accounts. In **Today**, open **Proactive suggestions**. Define a rule for an active goal, one anchor task, one verified account and thread, and required keywords. Rules start off. **Replay source history** checks up to 100 exact stored events without calling the model.

Choose **Start observing** after replay and set the global initiative limit to at least Observe. The router checks scope, source freshness, keywords, deduplication, cooldown and model budget before assessment. Observations record proposed or suppressed outcomes for review. Review at least 20 proposals with at least 70% marked useful before granting source read and private preparation. Private briefs retain their source reference and are available to the owner for inspection.

After reviewing a useful private brief, you can separately grant local brief notices. With both rule and global policy set to Act, approved local notices can appear in **Today**. They share the existing limit of three unsolicited notices per owner and local day across routes and honor quiet hours. Rules whose goal revision, source enrollment or model route changed require revalidation. An assessment with no useful proposal stays silent.

### Reuse a reviewed skill

Open **Reviewed skills** in **Today** and select a project. After accepting two Markdown or plain-text task results, select them as examples for a candidate. Write a Markdown template with named fields such as `## {{topic}}`. Select a separate accepted task artifact as the expected result of a held-out example and enter its inputs as a JSON object, such as `{"topic":"North"}`. The evaluator substitutes the inputs once and compares the resulting UTF-8 bytes to the accepted artifact.

Review the schema, sources and evaluation, then approve and activate the exact passing revision. Run it with new values to produce local Markdown you can copy. Record acceptance or a correction against that revision. A new draft keeps the current revision active until you approve the replacement. Select a previously approved revision to roll back when its evidence is still available.

Skill runs are explicit, local and limited to text rendering. An unavailable or excluded source blocks further use of the affected revision. The skill workflow leaves personal memory and schedules unchanged. [PA-020 evidence](docs/evidence/PA-020.md)

### Schedule local reminders and task wakes

Set `routines: true` in the existing `inbox` block of the named local Web profile. Add this row to the same overlay so the native schedule service waits for the private Session resolver before checking due work.

```yaml
- id: schedule
  inject: [dshpaScheduleResolverReady]
```

Open **Routines** in **Today**, save a draft, then select **Arm schedule**. One-time schedules take a UTC instant. Repeating schedules use a five-field Cron expression and an IANA zone. The native calendar skips a missing spring-forward time and selects the earlier instant during a fall-back overlap. Select whether to skip missed occurrences or run the latest missed occurrence. Editing saves a new draft that needs explicit arming.

Local reminders appear in **Today** without a Worker or a model. A task wake checks the exact released wait and current authority and budget before returning the task to the queue. To bind a later task revision, edit the draft and arm it again. **Run now** creates a separate occurrence. It uses its own command identity, independent of the next timed wake. The native Automation page shows opaque wake entries. Manage the routine and its business outcome in **Today**.

## Run as a resident host

Use a dedicated foreground profile or opt in to login startup. The same local inbox provides health checks, online backup and scoped audit export. [Resident operations](docs/operations.md)

## Restore a standalone work backup

Use a private standalone SQLite backup and an absolute destination path that does not exist. From the repository root after building the workspace, set `BACKUP_FILE` and `RESTORE_DIR` to those paths and run the restore command.

```sh
node --input-type=module - "$BACKUP_FILE" "$RESTORE_DIR" <<'JS'
import { restoreWorkStoreBackup } from './packages/personal-agent/lib/storage/restore.js'
restoreWorkStoreBackup(process.argv[2], process.argv[3])
JS
```

The source backup stays intact. The destination opens in reconciliation-only mode for scoped inspection and exact readback. New Worker input, action claims, and delivery stay disabled while the restored authority and post-backup outcomes are reviewed.

## Validate the plan

Requires Python 3 and Git; no application dependencies or model credentials are needed.

```sh
python3 scripts/check_plan.py
git diff --check
```

Use `python3 scripts/check_plan.py --check-sources` only when the upstream checkouts at the manifest's configured local paths are available. These commands validate the plan, not product functionality.

## Contributing

Follow [AGENTS.md](AGENTS.md) for bilingual documentation, English collaboration content and Conventional Commits. Notable changes are recorded in the [changelog](CHANGELOG.md).

## License

[Apache License 2.0](LICENSE).
