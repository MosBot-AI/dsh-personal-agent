# Personal Agent Vue 客户端演示

[English](README.md) | 简体中文

此演示使用 Vue 3 和 Vite。在仓库根目录使用 Node.js 24.12 或更高版本运行。

```sh
npm --prefix .demo ci
npm --prefix .demo run dev
```

Vite 在 `http://127.0.0.1:5173/` 提供界面。要连接后端，请在后端的 HTTPS 源上提供构建后的 demo。

## 连接 DSH

1. 在现有本机 Web profile 中启用移动监听器，并配置其专用 HTTPS 反向代理。参见 [DSH 移动端设置](../README-zh.md#启用移动任务视图)。
2. 运行 `npm --prefix .demo run build`。在已配置的移动端 HTTPS 源上，将 `.demo/dist/` 作为静态文件挂载到 `/demo/`，使 `/demo/` 提供 `index.html`，`/demo/assets/` 提供构建资源。继续将 `/v1/*` 路由至移动端回环监听器。保留配置要求的 Host 和浏览器 Origin 请求头，并关闭 `/v1/events` 的代理缓冲。
3. 在浏览器打开 `/demo/`。若浏览器在此源上已有配对会话，能力发现会自动使用该会话。否则，打开 DSH 移动扩展开关，在本地所有者工作台的 **待办 → 移动访问** 中生成配对码，并在 demo 提交。
4. 要体验审批，在本地所有者工作台将一项确切的待审批请求分派给此设备。演示会显示审批预览，并提交所显示的版本、摘要及您选择的决定。审批回执记录决定，由受信任的协调器负责执行。

共享 API 部署使用相同的 `/v1` 路由，以及该源上由后端提供的认证会话。当前 Hermes 实现提供本地诊断，尚未注册共享 HTTP 路由。参见[共享客户端 API 状态](../docs/shared-client-api-zh.md)。

## API 覆盖范围

| 接口 | 路由 |
| --- | --- |
| 共享 REST API | `GET /v1/capabilities`、`GET /v1/tasks` |
| DSH 移动扩展 | `POST /v1/pair`、`GET /v1/snapshot`、`GET /v1/approvals`、`POST /v1/approvals/{id}/responses`、`GET /v1/events` |

任务分页由服务端声明的 `tasks.list` 能力控制，游标保持原样。游标过期或失效时，从第一页重新读取。DSH 扩展根据事件提示重新读取快照和分派给设备的审批。会话失效后清除已显示的私有数据，事件流中断后用新快照恢复连接。共享能力发现会显示不可用的操作及服务端提供的原因。

## 本地验证

构建后的演示在 Chromium 中通过固定证书的回环 HTTPS 反向代理连接到隔离的原生 DSH profile。测试覆盖配对、能力发现、任务分页及游标恢复、近期快照、确切审批的批准和拒绝、事件驱动刷新、重连和设备撤销。还检查了 390 px 视口下页面不会横向溢出。部署后的 HTTPS 和实体设备验收仍待完成。
