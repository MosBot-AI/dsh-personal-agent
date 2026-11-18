import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ApiError, mobileApi, sharedApi } from './api.js'

export function describe(error) {
  if (!(error instanceof ApiError)) return '无法确认服务器响应。请检查网络后重新读取。'
  return [error.message, error.code, 'HTTP ' + error.status, error.retryable ? '可重试读取' : '']
    .filter(Boolean).join(' · ')
}

export function useWorkspace() {
  const extension = ref(false)
  const connection = ref('idle')
  const connectionError = ref('')
  const capabilities = ref(null)
  const taskPage = ref(null)
  const pageIndex = ref(0)
  const pageSize = ref(32)
  const taskBusy = ref(false)
  const taskError = ref('')
  const snapshot = ref(null)
  const approvals = ref([])
  const mobileBusy = ref(false)
  const mobileError = ref('')
  const approvalStatus = ref('')
  const responding = ref(null)
  const pairingCode = ref('')
  const pairing = ref(false)
  const live = ref('idle')
  const events = ref([])
  const canList = computed(() => capabilities.value?.capabilities.some(entry =>
    entry.id === 'tasks.list' && entry.supported && entry.enabled && entry.available) ?? false)

  let session
  let stream
  let deadline
  let reconnect
  let refreshAgain = false
  let approvalEpoch = 0

  function stopStream() {
    stream?.close()
    stream = undefined
    clearTimeout(deadline)
    clearTimeout(reconnect)
    refreshAgain = false
    live.value = 'idle'
  }

  function reset(next) {
    session?.abort()
    session = undefined
    stopStream()
    connection.value = next
    connectionError.value = ''
    capabilities.value = null
    taskPage.value = null
    pageIndex.value = 0
    taskBusy.value = false
    taskError.value = ''
    snapshot.value = null
    approvals.value = []
    mobileBusy.value = false
    mobileError.value = ''
    approvalStatus.value = ''
    responding.value = null
    pairingCode.value = ''
    pairing.value = false
    events.value = []
  }

  function endSession() {
    reset('auth')
    connectionError.value = '当前会话需要重新认证。'
  }

  async function connect() {
    if (document.hidden) return
    reset('connecting')
    const signal = (session = new AbortController()).signal
    try {
      const result = await sharedApi.discover(signal)
      if (signal.aborted) return
      capabilities.value = result
      connection.value = 'ready'
      if (extension.value) void refreshMobile()
    } catch (error) {
      if (signal.aborted) return
      if (error.status === 401) {
        endSession()
        return
      }
      connection.value = 'failed'
      connectionError.value = describe(error)
    }
  }

  async function pair() {
    if (pairing.value || !extension.value || connection.value !== 'auth') return
    const code = pairingCode.value.trim()
    if (!/^[\w-]{43}$/.test(code)) return
    pairingCode.value = ''
    pairing.value = true
    connectionError.value = ''
    const signal = (session = new AbortController()).signal
    try {
      await mobileApi.pair(code, signal)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError && error.status < 500) {
        connectionError.value = describe(error)
        pairing.value = false
        return
      }
      // A dropped response can still have set the browser's enrollment cookie.
    }
    if (!signal.aborted) await connect()
  }

  async function loadTasks(cursor = null) {
    if (!canList.value || taskBusy.value) return
    const { signal } = session
    taskError.value = ''
    taskBusy.value = true
    try {
      const page = await sharedApi.tasks(pageSize.value, cursor, signal)
      if (signal.aborted) return
      taskPage.value = page
      pageIndex.value = cursor === null ? 1 : pageIndex.value + 1
    } catch (error) {
      if (signal.aborted) return
      if (error.status === 401) {
        endSession()
        return
      }
      if (error.code === 'cursor_invalid' || error.code === 'capability_unavailable' || error.status === 403) {
        taskPage.value = null
        pageIndex.value = 0
      }
      taskError.value = error.code === 'cursor_invalid'
        ? '游标已失效。请从第一页重新读取。'
        : describe(error)
    } finally {
      if (!signal.aborted) taskBusy.value = false
    }
  }

  function follow(cursor) {
    const source = mobileApi.follow(cursor)
    stream = source
    live.value = 'connecting'

    function checkHeartbeat() {
      clearTimeout(deadline)
      deadline = setTimeout(() => recoverStream('heartbeat_timeout'), 30_000)
    }

    function recoverStream(reason) {
      if (stream !== source) return
      stopStream()
      addEvent(reason)
      taskPage.value = null
      pageIndex.value = 0
      snapshot.value = null
      approvals.value = []
      live.value = 'reconnecting'
      reconnect = setTimeout(refreshMobile, reason === 'snapshot-required' ? 0 : 1_500)
    }

    for (const type of ['open', 'heartbeat', 'work', 'approvals']) {
      source.addEventListener(type, () => {
        if (stream !== source) return
        checkHeartbeat()
        live.value = 'live'
        if (type === 'open' || type === 'work' || type === 'approvals') addEvent(type)
        if (type === 'work' || type === 'approvals') void refreshMobile()
      })
    }
    source.addEventListener('session-ended', () => {
      if (stream === source) endSession()
    })
    source.addEventListener('snapshot-required', () => recoverStream('snapshot-required'))
    source.onerror = () => recoverStream('disconnected')
    checkHeartbeat()
  }

  function addEvent(type) {
    events.value = [{ type, time: new Date() }, ...events.value].slice(0, 20)
  }

  async function refreshMobile() {
    if (!extension.value || connection.value !== 'ready') return false
    if (mobileBusy.value) {
      refreshAgain = true
      return false
    }
    clearTimeout(reconnect)
    const { signal } = session
    const epoch = approvalEpoch
    mobileBusy.value = true
    mobileError.value = ''
    try {
      const [current, reviews] = await Promise.all([mobileApi.snapshot(signal), mobileApi.approvals(signal)])
      if (signal.aborted) return false
      snapshot.value = current
      if (epoch === approvalEpoch) approvals.value = reviews.approvals
      if (!stream) follow(current.cursor)
      return true
    } catch (error) {
      if (signal.aborted) return false
      if (error.status === 401) {
        endSession()
        return false
      }
      const recovering = live.value === 'reconnecting' || stream !== undefined
      stopStream()
      snapshot.value = null
      approvals.value = []
      mobileError.value = describe(error)
      if (recovering && (error.status === undefined || error.status >= 500)) {
        live.value = 'reconnecting'
        reconnect = setTimeout(refreshMobile, 3_000)
      }
      return false
    } finally {
      if (!signal.aborted) {
        mobileBusy.value = false
        if (refreshAgain) {
          refreshAgain = false
          void refreshMobile()
        }
      }
    }
  }

  async function respond(approval, decision) {
    if (responding.value || mobileBusy.value || !approvals.value.includes(approval) || Date.parse(approval.expiresAt) <= Date.now()) return
    const { signal } = session
    responding.value = approval.id
    approvalStatus.value = ''
    try {
      const { status } = await mobileApi.respond(approval, decision, signal)
      if (signal.aborted) return
      approvalStatus.value = status === 'approved' ? '已记录批准。' : '已记录拒绝。'
    } catch (error) {
      if (signal.aborted) return
      if (error.status === 401) {
        endSession()
        return
      }
      approvalStatus.value = '审批回执未确认。' + describe(error)
    } finally {
      if (!signal.aborted) {
        approvalEpoch++
        // Remove the old review until the next authenticated read supplies the current fence.
        approvals.value = approvals.value.filter(entry => entry.id !== approval.id)
        await refreshMobile()
        if (!signal.aborted) responding.value = null
      }
    }
  }

  watch(pageSize, () => {
    taskPage.value = null
    pageIndex.value = 0
    taskError.value = ''
  })
  watch(extension, () => { if (connection.value !== 'idle') void connect() })

  function visibilityChanged() {
    if (document.hidden) reset('paused')
    else if (connection.value === 'paused') void connect()
  }

  function pageHidden() { reset('paused') }
  function pageShown(event) { if (event.persisted) void connect() }

  onMounted(() => {
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('pagehide', pageHidden)
    window.addEventListener('pageshow', pageShown)
    if (location.protocol === 'https:') void connect()
  })
  onUnmounted(() => {
    reset('idle')
    document.removeEventListener('visibilitychange', visibilityChanged)
    window.removeEventListener('pagehide', pageHidden)
    window.removeEventListener('pageshow', pageShown)
  })

  return {
    extension, connection, connectionError, capabilities, taskPage, pageIndex, pageSize,
    taskBusy, taskError, snapshot, approvals, mobileBusy, mobileError, approvalStatus, responding,
    pairingCode, pairing, live, events, canList, connect, pair, loadTasks, refreshMobile, respond,
  }
}
