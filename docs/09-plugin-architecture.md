# 09. Replaceable capabilities and plugin development

[Documentation index](README.md) · [简体中文](09-plugin-architecture-zh.md)

Image/video creation and memory must be independently replaceable **DSH/Cordis plugins** from the first complete release, with documented versioned interfaces, configuration and contract tests. An abstract class inside one package is insufficient. These are implementation requirements; the plugins are not yet built.

## 1. User-customizable capabilities

| Capability | Default plugin | Replaceable behavior | Core responsibility |
| --- | --- | --- | --- |
| Image/video generation | `media-comfyui` | Instance, models/workflows or custom local/hosted backend | Jobs, grants, budgets, cancellation reconciliation and artifacts |
| Creation workflow | `creation-workflows` | Storyboard, templates, variants, assembly and editing | Acceptance, versions and publishing authority |
| Personal memory | `memory-sqlite` | Persistence, retrieval and indexing, including file/database alternatives | Owner/scope, corrections, forgetting exclusions and disclosure policy |
| Voice | Future STT/TTS plugins | Transcription and synthesis | Identity, tasks, approvals and usage |
| Credentials | Keychain/Bitwarden providers | Protected storage and use | Secure intake, purpose grants and sanitized audit |
| Computer/browser/VNC | Native DSH providers plus adapters | Driver and desktop environment | Control ownership, takeover and device authority |

These are proposed directories, not published npm packages. Users select installed plugins and change configuration in settings; developers install local or packaged plugins without forking the core. A marketplace is not required.

## 2. Packaging and dependency direction

```text
packages/
  personal-agent/       # bundle, trusted control services, UI and consumers
  plugin-api/           # service definitions, versions, types and lifecycle
  plugin-testkit/       # keyless contracts and development fixtures
  memory-sqlite/        # default memory and keyword retrieval provider
  media-comfyui/        # default generation provider
  creation-workflows/  # default image/video creation workflows
examples/plugins/      # explicitly labeled memory and mock-media examples
```

Dependency direction is core consumers → `plugin-api` ← providers. Providers cannot import private core paths or modify core task/grant tables. The bundle supplies defaults that users can override. Keep Definition/Provider/Consumer roles complete without creating a package for every helper.

The documented extension API ships in alpha but remains pre-stable: pin interface versions, reject incompatibility and document breaking migrations. Registrations are effects with disposers. Lifecycle includes validate/start/health/drain/stop; unloaded plugins cannot admit new work.

## 3. Provider contracts

**MediaProvider:** `capabilities`, `submit`, `inspect`, `cancel`, `collect`, with durable handles and structured failures. Declare modalities, generation/editing, specifications, cancellation granularity, resources, destinations and pricing. Images and video may use different providers or one ComfyUI instance. Each MediaJob pins provider ID, plugin version and configuration revision. Default changes affect new jobs only; old jobs are never queried/cancelled against the new backend.

**CreationWorkflowProvider:** declares input/output, required capabilities, workflow version, steps and checkpoints. It submits work through core media/tool services. Users can replace storyboarding, assembly and editing without changing the Router. Workflows cannot grant authority or install custom nodes automatically.

**MemoryProvider:** `read`, `search`, `upsert`, `supersede`, `forget`, `exportSnapshot`, `importSnapshot`, `health`. Canonical records preserve IDs, owner/scope, content, sources, explicit/inferred status, validity, revision and tombstones. A vector-only component implements optional `MemoryRetrievalProvider`, not a complete store. Retrieval returns record IDs, scores and sources; the core rechecks scope and forgetting exclusions.

Memory-provider records store personal facts. Core tasks, grants, delivery and exclusion records remain in the core database. Replacing memory does not replace the entire agent's state. Forgetting first records a core exclusion, then requests provider deletion; offline or delayed deletion cannot allow forgotten content back into context. Show completed versus pending deletion separately.

## 4. Configuration and switching

Settings show ID/version, capabilities, schema-generated configuration, health, data location, network destinations, active jobs and test/select/disable controls. Secret inputs use secure cards and configuration stores CredentialRef only. Invalid configuration fails visibly without silent fallback.

1. Install/select a provider and disclose its resource/data access.
2. Validate version/configuration, run contracts and connection probes, and persist a configuration revision.
3. Media defaults change at new-job boundaries; retain old instances until jobs finish or cancellation reconciles.
4. For memory, freeze writes, export a versioned snapshot including tombstones, import into the candidate and compare counts, IDs, hashes, access and retrieval cases.
5. Atomically switch the core active-provider pointer. New context requests use the new revision; retain old snapshots under policy without migrating tasks/sessions.
6. Failed import retains the old backend. Before rollback, replay subsequent corrections/deletions from the change log; never point at a stale copy that revives facts. Incomplete reconciliation blocks rollback.

Arbitrary hot replacement is not promised. Drain idle providers; otherwise wait, reconcile cancellation or require an explicit restart. Unavailable capabilities leave affected tasks waiting without silently using a paid external service.

## 5. Trust and authority

In-process Cordis plugins are trusted code, not sandboxed by TypeScript or packaging. Trusted user-written providers may run in-process. Untrusted third-party implementations need restricted RPC/process/VM isolation without core database, full environment or vault access. Installation permission is separate from task authority.

External model/retrieval providers declare data destinations. Switching to remote memory or media requires disclosure checks; an old provider's read grant is not authorization to upload to a new service.

## 6. Implementation and acceptance

PA-038 creates API, registry, testkit and examples. PA-012 implements the independent memory provider; PA-033/034 implement independent media/workflow providers. PA-039 implements settings, switching, memory migration and rollback.

E21 proves external plugins load without core edits; incompatible versions fail; media jobs retain provider ownership; memory round trips preserve sources/tombstones; failed migration retains service; rollback after corrections/forgetting cannot revive facts; unload leaves no execution. Mock media examples cannot establish real generation capability.
