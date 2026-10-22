"""Direct reaction formulas, stop rules and actual equilibrium execution."""
import copy
import unittest
from tests.test_simulation_schedule import scheduled, setting, fixed, override
from tests.test_simulation_reactions import fresh_stages
from tests.test_simulation import reaktoro as r
from bridge.easyreaktoro_runtime.reaction_expression import evaluate_expression
from bridge.easyreaktoro_runtime.simulation_schedule import SchedulePlan
from bridge.easyreaktoro_runtime.simulation import Simulation, normalize_config
from bridge.easyreaktoro_runtime.simulation_code import render_code, parse_code
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.simulation_jobs import database_source


def formula(cfg, stage, kind, text):
    rounds = {'start': 1, 'end': 1} if stage.startswith('first') else {'start': 2}
    positions = {'start': 1, 'end': 1} if stage.endswith('start') else {'start': 2}
    cfg['schedule']['overrides'].append(override(stage+'-'+kind, [setting(stage+'-'+kind, kind, {'mode': 'expression', 'expression': text})], rounds, positions))


def base():
    cfg = scheduled()
    cfg['reaction_stages'] = fresh_stages()
    cfg.update(gas_model='ideal', balance_tolerance_mol=1e-10, ion_size_overrides={}, allow_database_defaults=True, allow_recorded_assignments=True)
    return cfg


class ExpressionContract(unittest.TestCase):
    def test_arithmetic_and_rejected_code(self):
        self.assertEqual(evaluate_expression('max(1, 2^3) + min(4, 3)', lambda name: 0), 11)
        self.assertEqual(evaluate_expression('-2^2', lambda name: 0), -4)
        self.assertEqual(evaluate_expression('0050', lambda name: 0), 50)
        self.assertEqual(evaluate_expression('0.3-3*0.1', lambda name: 0), 0)
        for text in ['__import__("os")', 'x.__class__', '1/0', 'sqrt(-1)', 'x[0]', 'True', '[1 for x in y]', '0x10', '1_000', '2**3', 'max(1,)' ]:
            with self.subTest(text=text), self.assertRaises((ValueError, TypeError)):
                evaluate_expression(text, lambda name: 1)

    def test_hch_pressure_path_and_code_roundtrip(self):
        cfg = base()
        for wave in ('first', 'later'):
            formula(cfg, wave+'_start', 'temperature', '250')
            formula(cfg, wave+'_following', 'temperature', 'T')
            formula(cfg, wave+'_start', 'pressure', '700')
            formula(cfg, wave+'_following', 'pressure', 'P-5')
        cfg['schedule']['stop'] = dict(first='P < 150', later='P < 150', rounds='N = 2')
        plan = SchedulePlan(cfg)
        self.assertEqual(plan.lengths, [112]*3)
        self.assertEqual(plan.total, 336)
        self.assertEqual(plan.point(2,111)['pressure_bar'], 145)
        parsed = parse_code(render_code(cfg), cfg)
        self.assertTrue(parsed['valid'], parsed)
        self.assertEqual(parsed['config']['schedule'], cfg['schedule'])

    def test_uneven_round_lengths(self):
        cfg = base();cfg['schedule']['stop'] = dict(first='i = 1', later='i = N+1', rounds='N = 2')
        plan = SchedulePlan(cfg)
        self.assertEqual(plan.lengths, [2,3,4]);self.assertEqual(plan.total, 9)
        self.assertFalse(plan.active(1,3));self.assertEqual(plan.run_index(2,0), 5)

    def test_inheritance_rejects_positions_not_reached_in_the_previous_round(self):
        for kind, profile, target in [
            ('material_amount', {'mode':'expression', 'expression':'Xr*2'}, {'material_id':'initial', 'species':'NaCl(aq)'}),
            ('material_amount', {'mode':'relative', 'along':'round', 'start':.1, 'step':.1, 'other_step':0}, {'material_id':'initial', 'species':'NaCl(aq)'}),
            ('temperature', {'mode':'relative', 'along':'round', 'start':25, 'step':10, 'other_step':0}, {}),
        ]:
            with self.subTest(kind=kind, mode=profile['mode']):
                cfg=base();cfg['schedule']['stop']={'first':'i=1','later':'i=2','rounds':'N=1'}
                cfg['schedule']['overrides'].append(override('inherit',[setting('inherit',kind,profile,**target)],rounds={'start':2}))
                with self.assertRaisesRegex(Exception, 'ended'):
                    SchedulePlan(cfg)
                cfg['schedule']['overrides'][0]['positions']['end']=2
                valid=SchedulePlan(cfg)
                self.assertEqual(valid.lengths,[2,3])

    def test_never_reaches_end_is_an_error(self):
        cfg = base();cfg['schedule']['stop'] = {'first': 'P < 0'}
        with self.assertRaisesRegex(Exception, '10,000'): SchedulePlan(cfg)


