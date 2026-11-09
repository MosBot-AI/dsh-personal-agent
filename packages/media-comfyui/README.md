# Local ComfyUI media provider

[简体中文](README-zh.md) · [Plugin architecture](../../docs/09-plugin-architecture.md)

`@mosbot-ai/dshpa-media-comfyui` connects the dshpa media queue to an existing local ComfyUI 0.44.0 installation. It uses a literal loopback HTTP origin and requires `ffmpeg` and `ffprobe` on the DSH process's PATH. Use a trusted ComfyUI installation with local nodes and models. Review the exported API workflow, including custom nodes, before enabling it. The adapter rejects nodes that ComfyUI declares as API nodes. [ComfyUI HTTP routes](https://docs.comfy.org/development/comfyui-server/comms_routes)

Build the workspace and install the provider in a named Web profile that already contains dshpa.

```sh
pnpm build
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/media-comfyui"
```

Set the following fields on the `dshpa-media-comfyui` plugin row in the Web profile overlay.

| Field | Value |
| --- | --- |
| `instanceId`, `configRevision` | Choose a stable instance ID and positive revision. Increment the revision when the endpoint or workflows change. Keep the originating revision available while it has unsettled jobs. |
| `origin`, `outputDirectory`, `compute` | Literal loopback HTTP origin, absolute path to ComfyUI's output directory and the expected `cpu` or `gpu` device class. |
| `workflows` | One to 16 approved API graphs. Each has `id`, `version`, `model`, `spec`, `graph`, `prompt`, `seed` and `outputs`. Use a fixed `generate` spec with `modality`, `width`, `height`, and `durationMs` for video. The model and dimensions must already be set in the graph. Set `prompt` and `seed` to `{ node, input }` bindings to an existing string and numeric input. List the approved output node IDs in `outputs`. |
| `minFreeDiskBytes`, `minFreeMemoryBytes` | Minimum free space on the output filesystem and minimum free system memory. Discrete GPU mode also checks free device memory. Defaults are 512 MiB and 256 MiB. |
| `maxOutputBytes`, `timeoutMs` | Total collected bytes per job and per-request HTTP deadline. Defaults are 32 MiB and 10 seconds. |

Enable the queue with `media` under `config.inbox` on the existing `dshpa` row. This example selects the same provider revision for both modalities. The configured graphs must support the selected modalities.

```yaml
media:
  providers:
    image: &local-comfy
      kind: media
      pluginId: '@mosbot-ai/dshpa-media-comfyui'
      pluginVersion: '0.1.0'
      instanceId: local-comfy
      configRevision: 1
    video: *local-comfy
  maxQueued: 16
  maxPerAttempt: 4
  pollMs: 2000
```

Trusted host components use `dshpaMedia.enqueue`, `inspect` and `cancel` with the exact current task and attempt scope. Requests use an approved workflow version, model, fixed output specification and prompt. This provider supports prompt-based generation. Reference-image intake, creation screens and artifact delivery belong to the subsequent creation workflows.

SQLite stores the prepared prompt ID, request and workflow digests, and seed before sending. The provider reads queue/history on the pinned instance after a disconnect. If neither can prove the outcome, the job holds the media lease and waits for reconciliation. Keep ComfyUI history and output files while jobs remain unsettled. The final record contains verified output metadata and SHA-256. Bytes stay in the configured ComfyUI output directory. Video duration may differ by up to 100 ms from its requested spec.
