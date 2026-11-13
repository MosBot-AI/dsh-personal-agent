"""Compare lexical, dense, and hybrid retrieval against synthetic annotations."""

import argparse
from collections import defaultdict
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path, PurePosixPath
import random
import resource
from time import perf_counter
import unicodedata

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


DIRECTORY = Path(__file__).resolve().parent
TOP_K = 3
THREADS = 4
SEED = 131
WARM_SAMPLES = 128


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def milliseconds(start):
    return 1000 * (perf_counter() - start)


def timing(values):
    ordered = sorted(values)
    return {
        "samples": len(ordered),
        "p50Ms": ordered[math.ceil(0.5 * len(ordered)) - 1],
        "p95Ms": ordered[math.ceil(0.95 * len(ordered)) - 1],
    }


def encode(session, tokenizer, texts):
    batches = []
    names = {argument.name for argument in session.get_inputs()}
    for start in range(0, len(texts), 16):
        tokens = tokenizer.encode_batch(texts[start:start + 16])
        mask = np.array([token.attention_mask for token in tokens], dtype=np.int64)
        inputs = {
            "input_ids": np.array([token.ids for token in tokens], dtype=np.int64),
            "attention_mask": mask,
            "token_type_ids": np.array([token.type_ids for token in tokens], dtype=np.int64),
        }
        hidden, = session.run(["last_hidden_state"], {key: inputs[key] for key in names})
        masked = (hidden * mask[..., None]).sum(axis=1, dtype=np.float32)
        pooled = masked / mask.sum(axis=1, keepdims=True).astype(np.float32)
        batches.append(pooled / np.linalg.norm(pooled, axis=1, keepdims=True))
    return np.concatenate(batches)


def open_encoder(assets, lock):
    options = ort.SessionOptions()
    options.intra_op_num_threads = THREADS
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    for dependency, pinned in lock["runtime"].items():
        if version(dependency) != pinned:
            raise ValueError(f"{dependency} must be {pinned}")
    model = assets / "model.onnx"
    tokenizer_file = assets / "tokenizer.json"
    for asset in lock["assets"]:
        path = assets / asset["name"]
        if path.stat().st_size != asset["bytes"] or digest(path) != asset["sha256"]:
            raise ValueError(f'Digest mismatch: {asset["name"]}')
    start = perf_counter()
    tokenizer = Tokenizer.from_file(str(tokenizer_file))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding(pad_id=tokenizer.token_to_id('<pad>'), pad_token='<pad>')
    session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise ValueError("The evaluation requires the CPU execution provider")
    return session, tokenizer, milliseconds(start)


def load_corpus(path, native):
    corpus = json.loads(path.read_text())
    if digest(path) != native["corpusDigest"]:
        raise ValueError("The lexical report used a different corpus")
    documents = corpus["documents"]
    if set(documents) != {row["path"] for row in native["documents"]}:
        raise ValueError("The lexical report did not read every document")
    for row in native["documents"]:
        body = documents[row["path"]].encode()
        content = hashlib.sha256(body).hexdigest()
        if row["contentSha256"] != content or row["revision"] != content or row["bytes"] != len(body):
            raise ValueError(f"Native source readback mismatch: {row['path']}")
    positives = [{**q, "relevant": {a["path"] for a in q["relevant"]}} for q in corpus["queries"]]
    negatives = [{**q, "id": q.get("id", f"no-answer-{i}"), "mode": "no-answer", "relevant": set()}
                 for i, q in enumerate(corpus["negativeControls"], 1)]
    evidence = {row["path"]: row for row in native["documents"]}
    for query in corpus["queries"]:
        for answer in query["relevant"]:
            raw = answer["anchor"].encode()
            source = evidence[answer["path"]]
            body = documents[answer["path"]].encode()
            if not any(anchor["queryId"] == query["id"]
                       and anchor["sha256"] == hashlib.sha256(raw).hexdigest()
                       and anchor["bytes"] == len(raw)
                       and body[anchor["byteOffset"]:anchor["byteOffset"] + len(raw)] == raw
                       for anchor in source["anchors"]):
                raise ValueError(f"Missing authenticated source anchor: {query['id']}")
    return documents, positives, negatives


def lookup(native):
    return {row["id"]: row["paths"] for row in native["results"] + native["noAnswer"]}


def cosine_matches(session, tokenizer, index, paths, query):
    vector = encode(session, tokenizer, ["query: " + query])[0]
    similarities = index @ vector
    ranking = np.argsort(-similarities, kind="stable")[:TOP_K]
    return [(paths[i], float(similarities[i])) for i in ranking]


