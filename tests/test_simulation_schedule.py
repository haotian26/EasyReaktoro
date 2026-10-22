"""Coordinate rules, actual parameter dependencies, material flow and saved code."""
import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from tests.test_simulation import reaktoro
from tests.test_simulation_loops import plan, repeat, values
from tests.test_simulation_process import route
from tests.test_simulation_reactions import fresh_stages
from tests.test_simulation_round_pressure import mixed_plan
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.simulation_schedule import SchedulePlan, normalize_schedule, to_schedule
from bridge.easyreaktoro_runtime.simulation_loops import LoopPlan, execution_config
from bridge.easyreaktoro_runtime.simulation import Simulation, normalize_config
from bridge.easyreaktoro_runtime.simulation_code import parse_code, render_code
from bridge.easyreaktoro_runtime.simulation_program import prepare_program
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs, database_source
from bridge.easyreaktoro_runtime.simulation_storage import records
from bridge.easyreaktoro_runtime.simulation_templates import load_settings
from bridge.easyreaktoro_runtime.service import Service


def setting(identity, kind, value, **target):
    return {'id': identity, 'target': {'kind': kind, **target}, 'value': value}


def fixed(value):
    return {'mode': 'fixed', 'value': value}


def scheduled(positions=1, rounds=1):
    cfg = plan()
    cfg.pop('loops')
    cfg['schedule'] = {'version': 1, 'positions': positions, 'rounds': rounds,
                       'parameters': [setting('temperature', 'temperature', fixed(25)), setting('pressure', 'pressure', fixed(1))], 'overrides': []}
    return cfg


def override(identity, parameters, rounds=None, positions=None):
    return {'id': identity, 'rounds': rounds or {'start': 1}, 'positions': positions or {'start': 1}, 'parameters': parameters}


def contract_cases():
    cases = []
    for mode in ('relative', 'linear', 'list'):
        cfg = scheduled(5, 2)
        profile = ({'mode': mode, 'along': 'path', 'start': 100, 'step': 10, 'other_step': 100} if mode == 'relative'
                   else {'mode': mode, 'start': 100, 'path_step': 10, 'round_step': 100} if mode == 'linear'
                   else {'mode': mode, 'along': 'path', 'values': [100, 110, 120, 130, 140]})
        cfg['schedule']['parameters'][0]['value'] = profile
        cfg['schedule']['overrides'] = [override('change', [setting('change-temperature', 'temperature', fixed(300))], {'start': 1, 'end': 1}, {'start': 2, 'end': 2})]
        expected = [100, 300, 310, 320, 330] if mode == 'relative' else [100, 300, 120, 130, 140]
        cases.append((mode+'-after-override', cfg, expected))
    cfg = scheduled(3, 3)
    cfg['schedule']['parameters'][0]['value'] = {'mode': 'relative', 'along': 'round', 'start': 25, 'step': 10, 'other_step': 2}
    cfg['schedule']['overrides'] = [override('middle', [setting('middle-temperature', 'temperature', fixed(100))], {'start': 2, 'end': 2}, {'start': 2, 'end': 2})]
    cases.append(('previous-round-final-value', cfg, [25, 27, 29, 35, 100, 39, 45, 110, 49]))
    cfg = scheduled(5)
    cfg['schedule']['overrides'] = [override('sparse', [setting('sparse-temperature', 'temperature', {'mode': 'relative', 'along': 'path', 'start': 999, 'step': 2, 'other_step': 0})], positions={'start': 3, 'step': 2})]
    cases.append(('relative-global-neighbour', cfg, [25, 25, 27, 25, 27]))
    cfg = scheduled(4)
    cfg['schedule']['parameters'].append(setting('salt', 'material_amount', {'mode': 'linear', 'start': .3, 'path_step': -.1, 'round_step': 0}, material_id='initial', species='NaCl(aq)'))
    cases.append(('decimal-zero-dose', cfg, [25]*4))
    return cases


