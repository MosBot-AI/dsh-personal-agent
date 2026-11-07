# dshpa — DSH Personal Agent

[简体中文](README-zh.md)

dshpa is a personal-agent project built on DeepSeek Harness. It is designed to run persistently on an owner's computer, coordinate ongoing work and deliver inspectable results through native, replaceable plugins.

**The native bundle, work and security foundations, bounded Workers, verifiable delivery, local Web inbox, guarded recovery, and event routing are implemented (PA-001 through PA-010).**

The [host compatibility record](docs/evidence/host-compatibility.md) describes the verified native controls and the boundaries that later tasks must handle.
The [work domain evidence](docs/evidence/PA-003.md) covers record validation, command admission, and task transitions.
The [storage evidence](docs/evidence/PA-004.md) covers atomic commits, locking, migration, and fault recovery.
The [authorization evidence](docs/evidence/PA-005.md) covers trusted identity, exact-action review, one-use dispatch, and private worker tool isolation.
The [Worker evidence](docs/evidence/PA-006.md) covers native launch and resume, report admission, foreground control, and teardown.
The [artifact and delivery evidence](docs/evidence/PA-007.md) covers immutable content, trusted verification, and provider receipt handling.
The [local Web inbox evidence](docs/evidence/PA-008.md) covers native conversation integration, task controls, approval, and result acceptance.
The [recovery evidence](docs/evidence/PA-009.md) covers input acknowledgments, cancellation fences, and backup restore.
The [routing evidence](docs/evidence/PA-010.md) covers source intake, subscriptions, Worker handbacks, and responsive controls.

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

Semantic assessment is optional. For a deployment that incurs no model charges, add an `inbox.routing` block with `provider`, `model`, permitted `dataScope` labels and `unmetered: true`. The assessor evaluates bounded batches and returns proposals for owner review. Exact work subscriptions can route without this block when `inbox.worker.unmetered` is `true` or a trusted policy permits the input. An event-triggered Worker wake requires a trusted wake policy for the current grant, budget, and wait condition. Connector enrollment and metered background dispatch are separate implementation tasks.

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
