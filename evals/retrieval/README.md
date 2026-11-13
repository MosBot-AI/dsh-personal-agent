# Offline retrieval evaluation

[简体中文](README-zh.md) · [PA-015 evidence](../../docs/evidence/PA-015.md)

This experiment compares the native lexical search with local CPU embeddings and an offline hybrid. The checked-in corpora are synthetic. The script runs inference in a private network namespace with loopback only. It starts a disposable DSH Web profile for each lexical report and reads every document and its annotated anchors through authenticated requests. The evaluator has no product runtime dependency.

## Prepare the local assets

The lock targets Linux x86-64 and CPython 3.13. Use a fresh workspace directory for the virtual environment, wheelhouse and model. The manifest pins the official E5 model revision, source license, files, sizes and SHA-256 hashes. The wheels are pinned to the artifacts published on PyPI. [Model manifest](assets.json) · [Python wheel lock](requirements-linux-x64.txt)

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

The evaluator verifies each asset's size and SHA-256 before loading it. Asset preparation uses public endpoints and requires no account. Keep the model and wheels in scratch storage.

## Reproduce the comparison

Build with the repository's pinned Node.js and pnpm toolchain. The Linux replay needs `bwrap` and `ip` on PATH. Supply absolute paths and a fresh report directory.

```sh
pnpm build
bash evals/retrieval/run-offline.sh "$PWD/.scratch/venv/bin/python" "$PWD/.scratch/assets" "$PWD/.scratch/replay"
```

Calibration chooses an absolute cosine cutoff, a top-two score gap, and a hybrid weight on the calibration corpus. The scorer binds the saved policy to the scorer and asset manifest digests and rejects evaluation on the calibration corpus or a byte-identical calibration document. The holdout is evaluated with the saved policy. The four existing corpora are then evaluated with the same policy as regressions. See [recorded measurements](results.json).

Each report measures one fresh process and a sequence of 100 warm lookups. Dense measurements exclude the asset digest check. Hybrid latency adds corresponding native and dense-plus-fusion samples from separate processes. To repeat the fresh-process experiment, use a new report directory per run and summarize the resulting holdout reports. The filesystem cache stays intact.
