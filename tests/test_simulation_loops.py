"""Real parameter loops, inherited inventories, and durable code round-trips."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from tests.test_simulation import config, reaktoro
from tests.test_simulation_process import route
from bridge.easyreaktoro_runtime.simulation_loops import axis_values, normalize_loops, execution_config, LoopPlan
from bridge.easyreaktoro_runtime.simulation_process import migrate_config
from bridge.easyreaktoro_runtime.simulation import normalize_config, Simulation
from bridge.easyreaktoro_runtime.simulation_code import render_code, parse_code
from bridge.easyreaktoro_runtime.simulation_program import prepare_program
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs, database_source
from bridge.easyreaktoro_runtime.simulation_templates import load_settings
from bridge.easyreaktoro_runtime.simulation_storage import records, explorer_payload
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.errors import BridgeError


def repeat(count=1):
    return {'mode': 'repeat', 'count': count}


def values(kind, rows, **target):
    return {'mode': 'list', 'target': {'kind': kind, **target}, 'values': rows}


def plan(inner=None, outer=None):
    cfg = migrate_config(config())
    cfg['name'] = '双层循环核对'
    cfg['loops'] = {'base': {'temperature_c': 25, 'pressure_bar': 1}, 'inner': inner or repeat(), 'outer': outer or repeat()}
    return cfg


class LoopShapeTests(unittest.TestCase):
    def test_display_names_describe_reaction_paths_without_changing_values_or_identifiers(self):
        cfg = plan(repeat(3), repeat(2))
        before = copy.deepcopy(cfg)
        p = LoopPlan(cfg)
        self.assertEqual(p.point(0, 1)['label'], '路径位置 2')
        self.assertEqual(p.point(0, 1)['id'], 'loop-2')
        self.assertEqual(p.common(1, 2), {'outer_index': 2, 'inner_index': 3, 'outer_value': 2, 'inner_value': 3})
        info = p.field_info()
        self.assertEqual(info['inner_index'], ['路径位置', 'Path position', ''])
        self.assertEqual(info['outer_index'], ['反应轮次', 'Reaction round', ''])
        self.assertEqual(info['inner_value'], info['inner_index'])
        self.assertEqual(info['outer_value'], info['outer_index'])
        self.assertEqual(cfg, before)
        actual = LoopPlan(plan(values('temperature', [25, 50]), values('pressure', [1, 100])))
        self.assertEqual(actual.field_info()['inner_value'], ['温度', 'Temperature', '°C'])
        self.assertEqual(actual.field_info()['outer_value'], ['压力', 'Pressure', 'bar'])

    def test_fixed_step_uses_bound_without_manufacturing_unequal_final_step(self):
        axis = {'mode': 'range', 'target': {'kind': 'temperature'}, 'start': 0, 'end': 5, 'step': 2}
        self.assertEqual(axis_values(axis), [0, 2, 4])
        self.assertEqual(axis_values({**axis, "start": 0, "end": 1e-12, "step": 1}), [0])
        self.assertEqual(axis_values({**axis, 'start': .3, 'end': 0, 'step': -.1})[-1], 0)
        self.assertEqual(axis_values({**axis, 'start': 0, 'end': .3, 'step': .1})[-1], .3)
        for change in [{'step': 0}, {'step': -1}, {'end': float('inf')}, {'end': 20001, 'step': 1}]:
            with self.assertRaises(BridgeError): axis_values({**axis, **change})
        self.assertEqual(axis_values(values('pressure', [1, 1, 2])), [1, 1, 2])

    def test_both_repeat_axes_are_real_dimensions_and_legacy_routes_are_retained(self):
        cfg = plan(repeat(3), repeat(2))
        cfg['points'].append({'id': 'old-2', 'label': 'legacy', 'temperature_c': 80, 'pressure_bar': 9, 'routes': [route('output', point_id='p1', lag=0)]})
        cfg['cycles'] = 7
        before = copy.deepcopy(cfg)
        normalize_loops(cfg)
        projected = execution_config(cfg)
        self.assertEqual(cfg, before)
        self.assertEqual([p['id'] for p in projected['points']], ['loop-1', 'loop-2', 'loop-3'])
        self.assertEqual(projected['cycles'], 2)
        self.assertTrue(all('routes' not in p for p in projected['points']))

    def test_references_targets_and_domains_are_validated_without_guessing(self):
        cases = [plan(values('temperature', [20]), values('temperature', [30])),
                 plan(values('material_amount', [.1], material_id='missing', species='NaCl(aq)')),
                 plan(values('route_fraction', [.5], route_id='missing', field='fraction')),
                 plan(values('route_fraction', [.5], route_id='route-1', field='fallback_fraction')),
                 plan(repeat(10000), repeat(3)), plan(values('material_amount', [-.1], material_id='initial', species='NaCl(aq)'))]
        saturated = plan(values('pressure', [1, 10])); saturated['loops']['base']['pressure_mode'] = 'water_saturation'; cases.append(saturated)
        for cfg in cases:
            with self.assertRaises(BridgeError): normalize_loops(cfg)
        cfg = plan(); cfg['routes'] = [route(id='route-2'), route(), route()]
        normalize_loops(cfg); self.assertEqual([r['id'] for r in cfg['routes']], ['route-2', 'route-2-1', 'route-3'])
        cfg['routes'][2]['id'] = 'route-2'
        with self.assertRaises(BridgeError): normalize_loops(cfg)

    def test_code_shows_only_active_loops_but_preserves_legacy_coordinates_and_custom_cells(self):
        cfg = plan(values('temperature', [25, 50]), repeat(2))
        cfg.update(gas_model='ideal', balance_tolerance_mol=1e-10, ion_size_overrides={}, allow_database_defaults=True, allow_recorded_assignments=True)
        doc = render_code(cfg)
        conditions = next(c for c in doc['cells'] if c['id'] == 'conditions')
        self.assertIn('loops =', conditions['source']); self.assertNotIn('points =', conditions['source']); self.assertNotIn('cycles =', conditions['source'])
        conditions['source'] = conditions['source'].replace("'count': 2", "'count': 3")
        parsed = parse_code(doc, cfg)
        self.assertTrue(parsed['valid'], parsed); self.assertEqual(parsed['config']['loops']['outer']['count'], 3)
        self.assertEqual(parsed['config']['points'], cfg['points']); self.assertEqual(parsed['config']['cycles'], cfg['cycles'])
        custom = next(c for c in doc['cells'] if c['id'] == 'process'); custom['source'] += '\n# User process note\n'
        editor = {'version': 1, 'mode': 'code', 'document': doc, 'config': cfg, 'dirty': True}
        next_cfg, program, identity = prepare_program(cfg, editor)
        self.assertEqual(next_cfg['loops']['outer']['count'], 3)
        self.assertEqual(next(c['source'] for c in program['cells'] if c['id'] == 'process'), custom['source'])
        self.assertEqual(identity['mode'], 'custom')
        conditions['source'] = 'loops = None\n'
        reverted = parse_code(doc, cfg)
        self.assertTrue(reverted['valid'], reverted); self.assertNotIn('loops', reverted['config'])
        self.assertEqual(reverted['config']['points'], cfg['points'])


@unittest.skipIf(reaktoro is None, 'External Reaktoro required')
class RealLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = Service(); cls.handle = cls.service.handle(cls.service.open_official('SUPCRT', 'supcrtbl')['handle_id'])
        cls.source = database_source(cls.handle)

    @classmethod
    def tearDownClass(cls): cls.service.simulation_jobs.close()

    def run_plan(self, cfg):
        rows = []; sim = Simulation({'config': cfg, 'records': self.handle['records'], 'source': self.source})
        metadata = sim.run(rows.append)
        self.assertTrue(all(r['summary']['max_component_balance_error_mol'] <= 1e-10 for r in rows))
        self.assertTrue(all(abs(r['error_mol']) <= 1e-9 for r in metadata['process_balance']))
        return rows, metadata

    def amount(self, row, name, key='inlet_amount_mol'):
        return next(r[key] for r in row['species'] if r['species'] == name)

    def test_temperature_pressure_grid_reapplies_original_inventory_at_each_combination(self):
        cfg = plan(values('pressure', [1, 10, 20]), values('temperature', [25, 50]))
        cfg['cycles'] = 99
        rows, meta = self.run_plan(cfg)
        self.assertEqual([(r['summary']['temperature_c'], r['summary']['pressure_bar']) for r in rows], [(t,p) for t in [25,50] for p in [1,10,20]])
        self.assertEqual([(r['summary']['outer_index'], r['summary']['inner_index']) for r in rows], [(o,i) for o in [1,2] for i in [1,2,3]])
        self.assertEqual([r['summary']['inner_value'] for r in rows], [1,10,20]*2)
        self.assertTrue(all(self.amount(r, 'NaCl(aq)') == .1 for r in rows))
        self.assertEqual(meta['config']['cycles'], 99); self.assertEqual(meta['config']['points'], cfg['points'])
        self.assertEqual(meta['loop_axes']['inner']['unit'], 'bar')

    def test_feed_amount_and_fraction_axes_change_real_moles_and_equilibrium(self):
        cfg = plan(values('material_amount', [.01, .1, .2], material_id='initial', species='NaCl(aq)'), values('route_fraction', [1, 2], route_id='route-1', field='fraction'))
        rows, meta = self.run_plan(cfg)
        self.assertEqual([self.amount(r, 'NaCl(aq)') for r in rows], [.01,.1,.2,.02,.2,.4])
        self.assertGreater(self.amount(rows[2], 'Na+', 'amount_mol'), self.amount(rows[0], 'Na+', 'amount_mol') * 10)
        self.assertAlmostEqual(self.amount(rows[3], 'H2O(aq)'), 2 * self.amount(rows[0], 'H2O(aq)'), delta=1e-12)
        self.assertEqual(meta['loop_axes']['inner']['unit'], 'mol')
        self.assertAlmostEqual(next(x['input_mol'] for x in meta['process_balance'] if x['component']=='Na'), .93)

    def test_feed_units_and_first_use_semantics_do_not_overwrite_inherited_solution(self):
        cfg = plan(values('material_amount', [1, 2, 3], material_id='initial', species='H2O(aq)'), repeat(2))
        cfg['routes'] = [route('previous_point', id='carry')]
        rows, _ = self.run_plan(cfg)
        self.assertEqual(len(rows), 6)
        # Every outer iteration starts with the first inner value: 1 kg. Later
        # recipe settings are not injected into an inherited fluid stream.
        for offset in (0,3):
            for i in (1,2):
                for name in cfg['species']:
                    self.assertEqual(self.amount(rows[offset+i], name), self.amount(rows[offset+i-1], name, 'amount_mol'))
        self.assertEqual(self.amount(rows[0], 'H2O(aq)'), self.amount(rows[3], 'H2O(aq)'))

    def test_fallback_multiplier_is_applied_only_when_each_outer_first_feed_is_needed(self):
        cfg = plan(repeat(2), values('route_fraction', [1, 2], route_id='fluid', field='fallback_fraction'))
        cfg['routes'] = [route('previous_point', id='fluid')]
        rows, _ = self.run_plan(cfg)
        self.assertAlmostEqual(self.amount(rows[2], 'H2O(aq)'), 2*self.amount(rows[0], 'H2O(aq)'), delta=1e-12)
        for a,b in ((1,0),(3,2)):
            for name in cfg['species']:
                self.assertEqual(self.amount(rows[a],name),self.amount(rows[b],name,'amount_mol'))
        cfg['routes'][0]['fallback'] = 'none'
        with self.assertRaisesRegex(BridgeError, '重新选择'):
            normalize_config(cfg,self.handle['records'],self.source)

    def test_phreeqc_mass_axis_uses_selected_input_units_for_every_combination(self):
        handle = self.service.handle(self.service.open_official('PHREEQC','phreeqc.dat')['handle_id'])
        cfg = plan(values('material_amount',[18,36],material_id='initial',species='H2O'),values('temperature',[25,50]))
        cfg['species'] = ['H2O','H+','OH-']; cfg['activity_model'] = 'phreeqc'
        cfg['materials'][0]['inputs'] = [{'species':'H2O','amount':0,'unit':'g'}]
        sim = Simulation({'config':cfg,'records':handle['records'],'source':database_source(handle)})
        rows=[];sim.run(rows.append)
        molar_mass=float(sim.database.species('H2O').molarMass())
        self.assertEqual(len(rows),4)
        for row,grams in zip(rows,[18,36,18,36]):
            self.assertAlmostEqual(self.amount(row,'H2O'),grams*.001/molar_mass,delta=1e-12)
            self.assertLessEqual(row['summary']['max_component_balance_error_mol'],1e-10)

    def test_flushing_carries_fluid_along_inner_and_rock_from_same_inner_of_prior_outer(self):
        cfg = plan(values('pressure', [10, 20]), repeat(2))
        cfg['species'] = ['H2O(aq)','H+','OH-','Ca+2','HCO3-','CO3-2','CO2(aq)','Calcite']
        cfg['materials'][0]['inputs'] = [{'species':'H2O(aq)','amount':1,'unit':'kg'}, {'species':'Calcite','amount':.002,'unit':'mol'}]
        cfg['routes'] = [route('previous_point', 'aqueous', id='fluid'), route('previous_cycle', 'mineral', id='rock')]
        rows, _ = self.run_plan(cfg)
        for a,b in ((1,0),(3,2)):
            for name in cfg['species'][:-1]: self.assertEqual(self.amount(rows[a],name), self.amount(rows[b],name,'amount_mol'))
        for a,b in ((2,0),(3,1)): self.assertEqual(self.amount(rows[a],'Calcite'),self.amount(rows[b],'Calcite','amount_mol'))
        self.assertEqual(self.amount(rows[2],'H2O(aq)'),self.amount(rows[0],'H2O(aq)'))

    def test_changed_transfer_fraction_is_checked_at_each_coordinate_before_running(self):
        cfg = plan(repeat(2), values('route_fraction', [.3, .7], route_id='a', field='fraction'))
        cfg['routes'] = [route('previous_point',id='a'),route('previous_point',id='b',fraction=.4, fallback='none')]
        with self.assertRaisesRegex(BridgeError, '超过 100%'):
            normalize_config(cfg,self.handle['records'],self.source)
        cfg = plan(repeat(2)); cfg['routes'] = [route('output', point_id='p1', lag=1)]
        with self.assertRaisesRegex(BridgeError, '引用存在'):
            normalize_config(cfg,self.handle['records'],self.source)

    def test_saturation_uses_current_temperature_and_catches_an_invalid_middle_value(self):
        cfg = plan(values('temperature', [25,50,100]), repeat())
        cfg['loops']['base']['pressure_mode'] = 'water_saturation'
        rows, _ = self.run_plan(cfg)
        self.assertTrue(all(rows[i]['summary']['pressure_bar'] < rows[i+1]['summary']['pressure_bar'] for i in (0,1)))
        cfg['loops']['inner']['values'][1] = 400
        with self.assertRaisesRegex(BridgeError, '饱和蒸汽压'):
            normalize_config(cfg,self.handle['records'],self.source)

    def test_worker_saves_and_reopens_same_loop_code_with_accurate_total_and_axes(self):
        cfg = plan(values('material_amount',[.01,.02],material_id='initial',species='NaCl(aq)'),values('temperature',[25,50]))
        cfg['cycles'] = 17
        jobs = Jobs()
        try:
            with tempfile.TemporaryDirectory() as folder:
                initial = jobs.start(self.handle,cfg,folder)
                self.assertEqual(initial['total'],4)
                root = Path(initial['output_path'])
                self.assertIn('loop_axes',json.loads((root/'metadata.json').read_text()))
                deadline=time.monotonic()+20
                while jobs.status(initial['job_id'])['status']=='running' and time.monotonic()<deadline: time.sleep(.03)
                status=jobs.status(initial['job_id']);self.assertEqual(status['status'],'completed',status)
                saved=load_settings(root/'simulation.ersim.json')
                self.assertEqual(saved['config']['loops'],cfg['loops']);self.assertEqual(saved['config']['points'],cfg['points']);self.assertEqual(saved['config']['cycles'],17)
                reopened, program, _ = prepare_program(saved['config'],saved['code_editor'])
                self.assertEqual(reopened['loops'],cfg['loops'])
                first = list(records(root));self.assertEqual(len(first),4)
                preview = explorer_payload(root)
                self.assertEqual(preview['metadata']['field_info']['inner_value'][2], 'mol')
                self.assertIn('NaCl(aq)', preview['metadata']['field_info']['inner_value'][0])
                self.assertEqual([r['summary']['inner_value'] for r in first],[.01,.02,.01,.02])
                self.assertEqual([r['summary']['outer_value'] for r in first],[25,25,50,50])
                cfg2=copy.deepcopy(saved['config']);cfg2['name']='重开双循环'
                runtime=next(c for c in saved['code_editor']['document']['cells'] if c['id']=='runtime')
                runtime['source']=runtime['source'].replace('from easyreaktoro_runtime.simulation_loops import execution_config, LoopPlan\n','')+'\n# Preserved custom runtime from before loop helpers were added.\n'
                second=jobs.start(self.handle,cfg2,folder,saved['code_editor'])
                deadline=time.monotonic()+20
                while jobs.status(second['job_id'])['status']=='running' and time.monotonic()<deadline: time.sleep(.03)
                status=jobs.status(second['job_id']);self.assertEqual(status['status'],'completed',status)
                self.assertEqual(list(records(Path(second['output_path']))),first)
        finally: jobs.close()

    def test_failed_later_iteration_keeps_original_settings_axes_and_complete_earlier_point(self):
        cfg = plan(values('material_amount',[1,0],material_id='initial',species='H2O(aq)'),repeat())
        cfg['cycles'] = 17
        jobs=Jobs()
        try:
            with tempfile.TemporaryDirectory() as folder:
                first=jobs.start(self.handle,cfg,folder)
                deadline=time.monotonic()+20
                while jobs.status(first['job_id'])['status']=='running' and time.monotonic()<deadline: time.sleep(.03)
                status=jobs.status(first['job_id']);self.assertEqual(status['status'],'failed',status)
                root=Path(first['output_path']);self.assertEqual(len(list(records(root))),1)
                metadata=json.loads((root/'metadata.json').read_text())
                self.assertEqual(metadata['config']['cycles'],17);self.assertEqual(metadata['config']['points'],cfg['points'])
                self.assertEqual(metadata['loop_axes']['inner']['values'],[1,0])
                self.assertEqual(metadata['field_info']['inner_value'][2],'kg')
        finally: jobs.close()
