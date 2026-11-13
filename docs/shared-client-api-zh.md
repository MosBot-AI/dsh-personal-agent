# 统一个人 Agent 客户端 API

[English](shared-client-api.md) | 简体中文

## 状态与权威来源

用户要求手机和电脑客户端使用同一套 REST 契约，并可选择 Hermes 或 DSH 作为后端。DSH 主线已包含**经过认证的协议发现与实时任务分页**。部署 HTTPS 和实体手机验收仍由 [PA-022](https://github.com/MosBot-AI/dsh-personal-agent/issues/23) 跟踪。

0.1.0 契约的唯一权威来源是 `MosBot-AI/hermes-superagent/contracts/personal-api`。本仓库在 `contracts/personal-api` 中保存完全一致的 JSON Schema、OpenAPI 描述、测试夹具和摘要清单。来源锁文件固定到权威提交 `48a930a2c01b2add9e349cbc1f0d65278066cc1c`。固定的文件与 Hermes 已合并的契约逐字节一致。[Hermes PR #100](https://github.com/MosBot-AI/hermes-superagent/pull/100)

必须先修改权威来源，独立审查后同步更新固定版本和复制的字节，再执行两端适配器的一致性测试。不得为了迁就某个实现而单独修改复制的 Schema。0.1.0 尚未稳定。破坏性协议改动需要为 `/v1` 适配器和客户端明确协调迁移。

## 已实现行为

- `GET /v1/capabilities` 使用已有移动设备 Cookie、严格 Host/Origin 检查、撤销机制和 no-store 响应。它返回统一的 `personal.api.v1` 信封、契约版本、用于诊断的后端 ID、能力、传输和限制。客户端应依据能力，而不是按后端名称分支。
- 配置好的移动监听器上 `tasks.list` 标为 supported、enabled、available；另外六项仍为 `reason:not_implemented`。已有原生或旧版移动功能不能证明新的统一操作已经存在。
- `GET /v1/tasks` 每次重新验证当前设备，返回最多 `limit` 条任务（1–64，默认32）、`next_cursor` 或 null，以及 `consistency:live`。每次数据库查询都限定可信 owner/profile 和绑定对话的任务，与既有移动可见范围相同。拒绝重复/未知参数。只返回五个共享任务字段，不输出私有约束、项目引用、凭据或原始目的地。
- 公共错误区分认证（401）、来源被拒（403）、请求无效（400）、能力不可用（409）和暂时服务故障（503）。不返回凭据、原生会话或来源目的地。
- 可轮询普通 JSON 发现接口。`transport.polling:true` 不代表已有领域变更流：`changes.poll` 仍不可用。尽管不变的旧版 `/v1/events` 使用 SSE，统一 SSE 仍为 false。
- 任务预期结果最多为 4,096 个 Unicode 码点时，共享任务 `title` 返回全文。更长的预期结果返回前 4,095 个码点，末尾加上 `…`（U+2026）。存储保留完整的预期结果，旧版任务快照也返回全文。
- 严格任务投影将原生状态映射到统一状态。正在取消仍为等待，需要对账仍为未知，绝不映射为已完成或已取消。ID 无效、记录格式错误或数值版本超出安全范围时，投影失败。这些是记录中的任务状态，不是 worker 仍运行或外部效果已完成的证明。

配对、旧版任务快照、审批交接/响应和旧版 SSE 保留现有路由及语义。未引入替代登录签发器、令牌转发、通用工具执行、外部写入或新监听端口。移动监听器仍需显式启用，并使用操作者配置的 HTTPS 反向代理。

OpenAPI 的 `backendSession` Cookie 绑定仅描述当前已实现的 DSH HTTP 适配器，不是新签发器，也不表示 Hermes 使用同名 Cookie。客户端使用正常的 Cookie 容器，业务行为不得按后端品牌分支。

## 实时分页语义

任务页按 SQLite 二进制任务 ID 排序。后续页查询沿此顺序直接定位到锚点 ID 之后，应用相同的所有者、Profile 和对话可见性过滤条件。游标前新增的任务需要从头扫描才能看到，游标后新增的任务可以出现在后续页；更新实时读取，删除锚点不影响排序。null 表示当前查询到达末尾，不保证以后没有新任务。

客户端应把游标当作不透明令牌。HMAC 将其绑定到可信 owner/profile、已注册设备和 feed 实例。篡改、另一设备或重启返回 `cursor_invalid`（400），客户端应清除游标重试；撤权/到期即使带旧游标也返回 `auth_required`（401）。游标没有认证权限，永不作为 SQL 作用域。没有新增凭据、持久秘密或签发方。分页 SQL 最多返回 65 行。所请求的页面中若有无效记录，响应返回通用 `internal_unavailable`（503）。

## 后续切片与兼容性差距

1. 在部署 HTTPS 和实体手机上验收共享任务分页。旧 64 条 snapshot 保持独立，不作为共享集合。
2. 适配审批、操作和可轮询的持久变更流，保留精确一次性授权、版本检查、撤销和结果未知时的对账语义。
3. 会话续接和记忆必须通过已有原生所有者/运行时边界适配。每项操作在具备已验证的适配器及安全/恢复证据前，都必须保持能力不可用。
4. Hermes 验证原生 HTTP 主体并注册共享路由后，用同一套客户端契约测试验证两端。[Hermes 身份 #29](https://github.com/MosBot-AI/hermes-superagent/issues/29) · [Hermes 领域 API #30](https://github.com/MosBot-AI/hermes-superagent/issues/30)

## 验证

`tests/api/shared-client.spec.ts` 将纯函数的不可用发现/错误输出与权威夹具精确比较，并验证实际 HTTP 任务可用状态及分页响应，验证复制文件的 SHA-256 摘要，覆盖所有原生任务状态映射，并通过真实回环 HTTP 验证认证、拒绝配对码作为凭据、设备撤销、严格 Host/Origin 和查询参数拒绝。`tests/api/remote.spec.ts` 保留旧版设备/回放覆盖。

分页测试还覆盖超过 64 条任务、精确公共字段、所有者和 Profile 隔离、隐藏任务、跨设备和篡改游标、重启后游标失效、撤销以及实时插入顺序。夹具使用隔离的本地状态。实体手机、外部部署的 HTTPS 来源和经认证的 Hermes HTTP 仍分别需要验收证据。

原生移动端套件还通过经过证书验证的回环 HTTPS 代理，在构建后的收件箱上检查两条共享路由。配对设备发现 `tasks.list`，从原生 WorkStore 读取两页任务，每页一项。所有者撤销设备后，原设备重用游标时收到 `auth_required`。另一台已注册设备也无法使用该游标。这项本地检查通过 `pnpm test:mobile` 运行。[原生 HTTPS 覆盖 #119](https://github.com/MosBot-AI/dsh-personal-agent/issues/119)

- [能力发现 #79](https://github.com/MosBot-AI/dsh-personal-agent/pull/79) 已合入，提交为 `3900cf4406caef7f15af69d09c9b6840255ce670`。能力发现分支通过了 14 项专项 API 测试。早期全量套件的失败和未运行的原生浏览器阶段均记录在 PR 中。
- [任务分页 #81](https://github.com/MosBot-AI/dsh-personal-agent/pull/81) 已合入，提交为 `ffbfa1bae6b147e19458269a662337e0d06c24f7`。最终整合版本通过了 19 项专项 API 测试、8 项原生 Chromium 用例、类型检查、构建、12 项协调测试和计划校验。PR 工作流在 Chrome 启动超时后重跑通过，合并提交的主线工作流首轮通过。[整合证据](https://github.com/MosBot-AI/dsh-personal-agent/issues/23#issuecomment-6846471838) · [PR CI](https://github.com/MosBot-AI/dsh-personal-agent/actions/runs/43381473515) · [主线 CI](https://github.com/MosBot-AI/dsh-personal-agent/actions/runs/43382599557)
