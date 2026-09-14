"""One temperature path, independently chosen pressure conditions for any round."""
import copy
import tempfile
import time
import unittest
from pathlib import Path
from tests.test_simulation import reaktoro
from tests.test_simulation_loops import plan,repeat,values
from tests.test_simulation_reactions import fresh_stages
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.simulation import Simulation,normalize_config
from bridge.easyreaktoro_runtime.simulation_loops import LoopPlan,normalize_loops,execution_config
from bridge.easyreaktoro_runtime.simulation_program import prepare_program
from bridge.easyreaktoro_runtime.simulation_code import parse_code
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs,database_source
from bridge.easyreaktoro_runtime.simulation_storage import records
from bridge.easyreaktoro_runtime.simulation_templates import load_settings
from bridge.easyreaktoro_runtime.service import Service


def mixed_plan():
    cfg=plan(values('temperature',[250,200,150,100]),repeat(2));cfg['name']='Mixed round pressure validation'
    cfg['loops']['base']['pressure_mode']='water_saturation';cfg['loops']['base']['pressure_bar']=700
    cfg['loops']['round_conditions']=[{'round':2,'pressure_mode':'fixed','pressure_bar':700}]
    cfg['species']=['H2O(aq)','H+','OH-','Ca+2','HCO3-','CO3-2','CO2(aq)','Calcite']
    cfg['materials'][0]['inputs']=[{'species':'H2O(aq)','amount':1,'unit':'kg'},{'species':'Calcite','amount':.002,'unit':'mol'}]
    cfg['reaction_stages']=fresh_stages()
    return cfg


class RoundPressureShapeTests(unittest.TestCase):
    def test_duplicate_invalid_round_and_unknown_fields_are_rejected(self):
        for rows in [[{'round':1,'pressure_mode':'fixed'}]*2,[{'round':True,'pressure_mode':'fixed'}],[{'round':1.5,'pressure_mode':'fixed'}],[{'round':10001,'pressure_mode':'fixed'}],[{'round':1,'pressure_mode':'wrong'}],[{'round':1,'pressure_mode':'fixed','temperature_c':100}]]:
            cfg=plan();cfg['loops']['round_conditions']=rows
            with self.subTest(rows=rows),self.assertRaises(BridgeError):normalize_loops(cfg)
    def test_pressure_axis_must_be_used_by_at_least_one_active_round(self):
        cfg=plan(values('pressure',[100,200]),repeat(2));cfg['loops']['base']['pressure_mode']='water_saturation'
        with self.assertRaisesRegex(BridgeError,'没有生效'):normalize_loops(cfg)
        cfg['loops']['round_conditions']=[{'round':2,'pressure_mode':'fixed'}];normalize_loops(cfg)
        self.assertEqual([LoopPlan(cfg).point(1,i)['pressure_bar'] for i in (0,1)],[100,200])
        cfg['loops']['round_conditions'][0]['pressure_bar']=700
        with self.assertRaisesRegex(BridgeError,'没有生效'):normalize_loops(cfg)


