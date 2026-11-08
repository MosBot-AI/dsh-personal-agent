import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { InboxPort, InboxRequest, InboxResponse, MobileDeviceSummary } from '../inbox/protocol.js'
import { formatTime, type Translate } from './copy.js'

type Pairing = Extract<InboxResponse, { kind: 'mobile_pair' }>

export function MobileDevices({ port, t }: { port: InboxPort; t: Translate }) {
  const [devices, setDevices] = useState<readonly MobileDeviceSummary[]>([])
  const [available, setAvailable] = useState(false)
  const [label, setLabel] = useState('')
  const [pairing, setPairing] = useState<Pairing>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef<AbortController>()

  async function run(request: InboxRequest) {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setFailed(false)
    try {
      const result = await port(request, controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) throw new Error()
      if (result.kind === 'mobile_pair') { setPairing(result); setLabel('') }
      if (request.type === 'mobile_revoke') setPairing(undefined)
      const list = result.kind === 'mobile_devices' ? result : await port({ type: 'mobile_devices' }, controller.signal)
      if (controller.signal.aborted) return
      if (!list.ok || list.kind !== 'mobile_devices') throw new Error()
      setDevices(list.devices)
      setAvailable(list.available)
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (pending.current === controller) {
        pending.current = undefined
        setBusy(false)
      }
    }
  }

  useEffect(() => {
    void run({ type: 'mobile_devices' })
    return () => { pending.current?.abort(); pending.current = undefined }
  }, [port])

  useEffect(() => {
    if (!pairing) return
    const timer = setTimeout(() => setPairing(undefined), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [pairing])

  function pair(event: FormEvent) {
    event.preventDefault()
    setPairing(undefined)
    void run({ type: 'mobile_pair', label: label.trim() })
  }

  return <section className="dshpa-section" aria-label={t('mobile.title')}>
    <h2>{t('mobile.title')}</h2>
    <button type="button" disabled={busy} onClick={() => { void run({ type: 'mobile_devices' }) }}>{t('action.refresh')}</button>
    {!available && !busy && <p role="status">{t('mobile.unavailable')}</p>}
    {failed && <p role="status">{t('mobile.failed')}</p>}
    <form onSubmit={pair}>
      <label>{t('mobile.name')}<input maxLength={80} required value={label} onChange={event => setLabel(event.target.value)} /></label>
      <button disabled={!available || busy || !label.trim()}>{t('mobile.pair')}</button>
    </form>
    {pairing && <div className="dshpa-card">
      <p>{t('mobile.open')} <a href={pairing.origin} target="_blank" rel="noreferrer">{pairing.origin}</a></p>
      <label>{t('mobile.code')}<input readOnly value={pairing.pairingCode} onFocus={event => event.currentTarget.select()} /></label>
      <p>{t('mobile.expires')} {formatTime(pairing.expiresAt, t)}</p>
      <button type="button" onClick={() => setPairing(undefined)}>{t('mobile.hide')}</button>
    </div>}
    {devices.length > 0 && <ul>{devices.map(device => <li key={device.deviceId}>
      {device.label} · {t(`mobile.${device.state}`)}
      <button type="button" disabled={busy || device.state === 'revoked'}
        onClick={() => { void run({ type: 'mobile_revoke', deviceId: device.deviceId }) }}>{t('mobile.revoke')}</button>
    </li>)}</ul>}
  </section>
}
