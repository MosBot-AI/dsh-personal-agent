# PA-017 GitHub 草稿审批证据

[English](PA-017.md)

[PA-017](https://github.com/MosBot-AI/dsh-personal-agent/issues/18) · 计划 `2026-11-07-r7` · 实现提交 `2dcbaf009aa56cfda58fb745d906bb9493f63b67`。

本地验证于 2026-11-08 在 Asia/Shanghai 时区的 macOS arm64 上执行，使用 Node.js 26.7.0、pnpm 11.28.5 和 `@deepseek-ai/dsh@0.2.2-rc.1`。[配置](../../README-zh.md) · [授权契约](../03-contracts-security-and-tests-zh.md)

## 实现边界

- 显式配置的测试仓库、活跃的 dshpa 项目、GitHub 身份及基准分支定义唯一写入路径。所有者在临时裸 Git 工作区中准备一个 Markdown 文件。审批预览绑定仓库、基准与源分支及提交、标题、带标记正文、文件内容和 SHA-256 摘要。
- WorkStore 一并记录准确的效果和审批。发布使用一次性领取及只允许新建源分支的 Git lease。连接器在发布分支和创建草稿 PR 之间重新验证授权，并在调用固定草稿端点前核对当前基准及源提交。
- 只读对账根据不可变标记核对提供者账号、仓库、分支、提交 ID、标题和正文。唯一准确的结果生成提供者回执和封存任务产物。查无结果或有歧义时仍保持不确定。连接器不会自动重放或清理远端分支。
- 正常本地 Web 通道提供显式准备、审批、发布、撤权及查证。功能要求为配置的测试仓库单独加载 `DSHPA_GITHUB_WRITE_TOKEN`。[GitHub 草稿 PR API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request)

## 检查

| 检查 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm check` | 0 | 类型检查、Bundle 构建、248 项非 Web 测试及计划校验通过。 |
| 写入、授权、恢复及客户端针对性测试 | 0 | 41 项通过，专用真实测试跳过。 |
| `pnpm test:local-flow` | 0 | 十条原生 DSH Web 流程通过。草稿流程使用受控提供者，验证准确预览、审批、回执及结果验收。 |
| `pnpm test:resident` 和命名 SDK 冒烟测试 | 0 | 两条原生常驻流程通过，已安装的 SDK Bundle 正常加载及释放。 |
| 固定源码检查、协调测试及 `git diff --check` | 0 | 核对源码路径、12 项协调测试、双语链接和空白字符。 |
| 真实 GitHub 草稿与回读 | 待完成 | 尚未提供专用测试仓库和明确的测试专用授权。连接器未创建真实分支或草稿。 |

## 独立集成评审（2026-11-09）

独立基线为 PR #63 的 `d1c4afda73451aabe427b2d705a1418f7b662c48`；发布前重新核对了源提交。候选版本集成当前 main `c3c613391be888fffd3885fd955fadc30e337912`（含手机审批和媒体变更，数据库 schema v16）。处理了九个冲突文件，并保留两项功能。未新增数据库迁移或调整迁移编号。

异步授权检查现在记录实际审批响应者（`mobile ?? primary`）及其注册时间。仍有效的手机审批者可以授权；分支发布期间撤销该设备后，后续草稿创建会被阻止。隔离 Git 子进程保留显式代理和 CA 信任环境配置，同时排除其他凭据、任意 Git 配置和禁用 TLS 验证的选项。真实本地 Git 测试还在准备后修改远端源分支，验证仅允许新建分支的 lease 不会覆盖它。

环境：Debian GNU/Linux 13、Linux 6.12.111、x86_64；Node.js 24.14.1；pnpm 11.28.5；Chromium 154.0.8037.92；已安装的 `@deepseek-ai/dsh@0.2.2-rc.1`。原生测试使用一次性 Profile 和回环端点。在仓库根目录执行 `pnpm install --frozen-lockfile` 后运行以下命令。

| 准确命令 | 结果 |
| --- | --- |
| 在原始 PR 源提交上执行 `pnpm check` | 通过：248 项测试、类型检查、构建和计划校验。 |
| 在原始 PR 源提交上执行 `pnpm exec vitest run tests/e2e/local-flow.spec.ts tests/e2e/resident.spec.ts tests/e2e/github-live.spec.ts` | 通过：12 项原生测试；跳过一项真实写入测试。 |
| 在集成候选版本上执行 `pnpm check` | 通过：320 项测试、类型检查、构建和计划校验。 |
| `pnpm exec vitest run tests/connectors/github-write.spec.ts tests/connectors/github-branch-environment.spec.ts` | 通过：九项针对性测试，包含手机审批及撤销、凭据隔离、响应中断恢复和新建分支冲突保护。 |
| `DSHPA_CHROME_PATH=/usr/bin/chromium pnpm exec vitest run tests/e2e/local-flow.spec.ts tests/e2e/resident.spec.ts tests/e2e/media-host.spec.ts tests/e2e/mobile.spec.ts tests/e2e/github-live.spec.ts` | 通过：24 项原生测试（11 项本地 host、两项常驻、六项媒体 host、五项移动测试，其中三项使用真实桌面 Chromium）；跳过一项真实 GitHub 写入测试。桌面浏览器移动视口测试不能证明实体手机验收通过。 |
| `python3 -m unittest discover -s tests/coordination -p 'test_*.py'` | 通过：12 项测试。 |
| `python3 scripts/check_plan.py` 和 `git diff --check` | 通过。缺少本地上游源码检出目录，未执行 `--check-sources`。 |

首次集成类型检查因新增测试夹具使用未标记的设备 ID 而失败；修正夹具后，全量检查通过。离线依赖安装缺少已缓存的包策略元数据；保留冻结锁文件及策略检查，在线安装后成功。运行记录保留了失败及后续成功结果。

已连接的 GitHub 插件用于仓库评审和 PR 操作，其凭据不会暴露给 dshpa 宿主。未找到专用真实测试仓库，连接器的显式启用测试仍跳过；该测试明确拒绝使用 `MosBot-AI/dsh-personal-agent`。连接器未创建真实分支或草稿。当前环境的 GitHub CLI 未登录，插件也不提供 Project 操作，因此未能更新私有 Project 字段；进度记录在 Issue／PR 评论中。本次评审未执行实体手机、真实 GPU／ComfyUI 和休眠唤醒验收。用户知识库 `/Users/charleypeng/Documents/llmwiki` 不可用。

## 验收范围

| 场景 | 已验证的 PA-017 行为 |
| --- | --- |
| E05 | 本地测试覆盖准确载荷绑定、重复领取拒绝、授权过期，以及分支发布和草稿创建之间的撤权或取消。 |
| E06 | 受控提供者在响应中断前接受草稿。冷启动分类和准确查证记录回执，分支和 PR 均未重复写入。缺少回执的操作继续保持不确定。 |
| E10 | 真实读取部分见 [PA-016](PA-016-zh.md)。草稿创建及回读仍需提供明确的专用测试仓库授权，并显式执行测试。 |

草稿功能已具备本地审查证据。PA-017 保持审查中，等待真实测试验收。指定的用户知识库路径仍不可用。
