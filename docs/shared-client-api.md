# Shared personal-agent client API

English | [简体中文](shared-client-api-zh.md)

## Status and authority

The owner requested one REST contract for phone and desktop clients, with Hermes or DSH selectable behind that contract. DSH main includes **authenticated protocol discovery and live task pagination**. Deployed HTTPS and physical-phone acceptance remain open under [PA-022](https://github.com/MosBot-AI/dsh-personal-agent/issues/23).

The canonical 0.1.0 contract belongs to `MosBot-AI/hermes-superagent/contracts/personal-api`. This repository vendors its exact JSON schema, OpenAPI description, fixtures and digest manifest in `contracts/personal-api`. The source lock pins authority commit `48a930a2c01b2add9e349cbc1f0d65278066cc1c`. The pinned artifacts match the merged Hermes contract byte for byte. [Hermes PR #100](https://github.com/MosBot-AI/hermes-superagent/pull/100)

Change the authority first, independently review it, update the pin and copied bytes together, then run both adapters' conformance tests. Never independently edit a vendored schema to accommodate a local implementation. Version 0.1.0 is pre-stable. Breaking wire changes require an explicit, coordinated migration for `/v1` adapters and clients.

## Implemented behavior

- `GET /v1/capabilities` uses the existing mobile device cookie, exact Host/Origin checks, revocation and no-store responses. It returns the shared `personal.api.v1` envelope with the contract version, diagnostic backend ID, capabilities, transports and limits. Client behavior depends on capabilities, not a backend-name switch.
- `tasks.list` reports supported, enabled and available on the configured mobile listener. The other six shared domain capabilities remain unavailable with `reason:not_implemented`. Existing native or legacy functionality does not imply a shared adapter exists.
- `GET /v1/tasks` reauthenticates the current device on every request and returns at most `limit` tasks (1–64, default 32), with `next_cursor` or null and `consistency:live`. Each database query is scoped to the trusted owner/profile and conversation-backed tasks, matching legacy mobile visibility. Duplicate/unknown parameters are rejected. Only the five shared task fields are returned; private constraints, project references, credentials and original destinations are excluded.
- Common errors distinguish authentication (401), forbidden origin (403), invalid request (400), unavailable capability (409), and temporary service failure (503). No credential, native session or source destination is returned.
- Plain JSON discovery can be polled. `transport.polling:true` does not advertise a domain change feed: `changes.poll` remains unavailable. Shared SSE is false even though the unchanged legacy `/v1/events` uses SSE.
- The shared task `title` contains the full requested outcome when it has at most 4,096 Unicode code points. Longer outcomes use the first 4,095 code points followed by `…` (U+2026). The full outcome is preserved in storage and returned by the legacy task snapshot.
- A strict task projection maps native states to shared states. Pending cancellation remains waiting, and reconciliation remains unknown, never completed or cancelled. Invalid IDs, malformed records and unsafe numeric revisions fail projection. These are recorded task states, not proof that a worker is still running or an external effect is complete.

Pairing, legacy task snapshots, approval handoff/responses and legacy SSE retain their current routes and semantics. No replacement login issuer, token forwarding, generic tool execution, external write or new listening port is introduced. The mobile listener remains opt-in and uses the operator's configured HTTPS reverse proxy.

The OpenAPI `backendSession` cookie binding describes the currently implemented DSH HTTP adapter only. It is not a new issuer or a claim that Hermes uses the same cookie. Clients use their normal cookie jar; business behavior must not branch on backend brand.

## Live pagination semantics

Pages follow SQLite binary task-ID order. Continuation queries seek directly past the anchor ID within that ordering and retain the same owner, profile and conversation visibility filters. Inserts before the cursor require restarting the scan to observe them; later inserts can appear on subsequent pages. Updates are read live. Deleting an anchor does not invalidate ordering. A null continuation means the current query reached the end, not that future tasks cannot appear.

Continuation tokens are opaque to clients, HMAC-bound to the trusted owner/profile, enrolled device and feed instance. Modifications, another device or a restart return `cursor_invalid` (400); restart without a cursor. Revocation/expiry returns `auth_required` (401), even with a previously valid cursor. Tokens carry no authentication authority and are never used as SQL scope. No new credential, durable secret or issuer is added. Page SQL returns at most 65 rows. An invalid record on the requested page fails the response with generic `internal_unavailable` (503).

## Next slices and compatibility gaps

1. Validate shared task pagination in deployed HTTPS and physical-phone environments. The legacy 64-task snapshot remains separate and is not used as the shared collection.
2. Adapt approvals, operations and a pollable durable change feed, preserving exact one-use grants, version checks, revocation and unknown-outcome reconciliation.
3. Adapt conversation continuation and memory only through the existing native owner/runtime boundary. Capability availability must remain false until each operation has its own verified adapter and security/recovery evidence.
4. Run the same client contract suite against both backends once Hermes verifies the native HTTP principal and registers the shared routes. [Hermes identity #29](https://github.com/MosBot-AI/hermes-superagent/issues/29) · [Hermes domain API #30](https://github.com/MosBot-AI/hermes-superagent/issues/30)

## Verification

`tests/api/shared-client.spec.ts` compares the pure unavailable-discovery/error helpers with the canonical fixtures and checks live HTTP task availability and page responses, verifies vendored artifact SHA-256 digests, covers all native task-state mappings, and exercises real loopback HTTP authentication, pairing-code rejection, device revocation, exact Host/Origin and query rejection. `tests/api/remote.spec.ts` retains legacy device/replay coverage.

Pagination checks also cover more than 64 tasks, the exact public fields, owner and profile isolation, hidden tasks, cross-device and tampered cursors, cursor invalidation after restart, revocation, and live insert ordering. The fixtures use isolated local state. Physical-phone behavior, an externally deployed HTTPS origin and authenticated Hermes HTTP still require their own acceptance evidence.

- [Discovery #79](https://github.com/MosBot-AI/dsh-personal-agent/pull/79) merged as `3900cf4406caef7f15af69d09c9b6840255ce670`. The discovery branch passed 14 focused API tests. Its initial full-suite failures and unrun native-browser stage are recorded in the PR.
- [Pagination #81](https://github.com/MosBot-AI/dsh-personal-agent/pull/81) merged as `ffbfa1bae6b147e19458269a662337e0d06c24f7`. The final integration passed 19 focused API tests, eight native Chromium cases, type checking, build, 12 coordination tests and plan validation. The PR workflow passed on retry after a Chrome startup timeout, and the merged commit's main workflow passed on the first run. [Integration evidence](https://github.com/MosBot-AI/dsh-personal-agent/issues/23#issuecomment-6846471838) · [PR CI](https://github.com/MosBot-AI/dsh-personal-agent/actions/runs/43381473515) · [Main CI](https://github.com/MosBot-AI/dsh-personal-agent/actions/runs/43382599557)
