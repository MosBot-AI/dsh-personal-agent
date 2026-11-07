# dshpa — DSH Personal Agent

[简体中文](README-zh.md)

dshpa is a personal-agent project built on DeepSeek Harness. It is designed to run persistently on an owner's computer, coordinate ongoing work and deliver inspectable results through native, replaceable plugins.

**The native bundle, host contracts, and work domain are implemented (PA-001 through PA-003).**

The [host compatibility record](docs/evidence/host-compatibility.md) describes the verified native controls and the boundaries that later tasks must handle.
The [work domain evidence](docs/evidence/PA-003.md) covers record validation, command admission, and task transitions.

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
