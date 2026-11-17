# Local semantic ranking for dshpa

[简体中文](README-zh.md)

This optional service ranks natural-language searches over the roots approved in the owner's dshpa Profile. It receives each query and its scoped source text through a private Unix socket and runs the models on the same computer. The host verifies each returned source reference, current revision, and UTF-8 byte range before showing an excerpt.

## Set up on Linux x64

From the dshpa source checkout, use Python 3.13 and a virtual environment. The first setup downloads the Python dependencies and about 7.6 GB of model files. Keep sufficient disk space for both. The manifest pins model repositories, revisions, and file SHA-256 digests. [PyTorch 2.11 installation](https://pytorch.org/get-started/previous-versions/#v2110)

```sh
ranker_home="${XDG_DATA_HOME:-$HOME/.local/share}/dshpa/knowledge-ranker"
install -d -m 700 "$ranker_home" "$ranker_home/run"
python3.13 -m venv "$ranker_home/venv"
"$ranker_home/venv/bin/python" -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.11.0
"$ranker_home/venv/bin/python" -m pip install -r scripts/knowledge-ranker/requirements.txt
umask 077
"$ranker_home/venv/bin/python" scripts/knowledge-ranker/models.py "$ranker_home/models" --download
```

Run the service under the same user as DSH. It verifies the installed file hashes and loads the local models before it makes the socket available. Keep the process running while using semantic search.

```sh
ranker_home="${XDG_DATA_HOME:-$HOME/.local/share}/dshpa/knowledge-ranker"
"$ranker_home/venv/bin/python" scripts/knowledge-ranker/serve.py \
  --models "$ranker_home/models" --socket "$ranker_home/run/rank.sock"
```

Under `config.inbox.knowledge` in the [Profile configuration](../../README.md#search-local-knowledge), add the absolute socket path alongside the existing `roots`. Use the path printed by `printf '%s\n' "$ranker_home/run/rank.sock"`.

```yaml
semanticRanker:
  socketPath: /home/your-user/.local/share/dshpa/knowledge-ranker/run/rank.sock
```

Restart DSH to apply the configuration and test in **Today → Local knowledge**. The service assesses natural-language questions when keyword search finds no hits. The first question over a scope can take longer while the model computes document vectors. Search can send up to 256 indexed files and 512 KiB of encoded text and metadata per request. If a search exceeds these limits, choose a smaller configured root or narrow its approved paths. If the service is unavailable, the natural-language search reports a failure and exact filename lookup remains available. Remove `semanticRanker` and restart DSH to resume the built-in search.

The service runs offline once its models are prepared. It retains a limited in-memory cache of document vectors. The model weights come directly from their publishers. [Qwen3 Embedding, Apache-2.0](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) · [Qwen3 Reranker, Apache-2.0](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) · [Qwen3 1.7B, Apache-2.0](https://huggingface.co/Qwen/Qwen3-1.7B/tree/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e) · [timpal0l mDeBERTa SQuAD2, MIT](https://huggingface.co/timpal0l/mdeberta-v3-base-squad2/tree/08d6e89c7a6557f967db2e1021f7f640483400ed)
