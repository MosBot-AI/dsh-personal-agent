# PA-022 移动设备与回放证据

[English](PA-022.md)

[PA-022](https://github.com/MosBot-AI/dsh-personal-agent/issues/23) · 计划 `2026-11-07-r7` · 设备与回放提交 `705776a39d8cb2039da5bd1116a79d68f2a3e04e`。

## 设备与回放

- WorkStore 生成与所有者和资料范围绑定的五分钟一次性配对码。注册成功时，以独立的三十天凭据摘要原子替换配对码摘要。数据库保存摘要和设备元数据。撤销或过期后，下次检查就会移除设备权限。备份恢复会清除恢复副本中的旧待配对和已注册凭据。
- 独立于传输层的事件源对每次快照和回放进行鉴权。它读取现有 WorkStore 中关联会话的任务，在范围内的游标后回放最多 128 条已提交事件。游标缺失、超出范围或过期时要求获取新快照。事件包含任务 ID、版本、状态和时间。快照省略会话标识、来源目的地、私有约束及产物。
- 固定版本的 DSH Web 连接将浏览器凭据映射为共享的 owner Peer。精确 Fetch 路由要求这个 owner Peer。现有收件箱还会将审批绑定到精确的客户端、设备和会话。后续需要独立的移动设备接入与显式审批移交。 [固定宿主证据](host-compatibility-zh.md) · [原生访问契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/remote-access/README.md)

## 移动 HTTP 与 Web

提交 `d833b4a21a49c56641ae1cda2a021d87b4cd76b6` 将账本与事件源接入可选的回环 HTTP 监听。独立 HTTPS 源地址由操作者的反向代理终止 TLS。上游校验 Host、Origin 和 Fetch Metadata，配对设置独立的 Secure、HttpOnly、SameSite=Strict Cookie。原生本机所有者通过待办面板生成配对码并撤销设备。

独立的响应式页面读取限定范围的快照并订阅 SSE。超出窗口的游标会要求获取新快照。事件流每次轮询都重新核验设备，设备撤销后关闭。移动监听仅提供自身的静态资源、配对、快照与事件路由。 [配置方法](../../README-zh.md#启用移动任务视图)

## 验证

2026-11-08（Asia/Shanghai）在本机运行。六个 PA-022 用例使用临时 SQLite WorkStore，覆盖一次性注册、拒绝跨资料范围访问、仅保存凭据摘要、过期、撤销已绑定身份、备份恢复、重开后在范围内回放及过期游标回退。这些是进程内服务测试。

- `pnpm check` 通过了 48 个测试套件中的 281 项测试。
- `pnpm test:mobile` 通过一个原生 DSH Web 集成用例。它以预期的代理请求头向隔离的回环移动监听发送真实 HTTP 请求，验证本机所有者配对、拒绝操作员、拒绝跨源及其他 Host、Cookie 属性、本机和移动端相同的任务 ID 与版本、SSE 回放及游标回退，以及撤销已打开的事件流。它也检查所提供的页面与浏览器脚本语法。测试通过请求头传入 Cookie，未涉及外部 TLS 代理或浏览器 Cookie 存储。
- 现有原生 Web 流程套件通过 10 个用例，常驻宿主套件通过两个用例。这些检查覆盖存储变更后的宿主回归。
- `python3 scripts/check_plan.py`、12 个协调测试及 `git diff --check` 通过。

## 待验收

移动只读界面具有部分 E07 和 E13 的回环网络证据。E05 还需通过移动传输层验证精确审批移交与响应。HTTPS 反向代理部署及实体手机浏览器验收仍待进行。