@unittest.skipIf(reaktoro is None,'External Reaktoro required')
class RoundPressureExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service=Service();cls.handle=cls.service.handle(cls.service.open_official('SUPCRT','supcrtbl')['handle_id']);cls.source=database_source(cls.handle)
    @classmethod
    def tearDownClass(cls):cls.service.simulation_jobs.close()
    def normalize(self,cfg):return normalize_config(cfg,self.handle['records'],self.source)[0]
    def run_plan(self,cfg):
        rows=[];meta=Simulation({'config':cfg,'records':self.handle['records'],'source':self.source}).run(rows.append)
        self.assertTrue(all(abs(b['error_mol'])<1e-9 for row in rows for b in row['balances']))
        return rows,meta
    def test_first_saturation_then_fixed_pressure_preserves_each_temperature_path(self):
        cfg=mixed_plan();before=copy.deepcopy(cfg);rows,meta=self.run_plan(cfg)
        self.assertEqual([r['summary']['temperature_c'] for r in rows],[250,200,150,100]*2)
        for i,t in enumerate([250,200,150,100]):self.assertAlmostEqual(rows[i]['summary']['pressure_bar'],float(reaktoro.waterSaturationPressureWagnerPruss(t+273.15))/1e5,places=9)
        self.assertEqual([r['summary']['pressure_bar'] for r in rows[4:]],[700]*4)
        self.assertEqual(cfg,before);self.assertEqual(meta['config']['loops'],cfg['loops'])
    def test_any_round_override_is_absolute_and_unmentioned_rounds_resume_base(self):
        cfg=mixed_plan();cfg['loops']['base']['pressure_mode']='fixed';cfg['loops']['base']['pressure_bar']=300;cfg['loops']['outer']=repeat(4)
        cfg['loops']['round_conditions']=[{'round':2,'pressure_mode':'water_saturation'},{'round':3,'pressure_mode':'fixed','pressure_bar':700},{'round':9,'pressure_mode':'fixed','pressure_bar':{'easyreaktoro_empty_number':True}}]
        normalized=self.normalize(cfg);plan=LoopPlan(normalized)
        self.assertEqual([plan.point(oi,0)['temperature_c'] for oi in range(4)],[250]*4)
        self.assertEqual([plan.point(oi,1)['pressure_bar'] for oi in (0,2,3)],[300,700,300])
        self.assertEqual(normalized['loops']['round_conditions'],cfg['loops']['round_conditions'])
        prepared,doc,_=prepare_program(normalized);self.assertTrue(parse_code(doc,prepared)['valid'])
        cfg['loops']['outer']=repeat(9)
        with self.assertRaisesRegex(BridgeError,'第 9 轮压力'):self.normalize(cfg)
    def test_domains_validate_the_actual_pressure_mode_of_every_round(self):
        cfg=mixed_plan();cfg['loops']['inner']=values('temperature',[450,400]);cfg['loops']['base']['pressure_mode']='fixed';cfg['loops']['round_conditions']=[{'round':2,'pressure_mode':'water_saturation'}]
        with self.assertRaisesRegex(BridgeError,'饱和蒸汽压'):self.normalize(cfg)
        cfg['loops']['round_conditions']=[{'round':9,'pressure_mode':'water_saturation'}];self.normalize(cfg)
        cfg['loops']['round_conditions']=[{'round':2,'pressure_mode':'fixed','pressure_bar':-1}]
        with self.assertRaises(BridgeError):self.normalize(cfg)
        cfg['loops']['round_conditions']=[{'round':1,'pressure_mode':'fixed','pressure_bar':100},{'round':2,'pressure_mode':'fixed','pressure_bar':700}];cfg['loops']['base']['pressure_mode']='water_saturation';self.normalize(cfg)
    def test_saved_standard_and_custom_programs_replay_the_same_mixed_path(self):
        cfg=mixed_plan();expected,_=self.run_plan(cfg);jobs=Jobs()
        try:
            with tempfile.TemporaryDirectory() as directory:
                for custom in (False,True):
                    cfg['name']='Mixed pressure '+str(custom)
                    prepared,doc,_=prepare_program(cfg)
                    if custom:next(c for c in doc['cells'] if c['id']=='collect')['source']+='\n# User calculation note retained\n'
                    editor={'version':1,'mode':'code','config':prepared,'document':doc,'dirty':custom}
                    started=jobs.start(self.handle,prepared,directory,editor);deadline=time.monotonic()+20
                    while jobs.status(started['job_id'])['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
                    status=jobs.status(started['job_id']);self.assertEqual(status['status'],'completed',status)
                    root=Path(started['output_path']);self.assertEqual(list(records(root)),expected)
                    loaded=load_settings(root/'simulation.ersim.json');self.assertEqual(loaded['config']['loops'],cfg['loops'])
                    actual,program,_=prepare_program(loaded['config'],loaded['code_editor']);self.assertEqual(actual['loops'],cfg['loops'])
                    self.assertEqual(next(c['source'] for c in program['cells'] if c['id']=='collect'),next(c['source'] for c in doc['cells'] if c['id']=='collect'))
        finally:jobs.close()