def dense_rank(matches, cutoff, minimum_gap):
    if len(matches) > 1 and matches[0][1] - matches[1][1] < minimum_gap:
        return []
    return [path for path, score in matches if score >= cutoff][:TOP_K]


def hybrid_rank(query, lexical, dense, lexical_weight):
    normalized = unicodedata.normalize("NFKC", query).strip().casefold()
    if lexical:
        first = unicodedata.normalize("NFKC", lexical[0]).casefold()
        if normalized in {first, PurePosixPath(first).name}:
            return lexical[:TOP_K]
    if not lexical or not dense:
        return (lexical or dense)[:TOP_K]
    scores = defaultdict(float)
    for paths, weight in [(lexical, lexical_weight), (dense, 1 - lexical_weight)]:
        for rank, path in enumerate(paths, 1):
            scores[path] += weight / (10 + rank)
    return sorted(scores, key=lambda path: (-scores[path], path))[:TOP_K]


def quality(positives, negatives, rankings):
    def summary(rows):
        return {
            "queries": len(rows),
            "hitAt1": sum(bool(query["relevant"].intersection(rankings[query["id"]][:1])) for query in rows),
            "hitAt3": sum(bool(query["relevant"].intersection(rankings[query["id"]][:3])) for query in rows),
            "missesAt1": [query["id"] for query in rows if not query["relevant"].intersection(rankings[query["id"]][:1])],
            "missesAt3": [query["id"] for query in rows if not query["relevant"].intersection(rankings[query["id"]][:3])],
        }

    return {
        **summary(positives),
        "byLanguage": {name: summary([q for q in positives if q["language"] == name])
                       for name in sorted({q["language"] for q in positives})},
        "byMode": {name: summary([q for q in positives if q["mode"] == name])
                   for name in sorted({q["mode"] for q in positives})},
        "falsePositives": [q["id"] for q in negatives if rankings[q["id"]]],
        "falsePositiveDenominator": len(negatives),
    }


