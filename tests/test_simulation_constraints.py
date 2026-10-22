"""Open equilibrium constraints checked against independent finite-dose solves."""
import copy
import json
import math
from pathlib import Path
import tempfile
import time
import unittest
from tests.test_simulation import reaktoro as r
from tests.test_simulation_schedule import scheduled, setting, fixed, override
from tests.test_simulation_process import route
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.simulation import Simulation, normalize_config
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs, database_source
from bridge.easyreaktoro_runtime.simulation_storage import records, rebuild_tables, explorer_payload
from bridge.easyreaktoro_runtime.simulation_program import prepare_program
from bridge.easyreaktoro_runtime.simulation_code import render_code, parse_code
from bridge.easyreaktoro_runtime.simulation_schedule import SchedulePlan


def ph(value=4, titrant='HCl', exchange='add_only', identity='acidity', **scope):
    return dict(id=identity, kind='ph', value=value, titrant=titrant, exchange=exchange, **scope)


def gas(value=.01, species='CO2(g)', identity='gas', **scope):
    return dict(id=identity, kind='fugacity', value=value, species=species, **scope)


def carbonate(positions=1, rounds=1):
    cfg = scheduled(positions, rounds)
    cfg['species'] += ['CO2(aq)', 'HCO3-', 'CO3-2']
    return cfg


