# 11. GitHub Project 执行与进度协议

[文档索引](README-zh.md) · [English](11-github-project-workflow.md)

[项目看板：dshpa Implementation](https://github.com/orgs/MosBot-AI/projects/3) · [任务 Issues](https://github.com/MosBot-AI/dsh-personal-agent/issues)

## 1. 权威来源

GitHub Project Status 和 Issue 是执行进度的权威来源；仓库 `implementation-tasks.json` 保存范围、依赖、验收和计划快照，不能用其 planned 值覆盖正在执行的 GitHub 状态。`github-project.json` 只保存 Project/字段/选项/Issue/item 标识，不作为实时状态缓存。

43 个任务各有一个英文 Issue，使用稳定 PA ID；Issue 编号与 PA 编号不必相同。原生 blocked-by 和正文依赖链接同时存在。新增/拆分任务时先更新中英文计划和 manifest，再创建英文 Issue 并同步映射与原生依赖，禁止重复创建相同 PA ID。

Project 当前为私有，关联公开仓库。具备 Project 访问权限的成员/agent 可以协作；CLI 需要 repo 和 project 权限，不能因为仓库公开就推断 Project 可读。未修改其他项目，也未扩大项目可见性。

## 2. 状态与字段

| Status | 意义与退出条件 |
| --- | --- |
| Backlog | 尚未认领，前置任务未完成；这是正常依赖等待，不是故障 |
| Ready | 前置 Issue 已 completed，Project Done、验收确认标签且有证据；可以认领 |
| In progress | 已认领，存在 Execution agent、GitHub assignee 和认领评论 |
| Blocked | 执行中需要具体外部条件/决定；记录阻塞和解锁条件，后续解除后恢复 |
| In review | 可评审 PR 和证据已提供，等待评审/必要真实验收 |
| Done | 代码已合并，适用检查通过，结果已验证；Issue closed as completed、有 acceptance:verified 标签且 Evidence 有链接 |

Phase/Release 是原方案阶段及首次交付级别；Priority：基础 alpha 为 P0，桌面扩展为 P1，后续 beta/v1 为 P2。Execution agent 记录运行/聊天身份，assignee 记录真实 GitHub 账户，Evidence 指向 PR/证据文件，Last update 在真实进度改变时更新。

不得因 PR 被关闭未合并、Issue not-planned 或只有文档/模拟结果而标 Done。live-not-run 如果是必需验收，就保留 In review 或 Blocked，不关闭任务。任务取消需要记录理由并重审下游依赖，不能伪装完成。

## 3. 每个 agent 的执行流程

1. `git pull --ff-only` 更新工作区前先检查本地变更，不覆盖其他人的修改。阅读 AGENTS、当前 Issue、前置任务证据和相关文档。
2. 运行 `python3 scripts/project_ready.py --release desktop-alpha` 获取实时候选。该命令只读；若权限或网络失败就报错，不回退成“全部就绪”。
3. 选一个候选，再读一次最新评论、assignee、Execution agent 和 Status。无冲突后自分配、写英文 Claim 评论、填 Execution agent、设置 In progress 和 Last update。
4. 使用独立 `codex/pa-NNN-short-description` 分支/worktree，任务大小超出一项可评审改动时拆子 issue，并同步计划，不悄悄扩大范围。
5. 有意义的里程碑、阻塞或交接时写英文进度评论。没有变化不重复刷屏。进度报告关联实际 commit/PR/测试和剩余工作。
6. 按 Issue 的清单实施，写中英证据文件，打开英文 PR，并设置 In review。PR 链接 Issue；除非所有验收都能在合并时满足，否则不要提前使用自动关闭关键词。
7. 验证合并和验收后，填 Evidence、添加 `acceptance:verified`、关闭 Issue 为 completed、设置 Done，并检查直接下游是否满足 Ready 条件。保留结束记录和最终负责人，清理不会再使用的控制标记。

GitHub 字段更新不是原子锁。认领后立即重读；若同时有其他 agent 认领，后到者停止编辑并协商，不能抢占。长时间没更新不自动解除他人认领；先根据最后报告联系负责人或由用户明确交接。无人处理的 Blocked 不应自动重跑。

## 4. 英文报告模板

```text
Claim
- Agent/run: <chat or run ID>
- Branch/worktree: <name and location>
- Dependencies checked: <Issue and evidence links>
- Scope: <this work package>
- Next checkpoint: <observable milestone>
```

```text
Progress / Blocked / Ready for review / Completed
- Completed: <observable changes>
- Evidence: <commit, PR, artifacts, commands actually run>
- Remaining: <unchecked acceptance items>
- Blockers: <condition, responsible party, exact unblock condition or none>
- Next step: <action or explicit handoff>
```

不要写无依据完成百分比。认领不代表实现，提交不代表测试，合并也不自动证明真实设备/账户场景通过。

## 5. GitHub CLI 操作

```sh
gh project view 3 --owner MosBot-AI
gh project item-list 3 --owner MosBot-AI --limit 100 --format json
python3 scripts/project_ready.py --release desktop-alpha --json
gh issue view 1 --repo MosBot-AI/dsh-personal-agent --comments
```

更新前从 `docs/github-project.json` 读取该任务的真实 number、item_id 和对应字段/选项 ID。示例中 `1` 仅指首次 PA-001，其他任务不得照抄编号。

```sh
gh issue edit 1 --repo MosBot-AI/dsh-personal-agent --add-assignee @me
gh issue comment 1 --repo MosBot-AI/dsh-personal-agent --body-file /tmp/dshpa-progress.md
```

用 `gh project item-edit` 更新字段：传入映射中的 `--id`、`--project-id`、`--field-id`，按字段类型使用 `--single-select-option-id`、`--text` 或 `--date`。完整英文正文先写文件再用 `--body-file`，不要在 shell 中拼接未经转义的评论。

已添加两个 GitHub Actions workflow：`Validate implementation plan` 在 push/PR 校验计划与协作逻辑；`Reconcile implementation project` 在 Issue/PR 事件和手动触发时重新计算依赖状态。后者需要仓库 Secret `DSHPA_PROJECT_TOKEN`；未配置时明确报告 inactive，不执行 Project 写入。使用项目专用最小权限凭据，通过仓库 Secrets 页面或 `gh secret set DSHPA_PROJECT_TOKEN --repo MosBot-AI/dsh-personal-agent` 的安全输入配置，不在聊天中提供。

同步器把 completed + acceptance:verified + Evidence 的任务设为 Done，再提升已满足依赖的 Backlog；未验证关闭不算完成，依赖重新打开会阻塞已启动的下游。In progress、Blocked、In review 和负责人仍由 agent 按真实情况报告，不从评论自由文本推断。PR 事件触发核对，不凭合并自动认可验收。Issue 重新打开时，workflow 用仓库 GITHUB_TOKEN 移除旧 acceptance:verified 标签；重新验收后才能再添加。项目专用 Token 仍只需读取仓库 Issue，项目写入由其 Projects 权限负责。

`python3 scripts/project_sync.py` 默认只读预览，`--apply` 才写入。每次写前重新读取以减少竞争，但不保证原子认领。`project_ready.py` 包含尚未被提升但依赖已满足的 Backlog，并检查 completed + Done + acceptance:verified + Evidence；开始前仍须阅读证据内容。

## 6. 发布视图与维护

Delivery board 展示所有状态；Ready to start 展示 Ready；Desktop alpha 展示 alpha 和 desktop-alpha 首次交付工作；Needs attention 展示 Blocked/In review。实际发布依赖仍由 manifest 的传递闭包决定：PA-028 / PA-035 / PA-029 / PA-030 分别是四个发布门槛。

里程碑不承诺日期。不得用“关闭了多少 Issue”替代产品验收；不要求先完成 beta/v1 才交付桌面 alpha。维护范围变更时更新映射、原生依赖和 Issue 正文；日常进度只更新 Project/Issue，避免每次状态变化都产生仓库提交。
