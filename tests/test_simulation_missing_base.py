"""An unfilled composition base is required only where it actually supplies matter."""
import copy
import json
import math
import tempfile
import time
import unittest
from pathlib import Path
from tests.test_simulation import reaktoro
from tests.test_simulation_loops import plan, values
from tests.test_simulation_process import route
from tests.test_simulation_reactions import stages
from tests.test_simulation_schedule import scheduled, setting, fixed, override
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.simulation import Simulation, normalize_config
from bridge.easyreaktoro_runtime.simulation_code import parse_code, render_code
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs, database_source
from bridge.easyreaktoro_runtime.simulation_loops import execution_config
from bridge.easyreaktoro_runtime.simulation_program import prepare_program
from bridge.easyreaktoro_runtime.simulation_storage import records
from bridge.easyreaktoro_runtime.simulation_templates import load_settings

EMPTY = {'easyreaktoro_empty_number': True}


def salt_setting(value=.2):
    return setting('salt', 'material_amount', fixed(value), material_id='initial', species='NaCl(aq)')


@unittest.skipIf(reaktoro is None, 'External Reaktoro required')
class MissingMaterialBaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = Service()
        cls.handle = cls.service.handle(cls.service.open_official('SUPCRT', 'supcrtbl')['handle_id'])
        cls.source = database_source(cls.handle)

    @classmethod
    def tearDownClass(cls):
        cls.service.simulation_jobs.close()

    def normalize(self, cfg):
        return normalize_config(cfg, self.handle['records'], self.source)[0]

    def run_plan(self, cfg):
        rows = []
        sim = Simulation({'config': cfg, 'records': self.handle['records'], 'source': self.source})
        meta = sim.run(rows.append)
        self.assertTrue(all(abs(row['error_mol']) < 1e-10 for row in meta['process_balance']))
        self.assertTrue(all(math.isfinite(row['summary']['pH']) for row in rows))
        return sim, rows, meta

    def sodium(self, rows):
        return [next(entry['input_mol'] for entry in row['balances'] if entry['component'] == 'Na') for row in rows]

    def test_complete_schedule_covers_null_marker_and_nan_without_replacing_saved_base(self):
        for empty in (None, EMPTY, float('nan')):
            with self.subTest(empty=empty):
                cfg = scheduled(2)
                cfg['materials'][0]['inputs'][1]['amount'] = copy.deepcopy(empty)
                cfg['schedule']['parameters'].append(salt_setting())
                sim, rows, _ = self.run_plan(cfg)
                self.assertEqual(self.sodium(rows), [.2, .2])
                saved = sim.original_config['materials'][0]['inputs'][1]['amount']
                self.assertTrue(math.isnan(saved) if type(empty) is float else saved == empty)
                self.assertEqual(sim.materials['initial']['NaCl(aq)'], 0.)
                projected = execution_config(self.normalize(cfg), fill_missing=False)
                retained = projected['materials'][0]['inputs'][1]['amount']
                self.assertTrue(math.isnan(retained) if type(empty) is float else retained == empty)

    def test_only_actual_fresh_feed_needs_coverage_including_legacy_fallback(self):
        for explicit in (False, True):
            cfg = scheduled(3)
            cfg['materials'][0]['inputs'][1]['amount'] = None
            cfg['schedule']['overrides'] = [override('first-dose', [salt_setting()], positions={'start': 1, 'end': 1})]
            if explicit:
                cfg['reaction_stages'] = stages(first_start=[route(id='feed')], first_following=[route('previous_point', id='inherit')])
            else:
                cfg['routes'] = [route('previous_point', id='feed')]
            _, rows, meta = self.run_plan(cfg)
            for amount in self.sodium(rows):
                self.assertAlmostEqual(amount, .2, delta=1e-10)
            sodium_inventory = [entry for entry in meta['process_balance'] if entry['component'] == 'Na']
            self.assertTrue(all(abs(entry['input_mol']-.2) < 1e-10 for entry in sodium_inventory))

    def test_phase_species_filters_zero_effective_fraction_and_unused_recipe_do_not_require_base(self):
        cfg = scheduled(2)
        cfg['materials'][0]['inputs'][1]['amount'] = None
        cfg['materials'].append({'id': 'unused', 'name': 'Unused composition', 'inputs': [{'species': 'H2O(aq)', 'amount': None, 'unit': 'kg'}]})
        cfg['routes'] = [route(phase='species', species=['H2O(aq)'], id='water'), route(id='zero', fraction=1), route(phase='mineral', id='empty-phase')]
        cfg['schedule']['parameters'].append(setting('no-salt', 'route_fraction', fixed(0), route_id='zero', field='fraction'))
        _, rows, _ = self.run_plan(cfg)
        self.assertTrue(all(abs(value) < 1e-12 for value in self.sodium(rows)))
        # Changing only the actual effective multiplier makes the base required.
        cfg['schedule']['parameters'][-1]['value'] = fixed(1)
        with self.assertRaisesRegex(BridgeError, '第 1 轮、路径位置 1.*NaCl.*未填写'):
            self.normalize(cfg)

    def test_first_uncovered_actual_feed_reports_coordinate_and_remains_empty(self):
        cfg = scheduled(2, 2)
        cfg['materials'][0]['inputs'][1]['amount'] = None
        cfg['schedule']['overrides'] = [override('first-round', [salt_setting()], rounds={'start': 1, 'end': 1})]
        with self.assertRaisesRegex(BridgeError, '第 2 轮、路径位置 1.*NaCl.*未填写'):
            self.normalize(cfg)
        self.assertIsNone(cfg['materials'][0]['inputs'][1]['amount'])
        cfg['schedule']['overrides'][0]['rounds'] = {'start': 1}
        self.normalize(cfg)
        cfg['schedule']['overrides'][0]['positions'] = {'start': 1, 'end': 1}
        with self.assertRaisesRegex(BridgeError, '第 1 轮、路径位置 2.*NaCl.*未填写'):
            self.normalize(cfg)
        cfg['schedule']['overrides'] = []
        with self.assertRaisesRegex(BridgeError, '第 1 轮、路径位置 1.*NaCl.*未填写'):
            self.normalize(cfg)

    def test_missing_base_exception_never_allows_invalid_explicit_profile_or_invalid_base_number(self):
        cfg = scheduled()
        cfg['materials'][0]['inputs'][1]['amount'] = None
        cfg['routes'] = [route(phase='species', species=['H2O(aq)'], id='water')]
        for invalid in (float('nan'), EMPTY, float('inf')):
            cfg['schedule']['parameters'] = cfg['schedule']['parameters'][:2]+[salt_setting(invalid)]
            with self.assertRaisesRegex(BridgeError, '有限数值'):
                self.normalize(cfg)
        cfg['schedule']['parameters'][-1] = salt_setting()
        for invalid in (-1, float('inf'), True, 'unfinished'):
            cfg['materials'][0]['inputs'][1]['amount'] = invalid
            with self.assertRaises(BridgeError):
                self.normalize(cfg)

    def test_water_base_can_be_empty_when_actual_water_dose_is_supplied(self):
        cfg = scheduled(2)
        cfg['materials'][0]['inputs'][0]['amount'] = None
        cfg['schedule']['parameters'].append(setting('water', 'material_amount', fixed(1), material_id='initial', species='H2O(aq)'))
        _, rows, _ = self.run_plan(cfg)
        self.assertEqual(len(rows), 2)
        cfg['schedule']['parameters'].pop()
        with self.assertRaisesRegex(BridgeError, 'H2O.*未填写'):
            self.normalize(cfg)

    def test_legacy_quantity_axis_covers_base_and_no_plan_unused_recipe_is_safe(self):
        cfg = plan(values('material_amount', [.1, .2], material_id='initial', species='NaCl(aq)'))
        cfg['materials'][0]['inputs'][1]['amount'] = None
        _, rows, _ = self.run_plan(cfg)
        self.assertEqual(self.sodium(rows), [.1, .2])
        # Omitted route fields use the same defaults as the regular preflight.
        cfg['routes'] = [{'source': 'material', 'phase': 'all', 'material_id': 'initial'}]
        _, rows, _ = self.run_plan(cfg)
        self.assertEqual(self.sodium(rows), [.1, .2])
        cfg.pop('loops')
        cfg['routes'] = [route(phase='species', species=['H2O(aq)'], id='water')]
        _, rows, _ = self.run_plan(cfg)
        self.assertEqual(self.sodium(rows), [0])

    def test_saved_code_and_old_custom_build_replay_empty_base_and_actual_quantity(self):
        cfg = scheduled(2)
        cfg['materials'][0]['inputs'][1]['amount'] = copy.deepcopy(EMPTY)
        cfg['schedule']['parameters'].append(salt_setting())
        cfg, document, _ = prepare_program(cfg)
        self.assertIsNone(cfg['materials'][0]['inputs'][1]['amount'])
        materials = next(cell for cell in document['cells'] if cell['id'] == 'materials')
        self.assertIn("'amount': None", materials['source'])
        self.assertNotIn('easyreaktoro_empty_number', materials['source'])
        materials['source'] += '\n# My composition explanation\n'
        restored = render_code(cfg, {'config': cfg, 'cells': document['cells']})
        self.assertEqual(next(cell['source'] for cell in restored['cells'] if cell['id'] == 'materials'), materials['source'])
        self.assertTrue(parse_code(document, cfg)['valid'])
        build = next(cell for cell in document['cells'] if cell['id'] == 'build')
        before = "    self.loop_plan = LoopPlan(self.cfg) if self.cfg.get('schedule') or self.cfg.get('loops') else None\n    self.cfg = execution_config(self.cfg, self.loop_plan)"
        self.assertIn(before, build['source'])
        build['source'] = build['source'].replace(before, "    self.cfg = execution_config(self.cfg)\n    self.loop_plan = LoopPlan(self.cfg) if self.cfg.get('loops') else None")+'\n# Existing custom build logic\n'
        editor = {'version': 1, 'mode': 'code', 'config': cfg, 'document': document, 'dirty': True}
        jobs = Jobs()
        try:
            with tempfile.TemporaryDirectory() as directory:
                result = jobs.start(self.handle, cfg, directory, editor)
                deadline = time.monotonic()+20
                while jobs.status(result['job_id'])['status'] == 'running' and time.monotonic() < deadline:
                    time.sleep(.03)
                status = jobs.status(result['job_id'])
                self.assertEqual(status['status'], 'completed', status)
                folder = Path(result['output_path'])
                self.assertEqual(self.sodium(list(records(folder))), [.2, .2])
                saved = json.loads((folder/'input.json').read_text())
                self.assertIsNone(saved['config']['materials'][0]['inputs'][1]['amount'])
                loaded = load_settings(folder/'simulation.ersim.json')
                replay, code, _ = prepare_program(loaded['config'], loaded['code_editor'])
                self.assertIsNone(replay['materials'][0]['inputs'][1]['amount'])
                self.assertEqual(next(cell['source'] for cell in code['cells'] if cell['id'] == 'build'), build['source'])
                self.assertEqual(next(cell['source'] for cell in code['cells'] if cell['id'] == 'materials'), materials['source'])
                self.normalize(replay)
        finally:
            jobs.close()
