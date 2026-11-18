<script setup>
import { computed, ref } from 'vue'
import { useWorkspace } from './useWorkspace.js'

const {
  extension, connection, connectionError, capabilities, taskPage, pageIndex, pageSize,
  taskBusy, taskError, snapshot, approvals, mobileBusy, mobileError, approvalStatus, responding,
  pairingCode, pairing, live, events, canList, connect, pair, loadTasks, refreshMobile, respond,
} = useWorkspace()

const sections = [
  { id: 'capabilities', title: '能力发现', route: 'GET /v1/capabilities' },
  { id: 'tasks', title: '任务列表', route: 'GET /v1/tasks' },
  { id: 'snapshot', title: '近期快照', route: 'GET /v1/snapshot' },
  { id: 'approvals', title: '待处理审批', route: 'GET /v1/approvals' },
  { id: 'events', title: '实时事件', route: 'GET /v1/events' },
]
const section = ref('capabilities')
const current = computed(() => sections.find(item => item.id === section.value))
const sharedSection = computed(() => section.value === 'capabilities' || section.value === 'tasks')
const available = computed(() => capabilities.value?.capabilities.filter(item => item.available).length ?? 0)
const validCode = computed(() => /^[\w-]{43}$/.test(pairingCode.value.trim()))
const connectionLabels = {
  idle: '未连接', connecting: '正在连接', ready: '已连接',
  auth: '需要认证', failed: '连接失败', paused: '已暂停',
}
const stateLabels = {
  queued: '排队中', running: '进行中', waiting: '等待中', paused: '已暂停',
  completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '未知',
}
const reasonLabels = {
  not_implemented: '尚未实现', identity_unavailable: '当前身份不可用',
  disabled: '已禁用', permission_denied: '权限不足',
}
const liveLabels = { idle: '未订阅', connecting: '正在订阅', live: '接收中', reconnecting: '正在重连' }
const eventLabels = {
  open: '流已连接', approvals: '审批已变更', work: '任务已变更',
  'snapshot-required': '需要重新读取快照', disconnected: '事件流已断开', heartbeat_timeout: '事件流心跳超时',
}
</script>

