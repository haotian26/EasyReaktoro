"""Adversarial tests of material allocation and recoverable calculation output."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from tests.test_simulation import config, reaktoro
from bridge.easyreaktoro_runtime.simulation import Simulation, normalize_config
from bridge.easyreaktoro_runtime.simulation_process import migrate_config
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs, database_source
from bridge.easyreaktoro_runtime.simulation_storage import explorer_payload, records
from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.errors import BridgeError


def route(source='material',phase='all',**kw):
    return {'source':source,'phase':phase,'material_id':'initial','fraction':1,'fallback':'material','fallback_fraction':1,'when':'always',**kw}


@unittest.skipIf(reaktoro is None,'External Reaktoro required')
class ProcessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service=Service();cls.handle=cls.service.handle(cls.service.open_official('SUPCRT','supcrtbl')['handle_id'])
        cls.source=database_source(cls.handle)
    @classmethod
    def tearDownClass(cls):cls.service.simulation_jobs.close()
    def plan(self,count=1,cycles=1):
        cfg=migrate_config(config())
        cfg['points']=[{'id':f'p{i+1}','label':f'P{i+1}','temperature_c':25,'pressure_bar':1} for i in range(count)]
        cfg['cycles']=cycles;cfg['routes']=[route()]
        return cfg
    def run_plan(self,cfg):
        sim=Simulation({'config':cfg,'records':self.handle['records'],'source':self.source});rows=[];meta=sim.run(rows.append)
        return rows,meta
    def normalize(self,cfg):return normalize_config(cfg,self.handle['records'],self.source)
    def lookup(self,rows,i,n):return next(x for x in rows[i]['species'] if x['species']==n)

    def test_split_streams_and_mix_an_independent_recipe_without_creating_mass(self):
        cfg=self.plan(3)
        cfg['materials'].append({'id':'salt','name':'Added salt','inputs':[{'species':'NaCl(aq)','amount':.2,'unit':'mol'}]})
        cfg['points'][1]['routes']=[route('output',point_id='p1',lag=0,fraction=.25),route(material_id='salt')]
        cfg['points'][2]['routes']=[route('output',point_id='p1',lag=0,fraction=.75)]
        rows,meta=self.run_plan(cfg)
        for n in cfg['species']:
            expected=.25*self.lookup(rows,0,n)['amount_mol']+(.2 if n=='NaCl(aq)' else 0)
            self.assertAlmostEqual(self.lookup(rows,1,n)['inlet_amount_mol'],expected,delta=1e-12)
        sodium=next(x for x in meta['process_balance'] if x['component']=='Na')
        self.assertAlmostEqual(sodium['input_mol'],.3,delta=1e-12)
        self.assertAlmostEqual(sodium['inventory_mol'],.3,delta=1e-12)

    def test_partial_recirculation_uses_previous_cycle_and_separately_accounts_makeup_feed(self):
        cfg=self.plan(cycles=3)
        cfg['routes']=[route('previous_cycle',fraction=.5),route(fraction=.5,when='after_first_cycle')]
        rows,meta=self.run_plan(cfg)
        for n in cfg['species']:
            fresh=.5*(.1 if n=='NaCl(aq)' else self.lookup(rows,0,n)['inlet_amount_mol'] if n=='H2O(aq)' else 0)
            self.assertAlmostEqual(self.lookup(rows,1,n)['inlet_amount_mol'],.5*self.lookup(rows,0,n)['amount_mol']+fresh,delta=1e-12)
        na=next(x for x in meta['process_balance'] if x['component']=='Na')
        self.assertAlmostEqual(na['input_mol'],.2,delta=1e-12)
        self.assertLess(abs(na['error_mol']),1e-10)

    def test_previous_point_output_is_not_replaced_with_original_feed(self):
        cfg=self.plan(2);cfg['routes']=[route('previous_point')]
        rows,_=self.run_plan(cfg)
        for n in cfg['species']:
            self.assertEqual(self.lookup(rows,1,n)['inlet_amount_mol'],self.lookup(rows,0,n)['amount_mol'])
        self.assertGreater(self.lookup(rows,1,'Na+')['inlet_amount_mol'],.09)

    def test_zero_recycle_fraction_does_not_disable_independent_first_feed(self):
        cfg=self.plan(cycles=2)
        cfg['routes']=[route('previous_cycle',fraction=0,fallback_fraction=1),route(when='after_first_cycle')]
        rows,meta=self.run_plan(cfg)
        self.assertEqual(len(rows),2)
        for row in rows:
            self.assertAlmostEqual(next(s for s in row['species'] if s['species']=='NaCl(aq)')['inlet_amount_mol'],.1,delta=1e-12)
        na=next(x for x in meta['process_balance'] if x['component']=='Na')
        self.assertAlmostEqual(na['input_mol'],.2,delta=1e-12)

    def test_same_output_cannot_be_spent_again_in_the_next_cycle(self):
        cfg=self.plan(2,2);cfg['routes']=[route('previous_point'),route('previous_cycle',fallback='none')]
        with self.assertRaisesRegex(BridgeError,'超过 100%'):self.normalize(cfg)

    def test_overlapping_phase_and_species_allocations_are_rejected_before_solving(self):
        cfg=self.plan(2);cfg['points'][1]['routes']=[route('previous_point'),route('previous_point','species',species=['Na+'])]
        with self.assertRaisesRegex(BridgeError,'超过 100%'):self.normalize(cfg)

    def test_future_unknown_points_and_missing_first_sources_are_rejected(self):
        for r in [route('output',point_id='p2',lag=0),route('output',point_id='absent',lag=1),route('previous_point',fallback='error')]:
            cfg=self.plan(2);cfg['points'][0]['routes']=[r]
            with self.assertRaises(BridgeError):self.normalize(cfg)

    def test_fraction_bounds_and_invalid_recipe_references_are_rejected(self):
        for r in [route('previous_cycle',fraction=1.1),route(fraction=float('nan')),route(material_id='absent'),route('output',point_id='p1',lag=True)]:
            cfg=self.plan();cfg['routes']=[r]
            with self.assertRaises(BridgeError):self.normalize(cfg)

    def test_cycle_temperature_pressure_schedule_and_invalid_late_pressure(self):
        cfg=self.plan(cycles=3);cfg['points'][0].update(temperature_increment_c=10,pressure_bar=100,pressure_increment_bar=-10)
        rows,_=self.run_plan(cfg)
        self.assertEqual([r['summary']['temperature_c'] for r in rows],[25,35,45])
        self.assertEqual([r['summary']['pressure_bar'] for r in rows],[100,90,80])
        cfg['points'][0]['pressure_increment_bar']=-100
        with self.assertRaises(BridgeError):self.normalize(cfg)
        cfg['points'][0]['pressure_increment_bar']=1e308
        with self.assertRaises(BridgeError):self.normalize(cfg)

    def test_selective_charged_transfer_does_not_silently_titrate(self):
        cfg=self.plan(2);cfg['points'][1]['routes']=[route('previous_point','species',species=['H2O(aq)','Na+'])]
        with self.assertRaisesRegex(BridgeError,'净电荷'):self.run_plan(cfg)

    def test_pure_mineral_system_does_not_require_water(self):
        cfg=self.plan();cfg['species']=['Quartz'];cfg['materials'][0]['inputs']=[{'species':'Quartz','amount':1,'unit':'mol'}]
        rows,_=self.run_plan(cfg)
        self.assertAlmostEqual(rows[0]['species'][0]['amount_mol'],1,delta=1e-12)
        self.assertIsNone(rows[0]['summary']['water_mass_kg'])
        self.assertIsNone(rows[0]['summary']['pH'])

    def test_pure_gas_ideal_and_peng_robinson_models_use_actual_phase_inventory(self):
        for model in ('ideal','peng_robinson'):
            cfg=self.plan(2);cfg['species']=['CO2(g)','N2(g)'];cfg['gas_model']=model
            cfg['materials'][0]['inputs']=[{'species':'CO2(g)','amount':.4,'unit':'mol'},{'species':'N2(g)','amount':.6,'unit':'mol'}]
            cfg['points'][1]['routes']=[route('previous_point','gas',fraction=.5)]
            rows,meta=self.run_plan(cfg)
            self.assertAlmostEqual(self.lookup(rows,1,'CO2(g)')['amount_mol'],.2,delta=1e-12)
            self.assertAlmostEqual(self.lookup(rows,1,'N2(g)')['amount_mol'],.3,delta=1e-12)
            self.assertIsNone(rows[1]['summary']['pH'])
            self.assertGreater(self.lookup(rows,1,'CO2(g)')['activity'],0)

    def test_failed_later_point_preserves_a_standalone_explorer_of_verified_prefix(self):
        cfg=self.plan(2);cfg['points'][1]['routes']=[route('previous_point','species',species=['H2O(aq)','Na+'])]
        with tempfile.TemporaryDirectory() as directory:
            manager=Jobs();job=manager.start(self.handle,cfg,directory);job_id=job['job_id'];root=Path(job['output_path'])
            deadline=time.monotonic()+20
            while manager.status(job_id)['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
            result=manager.status(job_id);self.assertEqual(result['status'],'failed');self.assertEqual(result['completed'],1)
            self.assertTrue((root/'Result Explorer.html').is_file());self.assertEqual(len(list(records(root))),1)
            self.assertFalse(explorer_payload(root)['metadata']['contains_all_planned_points']);manager.close()

    def test_durable_results_survive_manager_close_and_restore_explorer_data(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=Jobs();job=manager.start(self.handle,self.plan(),directory);job_id=job['job_id'];root=Path(job['output_path'])
            deadline=time.monotonic()+20
            while manager.status(job_id)['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
            self.assertEqual(manager.status(job_id)['status'],'completed')
            self.assertTrue((root/'Result Explorer.html').is_file());original=(root/'points.ndjson').read_bytes()
            manager.close();self.assertEqual((root/'points.ndjson').read_bytes(),original)
            reopened=manager.open_run(root);self.assertEqual(reopened['completed'],1)
            payload=explorer_payload(root);self.assertEqual(len(payload['summary']['rows']),1);self.assertEqual(len(payload['species_tables'][0]['rows']),6)
            self.assertEqual(payload['key_columns'],['run_index']);self.assertEqual(payload['format'],'result-explorer-1');self.assertNotIn('run_index',payload['dimension_columns']);self.assertTrue(payload['metadata']['contains_all_planned_points']);manager.close()

    def test_preview_is_bounded_even_when_one_cycle_exceeds_the_row_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=Jobs();job=manager.start(self.handle,self.plan(3),directory);job_id=job['job_id'];root=Path(job['output_path'])
            deadline=time.monotonic()+20
            while manager.status(job_id)['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
            with patch('bridge.easyreaktoro_runtime.simulation_jobs.PREVIEW_SPECIES_ROWS',7):
                self.assertTrue(manager.explorer(job_id)['choose_cycle'])
                choose=manager.explorer(job_id,1);self.assertTrue(choose['choose_page']);self.assertEqual(choose['page_count'],3)
                page=manager.explorer(job_id,1,2);self.assertEqual(page['point_count'],1)
                import gzip,base64
                payload=json.loads(gzip.decompress(base64.b64decode(page['data'])))
                row=dict(zip(payload['summary']['columns'],payload['summary']['rows'][0]));self.assertEqual(row['run_index'],1)
                self.assertEqual(len(payload['species_tables'][0]['rows']),6)
                with self.assertRaises(BridgeError):manager.explorer(job_id,1,4)
            self.assertEqual(len(list(records(root))),3);manager.close()

    def test_running_preview_reports_new_rounds_in_every_response_without_losing_selected_round(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=Jobs();self.addCleanup(manager.close)
            job=manager.start(self.handle,self.plan(3,2),directory);job_id=job['job_id'];root=Path(job['output_path'])
            deadline=time.monotonic()+20
            while manager.status(job_id)['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
            self.assertEqual(manager.status(job_id)['status'],'completed')
            complete=list(records(root))
            with patch('bridge.easyreaktoro_runtime.simulation_jobs.PREVIEW_SPECIES_ROWS',7):
                # Expose the committed prefix, then the later completed round,
                # without modifying the durable results used for payload loading.
                with patch('bridge.easyreaktoro_runtime.simulation_jobs.records',return_value=iter(complete[:3])) as stream:
                    first=manager.explorer(job_id,1,1)
                    self.assertEqual(first['cycles'],[1]);self.assertEqual(stream.call_count,1)
                for reply in (manager.explorer(job_id),manager.explorer(job_id,1),manager.explorer(job_id,1,1)):
                    self.assertEqual(reply['cycles'],[1,2])
                refreshed=manager.explorer(job_id,1,1)
                self.assertEqual(refreshed['data'],first['data'])
                self.assertEqual(refreshed['point_count'],1)

    def test_killed_worker_stale_lock_and_torn_record_recover_only_committed_points(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=Jobs();cfg=self.plan(5000);job=manager.start(self.handle,cfg,directory);root=Path(job['output_path']);process=manager.job(job['job_id'])['process']
            deadline=time.monotonic()+20
            while manager.status(job['job_id'])['completed']<1 and process.poll() is None and time.monotonic()<deadline:time.sleep(.03)
            process.kill();process.wait();manager.close()
            complete=list(records(root));self.assertGreater(len(complete),0)
            with (root/'points.ndjson').open('a') as stream:stream.write('{"torn":')
            before={p.name:p.read_bytes() for p in root.iterdir() if p.is_file()}
            restored=manager.open_run(root);self.assertEqual(restored['status'],'interrupted');self.assertEqual(restored['completed'],len(complete))
            self.assertEqual(manager.explorer(restored['job_id'])['point_count'],len(complete))
            self.assertEqual(before,{p.name:p.read_bytes() for p in root.iterdir() if p.is_file()});manager.close()

    def test_result_folder_creation_requires_a_real_location_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=Jobs()
            with self.assertRaises(BridgeError):manager.start(self.handle,self.plan(),str(Path(directory)/'absent'))
            first=manager.start(self.handle,self.plan(),directory);manager.cancel(first['job_id'])
            self.assertEqual(Path(first['output_path']).name,self.plan()['name'])
            before={p.name:p.read_bytes() for p in Path(first['output_path']).iterdir() if p.is_file()}
            with self.assertRaisesRegex(BridgeError,'已存在'):manager.start(self.handle,self.plan(),directory)
            self.assertEqual(before,{p.name:p.read_bytes() for p in Path(first['output_path']).iterdir() if p.is_file()})
            other=self.plan();other['name']='另外一次计算'
            second=manager.start(self.handle,other,directory);manager.cancel(second['job_id'])
            self.assertEqual(Path(second['output_path']).name,'另外一次计算');manager.close()

    def test_incomplete_saved_records_preview_committed_points_without_rewriting_source(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=Jobs();job=manager.start(self.handle,self.plan(),directory);job_id=job['job_id'];root=Path(job['output_path'])
            deadline=time.monotonic()+20
            while manager.status(job_id)['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
            self.assertEqual(manager.status(job_id)['status'],'completed');manager.close()
            data=(root/'points.ndjson').read_bytes();(root/'points.ndjson').write_bytes(data[:len(data)//2])
            before={p.name:p.read_bytes() for p in root.iterdir() if p.is_file()}
            result=manager.open_run(root);self.assertEqual(result['status'],'interrupted');self.assertEqual(result['completed'],0)
            self.assertEqual(manager.explorer(result['job_id'])['point_count'],0)
            self.assertEqual(manager.result(result['job_id'])['summary'],[])
            self.assertEqual(before,{p.name:p.read_bytes() for p in root.iterdir() if p.is_file()});manager.close()

if __name__=='__main__':unittest.main()
