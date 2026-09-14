"""UI/code authority errors can conserve mass while solving the wrong problem."""
import copy
import tempfile
import time
import unittest
from pathlib import Path
from tests.test_simulation import reaktoro
from tests.test_simulation_loops import plan
from tests.test_simulation_schedule import scheduled, fixed
from tests.test_simulation_process import route
from tests.test_simulation_reactions import stages
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.simulation_code import parse_code, render_code
from bridge.easyreaktoro_runtime.simulation_program import prepare_program
from bridge.easyreaktoro_runtime.simulation_schedule import to_schedule
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs
from bridge.easyreaktoro_runtime.simulation_storage import records


@unittest.skipIf(reaktoro is None, 'External Reaktoro required')
class ParameterAuthorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = Service()
        cls.handle = cls.service.handle(cls.service.open_official('SUPCRT', 'supcrtbl')['handle_id'])
        cls.database = reaktoro.SupcrtDatabase('supcrtbl')
        aqueous = reaktoro.AqueousPhase('H2O(aq) H+ OH- Na+ Cl- NaCl(aq)')
        aqueous.setActivityModel(reaktoro.ActivityModelIdealAqueous())
        cls.system = reaktoro.ChemicalSystem(cls.database, aqueous)

    @classmethod
    def tearDownClass(cls):
        cls.service.simulation_jobs.close()

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.jobs = Jobs()
        self.addCleanup(self.jobs.close)

    def oracle(self, temperature, portions=1):
        # Independent state assembly and the public equilibrate API. This does
        # not reuse Simulation.state/solve, ProcessInventory or schedule values.
        state = reaktoro.ChemicalState(self.system)
        state.setSpeciesAmounts(0.)
        state.temperature(temperature, 'celsius')
        state.pressure(1, 'bar')
        state.set('H2O(aq)', portions, 'kg')
        state.set('NaCl(aq)', .1*portions, 'mol')
        self.assertTrue(reaktoro.equilibrate(state).succeeded())
        return state

    def run_document(self, cfg, document, mode='ui'):
        editor = {'version': 1, 'mode': mode, 'config': copy.deepcopy(cfg), 'document': document, 'dirty': False}
        started = self.jobs.start(self.handle, cfg, self.folder.name, editor)
        deadline = time.monotonic()+20
        while self.jobs.status(started['job_id'])['status'] == 'running' and time.monotonic() < deadline:
            time.sleep(.03)
        status = self.jobs.status(started['job_id'])
        self.assertEqual(status['status'], 'completed', status)
        return list(records(Path(status['output_path'])))[0]

    def assert_oracle(self, row, temperature, portions=1):
        expected = self.oracle(temperature, portions)
        self.assertEqual(row['summary']['temperature_c'], temperature)
        self.assertAlmostEqual(row['summary']['pH'], float(reaktoro.AqueousProps(expected).pH()), delta=1e-9)
        for species in row['species']:
            self.assertAlmostEqual(species['amount_mol'], float(expected.speciesAmount(species['species'])), delta=1e-10)

    def test_ui_config_wins_when_restored_baseline_matches_but_parameter_text_is_stale(self):
        cfg, document, _ = prepare_program(scheduled())
        cfg['schedule']['parameters'][0]['value'] = fixed(100)
        row = self.run_document(cfg, document)
        self.assert_oracle(row, 100)

    def test_ui_chemistry_wins_over_stale_material_and_transfer_cells(self):
        cfg, document, _ = prepare_program(scheduled())
        for entry in cfg['materials'][0]['inputs']:
            entry['amount'] *= 2
        cfg['routes'][0]['fraction'] = .25
        row = self.run_document(cfg, document)
        self.assert_oracle(row, 25, .5)

    def test_visible_legacy_loops_override_an_implicitly_migrated_schedule(self):
        cfg, document, _ = prepare_program(plan())
        cfg['schedule'] = to_schedule(cfg)
        cfg.pop('loops')
        source = next(c for c in document['cells'] if c['id'] == 'conditions')
        self.assertIn("'temperature_c': 25", source['source'])
        source['source'] = source['source'].replace("'temperature_c': 25", "'temperature_c': 100") + '\n# Keep my loop explanation\n'
        parsed = parse_code(document, cfg)
        self.assertTrue(parsed['valid'], parsed)
        self.assertNotIn('schedule', parsed['config'])
        row = self.run_document(cfg, document, 'code')
        self.assert_oracle(row, 100)

    def test_visible_old_point_table_overrides_hidden_loops_and_schedule(self):
        cfg, document, _ = prepare_program(plan())
        cfg['schedule'] = to_schedule(cfg)
        next(c for c in document['cells'] if c['id'] == 'conditions')['source'] = "points = [{'id': 'p1', 'temperature_c': 100, 'pressure_bar': 1}]\ncycles = 1\n"
        parsed = parse_code(document, cfg)
        self.assertTrue(parsed['valid'], parsed)
        self.assertNotIn('schedule', parsed['config'])
        self.assertNotIn('loops', parsed['config'])
        row = self.run_document(cfg, document, 'code')
        self.assert_oracle(row, 100)

    def test_visible_routes_replace_migrated_stages_instead_of_silently_using_them(self):
        cfg = scheduled()
        cfg['reaction_stages'] = stages(first_start=[route(id='double-feed', fraction=2)])
        cfg, document, _ = prepare_program(cfg)
        next(c for c in document['cells'] if c['id'] == 'transfers')['source'] = 'routes = '+repr([route(id='visible-feed', fraction=.5)])+'\n'
        parsed = parse_code(document, cfg)
        self.assertTrue(parsed['valid'], parsed)
        self.assertNotIn('reaction_stages', parsed['config'])
        row = self.run_document(cfg, document, 'code')
        self.assert_oracle(row, 25, .5)

    def test_render_reconciles_valid_stale_values_without_rewriting_aligned_comments_or_drafts(self):
        cfg, document, _ = prepare_program(scheduled())
        condition = next(c for c in document['cells'] if c['id'] == 'conditions')
        condition['source'] += '\n# My explanation\n'
        same = render_code(cfg, {'config': cfg, 'cells': document['cells']})
        self.assertEqual(next(c for c in same['cells'] if c['id'] == 'conditions')['source'], condition['source'])
        cfg['schedule']['parameters'][0]['value'] = fixed(100)
        changed = render_code(cfg, {'config': cfg, 'cells': document['cells']})
        self.assertEqual(parse_code(changed, cfg)['config']['schedule']['parameters'][0]['value'], fixed(100))
        condition['source'] = 'schedule = ['
        draft = render_code(cfg, {'config': cfg, 'cells': document['cells']})
        self.assertEqual(next(c for c in draft['cells'] if c['id'] == 'conditions')['source'], 'schedule = [')
