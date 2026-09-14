"""Saved-result viewing must not require write access or rewrite source evidence."""
import base64
from contextlib import contextmanager, ExitStack
import fcntl
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs
from bridge.easyreaktoro_runtime.simulation_storage import records


def make_result(parent, status='completed', total=2, count=2, reported=None, tail=b''):
    root = Path(parent)/'source'; root.mkdir()
    config = {'name': 'Shared results', 'species': ['H2O'], 'activity_model': 'ideal', 'gas_model': 'ideal'}
    content = {
        'run.json': {'format': 'easyreaktoro-run', 'schema_version': 1, 'job_id': 'a'*32},
        'status.json': {'status': status, 'stage': 'complete', 'completed': count if reported is None else reported,
                        'total': total, 'started_at': 1, 'finished_at': 2, 'message': 'Saved result'},
        'metadata.json': {'config': config, 'partial_results': False, 'process_balance': [], 'row_counts': {'summary': 999}},
        'simulation.ersim.json': {'config': config, 'database': {'name': 'Source DB', 'path': '/Users/original/source.rtdb'}},
    }
    for name, value in content.items(): (root/name).write_text(json.dumps(value), encoding='utf-8')
    rows = []
    for index in range(count):
        rows.append({'summary': {'run_index': index, 'pass': 1, 'step': index+1, 'temperature_c': 25+index,
                                  'pressure_bar': 1, 'pH': 7-index/10, 'max_component_balance_error_mol': 0},
                     'species': [{'run_index': index, 'species': 'H2O', 'formula': 'H2O', 'phase_type': 'aqueous',
                                  'amount_mol': index+10, 'inlet_amount_mol': index+10, 'delta_amount_mol': 0,
                                  'molality': None, 'activity': 1, 'activity_coefficient': 1}],
                     'balances': [], 'process_balance': [{'component': 'H', 'input_mol': index+10, 'inventory_mol': index+10, 'error_mol': 0}]})
    (root/'points.ndjson').write_bytes(b''.join((json.dumps(row)+'\n').encode() for row in rows)+tail)
    # Deliberately stale derived files: preview must use the committed records.
    (root/'summary.csv').write_text('stale source CSV', encoding='utf-8')
    (root/'Result Explorer.html').write_text('stale source HTML', encoding='utf-8')
    (root/'worker.lock').write_text('old worker', encoding='utf-8')
    return root


def contents(root):
    return {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir() if p.is_file()}


@contextmanager
def read_only(root, guard_repair=True):
    for p in root.iterdir(): p.chmod(0o444)
    root.chmod(0o555)
    try:
        with ExitStack() as stack:
            if guard_repair:
                for name in ('atomic_json', 'rebuild_tables', 'write_explorer'):
                    stack.enter_context(patch('bridge.easyreaktoro_runtime.simulation_jobs.'+name,
                                              side_effect=AssertionError('Viewing attempted to write: '+name)))
            yield
    finally:
        root.chmod(0o755)
        for p in root.iterdir(): p.chmod(0o644)


