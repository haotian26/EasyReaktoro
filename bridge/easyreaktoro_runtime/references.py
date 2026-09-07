from __future__ import annotations

import re


def phreeqc_references(contents: str) -> list[dict[str, str]]:
    """Extract only reference text that is actually present in an embedded file."""
    lines = contents.splitlines()
    explicit = []
    for line in lines:
        value = re.sub(r"^\s*#\s?", "", line).strip()
        if re.match(r"ref\.\s*\d+\s*:", value, re.I):
            explicit.append(value)
    if explicit:
        return [{"raw": item, "kind": "database-reference", "verified_from": "embedded PHREEQC contents"} for item in explicit]
    start = next((i for i, line in enumerate(lines) if re.search(r"\breferences?\b", line, re.I)), None)
    if start is None:
        return []
    block = []
    for line in lines[start + 1:]:
        value = re.sub(r"^\s*#\s?", "", line).strip()
        if value:
            block.append(value)
    joined = "\n".join(block)
    records = [x.strip() for x in re.split(r"\n\s*\n|\n(?=[A-Z][^\n]{0,80}\b(?:19|20)\d{2}\b)", joined) if x.strip()]
    return [{"raw": item, "kind": "database-reference", "verified_from": "embedded PHREEQC contents"} for item in records]


def reference_tokens(contents: str, species_name: str) -> list[str]:
    matches = []
    for line in contents.splitlines():
        if species_name.lower() in line.lower() and re.search(r"\bref\.?\s*[:=]?\s*[\w.-]+", line, re.I):
            matches.extend(x.group(0) for x in re.finditer(r"\bref\.?\s*[:=]?\s*[\w.-]+", line, re.I))
    return sorted(set(matches))
