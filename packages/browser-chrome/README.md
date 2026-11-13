# DSHPA isolated Chrome provider

[简体中文](README-zh.md)

This optional bundle uses DSH's `SessionResources`, scoped MCP client and browser provider registration with Chrome DevTools MCP 1.9.0. It starts a fresh headless Chrome profile for each owner-authorized task Session and enables structured page observations, explicit page IDs, and the browser's URL allowlist. Use Chrome 149 or later.

Install the bundle into the same local Web profile as dshpa.

```sh
pnpm build
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/browser-chrome"
```

Enable the provider in the profile overlay and list the origins this deployment may access.

```yaml
- id: dshpa-browser-chrome
  disabled: false
  config:
    executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
    allowedOrigins:
      - https://example.com
```

Add the task targets under the dshpa entry's `config.inbox.desktop`. Each target uses an exact starting URL under an allowed origin.

```yaml
desktop:
  browserProfiles:
    - id: example
      startUrl: https://example.com/
```

In **Today**, choose the browser target and select **Authorize and start browser work**. dshpa opens a dedicated tab in a fresh isolated browser context and binds the lease to its profile and tab. **Pause browser automation** fences further tool calls. Continuing starts a new isolated tab and requires a fresh observation.

`allowedOrigins` lists the deployment's available targets; it does not grant every target to every task. Before the browser starts, the trusted host binds the exact Agent activation to the selected origin and lease. The MCP process receives only that origin as its network allowlist, covering frames, fetches, popups and redirects as well as navigation. The leased tool also binds actions to the exact tab and fresh observation. Taking over or losing the lease closes the owning MCP scope. A missing provider parks work before sending task input to a model. It sends a bounded projection of the top-level accessibility tree to the configured model and accepts only navigation, observation, click and fill operations. Browser state is discarded when the owning Session ends. Unrestricted code execution requires an independently enforced OS isolation boundary.

Run the live loopback test against a locally installed Chrome executable.

```sh
DSHPA_TEST_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm exec vitest run tests/e2e/browser-live.spec.ts tests/e2e/browser-multiorigin.spec.ts
```

Set `DSHPA_TEST_BROWSER_TARBALL=1` to also pack and install dshpa and the browser provider into a fresh DSH profile. The installed browser provider uses the pinned host's MCP client and scope packages so its leased tools are visible to the host. The install test can contact the package registry. The browser task uses only local test servers.

[Repository README](../../README.md)