class ScheduleShapeTests(unittest.TestCase):
    def test_decimal_arithmetic_retains_cancellation_across_finite_float_exponents(self):
        from bridge.easyreaktoro_runtime.simulation_schedule import _arithmetic
        self.assertEqual(_arithmetic(1, (1, 1e-40), (1, -1)), 1e-40)
        self.assertEqual(_arithmetic(1e308, (1, 5e-324), (1, -1e308)), 5e-324)
        self.assertEqual(_arithmetic(1e308, (10000, 5e-324), (1, -1e308)), 5e-320)
        self.assertEqual(_arithmetic(.3, (3, -.1)), 0)
        cfg = scheduled(2, 2)
        cfg['schedule']['parameters'].append(setting('trace', 'material_amount', {'mode': 'linear', 'start': 1, 'path_step': 1e-40, 'round_step': -1}, material_id='initial', species='NaCl(aq)'))
        self.assertEqual(SchedulePlan(cfg)._arrays[('material_amount', 'initial', 'NaCl(aq)')][-1], 1e-40)

    def test_nonfinite_linear_inputs_use_the_per_point_error(self):
        for start, step in [(float('inf'), float('-inf')), (float('nan'), 0), (1e308, 1e308)]:
            cfg = scheduled(2)
            cfg['schedule']['parameters'][0]['value'] = {'mode': 'linear', 'start': start, 'path_step': step, 'round_step': 0}
            with self.assertRaisesRegex(BridgeError, '第 1 轮、路径位置 [12] 的参数须为有限数值'):
                SchedulePlan(cfg)

    def test_profiles_have_distinct_override_and_reset_semantics(self):
        for name, cfg, expected in contract_cases():
            with self.subTest(name=name):
                before = copy.deepcopy(cfg)
                compiled = SchedulePlan(cfg)
                actual = [compiled.point(outer, inner)['temperature_c'] for outer in range(compiled.rounds) for inner in range(compiled.positions)]
                self.assertEqual(actual[:len(expected)], expected)
                self.assertEqual(cfg, before)
                if name == 'relative-after-override':
                    self.assertEqual(actual[5:], [200, 210, 220, 230, 240])
                if name == 'decimal-zero-dose':
                    self.assertEqual(compiled._arrays[('material_amount', 'initial', 'NaCl(aq)')].tolist(), [.3, .2, .1, 0])

    def test_scope_interval_uses_local_ordinals_and_list_does_not_wrap(self):
        cfg = scheduled(6, 4)
        cfg['schedule']['overrides'] = [override('selected', [setting('selected-T', 'temperature', {'mode': 'linear', 'start': 100, 'path_step': 10, 'round_step': 100})], {'start': 2, 'end': 4, 'step': 2}, {'start': 2, 'end': 6, 'step': 2})]
        compiled = SchedulePlan(cfg)
        self.assertEqual([compiled.point(1, i)['temperature_c'] for i in range(6)], [25, 100, 25, 110, 25, 120])
        self.assertEqual(compiled.point(3, 5)['temperature_c'], 220)
        cfg['schedule']['overrides'][0]['parameters'][0]['value'] = {'mode': 'list', 'along': 'path', 'values': [50, 60, 70, {'easyreaktoro_empty_number': True}]}
        self.assertEqual(SchedulePlan(cfg).point(3, 5)['temperature_c'], 70)
        cfg['schedule']['overrides'][0]['parameters'][0]['value']['values'] = [50, 60]
        with self.assertRaisesRegex(BridgeError, '数列值'):
            SchedulePlan(cfg)

    def test_overlaps_expand_bindings_but_allow_distinct_targets(self):
        cfg = scheduled(2, 2)
        cfg['reaction_stages'] = fresh_stages()
        bound = setting('bound', 'route_fraction', fixed(.5), route_id='first_start', field='fraction', bindings=[{'route_id': key, 'field': 'fraction'} for key in ('first_start', 'later_start')])
        cfg['schedule']['overrides'] = [override('a', [bound]), override('b', [setting('single', 'route_fraction', fixed(.3), route_id='later_start', field='fraction')])]
        with self.assertRaisesRegex(BridgeError, '重叠'):
            SchedulePlan(cfg)
        cfg['schedule']['overrides'][1]['parameters'] = [setting('pressure-local', 'pressure', fixed(100))]
        self.assertEqual(SchedulePlan(cfg).point(0, 0)['pressure_bar'], 100)

    def test_empty_local_groups_do_not_hide_the_existing_plan(self):
        cfg = scheduled(3, 2)
        cfg['schedule']['overrides'] = [override('new-group', []), override('future-group', [], {'start': 4})]
        compiled = SchedulePlan(cfg)
        self.assertEqual([compiled.point(outer, inner)['temperature_c'] for outer in range(2) for inner in range(3)], [25]*6)
        prepared, document, _ = prepare_program(cfg)
        self.assertEqual(parse_code(document, prepared)['config']['schedule'], cfg['schedule'])
        cfg['schedule']['overrides'][0]['positions']['step'] = 0
        with self.assertRaises(BridgeError):
            SchedulePlan(cfg)

    def test_inactive_scopes_preserve_drafts_and_missing_references(self):
        cfg = scheduled()
        cfg['schedule']['overrides'] = [override('future', [setting('future-missing', 'material_amount', fixed({'easyreaktoro_empty_number': True}), material_id='missing', species='missing')], {'start': 2})]
        SchedulePlan(cfg)
        self.assertIn('easyreaktoro_empty_number', json.dumps(cfg))
        cfg['schedule']['rounds'] = 2
        with self.assertRaises(BridgeError):
            SchedulePlan(cfg)

    def test_scope_errors_duplicates_missing_reference_and_nonfinite_actual_values(self):
        mutations = [lambda c: c['schedule'].update(positions=10000, rounds=3),
                     lambda c: c['schedule']['parameters'].append(setting('missing', 'material_amount', fixed(1), material_id='missing', species='missing')),
                     lambda c: c['schedule']['parameters'].append(copy.deepcopy(c['schedule']['parameters'][0])),
                     lambda c: c['schedule']['parameters'][1].update(value=fixed(0)),
                     lambda c: c['schedule']['parameters'][0].update(value=fixed(float('nan'))),
                     lambda c: c['schedule']['overrides'].append(override('zero', [setting('local', 'pressure', fixed(20))], positions={'start': 1, 'step': 0}))]
        for mutate in mutations:
            cfg = scheduled()
            mutate(cfg)
            with self.assertRaises(BridgeError):
                SchedulePlan(cfg)

    def test_common_legacy_points_migrate_to_editable_general_parameters(self):
        for temperatures, pressures, increment in [([25], [1], 0), ([25, 25], [1, 100], 0), ([25, 25], [10, 10], 5), ([100, 150], [10, 10], 0)]:
            with self.subTest(temperatures=temperatures, pressures=pressures, increment=increment):
                cfg = scheduled()
                cfg.pop('schedule')
                cfg['cycles'] = 2
                cfg['points'] = [{'id': f'p{i+1}', 'temperature_c': t, 'pressure_bar': p, 'temperature_increment_c': increment} for i, (t, p) in enumerate(zip(temperatures, pressures))]
                cfg['schedule'] = to_schedule(cfg)
                self.assertEqual(cfg['schedule']['overrides'], [])
                compiled = SchedulePlan(cfg)
                self.assertEqual([compiled.point(1, i)['temperature_c'] for i in range(len(temperatures))], [t+increment for t in temperatures])
                cfg['schedule']['parameters'][0]['value'] = fixed(80)
                self.assertEqual([SchedulePlan(cfg).point(1, i)['temperature_c'] for i in range(len(temperatures))], [80]*len(temperatures))
        cfg['points'] = [{'id': 'p1', 'temperature_c': 100, 'pressure_bar': 10, 'pressure_mode': 'water_saturation'}]
        cfg.pop('schedule')
        migrated = to_schedule(cfg)
        self.assertEqual(migrated['parameters'][1]['value'], {'mode': 'water_saturation'})
        self.assertEqual(migrated['overrides'], [])

    def test_code_parameter_roundtrip_keeps_inactive_history_and_user_comments(self):
        cfg = scheduled(2, 2)
        cfg['points'] = [{'unfinished': {'easyreaktoro_empty_number': True}}]
        cfg['loops'] = {'unfinished': {'easyreaktoro_empty_number': True}}
        prepared, document, _ = prepare_program(cfg)
        cell = next(cell for cell in document['cells'] if cell['id'] == 'conditions')
        cell['source'] = cell['source'].replace("'positions': 2", "'positions': 3").replace("'value': 25", "'value': 80") + '\n# User explanation of these conditions\n'
        parsed = parse_code(document, prepared)
        self.assertTrue(parsed['valid'], parsed)
        self.assertEqual(parsed['config']['schedule']['positions'], 3)
        self.assertEqual(SchedulePlan(parsed['config']).point(1, 2)['temperature_c'], 80)
        self.assertEqual(parsed['config']['points'], cfg['points'])
        self.assertEqual(parsed['config']['loops'], cfg['loops'])
        editor = {'version': 1, 'mode': 'code', 'config': prepared, 'document': document, 'dirty': True}
        changed, restored, _ = prepare_program(prepared, editor)
        self.assertEqual(changed['schedule'], parsed['config']['schedule'])
        self.assertEqual(next(c['source'] for c in restored['cells'] if c['id'] == 'conditions'), cell['source'])

    def test_twenty_thousand_relative_steps_compile_without_recursion(self):
        cfg = scheduled(10000, 2)
        cfg['schedule']['parameters'][0]['value'] = {'mode': 'relative', 'along': 'path', 'start': 25, 'step': .01, 'other_step': 100}
        compiled = SchedulePlan(cfg)
        self.assertEqual(compiled.point(1, 9999)['temperature_c'], 224.99)
        self.assertEqual(compiled.common(1, 9999), {'inner_index': 10000, 'outer_index': 2})
        self.assertNotIn('inner_value', compiled.field_info())

    def test_legacy_numeric_axes_and_uniform_point_tables_migrate_without_mutation(self):
        cfg = plan(values('material_amount', [.1, .2], material_id='initial', species='NaCl(aq)'), values('pressure', [10, 20]))
        before = copy.deepcopy(cfg)
        migrated = {**cfg, 'schedule': to_schedule(cfg)}
        old, new = LoopPlan(cfg), SchedulePlan(migrated)
        for outer in range(2):
            for inner in range(2):
                self.assertEqual(old.point(outer, inner), new.point(outer, inner))
        self.assertEqual(cfg, before)
        cfg = scheduled(2, 2)
        cfg.pop('schedule')
        cfg['cycles'] = 2
        cfg['points'] = [{'id': 'p1', 'temperature_c': 25, 'pressure_bar': 10, 'temperature_increment_c': 5}, {'id': 'p2', 'temperature_c': 50, 'pressure_bar': 20}]
        migrated = {**cfg, 'schedule': to_schedule(cfg)}
        self.assertEqual(SchedulePlan(migrated).point(1, 0)['temperature_c'], 30)
        cfg['routes'][0] = route('output', point_id='p1', lag=0)
        self.assertIsNone(to_schedule(cfg))


