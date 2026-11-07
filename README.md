# dshpa — DSH Personal Agent

[简体中文](README-zh.md)

dshpa is a planned personal agent built on DeepSeek Harness. It is designed to run persistently on an owner's computer, coordinate ongoing work and deliver inspectable results through native, replaceable plugins.

**Current status: architecture and implementation plan only. The application is not implemented yet.**

## Planned capabilities

- Continuous conversation, durable tasks, goals, reminders and correctable memory.
- Local computer operation with live VNC viewing and human takeover.
- Replaceable image/video generation and creation workflows.
- Secure password/key intake and purpose-limited credential use.
- Optional remote/mobile access, connected devices and voice.

Read the [documentation index](docs/README.md), [architecture](docs/01-product-and-architecture.md) and [plugin specification](docs/09-plugin-architecture.md). Implementation agents should start with the [execution guide](docs/06-agent-execution-guide.md) and [39-task manifest](docs/implementation-tasks.json).

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
