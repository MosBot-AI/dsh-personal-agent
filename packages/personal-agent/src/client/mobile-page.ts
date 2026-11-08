export function mobilePage(chinese: boolean): string {
  const title = chinese ? 'dshpa 移动工作台' : 'dshpa Mobile'
  return `<!doctype html>
<html lang="${chinese ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/mobile.css">
  <script src="/mobile.js" defer></script>
</head>
<body>
  <main>
    <header><p>dshpa</p><h1>${title}</h1></header>
    <p id="status" role="status">${chinese ? '正在连接…' : 'Connecting…'}</p>
    <form id="pair" hidden>
      <label for="code">${chinese ? '在本机工作台生成的配对码' : 'Pairing code from the local inbox'}</label>
      <input id="code" type="password" required maxlength="43" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button>${chinese ? '配对此设备' : 'Pair this device'}</button>
    </form>
    <section id="work" aria-labelledby="work-heading" hidden>
      <h2 id="work-heading">${chinese ? '任务' : 'Tasks'}</h2>
      <ul id="tasks"></ul>
    </section>
  </main>
</body>
</html>`
}

export const mobileStyles = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { margin: 0; color: CanvasText; background: Canvas; }
main { max-width: 42rem; margin: 0 auto; padding: 1.25rem; }
header > p { margin: 0; font-size: .9rem; opacity: .75; }
h1 { margin: .25rem 0 1rem; font-size: clamp(1.65rem, 7vw, 2.3rem); line-height: 1.2; }
h2 { font-size: 1.15rem; }
form { border: 1px solid GrayText; border-radius: .75rem; padding: 1rem; }
label, input, button { display: block; }
input, button { box-sizing: border-box; min-height: 44px; font: inherit; margin-top: .6rem; border: 1px solid GrayText; border-radius: .5rem; padding: .5rem .75rem; }
input { width: 100%; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }
ul { list-style: none; padding: 0; margin: 0; }
li { border: 1px solid GrayText; border-radius: .75rem; padding: .8rem; margin: .6rem 0; overflow-wrap: anywhere; }
li > p { margin: 0 0 .35rem; }
li > small { opacity: .78; }
[hidden] { display: none !important; }
`

function runMobilePage() {
  const chinese = document.documentElement.lang === 'zh-CN'
  const text = chinese ? {
    connected: '已连接', pairing: '请从本机工作台获取配对码。', rejected: '配对失败，请检查配对码是否有效。',
    reconnecting: '正在重新连接…', empty: '暂时没有任务。',
  } : {
    connected: 'Connected', pairing: 'Get a pairing code from the local inbox.', rejected: 'Pairing failed. Check that the code is valid.',
    reconnecting: 'Reconnecting…', empty: 'No tasks yet.',
  }
  const translations: Record<string, string> = {
    queued: '已排队', running: '运行中', waiting_input: '等待输入', waiting_approval: '等待审批',
    waiting_resource: '等待资源', waiting_event: '等待事件', waiting_environment: '等待环境', paused: '已暂停',
    blocked: '受阻', reconciliation_required: '等待核对', verifying: '正在验证', completed: '已完成',
    cancelling: '正在取消', cancelled: '已取消', failed: '失败',
  }
  const status = document.querySelector<HTMLParagraphElement>('#status')!
  const form = document.querySelector<HTMLFormElement>('#pair')!
  const code = document.querySelector<HTMLInputElement>('#code')!
  const work = document.querySelector<HTMLElement>('#work')!
  const tasks = document.querySelector<HTMLUListElement>('#tasks')!
  let stream: EventSource | undefined
  let pending: AbortController | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  function stop() {
    stream?.close()
    stream = undefined
    pending?.abort()
    pending = undefined
    clearTimeout(refreshTimer)
    refreshTimer = undefined
    work.hidden = true
    tasks.replaceChildren()
  }

  function showPairing(message = text.pairing) {
    stop()
    form.hidden = false
    status.textContent = message
  }

  function reconnect() {
    stop()
    form.hidden = true
    status.textContent = text.reconnecting
    refreshTimer = setTimeout(() => { void refresh() }, 1_500)
  }

  function follow(cursor: string | null) {
    const path = cursor ? '/v1/events?cursor=' + encodeURIComponent(cursor) : '/v1/events'
    const events = new EventSource(path)
    stream = events
    events.addEventListener('work', () => {
      if (stream !== events || refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh() }, 75)
    })
    events.addEventListener('session-ended', () => { if (stream === events) showPairing() })
    events.addEventListener('snapshot-required', () => {
      if (stream !== events) return
      stop()
      void refresh()
    })
    events.onerror = () => { if (stream === events) reconnect() }
  }

  async function refresh() {
    pending?.abort()
    const controller = new AbortController()
    pending = controller
    try {
      const response = await fetch('/v1/snapshot', { signal: controller.signal, cache: 'no-store' })
      if (controller.signal.aborted) return
      if (response.status === 401) { showPairing(); return }
      if (!response.ok) throw new Error()
      const snapshot = await response.json() as { cursor: string | null; tasks: { outcome: string; status: string }[] }
      if (controller.signal.aborted) return
      const rows = snapshot.tasks.map(task => {
        const row = document.createElement('li')
        const outcome = document.createElement('p')
        outcome.textContent = task.outcome
        const state = document.createElement('small')
        state.textContent = (chinese && translations[task.status]) || task.status.replaceAll('_', ' ')
        row.append(outcome, state)
        return row
      })
      if (rows.length === 0) {
        const empty = document.createElement('li')
        empty.textContent = text.empty
        rows.push(empty)
      }
      tasks.replaceChildren(...rows)
      form.hidden = true
      work.hidden = false
      status.textContent = text.connected
      if (!stream) follow(snapshot.cursor)
    } catch {
      if (!controller.signal.aborted) reconnect()
    } finally {
      if (pending === controller) pending = undefined
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault()
    const pairing = code.value.trim()
    code.value = ''
    const button = form.querySelector('button')!
    button.disabled = true
    try {
      const response = await fetch('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairing }), cache: 'no-store' })
      if (!response.ok) { showPairing(text.rejected); return }
      await refresh()
    } catch {
      showPairing(text.rejected)
    } finally {
      button.disabled = false
    }
  })
  window.addEventListener('pagehide', stop)
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh() })
  void refresh()
}

export const mobileScript = '(' + runMobilePage.toString() + ')()'
