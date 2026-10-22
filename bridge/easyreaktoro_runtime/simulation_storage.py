"""Durable, recoverable run files and a portable result-explorer payload."""
from __future__ import annotations
import base64
import csv
import gzip
import json
import os
from pathlib import Path
import uuid


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temp.open('w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def records(root):
    path = Path(root)/'points.ndjson'
    if path.exists():
        # Decode one committed line at a time. A torn multibyte character in
        # the final line must not prevent reading earlier complete records.
        with path.open('rb') as stream:
            for line in stream:
                if not line.endswith(b'\n'):
                    break
                try:
                    record = json.loads(line.decode('utf-8'))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    break
                yield record


class TableWriter:
    def __init__(self, root):
        self.root, self.streams, self.writers, self.counts = Path(root), {}, {}, {}

    def row(self, kind, row):
        if kind not in self.writers:
            stream = (self.root/f'{kind}.csv').open('w', newline='', encoding='utf-8-sig')
            self.streams[kind] = stream
            writer = csv.DictWriter(stream, fieldnames=list(row))
            writer.writeheader()
            self.writers[kind] = writer
            self.counts[kind] = 0
        self.writers[kind].writerow(row)
        self.counts[kind] += 1

    def record(self, record):
        self.row('summary', record['summary'])
        for row in record['species']:
            self.row(row['phase_type'], row)
        for row in record['balances']:
            self.row('component_balance', row)
        for row in record.get('process_balance', []):
            self.row('process_balance', row)
        for row in record.get('constraints', []):
            self.row('constraints', row)
        for rule, transfer in enumerate(record.get('transfers', []), 1):
            for species, amount in transfer['amounts_mol'].items():
                if amount:
                    self.row('transfers', {'run_index': record['summary']['run_index'], 'pass': record['summary']['pass'],
                        'step': record['summary']['step'], 'rule': rule, 'source': transfer['source'],
                        'fraction': transfer['fraction'], 'species': species, 'amount_mol': amount})
        for stream in self.streams.values():
            stream.flush()

    def close(self):
        for stream in self.streams.values():
            stream.close()


def rebuild_tables(root):
    for kind in ('summary', 'aqueous', 'mineral', 'gas', 'component_balance', 'process_balance', 'transfers', 'constraints'):
        (Path(root)/f'{kind}.csv').unlink(missing_ok=True)
    writer = TableWriter(root)
    try:
        for record in records(root):
            writer.record(record)
    finally:
        writer.close()
    return writer.counts


def explorer_payload(root, cycle=None, start=0, stop=None):
    summary, species = [], []
    columns = None
    eligible = 0
    species_columns = ['run_index', 'species', 'formula', 'phase_type', 'amount_mol', 'inlet_amount_mol',
                       'delta_amount_mol', 'molality', 'activity', 'activity_coefficient']
    for record in records(root):
        row = record['summary']
        if cycle is not None and row['pass'] != cycle:
            continue
        index = eligible
        eligible += 1
        if index < start:
            continue
        if stop is not None and index >= stop:
            break
        if columns is None:
            columns = list(row)
        summary.append([row.get(k) for k in columns])
        species.extend([[r.get(k) for k in species_columns] for r in record['species']])
    config = json.loads((Path(root)/'simulation.ersim.json').read_text())['config']
    metadata = json.loads((Path(root)/'metadata.json').read_text())
    report = json.loads((Path(root)/'status.json').read_text())
    provenance = {k: metadata[k] for k in ('database', 'runtime_version', 'warnings', 'source_file_unchanged', 'execution', 'loop_axes', 'field_info') if k in metadata}
    provenance.update(method=('Custom Python simulation at saved samples' if metadata.get('execution', {}).get('mode') == 'custom' else 'Equilibrium at saved samples'), solute_activity_standard='molality',
                      activity_model=config.get('activity_model'), gas_model=config.get('gas_model'),
                      expected_points=report['total'], completed_points=len(summary),
                      contains_all_planned_points=cycle is None and len(summary)==report['total'], preview_cycle=cycle,
                      preview_start=start, preview_stop=start+len(summary))
    return {'format': 'result-explorer-1', 'name': config['name'], 'metadata': provenance,
            'sources': [{'name': 'points.ndjson', 'run_directory': str(Path(root))}], 'summary': {'columns': columns or [], 'rows': summary},
            'species_tables': [{'columns': species_columns, 'rows': species}], 'key_columns': ['run_index'],
            'dimension_columns': [], 'description': 'Equilibrium results at saved samples'}


def packed_payload(payload):
    return base64.b64encode(gzip.compress(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode(), mtime=0)).decode('ascii')


def write_explorer(root):
    root = Path(root)
    payload = explorer_payload(root)
    if not payload['summary']['rows']:
        (root/'Result Explorer.html').unlink(missing_ok=True)
        return
    html_path = Path(__file__).with_name('result_explorer.html')
    if not html_path.exists():
        raise FileNotFoundError('Missing bundled Result Explorer')
    html = html_path.read_text(encoding='utf-8')
    marker = '<script id="payload" type="application/octet-stream" data-encoding="gzip-base64"></script>'
    if marker not in html:
        raise ValueError('Invalid bundled Result Explorer payload marker')
    html = html.replace(marker, marker.replace('></script>', '>'+packed_payload(payload)+'</script>'))
    temp = root/'Result Explorer.html.tmp'
    temp.write_text(html, encoding='utf-8')
    os.replace(temp, root/'Result Explorer.html')
