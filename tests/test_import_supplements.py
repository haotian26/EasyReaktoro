"""User-selected metadata merges must be lossless, persistent, and idempotent."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from bridge.easyreaktoro_runtime import repository
from bridge.easyreaktoro_runtime.service import Service


def record(**changes):
    return repository.normalize_species({'name':'X','formula':'H','composition':{'H':1},'charge':0,'state':'Aqueous',
        'model':{'type':'extended-maier-kelley','parameters':{'G298':-1000,'H298':-900,'S298':.3,'a':2,'b':.001,'c':5,'V':1e-5}},**changes})


class SupplementalImportTests(unittest.TestCase):
    def test_metadata_only_import_is_selectable_and_survives_save_reopen(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'target.rtdb';source=Path(folder)/'source.json'
            original=record(notes='旧备注\n\n\n原有格式',references=[{'title':'A'}],provenance={'database':'A'})
            incoming=record(notes='新备注',references=[{'title':'A'},{'title':'B'}],valid_tp={'temperature_K':[290,400]},provenance={'database':'B'})
            repository.create(str(path),'test',records=[original]);source.write_text(json.dumps({'records':[incoming]}))
            service=Service();handle=service.handle(service.open_rtdb(str(path))['handle_id']);before=copy.deepcopy(handle['records'])
            preview=service.import_preview(handle,{'path':str(source)})
            self.assertEqual((preview['import_count'],preview['update_count'],preview['reused_count']),(0,1,1));self.assertEqual(handle['records'],before)
            none=service.merge_preview(handle,[incoming],{'fingerprints':[]});service.commit_merge(handle,none,'test')
            self.assertFalse(handle['dirty']);self.assertEqual(handle['records'],before)
            result=service.import_commit(handle,{'path':str(source),'source_revision':preview['source_revision'],'fingerprints':[preview['items'][0]['fingerprint']]})
            self.assertEqual(result['update_count'],1);self.assertTrue(handle['dirty']);merged=handle['records'][0]
            self.assertEqual(merged['id'],original['id']);self.assertEqual(merged['model'],original['model']);self.assertTrue(merged['notes'].startswith(original['notes']))
            self.assertEqual(len(merged['references']),2);self.assertEqual(merged['valid_tp'],incoming['valid_tp']);self.assertEqual(merged['provenance']['database'],'A')
            service.dispatch({'op':'rtdb.save','handle_id':handle['id']})
            reopened=repository.normalize_species(repository.open_database(str(path))[1][0]);self.assertEqual(reopened,merged)
            again=service.import_preview(handle,{'path':str(source)});self.assertEqual(again['update_count'],0);self.assertFalse(again['items'])

    def test_conflicting_ranges_are_not_unioned_and_both_sources_remain(self):
        a=record(valid_tp={'temperature_K':[290,400]},provenance={'database':'A'});b=record(valid_tp={'temperature_K':[350,600]},provenance={'database':'B'})
        merged=repository.merge_supplemental(a,b)
        self.assertEqual(merged['valid_tp'],a['valid_tp']);self.assertEqual(merged['provenance']['valid_tp_alternatives'],[{'valid_tp':b['valid_tp'],'source':b['provenance']}])
        self.assertEqual(repository.merge_supplemental(merged,b),merged)

    def test_parameter_differences_remain_versions_and_unchecked_updates_do_not_leak(self):
        original=record();service=Service();handle={'records':[original],'read_only':False,'dirty':False}
        incoming=record(notes='supplement');new=record(name='Y');changed=record(model={**original['model'],'parameters':{**original['model']['parameters'],'G298':-1200}})
        preview=service.merge_preview(handle,[incoming,new,changed],{})
        self.assertEqual((preview['import_count'],preview['update_count']),(2,1))
        selected=[x['fingerprint'] for x in preview['items'] if x['name']=='Y']
        only=service.merge_preview(handle,[incoming,new,changed],{'fingerprints':selected});service.commit_merge(handle,only,'test')
        self.assertEqual([x['name'] for x in handle['records']],['X','Y']);self.assertEqual(handle['records'][0],original)

    def test_equal_numeric_parameters_and_repeated_source_rows_merge_once(self):
        original=record();incoming=copy.deepcopy(original);incoming['composition']['H']=1.0;incoming['notes']='extra'
        self.assertEqual(repository.calculation_signature(original),repository.calculation_signature(incoming))
        service=Service();preview=service.merge_preview({'records':[original],'read_only':False},[incoming,incoming],{})
        self.assertEqual(preview['update_count'],1);self.assertEqual(len(preview['combined_records']),1)

    def test_native_yaml_formatting_and_generated_labels_are_not_parameter_changes(self):
        a=record(model={'type':'reaktoro-native','native_type':'Constant','runtime_version':'2.13.0','parameters_yaml':'Constant:\n  G0: 1.0000000000000000\n  H0: 2'})
        b=record(model={'type':'reaktoro-native','parameters':{'Constant':{'G0':1,'H0':2}},'parameters_yaml':'Constant: {H0: 2, G0: 1}'},reaction={'reactants':{},'model_parameters_yaml':''},notes='reference')
        self.assertEqual(repository.calculation_signature(a),repository.calculation_signature(b))
        preview=Service().merge_preview({'records':[a],'read_only':False},[b],{})
        self.assertEqual((preview['import_count'],preview['update_count']),(0,1));self.assertEqual(preview['combined_records'][0]['model'],a['model'])


if __name__=='__main__': unittest.main()