@unittest.skipIf(r is None, 'External Reaktoro required')
class OpenEquilibriumTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = Service()
        cls.handle = cls.service.handle(cls.service.open_official('SUPCRT', 'supcrtbl')['handle_id'])
        cls.source = database_source(cls.handle)
        cls.database = r.SupcrtDatabase('supcrtbl')

    @classmethod
    def tearDownClass(cls):
        cls.service.simulation_jobs.close()

    def run_cfg(self, cfg, source=None):
        simulation = Simulation({'config': cfg, 'records': self.handle['records'], 'source': source or self.source})
        rows = []
        metadata = simulation.run(rows.append)
        self.assertLess(max(abs(b['error_mol']) for row in rows for b in row['balances']), 1e-10)
        self.assertLess(max(abs(b['error_mol']) for row in rows for b in row['process_balance']), 1e-9)
        for row in rows:
            charge = next(b for b in row['balances'] if b['component'] == 'charge')
            self.assertLess(abs(charge['output_mol']), 1e-10)
            for balance in row['balances']:
                self.assertAlmostEqual(balance['input_mol']+balance.get('external_exchange_mol', 0), balance['output_mol'], delta=1e-10)
        return rows, metadata

    def finite_dose_oracle(self, cfg, dose, titrant):
        # Ordinary CLOSED equilibrium, explicit finite neutral reagent input.
        # No custom constraints, schedule, Simulation helper or process ledger.
        aqueous = r.AqueousPhase(r.StringList(cfg['species']))
        aqueous.setActivityModel(r.ActivityModelIdealAqueous())
        system = r.ChemicalSystem(self.database, aqueous)
        state = r.ChemicalState(system)
        state.setSpeciesAmounts(0.)
        state.temperature(25, 'celsius'); state.pressure(1, 'bar')
        state.set('H2O(aq)', 1, 'kg'); state.set('NaCl(aq)', .1, 'mol')
        if titrant == 'HCl':
            state.add('H+', dose, 'mol'); state.add('Cl-', dose, 'mol')
        elif titrant == 'NaOH':
            state.add('Na+', dose, 'mol'); state.add('OH-', dose, 'mol')
        else:
            state.add(titrant, dose, 'mol')
        self.assertTrue(r.equilibrate(state).succeeded())
        return state

    def test_acid_and_base_targets_match_independent_finite_dose_root(self):
        for reagent, target, descending in [('HCl', 4, True), ('NaOH', 10, False)]:
            with self.subTest(reagent=reagent):
                cfg = scheduled(); cfg['equilibrium_constraints'] = [ph(target, reagent)]
                rows, _ = self.run_cfg(cfg)
                lo, hi = 0., .01
                for _ in range(38):
                    middle = (lo+hi)/2
                    state = self.finite_dose_oracle(cfg, middle, reagent)
                    actual = float(r.AqueousProps(state).pH())
                    if (actual > target) == descending: lo = middle
                    else: hi = middle
                amount = rows[0]['constraints'][0]['exchange_mol']
                self.assertAlmostEqual(amount, (lo+hi)/2, delta=1e-11)
                for species in rows[0]['species']:
                    self.assertAlmostEqual(species['amount_mol'], float(state.speciesAmount(species['species'])), delta=1e-10)
                self.assertAlmostEqual(rows[0]['summary']['pH'], target, delta=1e-7)

    def test_add_only_rejects_removal_and_both_records_signed_removal(self):
        cfg = scheduled(); cfg['equilibrium_constraints'] = [ph(10)]
        with self.assertRaisesRegex(BridgeError, '仅允许加入|需要移除'):
            self.run_cfg(cfg)
        cfg['equilibrium_constraints'][0]['exchange'] = 'both'
        rows, _ = self.run_cfg(cfg)
        self.assertLess(rows[0]['constraints'][0]['exchange_mol'], 0)
        self.assertAlmostEqual(rows[0]['summary']['pH'], 10, delta=1e-7)
        self.assertLess(next(b for b in rows[0]['process_balance'] if b['component'] == 'Cl')['external_exchange_mol'], 0)

    def test_general_gas_reference_is_not_added_as_phase_and_matches_closed_oracle(self):
        cfg = carbonate(); cfg['equilibrium_constraints'] = [gas()]
        rows, _ = self.run_cfg(cfg)
        self.assertNotIn('CO2(g)', [row['species'] for row in rows[0]['species']])
        lo, hi = 0., .01
        for _ in range(38):
            dose = (lo+hi)/2
            state = self.finite_dose_oracle(cfg, dose, 'CO2(aq)')
            props = r.ChemicalProps(state)
            mu = float(props.speciesChemicalPotential('CO2(aq)'))
            mu0 = float(self.database.species('CO2(g)').props(298.15, 1e5).G0)
            fugacity = math.exp((mu-mu0)/(float(r.universalGasConstant)*298.15))
            if fugacity < .01: lo = dose
            else: hi = dose
        self.assertAlmostEqual(rows[0]['constraints'][0]['exchange_mol'], (lo+hi)/2, delta=1e-11)
        for species in rows[0]['species']:
            self.assertAlmostEqual(species['amount_mol'], float(state.speciesAmount(species['species'])), delta=1e-10)

    def test_another_gas_works_without_co2_special_case(self):
        cfg = scheduled(); cfg['species'].append('N2(aq)')
        cfg['equilibrium_constraints'] = [gas(.1, 'N2(g)')]
        rows, _ = self.run_cfg(cfg)
        self.assertAlmostEqual(rows[0]['constraints'][0]['actual'], .1, delta=1e-8)
        self.assertGreater(rows[0]['constraints'][0]['exchange_mol'], 0)

    def test_trace_fugacity_is_validated_by_chemical_potential_not_amount_cutoff(self):
        cfg = scheduled(); cfg['species'].append('N2(aq)')
        cfg['equilibrium_constraints'] = [gas(1e-26, 'N2(g)')]
        rows, _ = self.run_cfg(cfg)
        result = rows[0]['constraints'][0]
        self.assertLess(abs(math.log(result['actual']/1e-26)), 1e-7)
        amount = next(row['amount_mol'] for row in rows[0]['species'] if row['species'] == 'N2(aq)')
        self.assertGreater(amount, 1e-30); self.assertLess(amount, 1e-28)
        cfg['equilibrium_constraints'][0]['value'] = 1e-30
        with self.assertRaisesRegex(BridgeError, '逸度未达到目标'):
            self.run_cfg(cfg)

    def test_gas_only_system_and_unanchored_open_system(self):
        cfg = scheduled(); cfg['species'] = ['H2(g)', 'N2(g)']; cfg['gas_model'] = 'ideal'
        cfg['materials'][0]['inputs'] = [{'species': n, 'amount': 1, 'unit': 'mol'} for n in cfg['species']]
        cfg['equilibrium_constraints'] = [gas(.2, 'N2(g)')]
        rows, _ = self.run_cfg(cfg)
        self.assertAlmostEqual(next(row for row in rows[0]['species'] if row['species'] == 'N2(g)')['amount_mol'], .25, delta=1e-8)
        self.assertAlmostEqual(rows[0]['constraints'][0]['exchange_mol'], -.75, delta=1e-8)
        cfg['equilibrium_constraints'].append(gas(.8, 'H2(g)', 'hydrogen'))
        with self.assertRaisesRegex(BridgeError, '缺少封闭组分'):
            self.run_cfg(cfg)

    def test_small_closed_inventory_is_not_compared_with_absolute_balance_tolerance(self):
        cfg = scheduled(); cfg['species'] = ['H2(g)', 'N2(g)']; cfg['gas_model'] = 'ideal'
        cfg['materials'][0]['inputs'] = [{'species': n, 'amount': 1e-12, 'unit': 'mol'} for n in cfg['species']]
        cfg['equilibrium_constraints'] = [gas(.2, 'N2(g)')]
        rows, _ = self.run_cfg(cfg)
        self.assertAlmostEqual(next(row for row in rows[0]['species'] if row['species'] == 'H2(g)')['amount_mol'], 1e-12, delta=1e-22)
        self.assertAlmostEqual(rows[0]['constraints'][0]['exchange_mol'], -7.5e-13, delta=1e-22)

    def test_fugacity_and_ph_at_changing_temperature_pressure_with_mineral(self):
        cfg = carbonate(2, 2); cfg['species'] += ['Ca+2', 'Calcite']
        cfg['materials'][0]['inputs'].append({'species': 'Calcite', 'amount': .001, 'unit': 'mol'})
        cfg['equilibrium_constraints'] = [ph(3), gas(.1)]
        cfg['schedule']['parameters'][0]['value'] = {'mode': 'list', 'along': 'path', 'values': [150, 100]}
        cfg['schedule']['parameters'][1]['value'] = {'mode': 'water_saturation'}
        cfg['schedule']['overrides'] = [override('high-pressure', [setting('P2', 'pressure', fixed(700))], rounds={'start': 2})]
        rows, _ = self.run_cfg(cfg)
        for row in rows:
            self.assertAlmostEqual(row['summary']['pH'], 3, delta=1e-7)
            self.assertAlmostEqual(row['summary']['constraint_gas_actual'], .1, delta=1e-7)
        self.assertEqual([row['summary']['temperature_c'] for row in rows], [150, 100]*2)
        self.assertEqual([row['summary']['pressure_bar'] for row in rows[-2:]], [700, 700])

    def test_reference_gas_and_native_dependencies_survive_user_database_build(self):
        cfg = carbonate(); cfg['equilibrium_constraints'] = [gas()]
        expected, _ = self.run_cfg(cfg)
        actual, _ = self.run_cfg(cfg, {**self.source, 'kind': 'user', 'required_reaktoro_version': r.__version__})
        self.assertAlmostEqual(actual[0]['summary']['pH'], expected[0]['summary']['pH'], delta=1e-9)
        self.assertAlmostEqual(actual[0]['constraints'][0]['exchange_mol'], expected[0]['constraints'][0]['exchange_mol'], delta=1e-11)

    def test_gas_reference_fingerprint_is_checked_even_when_not_selected(self):
        cfg = carbonate(); cfg['equilibrium_constraints'] = [gas()]
        records = copy.deepcopy(self.handle['records'])
        next(row for row in records if row['name'] == 'CO2(g)')['provenance']['source_fingerprint'] = 'changed'
        with self.assertRaisesRegex(BridgeError, '运行时物种数据已改变.*CO2'):
            Simulation({'config': cfg, 'records': records, 'source': self.source})

    def test_multistep_exchange_uses_inherited_output_and_cumulative_signed_ledger(self):
        cfg = carbonate(3, 2)
        cfg['routes'] = [route(source='previous_point', fallback='material')]
        cfg['equilibrium_constraints'] = [gas()]
        cfg['schedule']['parameters'].append(setting('gas-target', 'equilibrium_constraint', {'mode': 'list', 'along': 'path', 'values': [.1, .01, .001]}, constraint_id='gas'))
        rows, _ = self.run_cfg(cfg)
        amounts = [row['constraints'][0]['exchange_mol'] for row in rows]
        self.assertGreater(amounts[0], 0); self.assertLess(amounts[1], 0); self.assertLess(amounts[2], 0)
        for index, row in enumerate(rows):
            self.assertAlmostEqual(row['constraints'][0]['cumulative_exchange_mol'], sum(amounts[:index+1]), delta=1e-14)
        carbon = next(row for row in rows[-1]['process_balance'] if row['component'] == 'C')
        self.assertAlmostEqual(carbon['external_exchange_mol'], sum(amounts), delta=1e-13)
        self.assertEqual(carbon['fresh_input_mol'], 0)

    def test_scopes_and_local_targets_do_not_reactivate_reservoir_outside_scope(self):
        cfg = carbonate(3, 2)
        cfg['equilibrium_constraints'] = [ph(None, positions={'start': 2, 'end': 2}), gas(rounds={'start': 2})]
        cfg['schedule']['overrides'].append(override('ph-at-middle', [setting('ph-target', 'equilibrium_constraint', fixed(4), constraint_id='acidity')], positions={'start': 2, 'end': 2}))
        rows, _ = self.run_cfg(cfg)
        self.assertEqual([row['summary']['constraint_acidity_target'] for row in rows], [None, 4, None, None, 4, None])
        self.assertEqual([row['summary']['constraint_gas_target'] for row in rows], [None]*3+[.01]*3)
        self.assertEqual([len(row['constraints']) for row in rows], [0, 1, 0, 1, 2, 1])
        self.assertEqual(rows[2]['summary']['constraint_acidity_exchange_mol'], 0)

    def test_empty_inactive_constraint_draft_is_preserved_without_blocking(self):
        cfg = scheduled(); cfg['equilibrium_constraints'] = [gas(None, '', rounds={'start': 2})]
        rows, _ = self.run_cfg(cfg)
        self.assertEqual(rows[0]['constraints'], [])
        self.assertIsNone(cfg['equilibrium_constraints'][0]['value'])

    def test_only_active_constraint_profile_values_need_to_be_finite(self):
        cfg = carbonate(3); marker = {'easyreaktoro_empty_number': True}
        cfg['equilibrium_constraints'] = [gas(marker, positions={'start': 2, 'end': 2})]
        cfg['schedule']['parameters'].append(setting('gas-only-middle', 'equilibrium_constraint',
            {'mode': 'list', 'along': 'path', 'values': [marker, .02, marker]}, constraint_id='gas'))
        before = copy.deepcopy(cfg)
        rows, _ = self.run_cfg(cfg)
        self.assertEqual([row['summary']['constraint_gas_target'] for row in rows], [None, .02, None])
        self.assertEqual(cfg, before)
        _, document, _ = prepare_program(cfg)
        parsed = parse_code(document, cfg)
        self.assertTrue(parsed['valid'], parsed)
        self.assertEqual(parsed['config']['equilibrium_constraints'][0]['value'], marker)
        cfg['equilibrium_constraints'][0]['positions'] = {'start': 1}
        with self.assertRaisesRegex(BridgeError, '有限数'):
            self.run_cfg(cfg)

    def test_invalid_scopes_references_charge_and_dependent_targets_reject(self):
        cases = [(ph(titrant='H+'), '中性'), (ph(titrant='HBr'), '没有的元素'), (gas(species='H2O(aq)'), '中性气体'), (ph(rounds={'start': 1, 'step': 0}), '间隔')]
        for bad, reason in cases:
            cfg = carbonate(); cfg['equilibrium_constraints'] = [bad]
            with self.subTest(bad=bad), self.assertRaisesRegex(BridgeError, reason):
                normalize_config(cfg, self.handle['records'], self.source)
        cfg = carbonate(); cfg['equilibrium_constraints'] = [ph(titrant='CO2'), gas()]
        with self.assertRaisesRegex(BridgeError, '无法独立调节'):
            normalize_config(cfg, self.handle['records'], self.source)
        cfg['equilibrium_constraints'] = [ph(), ph(5, identity='other')]
        with self.assertRaisesRegex(BridgeError, '多个 pH'):
            normalize_config(cfg, self.handle['records'], self.source)

    def test_constraint_ids_cannot_silently_collide_in_summary_columns(self):
        cfg = carbonate(); cfg['equilibrium_constraints'] = [ph(identity='a'), gas(identity='a_cumulative')]
        with self.assertRaisesRegex(BridgeError, '重复结果列'):
            normalize_config(cfg, self.handle['records'], self.source)

    def test_charge_imbalance_is_not_silently_fixed_by_neutral_titrant(self):
        cfg = scheduled(); cfg['equilibrium_constraints'] = [ph()]
        cfg['materials'][0]['inputs'].append({'species': 'Na+', 'amount': .1, 'unit': 'mol'})
        with self.assertRaisesRegex(BridgeError, '总输入电中性'):
            self.run_cfg(cfg)

    def test_code_roundtrip_and_old_visible_parameters_turn_constraints_off(self):
        cfg = carbonate(2); cfg['equilibrium_constraints'] = [ph(), gas()]
        cfg['schedule']['parameters'].append(setting('ph-path', 'equilibrium_constraint', {'mode': 'list', 'along': 'path', 'values': [4, 3]}, constraint_id='acidity'))
        normalized, document, _ = prepare_program(cfg)
        parsed = parse_code(document, normalized)
        self.assertTrue(parsed['valid'], parsed)
        self.assertEqual(parsed['config']['equilibrium_constraints'], cfg['equilibrium_constraints'])
        condition = next(row for row in document['cells'] if row['id'] == 'conditions')
        condition['source'] = 'schedule = '+repr(scheduled()['schedule'])+'\n'
        parsed = parse_code(document, normalized)
        self.assertTrue(parsed['valid'], parsed)
        self.assertNotIn('equilibrium_constraints', parsed['config'])

    def test_standard_code_worker_persists_and_rebuilds_exchange_results(self):
        cfg = carbonate(3); cfg['equilibrium_constraints'] = [ph(), gas(rounds={'start': 1})]
        cfg['schedule']['parameters'].append(setting('ph-values', 'equilibrium_constraint', {'mode': 'list', 'along': 'path', 'values': [4, 3, 2]}, constraint_id='acidity'))
        with tempfile.TemporaryDirectory() as folder:
            jobs = Jobs()
            try:
                started = jobs.start(self.handle, cfg, folder)
                deadline = time.monotonic()+30
                while jobs.status(started['job_id'])['status'] == 'running' and time.monotonic() < deadline: time.sleep(.02)
                report = jobs.status(started['job_id'])
                self.assertEqual(report['status'], 'completed', report)
                root = Path(report['output_path'])
                actual = list(records(root)); expected, _ = self.run_cfg(cfg)
                for a, b in zip(actual, expected):
                    self.assertEqual(a['constraints'], b['constraints'])
                self.assertTrue((root/'constraints.csv').is_file())
                (root/'constraints.csv').unlink()
                self.assertEqual(rebuild_tables(root)['constraints'], 6)
                payload = explorer_payload(root)
                self.assertIn('constraint_acidity_target', payload['summary']['columns'])
                self.assertIn('constraint_gas_exchange_mol', payload['metadata']['field_info'])
                saved = json.loads((root/'simulation.ersim.json').read_text())
                self.assertEqual(saved['config']['equilibrium_constraints'], cfg['equilibrium_constraints'])
                code = (root/'program.py').read_text()
                self.assertIn('ConstraintEngine', code); self.assertIn('equilibrium_constraints =', code)
            finally: jobs.close()

    def test_older_custom_process_keeps_scopes_and_exchange_ledger_without_source_rewrite(self):
        cfg = carbonate(2, 2)
        cfg['equilibrium_constraints'] = [gas(rounds={'start': 2}, positions={'start': 2})]
        cfg, document, _ = prepare_program(cfg)
        process = next(cell for cell in document['cells'] if cell['id'] == 'process')
        # The pre-constraint generated loop, with a user comment: older saved
        # custom code has no coordinate annotation or explicit exchange arg.
        process['source'] = process['source'].replace('            point.update(_outer=cycle, _inner=i)\n', '').replace('inventory.commit(cycle, i, output, fresh, consumed, self.constraints.exchange)', 'inventory.commit(cycle, i, output, fresh, consumed)')+'\n# User process note\n'
        original = process['source']
        with tempfile.TemporaryDirectory() as folder:
            jobs = Jobs()
            try:
                editor = {'version': 1, 'mode': 'code', 'config': cfg, 'document': document, 'dirty': False}
                started = jobs.start(self.handle, cfg, folder, editor)
                deadline = time.monotonic()+30
                while jobs.status(started['job_id'])['status'] == 'running' and time.monotonic() < deadline: time.sleep(.02)
                report = jobs.status(started['job_id'])
                self.assertEqual(report['status'], 'completed', report)
                root = Path(report['output_path']); rows = list(records(root))
                self.assertEqual([row['summary']['constraint_gas_target'] for row in rows], [None, None, None, .01])
                self.assertLess(max(abs(value['error_mol']) for row in rows for value in row['process_balance']), 1e-10)
                saved = json.loads((root/'input.json').read_text())
                self.assertEqual(next(cell['source'] for cell in saved['program']['cells'] if cell['id'] == 'process'), original)
            finally: jobs.close()


