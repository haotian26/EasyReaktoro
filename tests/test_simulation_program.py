"""Run edited Python through the actual worker, and attack its save boundaries."""
import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from tests.test_simulation import config, reaktoro
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.simulation import Simulation, normalize_config
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs, database_source
from bridge.easyreaktoro_runtime.simulation_program import prepare_program, execution_identity
from bridge.easyreaktoro_runtime.simulation_code import parse_code, render_code
from bridge.easyreaktoro_runtime.simulation_storage import records
from bridge.easyreaktoro_runtime.errors import BridgeError


@unittest.skipIf(reaktoro is None, 'External Reaktoro required')
class ExecutableProgramTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = Service()
        cls.handle = cls.service.handle(cls.service.open_official('SUPCRT', 'supcrtbl')['handle_id'])
        cls.source = database_source(cls.handle)

    @classmethod
    def tearDownClass(cls):
        cls.service.simulation_jobs.close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.jobs = Jobs()
        self.addCleanup(self.jobs.close)
        self.cfg, self.doc, _ = prepare_program(config())
        self.editor = {'version': 1, 'mode': 'code', 'config': copy.deepcopy(self.cfg), 'document': self.doc, 'dirty': False}

    def cell(self, name):
        return next(c for c in self.doc['cells'] if c['id'] == name)

    def run_code(self, editor=True):
        job = self.jobs.start(self.handle, self.cfg, self.tmp.name, self.editor if editor else None)
        deadline = time.monotonic() + 15
        while job['status'] == 'running' and time.monotonic() < deadline:
            time.sleep(.03)
            job = self.jobs.status(job['job_id'])
        self.assertNotEqual(job['status'], 'running')
        root = Path(job['output_path'])
        return job, list(records(root)), root

    def test_standard_visible_program_matches_existing_solver_and_saves_exact_source(self):
        expected = []
        sim = Simulation({'config': self.cfg, 'records': self.handle['records'], 'source': self.source})
        sim.run(expected.append)
        job, actual, root = self.run_code()
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(actual, expected)
        saved = json.loads((root/'input.json').read_text())
        self.assertEqual(saved['program']['cells'], self.doc['cells'])
        self.assertEqual(saved['execution'], execution_identity(self.doc))
        self.assertIn('self.solver.solve(work, conditions)', (root/'program.py').read_text())

    def test_editing_process_changes_real_solved_conditions_and_is_preserved_on_ui_run(self):
        cell = self.cell('process')
        cell['source'] = cell['source'].replace('point = actual_point(base, cycle)', 'point = {**actual_point(base, cycle), "temperature_c": 80.0}')
        self.editor['mode'] = 'ui'
        self.cfg['points'][0]['pressure_bar'] = 15
        job, rows, root = self.run_code()
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(rows[0]['summary']['temperature_c'], 80)
        self.assertEqual(rows[0]['summary']['pressure_bar'], 15)
        self.assertEqual(job['execution']['mode'], 'custom')
        self.assertLess(rows[0]['summary']['max_component_balance_error_mol'], 1e-10)
        self.assertEqual(json.loads((root/'input.json').read_text())['program']['cells'][-2]['source'], cell['source'])

    def test_validation_of_code_never_executes_and_syntax_stops_before_folder_creation(self):
        sentinel = Path(self.tmp.name)/'sentinel'
        self.cell('execute')['source'] = f'from pathlib import Path\nPath({str(sentinel)!r}).touch()\n' + self.cell('execute')['source']
        self.assertTrue(parse_code(self.doc, self.cfg)['valid'])
        self.assertFalse(sentinel.exists())
        self.cell('equilibrium')['source'] += '\nif :\n'
        issue = parse_code(self.doc, self.cfg)
        self.assertFalse(issue['valid'])
        self.assertEqual(issue['errors'][0]['cell_id'], 'equilibrium')
        self.assertTrue(parse_code(self.doc, self.cfg, parameters_only=True)['valid'])
        with self.assertRaises(BridgeError):
            self.run_code()
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_runtime_error_names_cell_and_preserves_completed_points(self):
        cell = self.cell('process')
        cell['source'] = cell['source'].replace('emit(record)', 'emit(record)\n            raise RuntimeError("custom failure")')
        job, rows, root = self.run_code()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(len(rows), 1)
        self.assertIn('反应推进与物料传递 · 第', job['diagnostic'])
        self.assertIn('custom failure', job['diagnostic'])
        self.assertTrue((root/'Result Explorer.html').is_file())
        self.assertEqual(json.loads((root/'metadata.json').read_text())['execution']['mode'], 'custom')

    def test_empty_custom_program_cannot_report_success(self):
        self.cell('execute')['source'] = 'metadata = {}\n'
        job, rows, _ = self.run_code()
        self.assertEqual(job['status'], 'failed')
        self.assertFalse(rows)
        self.assertIn('没有保存任何结果点', job['diagnostic'])

    def test_cancel_custom_loop_and_keep_valid_prefix(self):
        self.cell('execute')['source'] += '\nimport time\nwhile True:\n    time.sleep(.1)\n'
        job = self.jobs.start(self.handle, self.cfg, self.tmp.name, self.editor)
        deadline = time.monotonic()+10
        while job['completed'] == 0 and time.monotonic()<deadline:
            time.sleep(.03)
            job = self.jobs.status(job['job_id'])
        self.assertGreater(job['completed'], 0)
        ended = self.jobs.cancel(job['job_id'])
        self.assertEqual(ended['status'], 'cancelled')
        self.assertEqual(ended['completed'], job['completed'])

    def test_incomplete_custom_result_is_rejected_before_durable_commit(self):
        self.cell('execute')['source'] = 'emit({"summary": {"run_index": 0}})\nmetadata = {}\n'
        job, rows, _ = self.run_code()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(rows, [])

    def test_changing_csv_columns_fails_before_committing_a_broken_second_point(self):
        cell = self.cell('execute')
        cell['source'] = """simulation = SimulationProgram(snapshot, progress)
rows = []
metadata = simulation.run(rows.append)
emit(rows[0])
second = copy.deepcopy(rows[0])
second['summary']['run_index'] = 1
second['summary']['only_on_second_point'] = 123
for row in second['species']:
    row['run_index'] = 1
emit(second)
"""
        job, rows, root = self.run_code()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(len(rows), 1)
        self.assertIn('列在本次运行中须保持一致', job['diagnostic'])
        self.assertTrue((root/'Result Explorer.html').is_file())

    def test_dynamic_activity_callback_exits_cleanly_in_generated_program(self):
        cfg = config(activity_model='nacl_edh')
        cfg['ion_size_overrides'] = {n: {'a_angstrom': 4, 'source': 'Synthetic test', 'reason': 'Worker callback lifecycle regression'} for n in ('H+', 'OH-', 'Na+', 'Cl-')}
        self.cfg, self.doc, _ = prepare_program(cfg)
        self.editor.update(config=copy.deepcopy(self.cfg), document=self.doc)
        job, rows, _ = self.run_code()
        self.assertEqual(job['status'], 'completed', job)
        self.assertTrue(rows)
        self.assertEqual(self.jobs.job(job['job_id'])['process'].returncode, 0)

    def test_nonzero_worker_exit_cannot_be_reported_as_completed(self):
        self.cell('execute')['source'] += '\nimport os\nprogress(status="completed")\nos._exit(7)\n'
        job, rows, _ = self.run_code()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(len(rows), 1)
        self.assertIn('7', job['diagnostic'])

    def test_legacy_six_cell_documents_upgrade_without_losing_unfinished_code(self):
        legacy = {'version': 1, 'cells': copy.deepcopy(self.doc['cells'][:6])}
        legacy['cells'][2]['source'] = '# still editing\npoints = ['
        upgraded = render_code(self.cfg, {'cells': legacy['cells'], 'config': self.cfg})
        self.assertEqual(upgraded['cells'][2]['source'], legacy['cells'][2]['source'])
        self.assertEqual(upgraded['version'], 2)
        self.assertEqual(len(upgraded['cells']), 14)

    def test_unchanged_old_execution_cells_upgrade_but_custom_code_remains(self):
        old = self.cell('collect')
        old['source'] = '# old shipped collect module\n' + old['source']
        old['baseline_source'] = old['source']
        custom = self.cell('process')
        custom['source'] += '\n# user custom program note\n'
        for mode in ('ui','code'):
            self.editor['mode']=mode
            _,document,_=prepare_program(self.cfg,self.editor)
            cells={c['id']:c for c in document['cells']}
            self.assertNotIn('old shipped collect module',cells['collect']['source'])
            self.assertEqual(cells['process']['source'],custom['source'])
