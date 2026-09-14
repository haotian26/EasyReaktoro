"""Round-trip real parameter cells, saved unfinished edits, and non-execution."""
import copy
import json
import pprint
import tempfile
import unittest
from pathlib import Path
from bridge.easyreaktoro_runtime.simulation_code import render_code, parse_code, validate_editor
from bridge.easyreaktoro_runtime.simulation_templates import load_settings
from bridge.easyreaktoro_runtime.simulation_jobs import Jobs


def config():
    return {'schema_version':2, 'name':'带注释的模拟', 'species':['H2O(aq)','H+','OH-'],
        'materials':[{'id':'initial','name':'流体','inputs':[{'species':'H2O(aq)','amount':.75,'unit':'kg'}]}],
        'points':[{'id':'p1','label':'入口','temperature_c':150,'pressure_bar':40,'temperature_increment_c':2.5,'pressure_increment_bar':-1}],
        'cycles':3, 'routes':[{'source':'previous_cycle','phase':'all','fraction':.6,'material_id':'initial','fallback':'material','fallback_fraction':1,'when':'always'}],
        'activity_model':'ideal','gas_model':'peng_robinson','bootstrap':False,'balance_tolerance_mol':1e-9,
        'allow_database_defaults':False,'allow_recorded_assignments':True,'allow_non_nacl':False,'allow_unsupported_water':False,
        'ion_size_overrides':{},'import_provenance':{'origin':'test'}}