def calibrate(positives, negatives, lexical, matches):
    # Preserve abstention on calibration negatives where the shipped lexical search abstains.
    # Prefer first-rank recall, then top-three recall, then the most conservative cutoff.
    baseline = quality(positives, negatives, lexical)
    query_texts = {query["id"]: query["query"] for query in positives + negatives}
    allowance = len(baseline["falsePositives"])
    cutoffs = [i / 100 for i in range(60, 101)] + [1.01]
    best = None
    for cutoff in cutoffs:
        for gap in [0, 0.005, 0.01, 0.02, 0.03, 0.05]:
            dense = {qid: dense_rank(results, cutoff, gap) for qid, results in matches.items()}
            dense_quality = quality(positives, negatives, dense)
            if len(dense_quality["falsePositives"]) > allowance:
                continue
            for weight in [0.25, 0.5, 0.75]:
                hybrid = {qid: hybrid_rank(query_texts[qid], lexical[qid], values, weight)
                          for qid, values in dense.items()}
                hybrid_quality = quality(positives, negatives, hybrid)
                if len(hybrid_quality["falsePositives"]) > allowance:
                    continue
                score = (
                    hybrid_quality["hitAt1"], dense_quality["hitAt1"], hybrid_quality["hitAt3"],
                    dense_quality["hitAt3"], -len(hybrid_quality["falsePositives"]), cutoff, gap, weight,
                )
                if best is None or score > best[0]:
                    best = score, cutoff, gap, weight, dense_quality, hybrid_quality
    if best is None:
        raise ValueError("Calibration failed to produce an abstaining threshold")
    _, cutoff, gap, weight, dense_quality, hybrid_quality = best
    return {"denseCutoff": cutoff, "denseMinimumGap": gap, "lexicalWeight": weight,
            "denseQuality": dense_quality, "hybridQuality": hybrid_quality, "lexicalQuality": baseline}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("mode", choices=["calibrate", "evaluate"])
    cli.add_argument("corpus", type=Path)
    cli.add_argument("lexical", type=Path)
    cli.add_argument("assets", type=Path)
    cli.add_argument("output", type=Path)
    cli.add_argument("--policy", type=Path)
    args = cli.parse_args()
    manifest = DIRECTORY / "assets.json"
    lock = json.loads(manifest.read_text())
    native = json.loads(args.lexical.read_text())
    documents, positives, negatives = load_corpus(args.corpus, native)
    all_queries = positives + negatives
    lexical = lookup(native)
    if set(lexical) != {query["id"] for query in all_queries}:
        raise ValueError("Native result identifiers do not match corpus")
    if any(path not in documents for ranked in lexical.values() for path in ranked):
        raise ValueError("Native ranking returned an unverified document")

    policy = None
    if args.mode == "calibrate":
        if digest(args.corpus) != digest(DIRECTORY / "semantic-calibration.json"):
            raise ValueError("Calibration requires the dedicated corpus")
    else:
        if args.policy is None:
            cli.error("evaluate requires --policy")
        policy = json.loads(args.policy.read_text())
        if policy["manifestDigest"] != digest(manifest) or policy["scorerDigest"] != digest(Path(__file__)):
            raise ValueError("The model manifest or scorer changed after calibration")
        if policy["corpusDigest"] == native["corpusDigest"]:
            raise ValueError("Evaluation requires a disjoint corpus")
        if set(policy["documentDigests"]).intersection(row["revision"] for row in native["documents"]):
            raise ValueError("A calibration document reappeared in evaluation")

    session, tokenizer, load_ms = open_encoder(args.assets, lock)
    paths = sorted(documents)
    start = perf_counter()
    index = encode(session, tokenizer, ["passage: " + documents[path] for path in paths])
    index_ms = milliseconds(start)
    matches = {}
    dense_ms = {}
    for query in all_queries:
        start = perf_counter()
        matches[query["id"]] = cosine_matches(session, tokenizer, index, paths, query["query"])
        dense_ms[query["id"]] = milliseconds(start)

    if policy is None:
        report = calibrate(positives, negatives, lexical, matches)
        report.update({
            "corpusDigest": native["corpusDigest"], "scorerDigest": digest(Path(__file__)),
            "manifestDigest": digest(manifest), "documentDigests": sorted(row["revision"] for row in native["documents"]),
            "modelLoadMs": load_ms, "indexMs": index_ms,
        })
    else:
        dense = {qid: dense_rank(results, policy["denseCutoff"], policy["denseMinimumGap"]) for qid, results in matches.items()}
        hybrid = {}
        for query in all_queries:
            qid = query["id"]
            hybrid[qid] = hybrid_rank(query["query"], lexical[qid], dense[qid], policy["lexicalWeight"])
        lexical_samples = native["warmMs"]
        samples = []
        hybrid_samples = []
        sampled_ids = native.get("warmIds")
        if not sampled_ids:
            order = random.Random(SEED).choices(all_queries, k=WARM_SAMPLES)
            sampled_ids = [query["id"] for query in order]
        queries_by_id = {query["id"]: query for query in all_queries}
        for qid in sampled_ids:
            start = perf_counter()
            ranked = cosine_matches(session, tokenizer, index, paths, queries_by_id[qid]["query"])
            sample = milliseconds(start)
            samples.append(sample)
            start = perf_counter()
            hybrid_rank(queries_by_id[qid]["query"], lexical[qid],
                        dense_rank(ranked, policy["denseCutoff"], policy["denseMinimumGap"]), policy["lexicalWeight"])
            hybrid_samples.append(sample + milliseconds(start))
        projected = timing([a + b for a, b in zip(lexical_samples, hybrid_samples, strict=True)]) if native.get("warmIds") else None
        methods = {"lexical": lexical, "dense": dense, "hybrid": hybrid}
        diagnostic = {qid: [path for path, _ in candidates] for qid, candidates in matches.items()}
        report = {
            "corpusDigest": native["corpusDigest"], "policyDigest": digest(args.policy),
            "manifestDigest": digest(manifest), "scorerDigest": digest(Path(__file__)),
            "quality": {method: quality(positives, negatives, ranking) for method, ranking in methods.items()},
            "rankings": methods,
            "unfilteredDenseDiagnostic": quality(positives, negatives, diagnostic),
            "sourceReadbacks": len(native["documents"]),
            "timing": {
                "lexical": {"hostStartupMs": native["metadata"]["hostStartupMs"],
                            "indexMs": native["indexMs"], "coldFirstMs": native["coldFirstMs"],
                            "warm": timing(lexical_samples), "peakHostRssKiB": native["peakRssKiB"]},
                "dense": {"modelLoadMs": load_ms, "indexMs": index_ms, "coldFirstMs": next(iter(dense_ms.values())),
                          "warm": timing(samples), "peakProcessRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},
                "hybrid": {"warmDenseAndFusion": timing(hybrid_samples), "projectedSequentialWarm": projected,
                           "fusionTimingScope": "Independent native RPC and dense+fusion measurements. No integrated host."},
            },
            "documents": len(paths), "indexBytes": index.nbytes, "threads": THREADS,
        }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if policy is None:
        print(json.dumps({key: report[key] for key in ["denseCutoff", "denseMinimumGap", "lexicalWeight"]}))
    else:
        print(json.dumps({name: {key: values[key] for key in ("hitAt1", "hitAt3", "queries", "falsePositives")}
                          for name, values in report["quality"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
