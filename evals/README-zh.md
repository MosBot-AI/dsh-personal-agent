# 基础工作流结果的人工评分

[English](README.md) · [PA-027 证据](../docs/evidence/PA-027-zh.md)

固定样本覆盖六类已安装的 alpha 工作流，每类独立执行五次。各轮使用同一套合成用例输入。先采集结果，再逐项查看证据并填写人工评分。

## 采集样本

使用装有 Git、Bubblewrap、Node.js 和 pnpm 的 Linux，以及经过校验的 alpha 归档。从本地密钥存储加载获授权的 `DEEPSEEK_API_KEY`。每次真实模型执行均使用现有用例的供应商限额。提醒使用无密钥模式。采集器为每个用例启动一个全新的安装 Profile。

```sh
pnpm build
node evals/runner.ts collect "$archives" "$output"
node evals/runner.ts report "$output"
```

将 `archives` 设为[安装证据](../docs/evidence/PA-028-zh.md)记录的归档目录，将 `output` 设为一个尚不存在的绝对路径，例如 `.dshpa` 下的新目录。采集器生成索引 `review.md`、执行台账 `batch.json` 和未评分的 `scores.json`。每个用例各有一份日志。产物文件包含该用例的实际输入和探针成功取得的结果。生成文件保存在本地临时目录。

## 审查结果

打开 `review.md`，依据适用的用例和实际产物逐项审查。在 `scores.json` 中将自己的名字或账号填入 `reviewer`。结果正确、可读且满足原任务用途时，把该项从 `pending` 改为 `accepted`。拒绝时填 `rejected`，将 `reason` 设为 `execution`、`accuracy`、`usability`、`recovery` 或 `other`，并在 `note` 描述具体问题。

| 工作流 | 审查要点 |
| --- | --- |
| 项目简报 | 澄清问题聚焦缺失的受众及启动日期。最终简报使用回答，保留套件数量和报名截止日期。 |
| 研究 | 两项对照均引用精确的当前来源版本和事实。推荐符合容量与费用限制。 |
| 提醒 | 修改后的提醒保留新时间和消息，在错过唤醒后只送达一次。 |
| 评审 | 三份决定及理由均遵循规则。复用模板根据所提供字段生成可读的新评审。 |
| 代码 | 补丁修复零值读数用例、保留其他行为，且只修改指定文件。查看采集到的测试输出。 |
| 文档与数据整理 | 表格可作为 CSV 使用，遵循最新记录取值规则，保留正确的来源文件名并明确标出未知位置。 |

用例失败也计入样本。查看日志和已有产物，按观察到的原因记录拒绝。评分后再次运行 `report`，查看待评分用例、各工作流的用例失败和人工拒绝原因。只有所有计划用例都完成执行并记录人工决定后，才计算验收率并判断是否达到 80% 目标。样本使用脚本交互，每类工作流覆盖一个合成场景。七天所有者试用单独跟踪。

## 运行所有者试用

选一个新的本地目录，以及[固定版本的三份 alpha 归档](../docs/evidence/PA-028-zh.md#本地-alpha-归档)。在仓库根目录准备独立的 DSH Web Profile，并在回环地址上启动常驻进程。

```sh
pnpm install --frozen-lockfile
mkdir -p "$PWD/.dshpa"
trial="$PWD/.dshpa/alpha-trial"
node evals/owner-trial.ts prepare "$trial" "$archives"
sh deploy/run-resident.sh "$(command -v node)" "$trial/home" dshpa-alpha-trial "$trial/resident.yml" 0
```

如需执行模型任务，在启动常驻进程前，在生成的 overlay 中配置已授权的原生模型路由和限额。由所有者决定纳入试用的工作和能力。[Worker 配置](../README-zh.md#打开本地-web-收件箱) · [预算限额](../README-zh.md#设置计算与通知限额) · [常驻运行说明](../docs/operations-zh.md)

在第二个终端将 `trial` 设为相同的绝对路径。在浏览器打开私有所有者链接，准备好后主动开始试用。启动日志命令验证常驻进程已经就绪，并记录实际安装的归档标识、宿主与运行时版本、初始进程实例和起始时间。一次性演练使用 `start "$trial" rehearsal`。

```sh
trial="$PWD/.dshpa/alpha-trial"
node deploy/ops.mjs owner-url "$trial/home/trial-state"
node evals/owner-trial.ts start "$trial" owner
node evals/owner-trial.ts status "$trial"
```

从记录的起始时间开始，在连续七个 24 小时时段内用 alpha 做自己的工作。`status` 会列出每个时段的 UTC 时间。在每个时段结束后用下列字段保存观察。记录你明确验收的结果、原本可以避免的打断，以及你干预工作流的秒数。事件简述应省略个人内容、凭据和所有者链接。完整观察且没有活动的时段填零，事件列表留空。只观察了部分时段时填 `partial`。

```json
{
  "coverage": "full",
  "acceptedOutcomes": 0,
  "avoidableInterruptions": 0,
  "interventionSeconds": 0,
  "incidents": []
}
```

```sh
node evals/owner-trial.ts record "$trial" 1 "$trial/observation.json"
node evals/owner-trial.ts status "$trial"
node evals/owner-trial.ts stop "$trial"
```

先将每次观察保存为 `observation.json`，再按对应的天数编号记录。用同一编号重新提交会替换该天的记录。用 `stop` 结束日志观察区间，再按 Ctrl+C 停止前台常驻进程。产物留在本机，需复用时可保留 Profile。报告分别标记完整、部分和缺失的时段，并汇总已记录的活动。所有者试用完成需要结束七天观察区间并提交七份完整记录。Project 的发布判断还会审查真实证据。[评估要求](../docs/07-evaluation-and-release-gates-zh.md)