class PythonParameterTests(unittest.TestCase):
    def test_every_parameter_round_trips_and_expressions_are_evaluated(self):
        cfg=config();doc=render_code(cfg)
        self.assertEqual(parse_code(doc,cfg)['config'],cfg)
        doc['cells'][2]['source']=doc['cells'][2]['source'].replace('cycles = 3','cycles = 2 + 3').replace("'pressure_bar': 40", "'pressure_bar': 100 / 2")
        actual=parse_code(doc,cfg)['config'];self.assertEqual(actual['cycles'],5);self.assertEqual(actual['points'][0]['pressure_bar'],50)
        self.assertEqual(actual['import_provenance'],cfg['import_provenance'])

    def test_ui_changes_regenerate_only_the_changed_module_and_keep_comments(self):
        cfg=config();doc=render_code(cfg)
        for cell in doc['cells']: cell['source']='# 我的注释\n'+cell['source']
        next_cfg=copy.deepcopy(cfg);next_cfg['materials'][0]['inputs'][0]['amount']=2
        result=render_code(next_cfg,{'cells':doc['cells'],'config':cfg})
        self.assertEqual([c['source'] for c in result['cells'] if c['id']!='materials'],[c['source'] for c in doc['cells'] if c['id']!='materials'])
        self.assertEqual(parse_code(result,next_cfg)['config'],next_cfg)

    def test_stage_comments_and_display_order_match_actual_material_semantics(self):
        from bridge.easyreaktoro_runtime.simulation_reactions import STAGE_KEYS
        cfg=config();cfg['reaction_stages']={key:[] for key in sorted(STAGE_KEYS)}
        cfg['loops']={'base':{'temperature_c':25,'pressure_bar':1},'inner':{'mode':'repeat','count':1},'outer':{'mode':'repeat','count':1}}
        before=copy.deepcopy(cfg);document=render_code(cfg)
        conditions=next(c for c in document['cells'] if c['id']=='conditions')['source']
        transfers=next(c for c in document['cells'] if c['id']=='transfers')['source']
        self.assertIn("field='fraction'",conditions);self.assertNotIn('fraction or fallback_fraction',conditions)
        self.assertIn("when must be 'always'",transfers);self.assertIn('do not add material',transfers)
        self.assertIn('missing source output stops',transfers);self.assertNotIn('fallback initializes a legacy source',transfers)
        body=transfers.split('reaction_stages =',1)[1]
        self.assertEqual(sorted(STAGE_KEYS,key=lambda key:body.index(repr(key))),list(STAGE_KEYS))
        self.assertEqual(cfg,before);self.assertEqual(list(cfg['reaction_stages']),sorted(STAGE_KEYS))
        self.assertEqual(parse_code(document,cfg)['config'],cfg)
        legacy=render_code(config())
        self.assertIn('fraction or fallback_fraction',legacy['cells'][2]['source'])
        self.assertIn('fallback initializes a legacy source',legacy['cells'][3]['source'])

    def test_only_unchanged_generated_stage_comments_upgrade_and_user_text_is_preserved(self):
        from bridge.easyreaktoro_runtime.simulation_code import CELLS
        from bridge.easyreaktoro_runtime.simulation_reactions import STAGE_KEYS
        cfg=config();cfg['reaction_stages']={key:[] for key in sorted(STAGE_KEYS)}
        cfg['loops']={'base':{'temperature_c':25,'pressure_bar':1},'inner':{'mode':'repeat','count':1},'outer':{'mode':'repeat','count':1}}
        old=render_code(cfg)
        for cell_id in ('conditions','transfers'):
            fields=('loops',) if cell_id=='conditions' else ('reaction_stages',)
            comment=next(c[4] for c in CELLS if c[0]==cell_id)
            if cell_id=='conditions':comment='\n'.join(line for line in comment.splitlines() if not line.startswith(('# loops=None','# Legacy points')))
            source=comment+'\n\n'+'\n\n'.join(f"{key} = {pprint.pformat(cfg.get(key),width=88,sort_dicts=False,compact=False)}" for key in fields)+'\n'
            next(c for c in old['cells'] if c['id']==cell_id)['source']=source
        upgraded=render_code(cfg,{'config':cfg,'cells':old['cells']})
        self.assertEqual(upgraded,render_code(cfg))
        reverted=copy.deepcopy(cfg);reverted.pop('reaction_stages')
        old_mode=render_code(reverted,{'config':cfg,'cells':upgraded['cells']})
        self.assertIn('fraction or fallback_fraction',old_mode['cells'][2]['source'])
        for source_change in (lambda text:'# 用户说明\n'+text,lambda text:text+'\n# 保留我的注释\n',lambda text:'reaction_stages = ['):
            custom=copy.deepcopy(old)
            for c in custom['cells']:
                if c['id'] in ('conditions','transfers'):c['source']=source_change(c['source'])
            preserved=render_code(cfg,{'config':cfg,'cells':custom['cells']})
            self.assertEqual([c['source'] for c in preserved['cells']],[c['source'] for c in custom['cells']])

    def test_new_templates_use_english_comments_without_translating_user_values(self):
        import io
        import re
        import tokenize
        from bridge.easyreaktoro_runtime.simulation_reactions import STAGE_KEYS
        cfg=config()
        loops={**copy.deepcopy(cfg), 'loops':{'base':{'temperature_c':25,'pressure_bar':1},'inner':{'mode':'repeat','count':1},'outer':{'mode':'repeat','count':1}},
               'reaction_stages':{key:[] for key in STAGE_KEYS}}
        schedule={**copy.deepcopy(loops),'schedule':{'version':1,'positions':2,'rounds':2,'parameters':[{'id':'t','target':{'kind':'temperature'},'value':{'mode':'fixed','value':25}},{'id':'p','target':{'kind':'pressure'},'value':{'mode':'fixed','value':1}}],'overrides':[]}}
        for value in (cfg,loops,schedule):
            with self.subTest(schedule=bool(value.get('schedule')),loops=bool(value.get('loops'))):
                document=render_code(value)
                for cell in document['cells']:
                    tokens=tokenize.generate_tokens(io.StringIO(cell['source']).readline)
                    comments=[token.string for token in tokens if token.type==tokenize.COMMENT]
                    self.assertFalse(any(re.search(r'[\u4e00-\u9fff]',comment) for comment in comments),cell['id'])
                    compile(cell['source'],cell['id'],'exec')
                self.assertIn("'name': '流体'",document['cells'][1]['source'])
                self.assertEqual(parse_code(document,value)['config'],value)

    def test_saved_custom_chinese_comments_and_unfinished_text_remain_verbatim(self):
        cfg=config();document=render_code(cfg)
        for cell in document['cells']:
            cell['source']='# 我的原始注释：不要翻译 Ca+2\r\n'+cell['source']+'\n#  保留缩进、空格与标点。  \n'
        next(cell for cell in document['cells'] if cell['id']=='conditions')['source']='# 尚未写完\npoints = [ '
        before=copy.deepcopy(document)
        restored=render_code(cfg,{'config':cfg,'cells':document['cells']})
        self.assertEqual([cell['source'] for cell in restored['cells']],[cell['source'] for cell in before['cells']])
        self.assertEqual(document,before)

    def test_legacy_model_switches_are_read_but_not_added_to_new_notebooks(self):
        cfg=config();doc=render_code(cfg);activity=next(c for c in doc['cells'] if c['id']=='activity')
        self.assertNotIn('allow_non_nacl',activity['source']);self.assertNotIn('allow_unsupported_water',activity['source'])
        activity['source']+='\nallow_non_nacl = False\nallow_unsupported_water = False\n'
        self.assertTrue(parse_code(doc,cfg)['valid'])

    def test_round_condition_shapes_are_checked_without_executing(self):
        cfg=config();cfg['points'][0]['round_conditions']=[{'round':9,'temperature_c':40,'pressure_bar':20,'pressure_mode':'fixed'}]
        self.assertEqual(parse_code(render_code(cfg),cfg)['config'],cfg)
        for value in [None,[{'round':2,'temperature_c':25}],[{'round':2,'temperature_c':25,'pressure_bar':1}]*2]:
            cfg['points'][0]['round_conditions']=value
            parsed=parse_code(render_code(cfg),cfg)
            self.assertFalse(parsed['valid']);self.assertEqual(parsed['errors'][0]['cell_id'],'conditions')

    def test_errors_have_module_and_line_and_never_execute(self):
        with tempfile.TemporaryDirectory() as folder:
            sentinel=Path(folder)/'should-not-exist'
            cases=[f"species = __import__('pathlib').Path({str(sentinel)!r}).touch()\nwater_species = None", "species = [\nwater_species = None", "species = []\nspecies = ['H+']\nwater_species = None", "species = []\nwater_species = None\nimport os", "species = [1e999]\nwater_species = None"]
            for source in cases:
                doc=render_code(config());doc['cells'][0]['source']=source;result=parse_code(doc,config())
                self.assertFalse(result['valid']);self.assertEqual(result['errors'][0]['cell_id'],'system');self.assertGreater(result['errors'][0]['line'],0)
            self.assertFalse(sentinel.exists())

    def test_nested_mistakes_and_ignored_fields_are_reported_in_their_module(self):
        for index, before, after in [(1,"'amount': 0.75","'amout': 0.75"),(2,'cycles = 3','cycles = 1.5'),(3,"'fraction': 0.6","'fraction': True"),(5,'1e-09','1 / 0')]:
            doc=render_code(config());self.assertIn(before,doc['cells'][index]['source']);doc['cells'][index]['source']=doc['cells'][index]['source'].replace(before,after)
            result=parse_code(doc,config());self.assertFalse(result['valid']);self.assertEqual(result['errors'][0]['cell_id'],doc['cells'][index]['id'])
        doc=render_code(config());doc['cells'][0]['id']=[];self.assertFalse(parse_code(doc,config())['valid'])

    def test_unfinished_edits_are_saved_and_reopened_without_losing_last_valid_ui(self):
        cfg=config();doc=render_code(cfg);doc['cells'][2]['source']='# 还没写完\npoints = ['
        editor={'version':1,'mode':'code','document':doc,'config':cfg,'dirty':True}
        handle={'kind':'rtdb','name':'synthetic','records':[],'path':None,'dirty':False}
        class FakeService:
            def handle(self,_): return handle
        jobs=Jobs()
        try:
            with tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'saved.ersim.json'
                result=jobs.dispatch(FakeService(),{'action':'save_settings','handle_id':'test','path':str(path),'config':cfg,'code_editor':editor})
                self.assertTrue(result['success']);loaded=load_settings(path)
                self.assertEqual(loaded['config'],cfg);self.assertEqual(loaded['code_editor'],editor)
                self.assertFalse(parse_code(loaded['code_editor']['document'],cfg)['valid'])
                damaged=copy.deepcopy(editor);damaged['document']['cells'].pop()
                with self.assertRaises(ValueError): validate_editor(damaged)
        finally: jobs.close()


if __name__=='__main__': unittest.main()
