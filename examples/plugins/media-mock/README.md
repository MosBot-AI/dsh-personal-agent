# Mock media example

[简体中文](README-zh.md) · [Plugin architecture](../../../docs/09-plugin-architecture.md)

`@mosbot-ai/dshpa-example-media-mock` is a keyless API version 1 fixture. It declares `mock: true`, uses `mock-job-` and `mock-asset-` IDs, and returns metadata for a fixed SVG fixture labeled `MOCK FIXTURE`. It uses no network or image model. Jobs and their fixture metadata live in memory until unload or restart.

From the workspace root, build the packages and add the example to an existing named DSH profile with dshpa installed.

```sh
pnpm build
pnpm exec dsh plugin --profile your-profile add "link:$PWD/examples/plugins/media-mock"
```

The profile mounts the `dshpa-example-media-mock` plugin. An optional overlay sets the instance ID, configuration revision, job limit and simulated latency in milliseconds.

```yaml
- id: dshpa-example-media-mock
  config:
    instanceId: example-media-mock
    configRevision: 1
    maxJobs: 32
    latencyMs: 0
```

The fixture accepts image-generation requests up to 1024 × 1024 and supports cancelling queued jobs. The provider and configuration revision remain attached to every handle. Registry and lifecycle tests use this fixture to check provider routing and cleanup.
