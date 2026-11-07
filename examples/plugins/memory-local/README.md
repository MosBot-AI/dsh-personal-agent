# Local memory example

[简体中文](README-zh.md) · [Plugin architecture](../../../docs/09-plugin-architecture.md)

`@mosbot-ai/dshpa-example-memory` is a bounded, keyless, in-memory provider for API version 1. It demonstrates scoped reads and keyword search, revision checks, supersession, forgetting and snapshots that retain record IDs and provenance. Restarting or unloading the provider discards its contents. Use synthetic data when trying the example.

From the workspace root, build the packages and add the example to an existing named DSH profile with dshpa installed.

```sh
pnpm build
pnpm exec dsh plugin --profile your-profile add "link:$PWD/examples/plugins/memory-local"
```

The profile mounts the `dshpa-example-memory` plugin. An optional overlay sets the instance ID, configuration revision and record limit.

```yaml
- id: dshpa-example-memory
  config:
    instanceId: example-memory
    configRevision: 1
    maxRecords: 128
```

`maxRecords` is a limit across scopes within the instance. The provider imports snapshots into an empty, matching scope and leaves existing scopes intact. Registration makes the provider available to trusted core consumers. Selection and memory authority belong to the core.