class SavedResultReadingTests(unittest.TestCase):
    def manager(self):
        manager = Jobs(); self.addCleanup(manager.close); return manager

    def test_complete_stopped_and_failed_results_open_on_read_only_media(self):
        for status in ('completed', 'cancelled', 'failed', 'interrupted'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                root = make_result(directory, status, total=2 if status=='completed' else 4)
                before = contents(root); manager = self.manager()
                with read_only(root):
                    opened = manager.open_run(root)
                    self.assertEqual(opened['status'], status); self.assertEqual(opened['completed'], 2)
                    self.assertEqual(opened['output_path'], str(root.resolve()))
                    result = manager.result(opened['job_id'], run_index=1)
                    self.assertEqual(result['species'][0]['amount_mol'], 11)
                    preview = manager.explorer(opened['job_id'])
                    payload = json.loads(gzip.decompress(base64.b64decode(preview['data'])))
                    self.assertEqual(payload['summary']['rows'][1][0], 1)
                    self.assertEqual(len(payload['summary']['rows']), 2)
                    self.assertEqual(manager.cancel(opened['job_id'])['status'], status)
                self.assertEqual(contents(root), before)

    def test_torn_json_and_multibyte_tail_preserve_complete_prefix_and_source_files(self):
        for tail in (b'{"torn":', b'{"torn":}\n', b'{"text":"\xe4\xb8', b'{"text":"\xff"}\n'):
            with self.subTest(tail=tail), tempfile.TemporaryDirectory() as directory:
                root = make_result(directory, count=1, reported=2, tail=tail)
                before = contents(root); manager = self.manager()
                with read_only(root):
                    opened = manager.open_run(root)
                    self.assertEqual(opened['status'], 'interrupted'); self.assertEqual(opened['completed'], 1)
                    self.assertEqual(manager.status(opened['job_id'])['completed'], 1)
                    self.assertEqual(manager.explorer(opened['job_id'])['point_count'], 1)
                    self.assertEqual(len(manager.result(opened['job_id'])['summary']), 1)
                    self.assertTrue(manager.result(opened['job_id'])['metadata']['partial_results'])
                self.assertEqual(contents(root), before)

    def test_no_complete_record_is_an_empty_interrupted_view_not_stale_csv_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = make_result(directory, count=0, reported=2, tail=b'{"summary":')
            before = contents(root); manager = self.manager()
            with read_only(root):
                opened = manager.open_run(root)
                self.assertEqual((opened['status'], opened['completed']), ('interrupted', 0))
                self.assertEqual(manager.result(opened['job_id'])['summary'], [])
                self.assertEqual(manager.explorer(opened['job_id'])['point_count'], 0)
            self.assertEqual(contents(root), before)

    def test_unowned_stale_running_lock_is_preserved_but_an_active_writer_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = make_result(directory, status='running', count=1)
            before = contents(root); manager = self.manager()
            with read_only(root):
                with (root/'worker.lock').open('rb') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaisesRegex(BridgeError, '另一计算进程'):
                        manager.open_run(root)
                opened = manager.open_run(root)
                self.assertEqual((opened['status'], opened['completed']), ('interrupted', 1))
                self.assertTrue((root/'worker.lock').is_file())
            self.assertEqual(contents(root), before)

    def test_export_recovers_only_the_new_copy_even_if_source_permissions_are_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = make_result(directory, status='failed', count=1, reported=2, tail=b'{"torn":')
            parent = Path(directory)/'copies'; parent.mkdir()
            before = contents(root); manager = self.manager()
            with read_only(root, guard_repair=False):
                opened = manager.open_run(root); exported = manager.export(opened['job_id'], parent)
                self.assertEqual(contents(root), before)
            target = Path(exported['output_path'])
            report = json.loads((target/'status.json').read_text())
            self.assertEqual((report['status'], report['completed']), ('interrupted', 1))
            self.assertEqual(exported['row_counts']['summary'], 1)
            self.assertEqual(len((target/'summary.csv').read_text().splitlines()), 2)
            self.assertIn('payload', (target/'Result Explorer.html').read_text())
            self.assertFalse((target/'worker.lock').exists())
            self.assertTrue(json.loads((target/'metadata.json').read_text())['partial_results'])
            self.assertEqual(self.manager().open_run(target)['completed'], 1)

    def test_export_rejects_nested_destination_before_creating_a_recursive_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = make_result(directory); nested = root/'nested'; nested.mkdir()
            before = contents(root); manager = self.manager(); opened = manager.open_run(root)
            for parent in (root, nested):
                with self.assertRaisesRegex(BridgeError, '之外'): manager.export(opened['job_id'], parent)
            self.assertEqual(contents(root), before); self.assertEqual(list(nested.iterdir()), [])

    def test_reopening_the_same_result_rereads_updated_saved_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = make_result(directory, count=1, reported=2)
            manager = self.manager(); first = manager.open_run(root)
            report = json.loads((root/'status.json').read_text()); report.update(status='cancelled', completed=1)
            (root/'status.json').write_text(json.dumps(report))
            second = manager.open_run(root)
            self.assertEqual(second['job_id'], first['job_id'])
            self.assertEqual(second['status'], 'cancelled')
            self.assertEqual(len(list(records(root))), 1)


if __name__ == '__main__': unittest.main()
