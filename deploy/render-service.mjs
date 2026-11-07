import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const [manager, node, home, profile, patch, port, ...extra] = process.argv.slice(2)
const absolute = path => typeof path === 'string' && isAbsolute(path) && !/[\u0000-\u001f\u007f]/u.test(path)
if (!['launchd', 'systemd'].includes(manager) || ![node, home, patch].every(absolute) || extra.length > 0
  || typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(profile)
  || typeof port !== 'string' || !/^[0-9]{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
  process.stderr.write('Usage: render-service.mjs launchd|systemd /absolute/node /absolute/dsh-home profile /absolute/patch.yml port\n')
  process.exit(64)
}

const launcher = fileURLToPath(new URL('./run-resident.sh', import.meta.url))
const args = ['/bin/sh', launcher, node, home, profile, patch, port]
const label = `org.mosbot.dshpa.${profile}`
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const systemd = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`

if (manager === 'launchd') {
  process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`)
} else {
  process.stdout.write(`[Unit]
Description=DSH Personal Agent (${profile})

[Service]
Type=simple
ExecStart=${args.map(systemd).join(' ')}
UMask=0077
Restart=no
TimeoutStopSec=15
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`)
}
