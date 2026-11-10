# Shared personal-agent client API

English | [简体中文](shared-client-api-zh.md)

## Status and authority

The owner requested one REST contract for phone and desktop clients, with Hermes or DSH selectable behind that contract. This first DSH slice implements **authenticated protocol discovery**, not functional parity or a new agent runtime. It extends [PA-022](https://github.com/MosBot-AI/dsh-personal-agent/issues/23); deployed HTTPS and physical-phone acceptance remain pending.

The canonical 0.1.0 contract belongs to `MosBot-AI/hermes-superagent/contracts/personal-api`. This repository vendors its exact JSON schema, OpenAPI description, fixtures and digest manifest in `contracts/personal-api`. The source lock records authority commit `48a930a2c01b2add9e349cbc1f0d65278066cc1c` on its review branch; this is not a claim that the authority change is merged or released. Change the authority first, independently review it, update the pin and copied bytes together, then run both adapters' conformance tests. Never independently edit a vendored schema to accommodate a local implementation. Version 0.1.0 is pre-stable; breaking wire changes require explicit coordinated migration, not silent reinterpretation of `/v1`.

## Implemented behavior

- `GET /v1/capabilities` uses the existing mobile device cookie, exact Host/Origin checks, revocation and no-store responses. It returns the shared `personal.api.v1` envelope with the contract version, diagnostic backend ID, capabilities, transports and limits. Client behavior depends on capabilities, not a backend-name switch.
- All seven shared domain capabilities currently report `supported:false`, `enabled:false`, `available:false`, `reason:not_implemented`. Existing native or legacy mobile functionality is not evidence that the new shared operation exists.
- `GET /v1/tasks`, after current device authentication, returns HTTP 409 with `capability_unavailable` and capability `tasks.list`. No task query or mutation occurs. Supported `limit` (1–64) and bounded opaque `cursor` parameters are validated before the unavailable result; duplicates and unknown parameters are rejected.
- Common errors distinguish authentication (401), forbidden origin (403), invalid request (400), unavailable capability (409), and temporary service failure (503). No credential, native session or source destination is returned.
- Plain JSON discovery can be polled. `transport.polling:true` does not advertise a domain change feed: `changes.poll` remains unavailable. Shared SSE is false even though the unchanged legacy `/v1/events` uses SSE.
- A pure, unconnected task projection maps native states to shared states. Pending cancellation remains waiting, and reconciliation remains unknown, never completed or cancelled. Unrepresentable IDs/titles and unsafe numeric revisions are rejected, never silently truncated or rounded. This is a tested adapter seam, not a registered task-list implementation.

Pairing, legacy task snapshots, approval handoff/responses and legacy SSE retain their current routes and semantics. No replacement login issuer, token forwarding, generic tool execution, external write or new listening port is introduced. The mobile listener remains opt-in and uses the operator's configured HTTPS reverse proxy.


The OpenAPI `backendSession` cookie binding describes the currently implemented DSH HTTP adapter only. It is not a new issuer or a claim that Hermes uses the same cookie. Clients use their normal cookie jar; business behavior must not branch on backend brand.

## Next slices and compatibility gaps

1. Add a bounded authenticated shared task list with explicitly live, scoped pagination. The existing 64-task snapshot has no completeness/continuation contract and must not masquerade as that collection.
2. Adapt approvals, operations and a pollable durable change feed, preserving exact one-use grants, version checks, revocation and unknown-outcome reconciliation.
3. Adapt conversation continuation and memory only through the existing native owner/runtime boundary. Capability availability must remain false until each operation has its own verified adapter and security/recovery evidence.
4. Run the same client contract suite against both backends. Hermes additionally requires verified HTTP principal propagation; a schema or DSH success does not resolve that host seam. Native phone sign-in and deployed-origin acceptance remain separate release gates.

## Verification

`tests/api/shared-client.spec.ts` compares the emitted discovery and unavailable-task responses with the canonical fixtures, verifies vendored artifact SHA-256 digests, covers all native task-state mappings, and exercises real loopback HTTP authentication, pairing-code rejection, device revocation, exact Host/Origin and query rejection. `tests/api/remote.spec.ts` retains legacy device/replay coverage.

These checks use isolated synthetic local state. They do not prove physical-phone behavior, a deployed HTTPS origin, full shared task access or parity with Hermes. The user's local knowledge base was unavailable in this cloud workspace; no historical decisions were inferred from it.

### This slice's local results

- Shared and existing mobile API tests: 14/14 passed, including real loopback HTTP.
- Workspace `tsc --noEmit`, personal-agent compilation and client bundle build passed. Plan validation, 12 coordination tests and whitespace checks passed.
- Full default-parallel suite: 332/336 passed; the known pending #75 schedule-recovery race and three media/restore five-second timeouts failed. With `--maxWorkers=2`, 335/336 passed; only the same schedule-recovery assertion failed. No timeout, assertion or production schedule logic was relaxed. This branch does not contain pending #76. The full-suite gate is not green.
- Native mobile/browser suite could not start under `dbus-run-session`: the current environment denied its transient directory and message-bus socket. No security setting was changed. This is an unrun stage, not a successful phone or browser check.
- The available pnpm executable is 11.25.0, not repository-pinned 11.28.5, and installation refused that mismatch. Tests used the existing same-lockfile dependency installation copied into this worktree and its pinned TypeScript/Vitest executables directly. No package or lockfile version was changed. An initial full-suite attempt before generated libraries existed failed; it is superseded by the post-build results above, not claimed as a pass.
