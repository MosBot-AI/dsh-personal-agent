# dshpa 本地语义排序

[English](README.md)

此可选服务为所有者在 dshpa Profile 中批准的目录提供自然语言搜索排序。它通过私有 Unix socket 接收查询和范围内的原文，并在同一台电脑上运行模型。宿主在展示引文前核对返回的来源引用、当前修订和 UTF-8 字节范围。

## 在 Linux x64 上安装

在 dshpa 源码目录中使用 Python 3.13 和虚拟环境。首次安装需下载 Python 依赖和约 7.6 GB 的模型文件，请为两者预留磁盘空间。清单固定了模型仓库、修订和文件的 SHA-256 摘要。[PyTorch 2.11 安装](https://pytorch.org/get-started/previous-versions/#v2110)

```sh
ranker_home="${XDG_DATA_HOME:-$HOME/.local/share}/dshpa/knowledge-ranker"
install -d -m 700 "$ranker_home" "$ranker_home/run"
python3.13 -m venv "$ranker_home/venv"
"$ranker_home/venv/bin/python" -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.11.0
"$ranker_home/venv/bin/python" -m pip install -r scripts/knowledge-ranker/requirements.txt
umask 077
"$ranker_home/venv/bin/python" scripts/knowledge-ranker/models.py "$ranker_home/models" --download
```

以运行 DSH 的同一个用户启动服务。服务会核对已安装文件的摘要并加载本地模型，然后开放 socket。使用语义搜索时请保持进程运行。

```sh
ranker_home="${XDG_DATA_HOME:-$HOME/.local/share}/dshpa/knowledge-ranker"
"$ranker_home/venv/bin/python" scripts/knowledge-ranker/serve.py \
  --models "$ranker_home/models" --socket "$ranker_home/run/rank.sock"
```

在 [Profile 配置](../../README-zh.md#搜索本地知识)的 `config.inbox.knowledge` 下，在现有 `roots` 旁添加 socket 的绝对路径。可通过 `printf '%s\n' "$ranker_home/run/rank.sock"` 查看该路径。

```yaml
semanticRanker:
  socketPath: /home/your-user/.local/share/dshpa/knowledge-ranker/run/rank.sock
```

重启 DSH 后在**今日 → 本地知识**中测试。关键词检索无结果时，服务会评估自然语言问题。首次查询某个范围时，模型需要计算文档向量，耗时可能较长。每次搜索最多可发送 256 个已索引文件，编码后的文本和元数据合计上限为 512 KiB。若超过限制，可选择较小的已配置目录，或缩小获准路径的范围。服务不可用时，自然语言搜索会显示失败，按精确文件名查找仍可用。删除 `semanticRanker` 并重启 DSH，可恢复内置搜索。

模型准备完毕后，服务离线运行。服务在内存中保留有限的文档向量缓存。模型权重直接来自其发布者。[Qwen3 Embedding，Apache-2.0](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) · [Qwen3 Reranker，Apache-2.0](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) · [Qwen3 1.7B，Apache-2.0](https://huggingface.co/Qwen/Qwen3-1.7B/tree/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e) · [timpal0l mDeBERTa SQuAD2，MIT](https://huggingface.co/timpal0l/mdeberta-v3-base-squad2/tree/08d6e89c7a6557f967db2e1021f7f640483400ed)
