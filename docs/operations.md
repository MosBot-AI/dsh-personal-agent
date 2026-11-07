# Resident host operations

[简体中文](operations-zh.md) · [Documentation index](README.md)

dshpa runs in one named foreground DSH Web profile on the owner's computer. The same process owns the SQLite writer, schedules, Workers and local inbox whether a browser is connected or closed. macOS uses an optional LaunchAgent. Linux headless deployment runs the same loopback process under an optional systemd user service. Model and connector availability depend on the configured routes.

## Prepare and run the profile

Build the workspace with the pinned Node.js and pnpm versions. Set up a fresh named profile once. DSH profile initialization replaces a profile with the same name.

```sh
export DSH_HOME="$PWD/.dshpa/resident-home"
pnpm install --frozen-lockfile
pnpm build
pnpm exec dsh --profile dshpa-resident --from-default-profile web --dump-config
pnpm exec dsh plugin --profile dshpa-resident add "link:$PWD/packages/personal-agent"
```

Save this owner overlay as `$PWD/.dshpa/resident.yml`. Add any Worker or routing settings to the same `inbox` block. The schedule setting enables the existing routine controls and exact wake reconciliation.

```yaml
- id: dshpa
  config:
    inbox:
      storageDirectory: !!js dshHomePath('resident-state')
      workRoot: !!js dshHomePath('resident-work')
      routines: true
      resident: {}
```

```sh
dshpa_node=$(command -v node)
dshpa_overlay="$PWD/.dshpa/resident.yml"
sh deploy/run-resident.sh "$dshpa_node" "$DSH_HOME" dshpa-resident "$dshpa_overlay" 3080
```

The launcher executes the pinned DSH process directly, binds `127.0.0.1`, and keeps native private output out of service logs. The SQLite writer lease is acquired before native schedule resolution becomes ready. A competing resident profile exits without taking ownership. Stop a foreground host with Ctrl+C. Service managers request shutdown with `SIGTERM`. The runtime stops new operations, drains owned work and closes the store. A forced exit is recovered from durable state on the next launch.

## Inspect the host

```sh
dshpa_state="$DSH_HOME/resident-state"
curl --noproxy '*' http://127.0.0.1:3080/dshpa/live
curl --noproxy '*' http://127.0.0.1:3080/dshpa/ready
node deploy/ops.mjs inspect "$dshpa_state"
node deploy/ops.mjs owner-url "$dshpa_state"
```

The live endpoint reports process reachability. Readiness uses HTTP 503 during startup, reconciliation, restore-only operation or shutdown. Both public responses contain only lifecycle fields and a per-process identifier. Owner inspection uses the authenticated local carrier and shows diagnostic codes and counts. The explicit `owner-url` command returns the process login link for the browser. Its file is owner-private and removed during normal shutdown.

The watchdog reports stale progress, repeated tool calls, compute limits and provider failures for the current Attempt. It is diagnostic. Provider authentication failures wait for owner revalidation. Temporary failures enter a timed resource wait and keep uncertain billing evidence. The owner can resume a released wait after its condition is met. A long heartbeat gap triggers bounded warm schedule reconciliation while preserving live work and cancelled generations.

## Opt in to automatic login startup

Generate a service description using the same prepared profile and paths. The templates start on login or user-manager startup. Operators restart after process failure or configuration changes. The semantic watchdog has no restart action.

### macOS LaunchAgent

```sh
dshpa_unit="$HOME/Library/LaunchAgents/org.mosbot.dshpa.dshpa-resident.plist"
mkdir -p "$HOME/Library/LaunchAgents"
node deploy/render-service.mjs launchd "$dshpa_node" "$DSH_HOME" dshpa-resident "$dshpa_overlay" 3080 > "$dshpa_unit"
plutil -lint "$dshpa_unit"
launchctl bootstrap "gui/$(id -u)" "$dshpa_unit"
```

To stop and unload it, run `launchctl bootout "gui/$(id -u)/org.mosbot.dshpa.dshpa-resident"`. Remove the plist to opt out of login startup. Keep the named profile and state for later reuse.

### Linux user service

```sh
mkdir -p "$HOME/.config/systemd/user"
dshpa_unit="$HOME/.config/systemd/user/dshpa-resident.service"
node deploy/render-service.mjs systemd "$dshpa_node" "$DSH_HOME" dshpa-resident "$dshpa_overlay" 3080 > "$dshpa_unit"
systemd-analyze verify "$dshpa_unit"
systemctl --user daemon-reload
systemctl --user enable --now dshpa-resident.service
```

The service uses an active systemd user manager. Use the host's user-manager policy if it should start before login or persist after logout. To stop and opt out, run `systemctl --user disable --now dshpa-resident.service`, remove the service description, and reload the user manager. Keep the profile and state directory.

## Backup, restore and retention

```sh
node deploy/ops.mjs backup "$dshpa_state"
node deploy/ops.mjs audit "$dshpa_state"
```

The backup operation copies a committed SQLite view, including sealed artifact bytes, to a standalone owner-private file. The default destination is `resident-backups` under the WorkStore. Set `resident.backupDirectory` to an absolute directory dedicated to this WorkStore if you use a separate volume. Its parent must already exist. After a successful backup, retention keeps at most `resident.maxBackups` managed snapshots within `resident.maxBackupAgeDays`. The defaults are seven snapshots and 30 days.

Keep the owner identity file `local-inbox-identity.json` separately with mode `0600` if the same owner will inspect a restored WorkStore. Restore the standalone database into a fresh directory using the [backup restore procedure](../README.md#restore-a-standalone-work-backup). Copy the matching identity file to the restored directory, point the owner overlay at it, and start the profile. The restored host allows scoped inspection and reports live with readiness held for reconciliation. It keeps old dispatch authority fenced.

The audit command emits fixed metadata and counts for the authenticated owner. Pass `nextAfterSequence` as the optional final argument to read the next page. Full backups contain the work record. Watchdog diagnostic metadata is kept in memory for up to 14 days and 512 records by default. Configure `resident.watchdog.retentionDays` and `resident.watchdog.maxDiagnostics` to change those bounds. Authoritative work and artifacts follow the owner's retention and deletion decisions.