@unittest.skipIf(r is None, 'External Reaktoro required')
class ExpressionEquilibria(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = Service()
        cls.handle = cls.service.handle(cls.service.open_official('SUPCRT', 'supcrtbl')['handle_id'])
        cls.source = database_source(cls.handle)

    def execute(self, cfg):
        normalized, _ = normalize_config(cfg, self.handle['records'], self.source)
        records = []
        Simulation({'config':normalized, 'records':self.handle['records'], 'source':self.source}, lambda **kw:None).run(records.append)
        self.assertEqual(len(records), SchedulePlan(cfg).total)
        for index, record in enumerate(records):
            self.assertEqual(record['summary']['run_index'], index)
            self.assertLess(record['summary']['max_component_balance_error_mol'], 1e-8)
        return records

    def test_real_mixed_pressure_cooling_and_dose(self):
        cfg = base()
        for wave in ('first','later'):
            formula(cfg, wave+'_start', 'temperature', '150-10*N')
            formula(cfg, wave+'_following', 'temperature', 'T-20')
            formula(cfg, wave+'_start', 'pressure', 'Psat(T)' if wave=='first' else '700')
            formula(cfg, wave+'_following', 'pressure', 'Psat(T)' if wave=='first' else 'P')
        cfg['schedule']['stop'] = dict(first='T <= 90',later='T <= 90',rounds='N = 2')
        records = self.execute(cfg)
        self.assertEqual([v['summary']['temperature_c'] for v in records], [150,130,110,90,140,120,100,80,130,110,90])
        for row in records:
            summary = row['summary'];expected = float(r.waterSaturationPressureWagnerPruss(summary['temperature_c']+273.15))/1e5 if summary['pass']==1 else 700
            self.assertAlmostEqual(summary['pressure_bar'], expected, places=7)

    def test_real_uneven_rounds_match_independent_single_point_solves(self):
        cfg = base();cfg['schedule']['stop'] = dict(first='i=1',later='i=N+1',rounds='N=2')
        cfg['schedule']['parameters'][0]['value'] = {'mode':'expression','expression':'50+20*i+10*N'}
        records = self.execute(cfg)
        self.assertEqual([(v['summary']['pass'],v['summary']['step']) for v in records], [(1,1),(1,2),(2,1),(2,2),(2,3),(3,1),(3,2),(3,3),(3,4)])
        for actual in records:
            single = base();single['schedule']['parameters'][0]['value'] = fixed(actual['summary']['temperature_c'])
            expected = self.execute(single)[0]
            self.assertAlmostEqual(actual['summary']['pH'], expected['summary']['pH'], places=7)
            by_name = {v['species']:v['amount_mol'] for v in expected['species']}
            for species in actual['species']:
                self.assertAlmostEqual(species['amount_mol'], by_name[species['species']], delta=max(1e-12, abs(by_name[species['species']])*1e-7))

    def test_coupled_fluid_and_solid_transfers_with_formula_doses(self):
        from tests.test_simulation_process import route
        cfg = base()
        aqueous = ['H2O(aq)','H+','OH-','Ca+2','HCO3-','CO3-2','CO2(aq)','Na+','Cl-','NaCl(aq)']
        cfg['species'] = aqueous+['Calcite']
        cfg['materials'] = [{'id':'fluid','name':'Fluid','inputs':[{'species':'H2O(aq)','amount':1,'unit':'kg'},{'species':'NaCl(aq)','amount':.01,'unit':'mol'}]}, {'id':'rock','name':'Rock','inputs':[{'species':'Calcite','amount':.002,'unit':'mol'}]}]
        cfg['reaction_stages'] = {
            'first_start':[route(material_id='fluid',id='water0'),route(material_id='rock',id='rock0')],
            'first_following':[route('previous_point','aqueous',id='left0',fallback='error'),route(material_id='rock',id='rock-i')],
            'later_start':[route(material_id='fluid',id='water-N'),route('previous_cycle','mineral',id='above0',fallback='error')],
            'later_following':[route('previous_point','aqueous',id='leftN',fallback='error'),route('previous_cycle','mineral',id='aboveN',fallback='error')],
        }
        cfg['schedule']['parameters'][0]['value']={'mode':'expression','expression':'150-20*i-10*N'}
        cfg['schedule']['parameters'][1]['value']=fixed(700)
        cfg['schedule']['parameters'].append(setting('rock-dose','route_fraction',{'mode':'expression','expression':'1+0.5*i'},route_id='rock-i',field='fraction'))
        cfg['schedule']['parameters'].append(setting('fluid-dose','route_fraction',{'mode':'expression','expression':'1/(N+1)'},route_id='water-N',field='fraction'))
        cfg['schedule']['stop']=dict(first='i=3',later='i=3',rounds='N=2')
        records=self.execute(cfg)
        for index, record in enumerate(records):
            outer, inner=divmod(index,4)
            self.assertEqual(record['summary']['temperature_c'],150-20*inner-10*outer)
            input_amounts={name:sum(t['amounts_mol'].get(name,0) for t in record['transfers']) for name in cfg['species']}
            if inner:
                previous={s['species']:s['amount_mol'] for s in records[index-1]['species']}
                for name in aqueous:self.assertAlmostEqual(input_amounts[name],previous[name],delta=max(1e-12,abs(previous[name])*1e-9))
            if outer:
                previous={s['species']:s['amount_mol'] for s in records[index-4]['species']}
                self.assertAlmostEqual(input_amounts['Calcite'],previous['Calcite'],delta=1e-12)
            # Independent equilibrium from exactly the assembled species inventory.
            single=copy.deepcopy(cfg);single['schedule']=scheduled()['schedule'];single['schedule']['parameters'][0]['value']=fixed(record['summary']['temperature_c']);single['schedule']['parameters'][1]['value']=fixed(700)
            single['materials']=[{'id':'initial','name':'Independent inventory','inputs':[{'species':name,'amount':amount,'unit':'mol'} for name,amount in input_amounts.items()]}];single['reaction_stages']=fresh_stages()
            expected=self.execute(single)[0]
            by_name={s['species']:s['amount_mol'] for s in expected['species']}
            self.assertAlmostEqual(record['summary']['pH'],expected['summary']['pH'],places=6)
            for species in record['species']:
                self.assertAlmostEqual(species['amount_mol'],by_name[species['species']],delta=max(1e-11,abs(by_name[species['species']])*1e-6))
