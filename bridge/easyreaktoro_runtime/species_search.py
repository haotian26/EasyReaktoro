"""Deterministic species lookup without changing database record order."""
import unicodedata


def text(value):
    return unicodedata.normalize('NFKC', str(value or '')).replace('−', '-').strip()


def search_records(records, args):
    query = text(args.get('query', ''))
    folded = query.casefold()
    terms = folded.split()
    state = str(args.get('state', 'All'))
    model = str(args.get('model', 'All'))
    elements = set(str(e) for e in args.get('elements', []) if e)
    found = []
    for record in records:
        actual_model = record.get('model', {}).get('native_type') or record.get('model', {}).get('type', '')
        if state != 'All' and record['state'] != state:
            continue
        if model.casefold() != 'all' and model.casefold() != actual_model.casefold():
            continue
        if not elements.issubset(record.get('composition', {})):
            continue
        names = [text(record.get(k)) for k in ('name', 'formula', 'original_name')]
        aliases = record.get('provenance', {}).get('aliases', [])
        if isinstance(aliases, list):
            names.extend(text(a) for a in aliases if isinstance(a, str))
        names = [n for n in names if n]
        lower = [n.casefold() for n in names]
        haystack = ' '.join([*lower, actual_model.casefold()])
        if terms and not all(term in haystack for term in terms):
            continue
        # CO and Co stay distinct in the highest rank; broad lookup remains forgiving.
        rank = (0 if query in names else 1 if folded in lower else
                2 if any(n.startswith(query) for n in names) else
                3 if any(n.startswith(folded) for n in lower) else
                4 if any(folded in n for n in lower) else 5) if query else 0
        found.append((rank, record['name'].casefold(), str(record.get('id') or ''), record))
    return [entry[3] for entry in sorted(found, key=lambda entry: entry[:3])]
