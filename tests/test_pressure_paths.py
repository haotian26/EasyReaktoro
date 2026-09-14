"""Actual thermodynamic conditions must agree between UI-style plans and runnable cells."""
import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from tests.test_simulation import config, reaktoro
from bridge.easyreaktoro_runtime.simulation_process import actual_point,migrate_config
from bridge.easyreaktoro_runtime.simulation import Simulation,normalize_config
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs,database_source
from bridge.easyreaktoro_runtime.simulation_code import render_code,parse_code
from bridge.easyreaktoro_runtime.simulation_storage import records
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.errors import BridgeError

@unittest.skipIf(reaktoro is None,'External Reaktoro required')
class PressurePathTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.service=Service();cls.handle=cls.service.handle(cls.service.open_official('SUPCRT','supcrtbl')['handle_id']);cls.source=database_source(cls.handle)
 @classmethod
 def tearDownClass(cls):cls.service.simulation_jobs.close()
 def plan(self):
  cfg=migrate_config(config());cfg['cycles']=3;cfg['gas_model']='ideal'
  cfg['points']=[{'id':'p1','label':'saturated','temperature_c':100,'pressure_bar':700,'pressure_mode':'water_saturation','temperature_increment_c':50}]
  return cfg
 def test_saturation_uses_each_round_temperature_and_saves_actual_pressure(self):
  cfg=self.plan();rows=[];Simulation({'config':cfg,'records':self.handle['records'],'source':self.source}).run(rows.append)
  self.assertEqual([r['summary']['temperature_c'] for r in rows],[100,150,200])
  for i,row in enumerate(rows):
   self.assertAlmostEqual(row['summary']['pressure_bar'],float(reaktoro.waterSaturationPressureWagnerPruss(373.15+i*50))/1e5,places=11)
 def test_ranges_and_incompatible_pressure_increments_block_before_solving(self):
  for changes in [{'temperature_c':0},{'temperature_c':300},{'temperature_c':373.946,'temperature_increment_c':0},{'pressure_increment_bar':1}]:
   cfg=self.plan();cfg['points'][0].update(changes)
   with self.subTest(changes=changes),self.assertRaises(BridgeError):normalize_config(cfg,self.handle['records'],self.source)
 def test_saturation_mode_round_trips_visible_code_and_worker(self):
  cfg,_=normalize_config(self.plan(),self.handle['records'],self.source);doc=render_code(cfg);parsed=parse_code(doc,cfg)
  self.assertTrue(parsed['valid'],parsed);self.assertEqual(parsed['config']['points'][0]['pressure_mode'],'water_saturation')
  with tempfile.TemporaryDirectory() as folder:
   jobs=Jobs()
   try:
    editor={'version':1,'mode':'code','document':doc,'config':cfg,'dirty':False}
    job=jobs.start(self.handle,cfg,folder,editor);deadline=time.monotonic()+20
    while job['status']=='running' and time.monotonic()<deadline:time.sleep(.03);job=jobs.status(job['job_id'])
    self.assertEqual(job['status'],'completed',job)
    output=list(records(Path(job['output_path'])));self.assertEqual(len(output),3)
    self.assertAlmostEqual(output[0]['summary']['pressure_bar'],1.0141799381792782,places=10)
    saved=json.loads((Path(job['output_path'])/'input.json').read_text());self.assertEqual(saved['config']['points'][0]['pressure_mode'],'water_saturation')
   finally:jobs.close()
 def test_standard_edh_runs_on_saturation_curve(self):
  cfg=self.plan();cfg['cycles']=1;cfg['points'][0]['temperature_c']=250;cfg['activity_model']='nacl_edh'
  cfg['ion_size_overrides']={n:{'a_angstrom':a,'source':'Synthetic test fixture','reason':'Numerical integration check'} for n,a in [('H+',9),('OH-',3.5),('Na+',4),('Cl-',3.5)]}
  rows=[];Simulation({'config':cfg,'records':self.handle['records'],'source':self.source}).run(rows.append)
  self.assertAlmostEqual(rows[0]['summary']['pressure_bar'],39.76204322580225,delta=1e-8)

 def test_round_override_is_absolute_and_does_not_change_the_other_rounds(self):
  cfg=self.plan();cfg['points'][0]['round_conditions']=[{'round':2,'temperature_c':25,'pressure_bar':20}]
  rows=[];Simulation({'config':cfg,'records':self.handle['records'],'source':self.source}).run(rows.append)
  self.assertEqual([r['summary']['temperature_c'] for r in rows],[100,25,200])
  self.assertEqual(rows[1]['summary']['pressure_bar'],20)
  self.assertAlmostEqual(rows[2]['summary']['pressure_bar'],float(reaktoro.waterSaturationPressureWagnerPruss(473.15))/1e5,places=10)

 def test_round_overrides_survive_code_and_worker_including_inactive_rounds(self):
  cfg=self.plan();cfg['points'][0].update(pressure_mode='fixed',pressure_bar=50,round_conditions=[
   {'round':2,'temperature_c':120,'pressure_bar':800,'pressure_mode':'water_saturation'},
   {'round':8,'temperature_c':30,'pressure_bar':25}])
  cfg,_=normalize_config(cfg,self.handle['records'],self.source);doc=render_code(cfg);parsed=parse_code(doc,cfg)
  self.assertTrue(parsed['valid'],parsed);self.assertEqual(parsed['config']['points'],cfg['points'])
  with tempfile.TemporaryDirectory() as folder:
   jobs=Jobs()
   try:
    job=jobs.start(self.handle,cfg,folder,{'version':1,'mode':'code','document':doc,'config':cfg,'dirty':False});deadline=time.monotonic()+20
    while job['status']=='running' and time.monotonic()<deadline:time.sleep(.03);job=jobs.status(job['job_id'])
    self.assertEqual(job['status'],'completed',job);output=list(records(Path(job['output_path'])));self.assertEqual(len(output),3)
    self.assertEqual(output[1]['summary']['temperature_c'],120)
    self.assertAlmostEqual(output[1]['summary']['pressure_bar'],float(reaktoro.waterSaturationPressureWagnerPruss(393.15))/1e5,places=10)
    saved=json.loads((Path(job['output_path'])/'simulation.ersim.json').read_text())['config']
    self.assertEqual(saved['points'][0]['round_conditions'],cfg['points'][0]['round_conditions'])
   finally:jobs.close()

 def test_invalid_middle_override_duplicate_and_masked_linear_endpoint_are_rejected(self):
  for conditions in [
   [{'round':2,'temperature_c':400,'pressure_bar':1,'pressure_mode':'water_saturation'}],
   [{'round':2,'temperature_c':25,'pressure_bar':-1}],
   [{'round':2,'temperature_c':25,'pressure_bar':1}]*2,
   [{'round':True,'temperature_c':25,'pressure_bar':1}],
   [{'round':1.5,'temperature_c':25,'pressure_bar':1}],
   [{'round':8,'temperature_c':float('nan'),'pressure_bar':1}]]:
   cfg=self.plan();cfg['points'][0]['round_conditions']=conditions
   with self.subTest(conditions=conditions),self.assertRaises(BridgeError):normalize_config(cfg,self.handle['records'],self.source)
  cfg=self.plan();cfg['points'][0].update(pressure_mode='fixed',pressure_bar=50,pressure_increment_bar=-60,
   round_conditions=[{'round':3,'temperature_c':25,'pressure_bar':50}])
  with self.assertRaises(BridgeError):normalize_config(cfg,self.handle['records'],self.source)

 def test_first_round_does_not_evaluate_a_nonexistent_previous_round(self):
  cfg=self.plan();cfg['cycles']=1;cfg['points'][0].update(temperature_c=25,temperature_increment_c=100)
  rows=[];Simulation({'config':cfg,'records':self.handle['records'],'source':self.source}).run(rows.append)
  self.assertEqual(len(rows),1)
