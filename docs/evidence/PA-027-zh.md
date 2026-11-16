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

剩余工作包括其他工作流的配对比较、人工评分抽样和七天试用，以及 [#18](https://github.com/MosBot-AI/dsh-personal-agent/issues/18) 跟踪的真实外部写入。
