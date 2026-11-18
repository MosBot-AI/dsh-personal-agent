# Personal Agent Vue client demo

English | [简体中文](README-zh.md)

The demo uses Vue 3 and Vite. Run it from the repository root with Node.js 24.12 or later.

```sh
npm --prefix .demo ci
npm --prefix .demo run dev
```

Vite serves the interface at `http://127.0.0.1:5173/`. Connect to a backend by serving the built demo on the backend's HTTPS origin.

## Connect to DSH

1. Enable the mobile listener on the existing local Web profile and configure its dedicated HTTPS reverse proxy. See the [DSH mobile setup](../README.md#opt-in-to-the-mobile-work-view).
2. Run `npm --prefix .demo run build`. Serve `.demo/dist/` as static files at `/demo/` on the configured mobile HTTPS origin, so `/demo/` serves `index.html` and `/demo/assets/` serves its assets. Keep `/v1/*` routed to the mobile loopback listener. Preserve the configured Host and browser Origin headers and disable buffering for `/v1/events`.
3. Open `/demo/` in your browser. If the browser already has a paired mobile session on this origin, discovery uses it automatically. Otherwise, turn on the DSH mobile extension, create a pairing code under **Today → Mobile access** in the local owner inbox, and submit it in the demo.
4. To exercise approvals, assign an exact pending review to this device from the local owner inbox. The demo shows the approval preview and submits the displayed version and digest with the selected decision. An approval receipt records the decision. The trusted coordinator handles execution.

A shared API deployment uses the same `/v1` routes and its own authenticated session on that origin. The current Hermes implementation exposes local diagnostics and has no registered shared HTTP router. See the [shared client API status](../docs/shared-client-api.md).

## API coverage

| Surface | Endpoints |
| --- | --- |
| Shared REST API | `GET /v1/capabilities`, `GET /v1/tasks` |
| DSH mobile extension | `POST /v1/pair`, `GET /v1/snapshot`, `GET /v1/approvals`, `POST /v1/approvals/{id}/responses`, `GET /v1/events` |

Task pagination uses the reported `tasks.list` capability and treats cursors as opaque. If a cursor expires or becomes invalid, read from the first page again. The DSH extension uses event hints to reload the snapshot and assigned approvals. It clears displayed private data on session loss and uses a fresh snapshot to reconnect an interrupted stream. Shared discovery lists unavailable operations with their reported reasons.

## Local verification

The built demo ran in Chromium against an isolated native DSH profile through a certificate-pinned loopback HTTPS proxy. The check exercised pairing, capability discovery, task pagination and cursor recovery, the recent snapshot, exact approval and denial, event-driven refresh, reconnect and device revocation. It also checked horizontal fit at a 390 px viewport. Deployed HTTPS and physical-device acceptance remain open.
