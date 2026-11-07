# SQLite memory provider

[简体中文](README-zh.md) · [Plugin architecture](../../docs/09-plugin-architecture.md)

`@mosbot-ai/dshpa-memory-sqlite` implements capability API version 1. It stores personal memory in a separate local SQLite file and registers with dshpa through the public plugin API. The authenticated inbox owns memory scope and disclosure policy.

Build the workspace and add the provider to a named DSH profile that already has dshpa installed.

```sh
pnpm build
pnpm exec dsh plugin --profile your-profile add "link:$PWD/packages/memory-sqlite"
```

The bundle loads the `dshpa-memory-sqlite` row. Its default directory is `dshpa-memory` under `DSH_HOME`. Set `directory` to an absolute path to use a different location. The default provider instance is `local-memory` at configuration revision `1`.

```yaml
- id: dshpa-memory-sqlite
  config:
    directory: /absolute/path/to/private-memory
    instanceId: local-memory
    configRevision: 1
```

The provider opens `memory.sqlite` in an owner-private directory. On Unix-like systems the directory uses mode `0700` and the file uses `0600`. A different database format at that path blocks startup. Memory records stay scoped to the exact owner, profile and selected profile, project or task scope. Search uses normalized text matching and returns active, currently valid records by reference. The consumer applies its own authorization before displaying the record.

Correction atomically supersedes the prior revision and inserts the replacement. Forgetting stores a tombstone with source and revision metadata. SQLite secure deletion applies to discarded data in the current database. Prior exports, filesystem snapshots and backup copies may retain old content and follow their own retention policies.

The provider exports a normalized version-1 snapshot for one scope, including superseded records and tombstones. A scope can hold up to 512 records and must fit in a 4 MiB snapshot. Import requires an empty matching scope and applies the full snapshot in one transaction. The WorkStore and provider use separate files. Include the memory provider in any backup procedure that needs to preserve memory content.