<template>
  <div class="workspace">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">PA</span>
        <div><strong>Personal Agent</strong><span>API 工作台</span></div>
      </div>

      <nav aria-label="接口页面">
        <div class="nav-group">
          <p>共享 API</p>
          <button v-for="item in sections.slice(0, 2)" :key="item.id"
            type="button" :aria-current="section === item.id ? 'page' : undefined" @click="section = item.id">
            <span>{{ item.title }}</span><span class="nav-arrow" aria-hidden="true">›</span>
          </button>
        </div>
        <div class="nav-group">
          <p>DSH 移动扩展</p>
          <button v-for="item in sections.slice(2)" :key="item.id"
            type="button" :aria-current="section === item.id ? 'page' : undefined" @click="section = item.id">
            <span>{{ item.title }}</span><span class="nav-arrow" aria-hidden="true">›</span>
          </button>
        </div>
      </nav>
      <label class="extension">
        <input v-model="extension" type="checkbox" role="switch">
        <span>启用 DSH 移动扩展</span>
      </label>
    </aside>

    <main>
      <header class="toolbar">
        <span class="connection" :data-state="connection" role="status">{{ connectionLabels[connection] }}</span>
        <button type="button" :disabled="connection === 'connecting' || pairing || responding !== null" @click="connect">
          {{ connection === 'ready' ? '重新发现' : '连接当前站点' }}
        </button>
      </header>

      <div class="content">
        <header class="page-heading">
          <div>
            <span class="section-label">{{ sharedSection ? '共享 API' : 'DSH 移动扩展' }}</span>
            <h1>{{ current.title }}</h1>
          </div>
          <code class="route">{{ current.route }}</code>
        </header>

        <p v-if="connectionError" class="notice" role="status">{{ connectionError }}</p>

        <section v-if="connection === 'auth' && extension" class="panel empty">
          <h2>配对此浏览器</h2>
          <p>在 DSH 本机工作台生成配对码，然后在此提交。</p>
          <form class="pair-form" @submit.prevent="pair">
            <label for="pairing-code">一次性配对码</label>
            <div class="action-row">
              <input id="pairing-code" v-model="pairingCode" type="password" autocomplete="off"
                spellcheck="false" :disabled="pairing" required>
              <button type="submit" class="primary" :disabled="pairing || !validCode">
                {{ pairing ? '正在配对' : '配对设备' }}
              </button>
            </div>
          </form>
        </section>

        <section v-else-if="connection !== 'ready'" class="panel empty">
          <h2>{{ connection === 'auth' ? '需要有效的后端会话' : '连接 Personal Agent' }}</h2>
          <p v-if="connection === 'auth'">通过当前后端登录。使用 DSH 时，可启用移动扩展并在这里配对。</p>
          <p v-else>将 demo 放在后端的同一 HTTPS 站点，或打开已配置的 demo 地址，然后连接。</p>
        </section>

        <template v-else-if="section === 'capabilities'">
          <dl class="summary">
            <div><dt>后端</dt><dd>{{ capabilities.backend.id.toUpperCase() }}</dd></div>
            <div><dt>契约版本</dt><dd>{{ capabilities.contract_version }}</dd></div>
            <div><dt>可用能力</dt><dd>{{ available }} / {{ capabilities.capabilities.length }}</dd></div>
            <div><dt>共享传输</dt><dd>{{ [capabilities.transport.polling ? '轮询' : '', capabilities.transport.sse ? 'SSE' : ''].filter(Boolean).join(' / ') || '未开放' }}</dd></div>
          </dl>
          <section class="panel table-wrap" aria-label="共享能力清单">
            <table>
              <thead><tr><th scope="col">能力</th><th scope="col">支持</th><th scope="col">启用</th><th scope="col">可用</th><th scope="col">原因 / 处理方式</th></tr></thead>
              <tbody>
                <tr v-for="entry in capabilities.capabilities" :key="entry.id">
                  <th scope="row"><code>{{ entry.id }}</code></th>
                  <td>{{ entry.supported ? '是' : '否' }}</td>
                  <td>{{ entry.enabled ? '是' : '否' }}</td>
                  <td><span class="tag" :class="{ good: entry.available }">{{ entry.available ? '可用' : '不可用' }}</span></td>
                  <td>
                    {{ reasonLabels[entry.reason] ?? '—' }}
                    <small v-if="entry.remediation">{{ entry.remediation.message }}</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>

        <template v-else-if="section === 'tasks'">
          <section v-if="!canList" class="panel empty">
            <h2>当前会话无法列出任务</h2>
            <p>可在能力发现查看 <code>tasks.list</code> 的状态和原因。</p>
          </section>
          <template v-else>
            <div class="task-controls">
              <label>每页条数 <input v-model.number="pageSize" type="number" min="1"
                :max="capabilities.limits.max_page_size" :disabled="taskBusy"></label>
              <button class="primary" type="button"
                :disabled="taskBusy || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > capabilities.limits.max_page_size"
                @click="loadTasks()">{{ taskPage ? '从第一页重读' : '读取第一页' }}</button>
              <button type="button" :disabled="taskBusy || !taskPage?.next_cursor"
                @click="loadTasks(taskPage.next_cursor)">下一页</button>
            </div>
            <p class="notice" v-if="taskError" role="status">{{ taskError }}</p>
            <section class="panel" aria-label="任务结果" :aria-busy="taskBusy">
              <div class="panel-title" v-if="taskPage"><strong>第 {{ pageIndex }} 页</strong><span>{{ taskPage.items.length }} 条 · 实时分页</span></div>
              <ul class="rows" v-if="taskPage?.items.length">
                <li v-for="task in taskPage.items" :key="task.id">
                  <div><strong>{{ task.title }}</strong><small>{{ task.id }} · 修订 {{ task.revision }}</small>
                    <small v-if="task.wait_reason">{{ task.wait_reason }}</small></div>
                  <span class="tag" :class="{ good: task.state === 'completed' }">{{ stateLabels[task.state] }}</span>
                </li>
              </ul>
              <p v-else class="empty">{{ taskBusy ? '正在读取任务…' : taskPage ? '此页没有任务。' : '读取第一页以开始浏览。' }}</p>
            </section>
          </template>
        </template>

        <section v-else-if="!extension" class="panel empty">
          <h2>启用 DSH 移动扩展</h2>
          <p>使用支持这些移动接口的站点，访问快照、审批和实时事件。</p>
          <button type="button" class="primary" @click="extension = true">启用扩展</button>
        </section>

        <template v-else>
          <div class="task-controls">
            <span class="tag" :class="{ good: live === 'live' }">{{ liveLabels[live] }}</span>
            <button type="button" :disabled="mobileBusy" @click="refreshMobile">重新读取</button>
          </div>
          <p class="notice" v-if="mobileError" role="status">{{ mobileError }}</p>
          <section v-if="section === 'snapshot'" class="panel" :aria-busy="mobileBusy">
            <ul v-if="snapshot?.tasks.length" class="rows">
              <li v-for="task in snapshot.tasks" :key="task.id">
                <div><strong>{{ task.outcome }}</strong><small>{{ task.id }} · {{ task.projectId }} · 版本 {{ task.version }}</small></div>
                <span class="tag">{{ stateLabels[task.status] ?? task.status }}</span>
              </li>
            </ul>
            <p v-else class="empty">{{ mobileBusy ? '正在读取…' : snapshot ? '没有近期任务。' : '等待任务快照。' }}</p>
          </section>

          <section v-else-if="section === 'approvals'" :aria-busy="mobileBusy">
            <p v-if="approvalStatus" class="notice" role="status">{{ approvalStatus }}</p>
            <p v-if="!approvals.length" class="panel empty">{{ mobileBusy ? '正在读取…' : '当前没有可处理的审批。' }}</p>
            <article v-for="entry in approvals" :key="entry.id" class="panel approval">
              <header><h2>{{ entry.kind }}</h2><small>任务 {{ entry.taskId }} · 版本 {{ entry.version }}</small></header>
              <dl>
                <dt>账户</dt><dd>{{ entry.accountId }}</dd>
                <dt>资源</dt><dd>{{ entry.resourceRef }}</dd>
                <template v-if="entry.recipient"><dt>接收方</dt><dd>{{ entry.recipient }}</dd></template>
                <dt>数据范围</dt><dd>{{ entry.dataScope.join('、') || '—' }}</dd>
                <dt>摘要</dt><dd><code>{{ entry.digest }}</code></dd>
                <dt>有效期至</dt><dd>{{ new Date(entry.expiresAt).toLocaleString() }}</dd>
              </dl>
              <details open><summary>操作预览</summary><pre>{{ entry.preview }}</pre></details>
              <div class="action-row">
                <button type="button" :disabled="mobileBusy || responding !== null || Date.parse(entry.expiresAt) <= Date.now()"
                  @click="respond(entry, 'deny')">拒绝</button>
                <button type="button" class="primary" :disabled="mobileBusy || responding !== null || Date.parse(entry.expiresAt) <= Date.now()"
                  @click="respond(entry, 'approve')">批准</button>
              </div>
            </article>
          </section>

          <section v-else class="panel" aria-label="最近事件">
            <ul v-if="events.length" class="rows">
              <li v-for="(event, index) in events" :key="index">
                <div><strong>{{ eventLabels[event.type] }}</strong><small><code>{{ event.type }}</code></small></div>
                <time :datetime="event.time.toISOString()">{{ event.time.toLocaleTimeString() }}</time>
              </li>
            </ul>
            <p v-else class="empty">等待事件流连接。</p>
          </section>
        </template>
      </div>
    </main>
  </div>
</template>
