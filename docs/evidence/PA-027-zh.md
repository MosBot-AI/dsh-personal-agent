# PA-027 基础工作流评测

[English](PA-027.md) · [文档索引](../README-zh.md)

发布门槛及剩余验收在 [PA-027](https://github.com/MosBot-AI/dsh-personal-agent/issues/31) 跟踪。[打包 alpha 证据](PA-028-zh.md) 链接了项目简报、研究、提醒、评审、代码变更和文档整理的可执行用例。

## 原生前台会话与 Worker 的配对试点

两组都使用[文档整理用例](PA-028-zh.md#真实文档与数据整理)中的同一批合成库存记录、取值规则和报告格式。前台组向原生 DSH 会话提交一次提示。Worker 组通过已鉴权的收件箱创建、启动和验收一项任务。测试读回前台会话已提交的回复和 Worker 封存的结果，对两组使用同一套精确 CSV 校验规则，并确认 Worker 产物在常驻进程重启后可读回。

两组在同一 Linux 主机使用保留的 alpha 归档、DSH 0.2.2-rc.1 和 Node.js 24.14.1。回环计量器在转发到官方端点前核对任务文本、`deepseek-flash`、关闭推理、零模型工具、每组最多一次请求，以及每次最多 256 个输出 token。它还检查每组 10,000 微美元的估算上限，并记录供应商用量。Worker 同时走原生预算预留和结算流程，测试将结算用量与估算费用和回环记录比对。两组使用同一套配置的高峰费率估算费用。

```sh
for order in foreground-first worker-first; do
  DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_ORGANIZATION=1 \
    DSHPA_INSTALL_PAIRED_ORGANIZATION=1 DSHPA_INSTALL_PAIR_ORDER="$order" \
    DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
done
```

测试需要[安装证据](PA-028-zh.md#deepseek-worker-真实调用冒烟测试)中说明的获授权凭据。两种顺序和最后一次前台优先的复测均于 2026-11-16 通过。六份结果均满足精确的三行校验规则，导出的 CSV 的 SHA-256 均为 `5c5d9f82cabf8202bc7b48522462e2b3554814a43c2015a883508bccf2371d89`。

| 顺序 | 前台读回耗时 | Worker 读回耗时 | 前台估算费用 | Worker 估算费用 |
| --- | ---: | ---: | ---: | ---: |
| 先前台，后 Worker | 1,020 毫秒 | 952 毫秒 | 220 微美元 | 243 微美元 |
| 先 Worker，后前台 | 613 毫秒 | 973 毫秒 | 220 微美元 | 241 微美元 |
| 先前台，后 Worker（复测） | 1,150 毫秒 | 746 毫秒 | 219 微美元 | 246 微美元 |

读回耗时从提交提示或启动任务开始，到首次读到持久化结果为止，排除了 Profile 准备、来源选择、导出校验、重启及验收。前台组每次有一条模拟所有者命令用于提交提示。Worker 组每次有三条，用于创建、启动和验收。命令计数排除了两组共用的准备步骤和只读调用。本轮没有测量人工操作时间或打断次数。各次配对测试使用同一合成任务，无法判定整体延迟或注意力收益。初次演练发现未插入前台预设、前台会话继承了工具。修订后的原生预设禁用继承的工具，回环计量器会在转发前拒绝不匹配的请求。[试点验证 #164](https://github.com/MosBot-AI/dsh-personal-agent/issues/164)

## 研究简报和代码补丁的配对评测

两个工作流使用与文档整理试点相同的归档、主机和预算。回环计量器核对两组收到相同的任务文本。原生前台会话和 Worker 可以在该文本外附加不同的运行时指令。每次配对评测中，Worker 结算一次供应商调用，且在常驻进程重启后原样返回已验收的结果。

- **研究简报。** 用例通过已鉴权的知识接口读取两个精确的来源版本，并确认 Harbor Room 的旧版本读取被拒绝。两组收到相同的精选摘录。两份简报都必须引用当前版本、列出两个房间的容量和费用，并说明推荐 Harbor Room 的理由。[研究用例](PA-028-zh.md#基于精确版本本地来源的真实研究简报)为两组提供同一套校验规则。
- **代码补丁。** 两组分别为同一个合成用例中的零值读数缺陷提出补丁。测试在两个独立的 Git 仓库副本上运行，两个副本初始都只有同一项测试失败。测试检查每个补丁只修改 `readings.mjs`，由 Git 应用，并在隔离的 Node 环境中验证全部四个用例。参见[代码用例](PA-028-zh.md#真实代码补丁与可执行验证)。

```sh
for workflow in RESEARCH CODE; do
  for order in foreground-first worker-first; do
    env DSHPA_INSTALL_LIVE_DEEPSEEK=1 "DSHPA_INSTALL_LIVE_$workflow=1" \
      DSHPA_INSTALL_PAIRED=1 DSHPA_INSTALL_PAIR_ORDER="$order" \
      DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
  done
done
```

初次研究评测的前台组未正常结束供应商调用。初次 Worker 优先的代码评测返回了格式有误的补丁。修订后的提示明确要求三行简报和覆盖整个文件的 diff 区块格式。校验规则、模型和预算保持一致。2026-11-16，两项工作流均通过两种顺序的评测。原有的文档整理开关和无密钥安装也通过了回归测试。[研究与代码评测验证 #166](https://github.com/MosBot-AI/dsh-personal-agent/issues/166)

| 工作流 | 顺序 | 前台读回耗时 | Worker 读回耗时 | 前台估算费用 | Worker 估算费用 | 输出 token（前台 / Worker） |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 研究 | 先前台，后 Worker | 892 毫秒 | 1,050 毫秒 | 310 微美元 | 276 微美元 | 86 / 102 |
| 研究 | 先 Worker，后前台 | 1,141 毫秒 | 1,167 毫秒 | 256 微美元 | 272 微美元 | 104 / 99 |
| 代码 | 先前台，后 Worker | 1,296 毫秒 | 1,318 毫秒 | 320 微美元 | 310 微美元 | 118 / 123 |
| 代码 | 先 Worker，后前台 | 1,220 毫秒 | 1,458 毫秒 | 282 微美元 | 311 微美元 | 118 / 122 |

前台组通过脚本提交一次提示。Worker 组通过三条脚本命令创建、启动及验收任务。读回耗时排除了来源选择、应用补丁、运行补丁测试、重启及验收。测试对每次配对中的 Worker 结算用量与回环计量器记录进行核对。每个工作流只评测一项合成任务，本轮没有测量人工操作时间或打断次数。

## 项目简报澄清的配对评测

[项目简报用例](PA-028-zh.md#真实项目简报与澄清流程)向两组提供同一个虚构图书馆试点任务，暂不提供受众与启动日期。两组都必须询问这两项信息。测试在向两组提交同一个脚本化回答前重启常驻进程。重启后，测试从原生前台组的同一个 Session 读回原澄清问题，并从 Worker 组的同一个收件箱任务读回未在执行的输入等待状态。

回环计量器核对每组都完成两次调用，两次调用均包含原任务文本，第二次还包含所有者的原样回答。两组使用保留的归档和相同的 `deepseek-flash` 设置，关闭思考且不提供模型工具，每次调用最多 256 个输出 token，估算费用上限为 10,000 微美元。所有最终简报都通过同一套四项事实校验。Worker 的已验收产物在该组第二次重启后仍一致，且两条结算用量都与回环计量器记录一致。

```sh
for order in foreground-first worker-first; do
  DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_BRIEF=1 \
    DSHPA_INSTALL_PAIRED=1 DSHPA_INSTALL_PAIR_ORDER="$order" \
    DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
done
```

两种顺序于 2026-11-16 通过。前台组通过脚本提交两次所有者提示。Worker 组通过五条成功的命令创建、启动、回答、恢复执行和验收任务。测试还确认收件箱拒绝回答无关的问题引用。

| 顺序 | 澄清耗时（毫秒，前台 / Worker） | 回答至读回耗时（毫秒，前台 / Worker） | 输出 token 总数（前台 / Worker） | 估算费用（微美元，前台 / Worker） |
| --- | ---: | ---: | ---: | ---: |
| 先前台，后 Worker | 974 / 947 | 942 / 1,260 | 157 / 175 | 483 / 571 |
| 先 Worker，后前台 | 1,066 / 968 | 962 / 901 | 167 / 169 | 494 / 564 |

澄清耗时从提交提示或启动任务开始，到首次读到问题为止。回答耗时从提交回答开始，到首次读到最终结果为止，包含 Worker 组显式恢复任务执行的时间。两项耗时都覆盖脚本交互，排除两轮之间常驻进程重启和人工口述或键入回答的时间。[简报澄清验证 #168](https://github.com/MosBot-AI/dsh-personal-agent/issues/168)

## 库存评审的配对评测

两组都根据[已安装评审用例](PA-028-zh.md#真实评审与经验证的技能复用)中的同一规则评审三项虚构库存变更。IR-21 应获批准，IR-26 因超出数量上限退回，IR-42 因缺少佐证记录退回。每份评审都必须精确匹配相同的三行 Markdown。前台组在同一个原生 Session 中依次提交三次提示，并保留先前轮次。Worker 组使用三个独立的收件箱任务。两组分别重启常驻进程后，测试从原 Session 或 Worker 已验收的产物中读回三份结果。

回环计量器逐次核对来源文本，并检查两组使用相同的 `deepseek-flash` 模型、关闭思考、零模型工具、每项请求一次调用，每次最多 256 个输出 token 和 10,000 微美元估算费用。两组都使用保留的 alpha 归档和 DSH 0.2.2-rc.1。Worker 结算三次调用，测试逐条核对结算记录与计量器记录。

```sh
for order in foreground-first worker-first; do
  DSHPA_INSTALL_LIVE_DEEPSEEK=1 DSHPA_INSTALL_LIVE_REVIEW=1 \
    DSHPA_INSTALL_PAIRED=1 DSHPA_INSTALL_PAIR_ORDER="$order" \
    DSHPA_INSTALL_ARCHIVES="$archives" pnpm test:install
done
```

两种顺序于 2026-11-16 通过。十二份结果均满足精确校验规则。两组每次的输出用量一致，IR-21 为 41 个 token、IR-26 为 39 个、IR-42 为 38 个。

| 先运行的一组 | 请求 | 读回耗时（毫秒，前台 / Worker） | 估算费用（微美元，前台 / Worker） |
| --- | --- | ---: | ---: |
| 前台 | IR-21 | 1,195 / 1,182 | 171 / 194 |
| 前台 | IR-26 | 631 / 894 | 176 / 189 |
| 前台 | IR-42 | 834 / 689 | 182 / 189 |
| Worker | IR-21 | 683 / 1,171 | 170 / 190 |
| Worker | IR-26 | 828 / 1,201 | 175 / 189 |
| Worker | IR-42 | 773 / 892 | 181 / 186 |

读回耗时从发出请求到读到结果。前台组通过脚本提交三次提示，Worker 组通过九条脚本命令创建、启动和验收三项任务。命令计数和耗时覆盖脚本交互。Worker 组还基于已验收的结果运行原用例的后续技能检查。保留样本校验失败时禁止激活，修订后的版本从所提供字段生成一份新评审，额外模型调用为零，反馈和重放在重启后仍然可用。[库存评审验证 #170](https://github.com/MosBot-AI/dsh-personal-agent/issues/170)

提醒工作流的配对比较、人工评分抽样和七天试用，以及 [#18](https://github.com/MosBot-AI/dsh-personal-agent/issues/18) 跟踪的真实外部写入仍待完成。
