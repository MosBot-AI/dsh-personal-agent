"""Require an expressed maker relationship for explicit manufacturer and printer lookups."""

import re
from unicodedata import normalize


maker_request = re.compile(
    r'\b(?:which|what)\s+(?:manufacturer|maker|print shop|printing company)\b'
    r'|\b(?:which|what)\s+(?:company|supplier|vendor)\s+(?:makes?|made|manufactures?|manufactured|prints?|printed)\b'
    r'|(?:哪家|哪间|哪个)[^？?。]{0,18}(?:制造商|厂商|厂家|生产商|印刷(?:公司|厂|店)|印务|printing company|print shop|manufacturer)'
    r'|(?:由)?(?:哪家|哪间)(?:公司|单位|店)[^？?。]{0,12}(?:制造|制作|生产|印制|印刷)',
    re.IGNORECASE,
)

unidentified = re.compile(r'^(?:unknown|unlisted|unspecified|not available|not disclosed|none|n/?a)\b|^(?:未知|未公布|未注明|未披露|不明)', re.IGNORECASE)
passive_maker = re.compile(r'\b(?:made|manufactured|printed|fabricated|produced)\s+(?:and supplied\s+)?by\s+([^.!?;。！？]+)', re.IGNORECASE)
maker_field = re.compile(r'(?:\b(?:manufacturer|maker|printing company|printer)\b|制造商|生产商|制作方|印制单位|印刷方)\s*[:：]\s*([^.!?;。！？]+)', re.IGNORECASE)
maker_title = r'[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*){0,7}'
active_maker = re.compile(rf'\b{maker_title}\s+(?:manufactured|manufactures|printed|prints|fabricated|makes|made)\b(?!\s+(?:available|of)\b)')
cjk_maker = re.compile(
    r'由\s*([^，,。！？!?；;]{2,48}?)(?:制造|制作|生产|印制|印刷|出品)'
    r'|([^，,。！？!?；;]{2,32}(?:公司|印务|印刷厂|印刷室|制造厂))\s*(?:制造|制作|生产|印制|印刷)'
)
denial = re.compile(r'\b(?:not|never)\s+(?:made|manufactured|printed|fabricated|produced)\b'
                    r'|(?:并非|没有|未曾|未|并不是)(?:由[^，。]{1,40})?(?:制造|制作|生产|印制|印刷)')


def states_maker(query, passage):
    if not maker_request.search(normalize('NFKC', query)):
        return True
    for evidence in re.split(r'[，,；;。！？!?]', normalize('NFKC', passage)):
        if denial.search(evidence):
            continue
        values = maker_field.findall(evidence) + passive_maker.findall(evidence)
        values.extend(value for pair in cjk_maker.findall(evidence) for value in pair)
        if active_maker.search(evidence) or any(value.strip() and not unidentified.match(value.strip()) for value in values):
            return True
    return False
