import type { InboxApproval } from '../inbox/protocol.js'

export function mobilePage(chinese: boolean): string {
  const title = chinese ? 'dshpa 移动工作台' : 'dshpa Mobile'
  return `<!doctype html>
<html lang="${chinese ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="manifest" href="/mobile.webmanifest">
  <link rel="icon" href="/mobile.svg" type="image/svg+xml">
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
    <section id="reviews" aria-labelledby="review-heading" hidden>
      <h2 id="review-heading">${chinese ? '待审批' : 'Approvals'}</h2>
      <p id="review-status" role="status"></p>
      <ul id="review-items"></ul>
    </section>
    <section id="work" aria-labelledby="work-heading" hidden>
      <h2 id="work-heading">${chinese ? '任务' : 'Tasks'}</h2>
      <button id="browse-tasks" type="button">${chinese ? '浏览全部任务' : 'Browse all tasks'}</button>
      <button id="recent-tasks" type="button" hidden>${chinese ? '最近任务' : 'Recent tasks'}</button>
      <p id="task-browse-status" role="status" hidden></p>
      <ul id="tasks"></ul>
      <div id="task-page-actions" hidden>
        <button id="task-next" type="button" disabled>${chinese ? '下一页' : 'Next page'}</button>
        <button id="task-restart" type="button">${chinese ? '从头开始' : 'Restart'}</button>
      </div>
    </section>
  </main>
</body>
</html>`
}

export const mobileManifest = JSON.stringify({
  name: 'dshpa Mobile', short_name: 'dshpa', start_url: '/', scope: '/', display: 'standalone',
  icons: [{ src: '/mobile.svg', sizes: 'any', type: 'image/svg+xml' }],
})