@unittest.skipIf(reaktoro is None, 'External Reaktoro required')
class ScheduleExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = Service()
        cls.handle = cls.service.handle(cls.service.open_official('SUPCRT', 'supcrtbl')['handle_id'])
        cls.source = database_source(cls.handle)

    @classmethod
    def tearDownClass(cls):
        cls.service.simulation_jobs.close()

    def run_plan(self, cfg):
        rows = []
        metadata = Simulation({'config': cfg, 'records': self.handle['records'], 'source': self.source}).run(rows.append)
        self.assertTrue(all(abs(balance['error_mol']) < 1e-9 for row in rows for balance in row['balances']))
        self.assertTrue(all(abs(balance['error_mol']) < 1e-9 for balance in metadata['process_balance']))
        return rows, metadata

    def test_point_edits_and_restore_drive_real_equilibrium_conditions(self):
        cfg = scheduled(3)
        cfg['schedule']['parameters'][0]['value'] = fixed(150)
        cfg['schedule']['parameters'][1]['value'] = {'mode': 'water_saturation'}
        cfg['schedule']['overrides'] = [
            override('path', [setting('path-t', 'temperature', {'mode': 'expression', 'expression': 'T-20'})], positions={'start': 2}),
            {**override('point', [setting('point-t', 'temperature', fixed(100)), setting('point-p', 'pressure', fixed(700))], {'start': 1, 'end': 1}, {'start': 2, 'end': 2}), 'point': True},
        ]
        rows, _ = self.run_plan(cfg)
        self.assertEqual([row['summary']['temperature_c'] for row in rows], [150, 100, 80])
        self.assertAlmostEqual(rows[1]['summary']['pressure_bar'], 700)
        cfg['schedule']['overrides'][1]['parameters'].pop()
        restored, _ = self.run_plan(cfg)
        self.assertAlmostEqual(restored[1]['summary']['pressure_bar'], float(reaktoro.waterSaturationPressureWagnerPruss(373.15))/1e5)
        cfg['schedule']['overrides'].pop()
        resumed, _ = self.run_plan(cfg)
        self.assertEqual([row['summary']['temperature_c'] for row in resumed], [150, 130, 110])

    def test_saturation_uses_final_temperature_and_relative_pressure_uses_actual_prior_pressure(self):
        cfg = scheduled(3)
        cfg['schedule']['parameters'][0]['value'] = {'mode': 'linear', 'start': 100, 'path_step': 50, 'round_step': 0}
        cfg['schedule']['parameters'][1]['value'] = {'mode': 'relative', 'along': 'path', 'start': 1, 'step': 10, 'other_step': 0}
        cfg['schedule']['overrides'] = [override('saturated-first', [setting('sat', 'pressure', {'mode': 'water_saturation'})], positions={'start': 1, 'end': 1})]
        compiled = SchedulePlan(cfg)
        first = float(reaktoro.waterSaturationPressureWagnerPruss(373.15))/1e5
        self.assertAlmostEqual(compiled.point(0, 1)['pressure_bar'], first+10)
        self.assertAlmostEqual(compiled.point(0, 2)['pressure_bar'], first+20)
        self.assertEqual(compiled.point(0, 1)['pressure_mode'], 'fixed')

    def test_legacy_saturation_with_pressure_axis_restores_only_explicit_fixed_rounds(self):
        for kind in ('inner', 'outer'):
            cfg = plan(values('pressure', [100, 200]) if kind == 'inner' else repeat(2), values('pressure', [100, 200]) if kind == 'outer' else repeat(2))
            cfg['loops']['base'].update(temperature_c=150, pressure_mode='water_saturation')
            cfg['loops']['round_conditions'] = [{'round': 2, 'pressure_mode': 'fixed'}]
            old, new = LoopPlan(cfg), SchedulePlan({**cfg, 'schedule': to_schedule(cfg)})
            for outer in range(2):
                for inner in range(2):
                    self.assertEqual(old.point(outer, inner), new.point(outer, inner))

    def test_legacy_point_migration_keeps_future_increments_overrides_and_pressure_modes(self):
        from bridge.easyreaktoro_runtime.simulation_process import actual_point
        cfg = scheduled()
        cfg.pop('schedule')
        cfg['cycles'] = 1
        cfg['points'] = [
            {'id': 'p1', 'temperature_c': 100, 'pressure_bar': 10, 'temperature_increment_c': 5, 'pressure_mode': 'water_saturation',
             'round_conditions': [{'round': 3, 'temperature_c': 170, 'pressure_bar': 700}]},
            {'id': 'p2', 'temperature_c': 150, 'pressure_bar': 20, 'temperature_increment_c': -2, 'pressure_increment_bar': 3,
             'round_conditions': [{'round': 2, 'temperature_c': 180, 'pressure_bar': 1, 'pressure_mode': 'water_saturation'},
                                  {'round': 4, 'temperature_c': 160, 'pressure_bar': 600, 'pressure_mode': 'fixed'}]}]
        original = copy.deepcopy(cfg)
        cfg['schedule'] = to_schedule(cfg)
        self.assertEqual({key: value for key, value in cfg.items() if key != 'schedule'}, original)
        cfg['schedule']['rounds'] = 5
        compiled = SchedulePlan(cfg)
        for outer in range(5):
            for inner in range(2):
                previous = actual_point(original['points'][inner], outer)
                actual = compiled.point(outer, inner)
                for key in ('temperature_c', 'pressure_bar', 'pressure_mode'):
                    self.assertEqual(actual[key], previous[key])
        self.assertEqual(compiled.point(2, 0)['pressure_mode'], 'fixed')
        self.assertEqual(compiled.point(4, 0)['pressure_mode'], 'water_saturation')
        self.assertEqual(compiled.point(4, 1)['pressure_bar'], 32)

    def test_temperature_pressure_dose_and_route_multiplier_all_affect_real_assembly(self):
        cfg = scheduled(3, 2)
        cfg['schedule']['parameters'] = [setting('T', 'temperature', {'mode': 'linear', 'start': 50, 'path_step': 25, 'round_step': 0}),
                                       setting('P', 'pressure', {'mode': 'list', 'along': 'round', 'values': [10, 100]}),
                                       setting('salt', 'material_amount', {'mode': 'linear', 'start': .1, 'path_step': .1, 'round_step': 0}, material_id='initial', species='NaCl(aq)'),
                                       setting('dose', 'route_fraction', {'mode': 'list', 'along': 'round', 'values': [1, 2]}, route_id='route-1', field='fraction')]
        rows, metadata = self.run_plan(cfg)
        self.assertEqual([row['summary']['temperature_c'] for row in rows], [50, 75, 100]*2)
        self.assertEqual([row['summary']['pressure_bar'] for row in rows], [10]*3+[100]*3)
        doses = [next(species['inlet_amount_mol'] for species in row['species'] if species['species'] == 'NaCl(aq)') for row in rows]
        for actual, expected in zip(doses, [.1, .2, .3, .2, .4, .6]):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(metadata['config']['schedule'], cfg['schedule'])
        self.assertNotIn('loops', metadata['config'])
        self.assertTrue(all('inner_value' not in row['summary'] and 'outer_value' not in row['summary'] for row in rows))

    def test_dose_rule_does_not_inject_material_into_inherited_state(self):
        cfg = scheduled(3)
        cfg['reaction_stages'] = {'first_start': [route(id='start')], 'first_following': [route('previous_point', id='follow', fallback='error')], 'later_start': [], 'later_following': []}
        cfg['schedule']['parameters'].append(setting('salt', 'material_amount', {'mode': 'list', 'along': 'path', 'values': [.1, .2, .3]}, material_id='initial', species='NaCl(aq)'))
        rows, _ = self.run_plan(cfg)
        for row in rows:
            sodium = next(balance['input_mol'] for balance in row['balances'] if balance['component'] == 'Na')
            self.assertAlmostEqual(sodium, .1)

    def test_old_custom_loop_execution_interfaces_apply_new_numeric_parameters(self):
        cfg = scheduled(3, 2)
        cfg['schedule']['parameters'].extend([
            setting('salt', 'material_amount', {'mode': 'linear', 'start': .1, 'path_step': .1, 'round_step': 0}, material_id='initial', species='NaCl(aq)'),
            setting('portion', 'route_fraction', {'mode': 'list', 'along': 'round', 'values': [1, 2]}, route_id='route-1', field='fraction')])
        prepared, document, _ = prepare_program(cfg)
        # Retain the formerly shipped interfaces as customized source. In
        # particular, older user code creates LoopPlan only when loops exists.
        replacements = {
            'runtime': ("    'schedule': locals().get('schedule', snapshot['config'].get('schedule')),\n", ''),
            'build': ("    self.loop_plan = LoopPlan(self.cfg) if self.cfg.get('schedule') or self.cfg.get('loops') else None\n    self.cfg = execution_config(self.cfg, self.loop_plan)", "    self.cfg = execution_config(self.cfg)\n    self.loop_plan = LoopPlan(self.cfg) if self.cfg.get('loops') else None"),
            'inventory': ("getattr(simulation, 'loop_plan', None) or (LoopPlan(self.cfg) if self.cfg.get('schedule') or self.cfg.get('loops') else None)", "LoopPlan(self.cfg) if self.cfg.get('loops') else None")}
        expected_sources = {}
        for cell in document['cells']:
            if cell['id'] in replacements:
                before, after = replacements[cell['id']]
                self.assertIn(before, cell['source'])
                cell['source'] = cell['source'].replace(before, after) + '\n# User customization retained\n'
                expected_sources[cell['id']] = cell['source']
        editor = {'version': 1, 'mode': 'code', 'config': prepared, 'document': document, 'dirty': True}
        jobs = Jobs()
        try:
            with tempfile.TemporaryDirectory() as directory:
                started = jobs.start(self.handle, prepared, directory, editor)
                deadline = time.monotonic()+20
                while jobs.status(started['job_id'])['status'] == 'running' and time.monotonic() < deadline:
                    time.sleep(.03)
                status = jobs.status(started['job_id'])
                self.assertEqual(status['status'], 'completed', status)
                rows = list(records(Path(started['output_path'])))
                doses = [next(species['inlet_amount_mol'] for species in row['species'] if species['species'] == 'NaCl(aq)') for row in rows]
                self.assertEqual(doses, [.1, .2, .3, .2, .4, .6])
                saved = json.loads((Path(started['output_path'])/'input.json').read_text())
                for cell in saved['program']['cells']:
                    if cell['id'] in expected_sources:
                        self.assertEqual(cell['source'], expected_sources[cell['id']])
        finally:
            jobs.close()

    def test_saved_standard_and_custom_programs_use_the_same_schedule(self):
        cfg = mixed_plan()
        expected, _ = self.run_plan(cfg)
        cfg['schedule'] = to_schedule(cfg)
        cfg.pop('loops')
        cfg['points'] = [{'unfinished-old-point': {'easyreaktoro_empty_number': True}}]
        jobs = Jobs()
        try:
            with tempfile.TemporaryDirectory() as directory:
                for custom in (False, True):
                    cfg['name'] = 'Generic schedule '+str(custom)
                    prepared, document, _ = prepare_program(cfg)
                    conditions = next(cell for cell in document['cells'] if cell['id'] == 'conditions')['source']
                    self.assertIn('schedule =', conditions)
                    self.assertNotIn('\nloops =', conditions)
                    self.assertNotIn('\npoints =', conditions)
                    if custom:
                        next(cell for cell in document['cells'] if cell['id'] == 'process')['source'] += '\n# Preserve user process text\n'
                    editor = {'version': 1, 'mode': 'code', 'config': prepared, 'document': document, 'dirty': custom}
                    started = jobs.start(self.handle, prepared, directory, editor)
                    deadline = time.monotonic()+20
                    while jobs.status(started['job_id'])['status'] == 'running' and time.monotonic() < deadline:
                        time.sleep(.03)
                    status = jobs.status(started['job_id'])
                    self.assertEqual(status['status'], 'completed', status)
                    folder = Path(started['output_path'])
                    actual = list(records(folder))
                    self.assertEqual(len(actual), 8)
                    for previous, current in zip(expected, actual):
                        for key in ('temperature_c', 'pressure_bar', 'pH'):
                            self.assertAlmostEqual(previous['summary'][key], current['summary'][key])
                    loaded = load_settings(folder/'simulation.ersim.json')
                    config, code, _ = prepare_program(loaded['config'], loaded['code_editor'])
                    self.assertEqual(config['schedule'], cfg['schedule'])
                    self.assertEqual(config['points'], cfg['points'])
                    self.assertEqual(next(cell['source'] for cell in code['cells'] if cell['id'] == 'process'), next(cell['source'] for cell in document['cells'] if cell['id'] == 'process'))
        finally:
            jobs.close()


