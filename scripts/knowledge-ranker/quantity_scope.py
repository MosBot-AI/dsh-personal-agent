"""Check topical overlap before attributing a Mandarin measurement to a named operation."""

import re

from passage_evidence import duration_question, normalize_evidence, quantity_question


han = re.compile(r'[\u3400-\u9fff]+')
latin = re.compile(r'[a-z]')
calendar_question = re.compile(r'(?:哪几|第几)(?:天|日|周|月|年)')
measurement_language = re.compile(r'(?:多少|几)[个件份条张人台辆次项套分天]|'
                                  r'多少|最多|最少|至少|至多|上限|下限|固定|默认|每次|每轮|每个|总共|一共|合计|包含')


def is_mandarin(text):
    characters = sum(len(run) for run in han.findall(text))
    return characters >= 4 and characters >= len(latin.findall(text))


def mentions_quantity_scope(question, source, width):
    question, source = normalize_evidence(question), normalize_evidence(source)
    if calendar_question.search(question) or not (duration_question.search(question) or quantity_question.search(question)):
        return True
    if not is_mandarin(question) or not is_mandarin(source):
        return True
    runs = han.findall(measurement_language.sub(' ', question))
    terms = {run[index:index+width] for run in runs for index in range(len(run)-width+1)}
    return not terms or any(term in source for term in terms)
