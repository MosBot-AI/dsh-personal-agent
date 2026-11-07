# dshpa — DSH Personal Agent

[简体中文](README-zh.md)

dshpa is a personal-agent project built on DeepSeek Harness. It is designed to run persistently on an owner's computer, coordinate ongoing work and deliver inspectable results through native, replaceable plugins.

**The native bundle, work and security foundations, bounded Workers, verifiable delivery, local Web inbox, guarded recovery, event routing, compute and attention controls, durable schedules, resident host operations, and capability plugin contracts are implemented (PA-001 through PA-010, PA-013, PA-018, PA-021, and PA-038).**

The [host compatibility record](docs/evidence/host-compatibility.md) describes the verified native controls and the boundaries that later tasks must handle.
The [work domain evidence](docs/evidence/PA-003.md) covers record validation, command admission, and task transitions.
The [storage evidence](docs/evidence/PA-004.md) covers atomic commits, locking, migration, and fault recovery.
The [authorization evidence](docs/evidence/PA-005.md) covers trusted identity, exact-action review, one-use dispatch, and private worker tool isolation.
The [Worker evidence](docs/evidence/PA-006.md) covers native launch and resume, report admission, foreground control, and teardown.
The [artifact and delivery evidence](docs/evidence/PA-007.md) covers immutable content, trusted verification, and provider receipt handling.
The [local Web inbox evidence](docs/evidence/PA-008.md) covers native conversation integration, task controls, approval, and result acceptance.
The [recovery evidence](docs/evidence/PA-009.md) covers input acknowledgments, cancellation fences, and backup restore.
The [routing evidence](docs/evidence/PA-010.md) covers source intake, subscriptions, Worker handbacks, and responsive controls.
The [budget and attention evidence](docs/evidence/PA-013.md) covers model claims, resource ceilings, notification policy, and scoped usage.
The [schedule evidence](docs/evidence/PA-018.md) covers routine intent, native wake reconciliation, and deduplicated reminders and task wakes.
The [resident host evidence](docs/evidence/PA-021.md) covers lifecycle, diagnostics, online backups, and restore.
The [capability plugin evidence](docs/evidence/PA-038.md) covers versioned registration, scoped consumers, and independent keyless examples.

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