export const mobileIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#1d4ed8"/>
  <path d="M35 64l19 19 39-41" fill="none" stroke="white" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

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
.review-actions, #task-page-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
dl { margin: .65rem 0; }
dt { font-weight: 600; }
dd { margin: 0 0 .35rem; }
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
    approve: '批准此动作', deny: '拒绝此动作', recorded: '已记录审批答复。', changed: '审批已变化或不可用，请重新检查。',
    unconfirmed: '无法确认审批答复，请查看刷新后的审批。',
    loadingTasks: '正在加载任务…', taskBrowseFailed: '无法加载任务，请从头开始重试。',
    taskCursorExpired: '此任务页已过期，请从第一页重新开始。',
    tasksUnavailable: '暂时无法浏览全部任务。', tasksUnsupported: '此服务尚未提供全部任务浏览。',
    tasksDisabled: '全部任务浏览已停用，请联系服务管理员。',
    tasksIdentityUnavailable: '暂时无法验证任务浏览权限，请联系服务管理员。',
    tasksForbidden: '当前会话没有浏览全部任务的权限。',
    account: '账户', resource: '资源', recipient: '接收方', scope: '数据范围', digest: '载荷摘要', expires: '过期时间', preview: '完整载荷预览',
  } : {
    connected: 'Connected', pairing: 'Get a pairing code from the local inbox.', rejected: 'Pairing failed. Check that the code is valid.',
    reconnecting: 'Reconnecting…', empty: 'No tasks yet.',
    approve: 'Approve this action', deny: 'Deny this action', recorded: 'Review response recorded.', changed: 'The review changed or is unavailable. Check it again.',
    unconfirmed: 'Could not confirm the response. Check the refreshed review.',
    loadingTasks: 'Loading tasks…', taskBrowseFailed: 'Could not load tasks. Restart to try again.',
    taskCursorExpired: 'This task page expired. Restart from the first page.',
    tasksUnavailable: 'Browsing all tasks is currently unavailable.', tasksUnsupported: 'This service does not support browsing all tasks yet.',
    tasksDisabled: 'Task browsing is disabled. Contact the service operator.',
    tasksIdentityUnavailable: 'Task browsing cannot verify your identity. Contact the service operator.',
    tasksForbidden: 'This session does not have permission to browse all tasks.',
    account: 'Account', resource: 'Resource', recipient: 'Recipient', scope: 'Data scope', digest: 'Payload digest', expires: 'Expires', preview: 'Exact payload preview',
  }
  const translations: Record<string, string> = {
    queued: '已排队', running: '运行中', waiting_input: '等待输入', waiting_approval: '等待审批',
    waiting_resource: '等待资源', waiting_event: '等待事件', waiting_environment: '等待环境', paused: '已暂停',
    blocked: '受阻', reconciliation_required: '等待核对', verifying: '正在验证', completed: '已完成',
    cancelling: '正在取消', cancelled: '已取消', failed: '失败', waiting: '等待中', unknown: '未知',
    verification: '正在验证', input: '输入', approval: '审批', event: '事件', environment: '环境', resource: '资源',
    dependency: '依赖', cancellation_requested: '已请求取消',
  }
  const status = document.querySelector<HTMLParagraphElement>('#status')!
  const form = document.querySelector<HTMLFormElement>('#pair')!
  const code = document.querySelector<HTMLInputElement>('#code')!
  const work = document.querySelector<HTMLElement>('#work')!
  const tasks = document.querySelector<HTMLUListElement>('#tasks')!
  const browseTasks = document.querySelector<HTMLButtonElement>('#browse-tasks')!
  const recentTasks = document.querySelector<HTMLButtonElement>('#recent-tasks')!
  const taskBrowseStatus = document.querySelector<HTMLParagraphElement>('#task-browse-status')!
  const taskPageActions = document.querySelector<HTMLDivElement>('#task-page-actions')!
  const taskNext = document.querySelector<HTMLButtonElement>('#task-next')!
  const taskRestart = document.querySelector<HTMLButtonElement>('#task-restart')!
  const reviewSection = document.querySelector<HTMLElement>('#reviews')!
  const reviewStatus = document.querySelector<HTMLParagraphElement>('#review-status')!
  const reviewItems = document.querySelector<HTMLUListElement>('#review-items')!
  const replying = new Map<string, AbortController>()
  let stream: EventSource | undefined
  let streamDeadline: ReturnType<typeof setTimeout> | undefined
  let pending: AbortController | undefined
  let refreshAfterPending = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let browsingTasks = false
  let taskRequest: AbortController | undefined
  let nextTaskCursor: string | null = null
  const taskPageSize = 32
  const sharedSchemaVersion = 'personal.api.v1'
  const sharedTaskStates = new Set(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'unknown'])
  const taskAvailability: Record<string, string> = {
    not_implemented: text.tasksUnsupported,
    disabled: text.tasksDisabled,
    identity_unavailable: text.tasksIdentityUnavailable,
    permission_denied: text.tasksForbidden,
  }

  function leaveTaskBrowser() {
    taskRequest?.abort()
    taskRequest = undefined
    nextTaskCursor = null
    browsingTasks = false
    browseTasks.hidden = false
    recentTasks.hidden = true
    taskPageActions.hidden = true
    taskBrowseStatus.hidden = true
    taskBrowseStatus.textContent = ''
    taskNext.disabled = true
    tasks.replaceChildren()
  }

  function renderTasks(entries: readonly { title: string; state: string }[]) {
    const rows = entries.map(task => {
      const row = document.createElement('li')
      const title = document.createElement('p')
      title.textContent = task.title
      const state = document.createElement('small')
      state.textContent = task.state
      row.append(title, state)
      return row
    })
    if (rows.length === 0) {
      const empty = document.createElement('li')
      empty.textContent = text.empty
      rows.push(empty)
    }
    tasks.replaceChildren(...rows)
  }

  function displayTaskState(state: string): string {
    if (chinese && Object.hasOwn(translations, state)) return translations[state]!
    return state.replaceAll('_', ' ')
  }

  function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  }

  function sharedTask(value: unknown) {
    const task = asRecord(value)
    if (!task || typeof task.id !== 'string' || [...task.id].length < 1 || [...task.id].length > 256
      || typeof task.title !== 'string' || [...task.title].length > 4096
      || typeof task.revision !== 'string' || !/^[1-9][0-9]{0,19}$/.test(task.revision)
      || typeof task.state !== 'string' || !sharedTaskStates.has(task.state)
      || (task.wait_reason !== null && (typeof task.wait_reason !== 'string' || !task.wait_reason
        || [...task.wait_reason].length > 256))) {
      throw new Error('Invalid shared task')
    }
    const state = displayTaskState(task.state)
    return { title: task.title, state: task.wait_reason ? state + ' · ' + displayTaskState(task.wait_reason) : state }
  }

  async function readTaskData(path: string, controller: AbortController) {
    const response = await fetch(path, { signal: controller.signal, cache: 'no-store' })
    if (taskRequest !== controller) return
    if (controller.signal.aborted) throw new Error('Task request timed out')
    if (response.status === 401) { showPairing(); return }
    const payload = asRecord(await response.json())
    if (taskRequest !== controller) return
    if (controller.signal.aborted) throw new Error('Task request timed out')
    if (payload?.schema_version !== sharedSchemaVersion) throw new Error('Invalid shared response')
    if (response.ok) {
      const data = asRecord(payload.data)
      if (!data) throw new Error('Invalid shared response data')
      return data
    }
    const code = asRecord(payload.error)?.code
    if (response.status === 400 && code === 'cursor_invalid') taskBrowseStatus.textContent = text.taskCursorExpired
    else if (response.status === 409 && code === 'capability_unavailable') taskBrowseStatus.textContent = text.tasksUnavailable
    else if (response.status === 403 && code === 'forbidden') taskBrowseStatus.textContent = text.tasksForbidden
    else taskBrowseStatus.textContent = text.taskBrowseFailed
  }

  async function browseTaskPage(cursor: string | null) {
    if (work.hidden || document.hidden || taskRequest) return
    const controller = new AbortController()
    taskRequest = controller
    browsingTasks = true
    nextTaskCursor = null
    browseTasks.hidden = true
    recentTasks.hidden = false
    taskPageActions.hidden = false
    taskBrowseStatus.hidden = false
    taskBrowseStatus.textContent = text.loadingTasks
    taskNext.disabled = true
    taskRestart.disabled = true
    tasks.replaceChildren()
    const deadline = setTimeout(() => controller.abort(), 10_000)
    controller.signal.addEventListener('abort', () => clearTimeout(deadline), { once: true })
    try {
      if (cursor === null) {
        const discovery = await readTaskData('/v1/capabilities', controller)
        if (taskRequest !== controller) return
        if (!discovery) return
        if (discovery.contract_version !== '0.1.0' || !Array.isArray(discovery.capabilities)) {
          throw new Error('Invalid shared capability discovery')
        }
        const capability = discovery.capabilities.map(asRecord).find(item => item?.id === 'tasks.list')
        if (!capability || capability.supported !== true || capability.enabled !== true || capability.available !== true) {
          const reason = capability?.reason
          taskBrowseStatus.textContent = typeof reason === 'string' && Object.hasOwn(taskAvailability, reason)
            ? taskAvailability[reason]!
            : text.tasksUnavailable
          return
        }
      }

      const params = new URLSearchParams({ limit: String(taskPageSize) })
      if (cursor !== null) params.set('cursor', cursor)
      const page = await readTaskData('/v1/tasks?' + params, controller)
      if (taskRequest !== controller) return
      if (!page) return
      const continuation = page.next_cursor
      if (page.consistency !== 'live' || !Array.isArray(page.items) || page.items.length > taskPageSize
        || (continuation !== null && (typeof continuation !== 'string' || !continuation || [...continuation].length > 2048))) {
        throw new Error('Invalid shared task page')
      }
      renderTasks(page.items.map(sharedTask))
      nextTaskCursor = continuation
      taskBrowseStatus.textContent = ''
    } catch {
      if (taskRequest === controller) taskBrowseStatus.textContent = text.taskBrowseFailed
    } finally {
      clearTimeout(deadline)
      if (taskRequest === controller) {
        taskRequest = undefined
        taskNext.disabled = nextTaskCursor === null
        taskRestart.disabled = false
      }
    }
  }

  function resetView() {
    stream?.close()
    stream = undefined
    clearTimeout(streamDeadline)
    streamDeadline = undefined
    pending?.abort()
    pending = undefined
    refreshAfterPending = false
    clearTimeout(refreshTimer)
    refreshTimer = undefined
    work.hidden = true
    leaveTaskBrowser()
    reviewSection.hidden = true
    reviewItems.replaceChildren()
    reviewStatus.textContent = ''
  }

  function stop() {
    for (const controller of replying.values()) controller.abort()
    replying.clear()
    resetView()
  }

  function showPairing(message = text.pairing) {
    stop()
    form.hidden = false
    status.textContent = message
  }

  function reconnect() {
    resetView()
    form.hidden = true
    status.textContent = text.reconnecting
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, 1_500)
  }

  function follow(cursor: string | null) {
    const path = cursor ? '/v1/events?cursor=' + encodeURIComponent(cursor) : '/v1/events'
    const events = new EventSource(path)
    stream = events
    const expectStreamTraffic = () => {
      if (stream !== events) return
      clearTimeout(streamDeadline)
      // A proxy can stop forwarding data without closing the connection.
      streamDeadline = setTimeout(() => { if (stream === events) reconnect() }, 30_000)
    }
    expectStreamTraffic()
    events.addEventListener('open', expectStreamTraffic)
    events.addEventListener('heartbeat', expectStreamTraffic)
    const scheduleRefresh = () => {
      if (stream !== events) return
      expectStreamTraffic()
      if (pending) {
        refreshAfterPending = true
        return
      }
      if (refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        void refresh('event')
      }, 75)
    }
    events.addEventListener('work', scheduleRefresh)
    events.addEventListener('approvals', scheduleRefresh)
    events.addEventListener('session-ended', () => { if (stream === events) showPairing() })
    events.addEventListener('snapshot-required', () => {
      if (stream !== events) return
      resetView()
      void refresh()
    })
    events.onerror = () => { if (stream === events) reconnect() }
  }

  async function respond(approval: InboxApproval, decision: 'approve' | 'deny', controls: HTMLDivElement) {
    const requestId = approval.id
    if (replying.has(requestId)) return
    const controller = new AbortController()
    replying.set(requestId, controller)
    for (const button of controls.querySelectorAll('button')) button.disabled = true
    const deadline = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch('/v1/approvals/' + encodeURIComponent(requestId) + '/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({ expectedVersion: approval.version, digest: approval.digest, decision }),
      })
      if (replying.get(requestId) !== controller) return
      if (response.status === 401) { showPairing(); return }
      reviewStatus.textContent = response.ok ? text.recorded : text.changed
    } catch {
      if (replying.get(requestId) !== controller) return
      reviewStatus.textContent = text.unconfirmed
    } finally {
      clearTimeout(deadline)
      if (replying.get(requestId) === controller) replying.delete(requestId)
    }
    await refresh()
  }

  function renderReviews(approvals: readonly InboxApproval[]) {
    reviewItems.replaceChildren(...approvals.map(approval => {
      const row = document.createElement('li')
      const kind = document.createElement('strong')
      kind.textContent = approval.kind
      const fields = document.createElement('dl')
      const entries = [
        [text.account, approval.accountId], [text.resource, approval.resourceRef],
        [text.recipient, approval.recipient], [text.scope, approval.dataScope.join(', ')],
        [text.digest, approval.digest], [text.expires, new Date(approval.expiresAt).toLocaleString()],
      ]
      for (const [name, value] of entries) {
        if (!value) continue
        const label = document.createElement('dt')
        const field = document.createElement('dd')
        label.textContent = name!
        field.textContent = value
        fields.append(label, field)
      }
      const details = document.createElement('details')
      details.open = true
      const caption = document.createElement('summary')
      const preview = document.createElement('pre')
      caption.textContent = text.preview
      preview.textContent = approval.preview
      details.append(caption, preview)
      const controls = document.createElement('div')
      controls.className = 'review-actions'
      for (const decision of ['approve', 'deny'] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = text[decision]
        button.disabled = replying.has(approval.id) || Date.parse(approval.expiresAt) <= Date.now()
        button.onclick = () => { void respond(approval, decision, controls) }
        controls.append(button)
      }
      row.append(kind, fields, details, controls)
      return row
    }))
    reviewSection.hidden = approvals.length === 0 && !reviewStatus.textContent
  }

  async function refresh(source: 'direct' | 'event' = 'direct') {
    if (document.hidden) return
    if (source === 'event' && pending) {
      refreshAfterPending = true
      return
    }
    pending?.abort()
    refreshAfterPending = false
    const controller = new AbortController()
    pending = controller
    const deadline = setTimeout(() => {
      if (pending === controller) reconnect()
    }, 10_000)
    try {
      const request: RequestInit = { signal: controller.signal, cache: 'no-store' }
      const [response, reviews] = await Promise.all([fetch('/v1/snapshot', request), fetch('/v1/approvals', request)])
      if (controller.signal.aborted) return
      if (response.status === 401 || reviews.status === 401) { showPairing(); return }
      if (!response.ok || !reviews.ok) throw new Error()
      const snapshot = await response.json() as { cursor: string | null; tasks: { outcome: string; status: string }[] }
      const { approvals } = await reviews.json() as { approvals: InboxApproval[] }
      if (controller.signal.aborted) return
      renderReviews(approvals)
      if (!browsingTasks) {
        renderTasks(snapshot.tasks.map(task => ({ title: task.outcome, state: displayTaskState(task.status) })))
      }
      form.hidden = true
      work.hidden = false
      status.textContent = text.connected
      if (!stream) follow(snapshot.cursor)
    } catch {
      if (!controller.signal.aborted) reconnect()
    } finally {
      clearTimeout(deadline)
      if (pending === controller) {
        pending = undefined
        if (refreshAfterPending) void refresh()
      }
    }
  }

  browseTasks.onclick = taskRestart.onclick = () => { void browseTaskPage(null) }
  taskNext.onclick = () => { if (nextTaskCursor !== null) void browseTaskPage(nextTaskCursor) }
  recentTasks.onclick = () => {
    leaveTaskBrowser()
    void refresh('event')
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void refresh()
      return
    }
    stop()
    form.hidden = true
    status.textContent = text.reconnecting
  })
  window.addEventListener('pagehide', stop)
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh() })
  void refresh()
}

export const mobileScript = '(' + runMobilePage.toString() + ')()'