class PointInheritanceTests(unittest.TestCase):
    def make_config(self):
        cfg = scheduled(3, 2)
        cfg['schedule']['parameters'][0]['value'] = fixed(250)
        cfg['schedule']['overrides'] = [
            override('stage', [setting('stage-t', 'temperature', {'mode': 'expression', 'expression': 'T-20'})], {'start': 1, 'end': 1}, {'start': 2}),
            {**override('point', [setting('point-t', 'temperature', fixed(100))], {'start': 1, 'end': 1}, {'start': 2, 'end': 2}), 'point': True},
        ]
        return cfg

    def test_point_takes_precedence_and_reset_resumes_the_live_parent_rule(self):
        cfg = self.make_config()
        self.assertEqual(list(SchedulePlan(cfg)._arrays[('temperature',)][:3]), [250, 100, 80])
        cfg['schedule']['overrides'][0]['parameters'][0]['value']['expression'] = 'T-10'
        self.assertEqual(list(SchedulePlan(cfg)._arrays[('temperature',)][:3]), [250, 100, 90])
        cfg['schedule']['overrides'].pop()
        self.assertEqual(list(SchedulePlan(cfg)._arrays[('temperature',)][:3]), [250, 240, 230])

    def test_point_priority_is_independent_of_order_and_round_trips_through_code(self):
        cfg = self.make_config()
        cfg['schedule']['overrides'].reverse()
        prepared, document, _ = prepare_program(cfg)
        parsed = parse_code(document, prepared)
        self.assertTrue(parsed['valid'], parsed)
        self.assertEqual(parsed['config']['schedule'], cfg['schedule'])
        self.assertEqual(list(SchedulePlan(parsed['config'])._arrays[('temperature',)][:3]), [250, 100, 80])

    def test_point_overrides_reject_duplicate_targets_and_multi_point_scopes(self):
        cfg = self.make_config()
        duplicate = copy.deepcopy(cfg['schedule']['overrides'][1])
        duplicate['id'] = 'duplicate'
        duplicate['parameters'][0]['id'] = 'duplicate-t'
        cfg['schedule']['overrides'].append(duplicate)
        with self.assertRaises(BridgeError):
            SchedulePlan(cfg)
        cfg = self.make_config()
        cfg['schedule']['overrides'][1]['positions']['end'] = 3
        with self.assertRaises(BridgeError):
            SchedulePlan(cfg)
