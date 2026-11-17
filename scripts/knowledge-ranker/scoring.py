"""Local shortlist, calibrated ranking, and extractive passage selection."""

from collections import OrderedDict

import torch
from torch.nn.functional import normalize
from transformers import AutoModel, AutoModelForCausalLM, AutoModelForQuestionAnswering, AutoTokenizer

from manufacturing_evidence import states_maker
from passage_evidence import PassageJudge, measured_value, passages, requested_identifiers_present
from quantity_scope import mentions_quantity_scope


LOAD = {'local_files_only': True, 'trust_remote_code': False}
WEIGHTS = {**LOAD, 'use_safetensors': True, 'dtype': torch.float32}
EMBED_INSTRUCTION = 'Find the local passage that contains the factual answer to the question.'
RANK_INSTRUCTION = 'Determine whether the passage contains enough factual information to answer the question.'
RANK_PREFIX = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. '
               'Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
RANK_SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'

# Frozen policy from the multilingual calibration and native passage confirmation.
RERANK_SCALE = 8.7122535
EXTRACTIVE_SCALE = 16.644049555063248
EXTRACTIVE_WEIGHT = 0.75
SOURCE_SCORE_CUTOFF = -0.32899310905953555
QUANTITY_SCOPE_WIDTH = 3
PASSAGE_MARGIN = 0


def plain_prompt(value):
    return value.replace('<|', '‹¦')


class Ranker:
    def __init__(self, root, threads):
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        self.encoder_tokenizer = AutoTokenizer.from_pretrained(root / 'qwen3-embedding', padding_side='left', **LOAD)
        self.encoder = AutoModel.from_pretrained(root / 'qwen3-embedding', **WEIGHTS).eval()
        self.rerank_tokenizer = AutoTokenizer.from_pretrained(root / 'qwen3-reranker', padding_side='left', **LOAD)
        self.reranker = AutoModelForCausalLM.from_pretrained(root / 'qwen3-reranker', **WEIGHTS).eval()
        self.labels = self.reranker.lm_head.weight.detach()[
            [self.rerank_tokenizer.convert_tokens_to_ids(word) for word in ('yes', 'no')]]
        self.prefix = self.rerank_tokenizer.encode(RANK_PREFIX, add_special_tokens=False)
        self.suffix = self.rerank_tokenizer.encode(RANK_SUFFIX, add_special_tokens=False)
        self.answer_tokenizer = AutoTokenizer.from_pretrained(root / 'mdeberta-v3-base-squad2', use_fast=True, **LOAD)
        self.extractor = AutoModelForQuestionAnswering.from_pretrained(root / 'mdeberta-v3-base-squad2', **WEIGHTS).eval()
        self.judge = PassageJudge(root / 'qwen3-instruct-1.7b')
        self.vectors = OrderedDict()

    def embed(self, texts):
        vectors = []
        for offset in range(0, len(texts), 8):
            batch = self.encoder_tokenizer(texts[offset:offset+8], max_length=512, padding=True,
                                           truncation=True, return_tensors='pt')
            hidden = self.encoder(**batch, use_cache=False).last_hidden_state[:, -1]
            vectors.extend(normalize(hidden, p=2, dim=1))
        return vectors

    def shortlist(self, query, documents, lexical):
        rows = sorted(documents, key=lambda row: row['path'])
        missing = {row['revision']: plain_prompt(row['text']) for row in rows if row['revision'] not in self.vectors}
        if missing:
            self.vectors.update(zip(missing, self.embed(list(missing.values())), strict=True))
        for row in rows:
            self.vectors.move_to_end(row['revision'])
        matrix = torch.stack([self.vectors[row['revision']] for row in rows])
        while len(self.vectors) > 2048:
            self.vectors.popitem(last=False)
        vector, = self.embed([f'Instruct: {EMBED_INSTRUCTION}\nQuery:{plain_prompt(query)}'])
        dense = (matrix @ vector).argsort(descending=True, stable=True)[:8].tolist()
        lookup = {row['id']: row for row in rows}
        selected = dict.fromkeys([rows[index]['id'] for index in dense] + lexical)
        return sorted((lookup[ref] for ref in selected), key=lambda row: len(row['text']))

    def rerank(self, query, rows):
        prompts = [f'<Instruct>: {RANK_INSTRUCTION}\n<Query>: {plain_prompt(query)}\n<Document>: {plain_prompt(row["text"])}'
                   for row in rows]
        ids = self.rerank_tokenizer(prompts, add_special_tokens=False, max_length=512-len(self.prefix)-len(self.suffix),
                                    truncation=True, return_attention_mask=False)['input_ids']
        margins = []
        for offset in range(0, len(ids), 8):
            batch = self.rerank_tokenizer.pad({'input_ids': [self.prefix+entry+self.suffix for entry in ids[offset:offset+8]]},
                                             padding=True, return_attention_mask=True, return_tensors='pt')
            logits = self.reranker.model(**batch, use_cache=False).last_hidden_state[:, -1] @ self.labels.T
            margins.extend(round(value, 6) for value in (logits[:, 0] - logits[:, 1]).tolist())
        return margins

    def answer_margins(self, query, rows):
        batch = self.answer_tokenizer([query] * len(rows), [row['text'] for row in rows], padding=True,
                                      truncation='only_second', max_length=384, return_offsets_mapping=True, return_tensors='pt')
        offsets = batch.pop('offset_mapping').tolist()
        output = self.extractor(**batch)
        margins = []
        for i, (start_logits, end_logits) in enumerate(zip(output.start_logits, output.end_logits, strict=True)):
            start = start_logits.tolist()
            end = end_logits.tolist()
            cls = batch.input_ids[i].tolist().index(self.answer_tokenizer.cls_token_id)
            positions = [index for index, segment in enumerate(batch.sequence_ids(i))
                         if segment == 1 and offsets[i][index][0] < offsets[i][index][1]]
            best = max((start[left] + end[right] for j, left in enumerate(positions) for right in positions[j:j+32]),
                       default=float('-inf'))
            margins.append(best - (start[cls] + end[cls]))
        return margins

    @torch.inference_mode()
    def search(self, query, documents, lexical, limit):
        rows = self.shortlist(query, documents, lexical)
        qa = self.answer_margins(query, rows)
        ranked = self.rerank(query, rows)
        scores = [(1 - EXTRACTIVE_WEIGHT) * value / RERANK_SCALE + EXTRACTIVE_WEIGHT * margin / EXTRACTIVE_SCALE
                  for value, margin in zip(ranked, qa, strict=True)]
        candidates = sorted(zip(scores, rows, strict=True), key=lambda item: (-item[0], item[1]['path']))

        matches = []
        for score, row in candidates[:3]:
            source = row['text']
            if score <= SOURCE_SCORE_CUTOFF or not requested_identifiers_present(query, source):
                continue
            if not mentions_quantity_scope(query, source, QUANTITY_SCOPE_WIDTH):
                continue
            for selected in self.judge.choose(query, source, passages(source)):
                start, end = selected['start'], selected['end']
                text = source[start:end]
                if selected['mean'] <= PASSAGE_MARGIN or not measured_value(query, text) or not states_maker(query, text):
                    continue
                matches.append({'id': row['id'], 'revision': row['revision'],
                                'offset': len(source[:start].encode('utf-8')), 'length': len(text.encode('utf-8'))})
                break
            if len(matches) == limit:
                break
        return matches
