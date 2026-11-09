# DSHPA 隔离 Chrome 提供者

[English](README.md)

此可选 Bundle 使用 DSH 的 `SessionResources`、限定作用域的 MCP 客户端及浏览器提供者注册和 Chrome DevTools MCP 1.9.0。每个获得所有者授权的任务 Session 会启动一个全新的无头 Chrome Profile，并启用结构化页面观察、显式页面 ID 和浏览器 URL 白名单。使用 Chrome 149 或更高版本。

将 Bundle 安装到 dshpa 所用的本地 Web Profile。

```sh
pnpm build
pnpm exec dsh plugin --profile dshpa-web add "link:$PWD/packages/browser-chrome"
```

在 Profile 覆盖文件中启用提供者，并列出此部署可访问的来源。

```yaml
- id: dshpa-browser-chrome
  disabled: false
  config:
    executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
    allowedOrigins:
      - https://example.com
```

在 dshpa 条目的 `config.inbox.desktop` 下添加任务目标。每个目标使用一个位于已批准来源下的精确起始 URL。

```yaml
desktop:
  browserProfiles:
    - id: example
      startUrl: https://example.com/
```

在**今日**选择浏览器目标，然后点击**授权并开始浏览器工作**。dshpa 在全新的隔离浏览器上下文中打开专用标签页，并将租约绑定到对应 Profile 和标签页。**暂停浏览器自动化**会阻止新的工具调用。继续时会打开新的隔离标签页并要求重新观察。

`allowedOrigins` 列出部署可用的目标，不会把所有目标的权限授予每个任务。浏览器启动前，可信宿主将确切的 Agent 活动实例绑定到所选来源和租约。MCP 进程只接收该来源作为网络白名单，覆盖 iframe、fetch、弹窗、重定向及普通导航。租约工具还将操作绑定到确切标签页和新观察。接管或租约失效会关闭所属 MCP 作用域。缺少提供者时，任务先进入等待，不向模型发送任务输入。它将顶层辅助功能树的有限投影发送给已配置的模型，只接受导航、观察、点击和填写操作。所属 Session 结束时清理浏览器状态。无限制代码执行需要独立且强制实施的操作系统隔离边界。

使用本机安装的 Chrome 可执行文件运行真实回环测试。

```sh
DSHPA_TEST_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm exec vitest run tests/e2e/browser-live.spec.ts tests/e2e/browser-multiorigin.spec.ts
```

[仓库 README](../../README-zh.md)
