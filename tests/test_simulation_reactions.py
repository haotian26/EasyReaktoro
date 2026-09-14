"""Four independent reaction positions, dynamic bindings, and exact replay."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from tests.test_simulation import reaktoro
from tests.test_simulation_process import route
from tests.test_simulation_loops import plan, repeat, values
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.simulation_reactions import STAGE_KEYS, normalize_reaction_stages, reaction_stage
from bridge.easyreaktoro_runtime.simulation_loops import normalize_loops
from bridge.easyreaktoro_runtime.simulation import Simulation, normalize_config
from bridge.easyreaktoro_runtime.simulation_code import render_code, parse_code
from bridge.easyreaktoro_runtime.simulation_program import prepare_program
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs, database_source
from bridge.easyreaktoro_runtime.simulation_storage import records
from bridge.easyreaktoro_runtime.simulation_templates import load_settings
from bridge.easyreaktoro_runtime.service import Service


def stages(**overrides):
    return {key: copy.deepcopy(overrides.get(key, [])) for key in STAGE_KEYS}


def fresh_stages():
    return stages(**{key: [route(id=key)] for key in STAGE_KEYS})


class ReactionShapeTests(unittest.TestCase):
    def test_four_groups_have_unique_stable_ids_and_never_edit_retained_old_rules(self):
        cfg=plan();cfg['reaction_stages']=stages(first_start=[route()],later_start=[route()])
        old=copy.deepcopy(cfg['routes']);normalize_reaction_stages(cfg)
        self.assertEqual(cfg['routes'],old)
        self.assertEqual(cfg['reaction_stages']['first_start'][0]['id'],'first_start-route-1')
        self.assertEqual(cfg['reaction_stages']['later_start'][0]['id'],'later_start-route-1')
        self.assertEqual([reaction_stage(c,i) for c in (0,1) for i in (0,1)],list(STAGE_KEYS))
        cfg['reaction_stages']['later_start'][0]['id']='first_start-route-1'
        with self.assertRaisesRegex(BridgeError,'唯一'):normalize_reaction_stages(cfg)

    def test_empty_groups_can_be_saved_and_code_only_shows_active_reaction_inputs(self):
        cfg=plan();cfg['reaction_stages']=stages()
        cfg.update(gas_model='ideal',balance_tolerance_mol=1e-10,ion_size_overrides={},allow_database_defaults=True,allow_recorded_assignments=True)
        doc=render_code(cfg);cell=next(c for c in doc['cells'] if c['id']=='transfers')
        self.assertIn('reaction_stages =',cell['source']);self.assertNotIn('\nroutes =',cell['source'])
        parsed=parse_code(doc,cfg);self.assertTrue(parsed['valid'],parsed)
        self.assertEqual(parsed['config']['routes'],cfg['routes'])
        self.assertEqual(parsed['config']['reaction_stages'],stages())
        cell['source']='reaction_stages = None\n'
        parsed=parse_code(doc,cfg);self.assertTrue(parsed['valid'],parsed)
        self.assertNotIn('reaction_stages',parsed['config']);self.assertEqual(parsed['config']['routes'],cfg['routes'])

    def test_bindings_are_unambiguous_and_cannot_overlap_the_other_axis(self):
        cfg=plan(repeat(2),values('route_fraction',[1,2],route_id='first_start',field='fraction'))
        cfg['reaction_stages']=fresh_stages()
        target=cfg['loops']['outer']['target'];target['bindings']=[{'route_id':key,'field':'fraction'} for key in ('first_start','later_start')]
        normalize_loops(cfg)
        cfg['loops']['inner']=values('route_fraction',[1,2],route_id='later_start',field='fraction')
        with self.assertRaisesRegex(BridgeError,'同一个'):normalize_loops(cfg)
        cfg['loops']['inner']=repeat(2)
        for bindings in [[],[{'route_id':'later_start','field':'fraction'}],target['bindings']*2,[{'route_id':'first_start','field':'unknown'}]]:
            changed=copy.deepcopy(cfg);changed['loops']['outer']['target']['bindings']=bindings
            with self.assertRaises(BridgeError):normalize_loops(changed)
        changed=copy.deepcopy(cfg);changed['loops']['outer']['target']={'kind':'route_fraction','route_id':'route-1','field':'fraction'}
        with self.assertRaisesRegex(BridgeError,'不存在'):normalize_loops(changed)

    def test_code_and_json_import_assign_same_ids_without_rewriting_code_or_bindings(self):
        cfg,_,_=prepare_program(plan())
        cfg['reaction_stages']=stages(first_start=[route(),route()],later_start=[route(id='first_start-route-1'),route(id='legacy-id')])
        cfg['loops']['inner']=values('route_fraction',[1],route_id='legacy-id',field='fraction')
        document=render_code(cfg);before=copy.deepcopy(document)
        expected=['first_start-route-1-1','first_start-route-2','first_start-route-1','legacy-id']
        parsed=parse_code(document,cfg);self.assertTrue(parsed['valid'],parsed)
        self.assertEqual([r['id'] for rows in parsed['config']['reaction_stages'].values() for r in rows],expected)
        self.assertEqual(document,before);self.assertNotIn('id',cfg['reaction_stages']['first_start'][0])
        self.assertEqual(parsed['config']['loops'],cfg['loops'])
        self.assertEqual(parse_code(document,parsed['config'])['config'],parsed['config'])
        editor={'version':1,'mode':'code','config':cfg,'document':document,'dirty':True}
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'id-import.ersim.json'
            payload={'format':'easyreaktoro-simulation','schema_version':2,'config':cfg,'code_editor':editor}
            path.write_text(json.dumps(payload));original=path.read_bytes();loaded=load_settings(path)
            self.assertEqual(loaded['config'],parsed['config'])
            self.assertEqual(loaded['code_editor']['config'],parsed['config'])
            self.assertEqual(loaded['code_editor']['document'],before)
            self.assertEqual(path.read_bytes(),original)
            loaded['config']['reaction_stages']['later_start'][0]['id']=expected[0]
            path.write_text(json.dumps({**payload,'config':loaded['config']}))
            with self.assertRaisesRegex(BridgeError,'唯一'):load_settings(path)
        # The explicitly visible old routes select their own calculation;
        # migrated but hidden stages must not mask edits to those routes.
        legacy=copy.deepcopy(document);next(c for c in legacy['cells'] if c['id']=='transfers')['source']='routes = '+repr(cfg['routes'])+'\n'
        self.assertNotIn('reaction_stages',parse_code(legacy,cfg)['config'])

    def test_stage_hidden_when_is_rejected_including_unused_stage_without_changing_legacy_rules(self):
        cfg,_,_=prepare_program(plan());cfg['reaction_stages']=stages(first_start=[route(id='a')],later_following=[route(id='hidden',when='first_cycle')])
        with self.assertRaisesRegex(BridgeError,'对应反应位置'):normalize_reaction_stages(cfg)
        parsed=parse_code(render_code(cfg),cfg);self.assertFalse(parsed['valid']);self.assertEqual(parsed['errors'][0]['cell_id'],'transfers')
        old=plan();old['routes'][0]['when']='first_cycle';normalize_loops(old)
        self.assertEqual(old['routes'][0]['when'],'first_cycle')

    def test_stage_axes_cannot_vary_unused_fallback_quantities(self):
        cfg=plan(repeat(2),values('route_fraction',[1,2],route_id='after',field='fallback_fraction'))
        cfg['reaction_stages']=stages(first_start=[route(id='start')],first_following=[route('previous_point',id='after')])
        with self.assertRaisesRegex(BridgeError,'配方份数或输出'):normalize_loops(cfg)


@unittest.skipIf(reaktoro is None,'External Reaktoro required')
class ReactionExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service=Service();cls.handle=cls.service.handle(cls.service.open_official('SUPCRT','supcrtbl')['handle_id']);cls.source=database_source(cls.handle)
    @classmethod
    def tearDownClass(cls):cls.service.simulation_jobs.close()
    def normalize(self,cfg):return normalize_config(cfg,self.handle['records'],self.source)
    def run_plan(self,cfg):
        rows=[];sim=Simulation({'config':cfg,'records':self.handle['records'],'source':self.source});meta=sim.run(rows.append)
        self.assertTrue(all(r['summary']['max_component_balance_error_mol']<=1e-10 for r in rows))
        self.assertTrue(all(abs(r['error_mol'])<=1e-9 for r in meta['process_balance']))
        return rows,meta
    def amount(self,row,name,key='inlet_amount_mol'):return next(r[key] for r in row['species'] if r['species']==name)

    def test_each_position_uses_only_its_own_recipe_and_unused_recipes_do_not_enter_system(self):
        cfg=plan(repeat(3),repeat(2));cfg['reaction_stages']=stages()
        for i,key in enumerate(STAGE_KEYS,1):
            cfg['materials'].append({'id':key,'name':key,'inputs':[{'species':'H2O(aq)','amount':1,'unit':'kg'},{'species':'NaCl(aq)','amount':i*.1,'unit':'mol'}]})
            cfg['reaction_stages'][key]=[route(id=key,material_id=key)]
        cfg['materials'].append({'id':'unused','name':'Unused unbalanced recipe','inputs':[{'species':'Na+','amount':10,'unit':'mol'}]})
        cfg['routes']=[route(material_id='unused')]
        rows,meta=self.run_plan(cfg)
        self.assertEqual([self.amount(r,'NaCl(aq)') for r in rows],[.1,.2,.2,.30000000000000004,.4,.4])
        self.assertTrue(all(self.amount(r,'Na+')==0 for r in rows))
        self.assertEqual(meta['config']['routes'],cfg['routes']);self.assertEqual(meta['config']['points'],cfg['points'])
        self.assertAlmostEqual(next(r['input_mol'] for r in meta['process_balance'] if r['component']=='Na'),1.6)

    def test_only_a_stage_reached_by_actual_execution_must_have_material_sources(self):
        cfg=plan();cfg['reaction_stages']=stages(first_start=[route(id='only')])
        self.assertEqual(len(self.run_plan(cfg)[0]),1)
        for inner,outer,label in [(2,1,'首轮后续'),(1,2,'后续轮起点'),(2,2,'首轮后续')]:
            cfg['loops']['inner']=repeat(inner);cfg['loops']['outer']=repeat(outer)
            with self.assertRaisesRegex(BridgeError,label):self.normalize(cfg)
        cfg['loops']['inner']=repeat(1);cfg['loops']['outer']=repeat(1);cfg['reaction_stages']['first_start']=[]
        with self.assertRaisesRegex(BridgeError,'首次起点'):self.normalize(cfg)

    def test_hidden_invalid_rules_and_unfinished_numbers_survive_code_and_single_execution(self):
        cfg=plan();cfg['reaction_stages']=stages(first_start=[route(id='active')],first_following=[route('output','species',id='hidden',point_id='loop-2',lag=0,species=[],fraction={'easyreaktoro_empty_number':True})])
        cfg['routes']=[route(fraction={'easyreaktoro_empty_number':True},material_id='deleted')]
        cfg['points'][0]['routes']=copy.deepcopy(cfg['routes'])
        prepared,document,_=prepare_program(cfg)
        self.assertEqual(prepared['reaction_stages'],cfg['reaction_stages'])
        self.assertEqual(len(self.run_plan(prepared)[0]),1)
        cfg['loops']['inner']=repeat(2)
        with self.assertRaisesRegex(BridgeError,'有限数'):self.normalize(cfg)
        changed=parse_code(document,cfg)
        self.assertTrue(changed['valid'],changed) # document still explicitly selects one position
        self.assertEqual(changed['config']['loops']['inner'],repeat(1))

    def test_same_output_phase_overlap_is_counted_per_species(self):
        cfg=plan(repeat(2));cfg['reaction_stages']=stages(first_start=[route(id='initial')],first_following=[route('previous_point','all',id='all'),route('previous_point','aqueous',id='part',fraction=.25)])
        with self.assertRaisesRegex(BridgeError,'超过 100%'):self.normalize(cfg)
        cfg['reaction_stages']['first_following']=[route('previous_point','aqueous',id='part-a',fraction=.25),route('previous_point','aqueous',id='part-b',fraction=.75)]
        rows,_=self.run_plan(cfg)
        for name in cfg['species']:self.assertAlmostEqual(self.amount(rows[1],name),self.amount(rows[0],name,'amount_mol'))

    def test_missing_stage_history_never_adds_a_hidden_fallback_recipe(self):
        for source in ('previous_point','previous_cycle','output'):
            for fallback in ('material','none','error'):
                cfg=plan();cfg['reaction_stages']=stages(first_start=[route(source,id='missing',fallback=fallback,**({'point_id':'loop-1','lag':1} if source=='output' else {}))])
                with self.subTest(source=source,fallback=fallback):
                    with self.assertRaisesRegex(BridgeError,'改选配方或已有输出'):self.normalize(cfg)
        # Compatibility metadata is harmless once the selected output exists.
        cfg=plan(repeat(2));cfg['reaction_stages']=stages(first_start=[route(id='first')],first_following=[route('previous_point',id='next',fallback='material',fallback_fraction=100,material_id='removed-old-recipe')])
        rows,_=self.run_plan(cfg)
        for name in cfg['species']:self.assertEqual(self.amount(rows[1],name),self.amount(rows[0],name,'amount_mol'))

    def test_selected_phases_follow_distinct_sources_without_replenishing_first_only_tracer(self):
        cfg=plan(repeat(3),repeat(2))
        aqueous=['H2O(aq)','H+','OH-','Ca+2','HCO3-','CO3-2','CO2(aq)','Na+','Cl-','NaCl(aq)']
        cfg['species']=[*aqueous,'Calcite']
        cfg['materials']=[{'id':'fluid','name':'Fluid','inputs':[{'species':'H2O(aq)','amount':1,'unit':'kg'}]},
                          {'id':'rock','name':'Rock','inputs':[{'species':'Calcite','amount':.002,'unit':'mol'}]},
                          {'id':'tracer','name':'Tracer','inputs':[{'species':'NaCl(aq)','amount':.001,'unit':'mol'}]}]
        cfg['reaction_stages']=stages(
            first_start=[route('material','aqueous',id='first-fluid',material_id='fluid'),route('material','mineral',id='first-rock',material_id='rock'),route('material','species',id='first-tracer',material_id='tracer',species=['NaCl(aq)'])],
            first_following=[route('previous_point','aqueous',id='along-fluid',fallback='error'),route('material','mineral',id='along-rock',material_id='rock')],
            later_start=[route('material','aqueous',id='later-fluid',material_id='fluid'),route('previous_cycle','mineral',id='later-rock',fallback='error')],
            later_following=[route('previous_point','aqueous',id='both-fluid',fallback='error'),route('previous_cycle','mineral',id='both-rock',fallback='error')])
        rows,meta=self.run_plan(cfg)
        for a,b in ((1,0),(2,1),(4,3),(5,4)):
            for name in aqueous:self.assertEqual(self.amount(rows[a],name),self.amount(rows[b],name,'amount_mol'))
        for a,b in ((3,0),(4,1),(5,2)):self.assertEqual(self.amount(rows[a],'Calcite'),self.amount(rows[b],'Calcite','amount_mol'))
        self.assertEqual(self.amount(rows[3],'H2O(aq)'),self.amount(rows[0],'H2O(aq)'))
        transfers=[t for row in rows for t in row['transfers']]
        self.assertEqual([t['source'] for t in transfers].count('material:rock'),3)
        self.assertEqual([t['source'] for t in transfers].count('material:fluid'),2)
        self.assertEqual([t['source'] for t in transfers].count('material:tracer'),1)
        inputs={r['component']:r['input_mol'] for r in meta['process_balance']}
        self.assertAlmostEqual(inputs['Ca'],.006);self.assertAlmostEqual(inputs['Na'],.001);self.assertAlmostEqual(inputs['Cl'],.001)
        self.assertEqual(self.amount(rows[3],'NaCl(aq)'),0)

    def test_migrated_multi_bindings_preserve_previous_fallback_scan_exactly(self):
        old=plan(repeat(2),values('route_fraction',[1,2],route_id='carry',field='fallback_fraction'))
        old['routes']=[route('previous_point',id='carry',fraction=.5)]
        expected,_=self.run_plan(old)
        cfg=copy.deepcopy(old)
        cfg['reaction_stages']=stages(first_start=[route(id='initial-feed')],first_following=[route('previous_point',id='first-carry',fraction=.5)],later_start=[route(id='later-feed')],later_following=[route('previous_point',id='later-carry',fraction=.5)])
        cfg['loops']['outer']['target']={'kind':'route_fraction','route_id':'initial-feed','field':'fraction','bindings':[{'route_id':'initial-feed','field':'fraction'},{'route_id':'later-feed','field':'fraction'}]}
        actual,metadata=self.run_plan(cfg)
        self.assertEqual(actual,expected)
        self.assertIn('2 处',metadata['field_info']['outer_value'][0])

    def test_legacy_point_rules_are_preserved_and_stage_specific_outputs_validate_where_used(self):
        cfg=plan();cfg.pop('loops');cfg['cycles']=2
        cfg['points'].append({**cfg['points'][0],'id':'p2','routes':[route(material_id='does-not-exist')]})
        cfg['reaction_stages']=stages(first_start=[route(id='a')],first_following=[route('output',point_id='p1',lag=0,id='b')],later_start=[route(id='c')],later_following=[route('output',point_id='p1',lag=0,id='d')])
        rows,meta=self.run_plan(cfg)
        self.assertEqual(len(rows),4)
        for actual, original in zip(meta['config']['points'],cfg['points']):
            self.assertEqual({key:actual[key] for key in original},original)
        cfg['reaction_stages']['first_start']=[route('output',point_id='p2',lag=0,id='bad')]
        with self.assertRaisesRegex(BridgeError,'尚未计算'):self.normalize(cfg)

    def test_stage_allocations_cannot_spend_same_output_twice_across_rounds(self):
        cfg=plan(repeat(2),repeat(2));cfg['reaction_stages']=fresh_stages()
        cfg['reaction_stages']['first_following']=[route('previous_point',id='along')]
        cfg['reaction_stages']['later_start']=[route('previous_cycle',id='across')]
        with self.assertRaisesRegex(BridgeError,'超过 100%'):self.normalize(cfg)

    def test_worker_and_saved_code_preserve_hidden_draft_numbers(self):
        cfg=plan();cfg['name']='隐藏未完成来源核对'
        cfg['reaction_stages']=stages(first_start=[route(id='active')],later_following=[route('output','species',id='hidden',point_id='loop-2',lag=0,species=[],fraction={'easyreaktoro_empty_number':True})])
        jobs=Jobs()
        try:
            with tempfile.TemporaryDirectory() as folder:
                started=jobs.start(self.handle,cfg,folder)
                deadline=time.monotonic()+20
                while jobs.status(started['job_id'])['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
                status=jobs.status(started['job_id']);self.assertEqual(status['status'],'completed',status)
                saved=load_settings(Path(started['output_path'])/'simulation.ersim.json')
                self.assertEqual(saved['config']['reaction_stages'],cfg['reaction_stages'])
                cfg2,_,_=prepare_program(saved['config'],{**saved['code_editor'],'mode':'code'})
                self.assertEqual(cfg2['reaction_stages'],cfg['reaction_stages'])
                self.assertEqual(len(self.run_plan(cfg2)[0]),1)
        finally:jobs.close()

    def test_worker_code_and_saved_settings_use_same_stages_and_replay_without_global_feed(self):
        cfg=plan(repeat(2),repeat(2));cfg['reaction_stages']=fresh_stages()
        cfg['reaction_stages']['later_start'][0]['fraction']=2
        expected,_=self.run_plan(cfg)
        jobs=Jobs()
        try:
            with tempfile.TemporaryDirectory() as folder:
                for n in (1,2):
                    cfg['name']=f'独立反应物料{n}'
                    started=jobs.start(self.handle,cfg,folder,editor if n==2 else None)
                    deadline=time.monotonic()+20
                    while jobs.status(started['job_id'])['status']=='running' and time.monotonic()<deadline:time.sleep(.03)
                    status=jobs.status(started['job_id']);self.assertEqual(status['status'],'completed',status)
                    root=Path(started['output_path']);self.assertEqual(list(records(root)),expected)
                    saved=load_settings(root/'simulation.ersim.json');self.assertEqual(saved['config']['reaction_stages'],cfg['reaction_stages'])
                    self.assertEqual(saved['config']['routes'],cfg['routes'])
                    editor=saved['code_editor'];cell=next(c for c in editor['document']['cells'] if c['id']=='transfers')
                    self.assertIn('reaction_stages =',cell['source']);self.assertNotIn('\nroutes =',cell['source'])
                    parsed,_,_=prepare_program(saved['config'],editor);self.assertEqual(parsed['reaction_stages'],cfg['reaction_stages'])
        finally:jobs.close()
