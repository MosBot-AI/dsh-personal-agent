# 离线检索评估

[English](README.md) · [PA-015 证据](../../docs/evidence/PA-015-zh.md)

本实验对比原生词项检索、本机 CPU 向量检索和离线混合排序。仓库中的语料均为合成数据。脚本在仅允许回环通信的私有网络命名空间内运行推理。每份词项报告使用一次性 DSH Web Profile，通过鉴权请求回读每份文档和标注的答案锚点。评估器无需添加产品运行时依赖。

## 准备本地资产

依赖锁适用于 Linux x86-64 和 CPython 3.13。请在新的工作区目录中存放虚拟环境、wheel 和模型。清单固定官方 E5 模型的修订、来源许可、文件名、大小和 SHA-256。wheel 固定到 PyPI 上发布的具体文件。[模型清单](assets.json) · [Python wheel 依赖锁](requirements-linux-x64.txt)

```sh
mkdir -p .scratch/tmp .scratch/wheelhouse .scratch/assets
TMPDIR="$PWD/.scratch/tmp" python3 -m venv .scratch/venv
TMPDIR="$PWD/.scratch/tmp" .scratch/venv/bin/python -m pip --isolated download \
  --index-url https://pypi.org/simple --only-binary=:all: --require-hashes \
  -r evals/retrieval/requirements-linux-x64.txt -d .scratch/wheelhouse
TMPDIR="$PWD/.scratch/tmp" .scratch/venv/bin/python -m pip --isolated install \
  --no-index --only-binary=:all: --require-hashes --find-links .scratch/wheelhouse \
  -r evals/retrieval/requirements-linux-x64.txt
.scratch/venv/bin/python -m pip check
python3 - <<'PY'
import json
import subprocess
from pathlib import Path

for asset in json.loads(Path('evals/retrieval/assets.json').read_text())['assets']:
    target = Path('.scratch/assets') / asset['name']
    subprocess.run(['curl', '--fail', '--location', '--output', str(target), asset['url']], check=True)
PY
```

评估器在加载资产前核对文件大小和 SHA-256。资产准备使用公开地址，无需账户。模型和 wheel 保留在临时工作目录。

## 复现对比

使用仓库固定的 Node.js 和 pnpm 工具链构建。Linux 复跑要求 PATH 中有 `bwrap` 和 `ip`。传入绝对路径和新的报告目录。

```sh
pnpm build
bash evals/retrieval/run-offline.sh "$PWD/.scratch/venv/bin/python" "$PWD/.scratch/assets" "$PWD/.scratch/replay"
```

校准集用于选择余弦分数阈值、前两名分差和混合权重。评分器将保存的策略绑定到评分器与资产清单的摘要，并拒绝在校准集或含有字节完全相同的校准文档的语料上评估。留出集使用保存的策略评分，之后使用同一策略复跑四套既有回归语料。[实测结果](results.json)

每份报告测量一次新进程及 100 次暖态查询。向量计时不含资产摘要核对。混合延迟由独立进程中对应的原生查询和向量加融合样本相加得出。重复新进程实验时，每次使用新的报告目录，再汇总留出集报告。文件系统缓存保持原样。