@unittest.skipIf(r is None, 'External Reaktoro required')
class ConstraintFeedbackTests(unittest.TestCase):
    setUpClass = classmethod(OpenEquilibriumTests.setUpClass.__func__)
    tearDownClass = classmethod(OpenEquilibriumTests.tearDownClass.__func__)
    run_cfg = OpenEquilibriumTests.run_cfg
    def test_actual_lengths_determine_active_target_definitions(self):
        from bridge.easyreaktoro_runtime.simulation_constraints import active_definitions
        cfg = scheduled(1, 1)
        cfg['schedule']['stop'] = dict(first='i = 2', later='i = 0', rounds='N = 1')
        cfg['equilibrium_constraints'] = [ph(None, '', positions={'start': 2}, rounds={'start': 2}), gas(None, '', positions={'start': 2}, rounds={'start': 2})]
        before = copy.deepcopy(cfg)
        self.assertEqual(active_definitions(cfg), [])
        rows, _ = self.run_cfg(cfg)
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(not row['constraints'] for row in rows))
        self.assertEqual(cfg, before)
        cfg['equilibrium_constraints'][0]['value'] = 4
        cfg['schedule']['stop']['later'] = 'i = 2'
        with self.assertRaises(BridgeError) as caught:
            normalize_config(cfg, self.handle['records'], self.source)
        self.assertEqual(caught.exception.response()['error']['location'], dict(kind='constraint', constraintId='acidity', field='titrant'))

    def test_backend_error_has_a_readable_target_and_a_separate_input_reference(self):
        cfg = scheduled(); cfg['equilibrium_constraints'] = [ph(4, 'HBr', identity='internal-uuid')]
        with self.assertRaises(BridgeError) as caught:
            normalize_config(cfg, self.handle['records'], self.source)
        error = caught.exception.response()['error']
        self.assertIn('pH · HBr', error['diagnostic'])
        self.assertNotIn('internal-uuid', error['diagnostic'])
        self.assertEqual(error['location'], dict(kind='constraint', constraintId='internal-uuid', field='titrant'))

    def test_reactivated_targets_and_saved_code_match_actual_points(self):
        cfg = scheduled(1, 1)
        cfg['schedule']['stop'] = dict(first='i = 2', later='i = 1', rounds='N = 1')
        cfg['equilibrium_constraints'] = [ph(4, positions={'start': 2})]
        _, document, _ = prepare_program(cfg)
        parsed = parse_code(document, cfg)
        self.assertTrue(parsed['valid'], parsed)
        rows, _ = self.run_cfg(parsed['config'])
        self.assertEqual(len(rows), 5)
        self.assertEqual([len(row['constraints']) for row in rows], [0, 1, 1, 0, 1])
        for row in rows:
            if row['constraints']:
                self.assertAlmostEqual(row['summary']['pH'], 4, delta=1e-7)

    def test_failed_run_keeps_its_actionable_location_in_saved_status(self):
        cfg = scheduled(); cfg['equilibrium_constraints'] = [ph(10)]
        with self.assertRaises(BridgeError) as caught:
            self.run_cfg(cfg)
        self.assertEqual(caught.exception.location, dict(kind='constraint', constraintId='acidity', field='exchange'))
        with tempfile.TemporaryDirectory() as directory:
            job = self.service.simulation_jobs.start(self.handle, cfg, directory)
            deadline = time.monotonic()+30
            while job['status'] == 'running' and time.monotonic() < deadline:
                time.sleep(.05)
                job = self.service.simulation_jobs.status(job['job_id'])
            self.assertEqual(job['status'], 'failed', job)
            self.assertEqual(job['error_location'], caught.exception.location)
            status = json.loads((Path(job['output_path'])/'status.json').read_text())
            self.assertEqual(status['error_location'], caught.exception.location)
