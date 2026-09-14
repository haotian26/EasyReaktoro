"""Composition of personal databases must preserve conflicts, dependencies, and originals."""
import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from tests.test_import_supplements import record
from bridge.easyreaktoro_runtime import repository
from bridge.easyreaktoro_runtime.service import Service
class CrossDatabaseTests(unittest.TestCase):
 def test_personal_sources_preview_and_commit_without_modifying_originals(self):
  with tempfile.TemporaryDirectory() as folder:
   a,b,out=[Path(folder)/n for n in ['a.rtdb','b.rtdb','combined.rtdb']]
   x=record(provenance={'database':'A'},references=[{'title':'A reference'}]);y=record(name='Y',provenance={'database':'B'})
   repository.create(str(a),'A',records=[x]);repository.create(str(b),'B',records=[y]);before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in (a,b)]
   svc=Service();h=[svc.open_rtdb(str(p)) for p in (a,b)];args={'selections':[{'handle_id':z['handle_id'],'all':True} for z in h],'path':str(out)}
   preview=svc.compose_preview(args);self.assertTrue(preview['can_commit']);self.assertEqual(len(preview['records']),2)
   result=svc.compose_commit(args);self.assertTrue(result['success']);self.assertEqual(result['summary']['species_count'],2);self.assertEqual([hashlib.sha256(p.read_bytes()).hexdigest() for p in (a,b)],before)
   self.assertEqual({x['kind'] for x in preview['source_databases']},{'rtdb'})
 def test_conflicting_same_name_species_are_never_silently_replaced(self):
  with tempfile.TemporaryDirectory() as folder:
   svc=Service();handles=[]
   for i in range(2):
    x=record(provenance={'database':str(i)});x['model']['parameters']['G298']-=i*200
    p=Path(folder)/f'{i}.rtdb';repository.create(str(p),str(i),records=[x]);handles.append(svc.open_rtdb(str(p)))
   p=svc.compose_preview({'selections':[{'handle_id':h['handle_id'],'all':True} for h in handles]});self.assertTrue(p['can_commit']);self.assertEqual(len(p['rename_decisions']),2);self.assertEqual(len({r['name'] for r in p['records']}),2)

 def test_matching_parameters_merge_supplemental_references_once(self):
  with tempfile.TemporaryDirectory() as folder:
   svc=Service();handles=[]
   for i in range(2):
    x=record(provenance={'database':str(i)},references=[{'title':str(i)}]);p=Path(folder)/f'{i}.rtdb';repository.create(str(p),str(i),records=[x]);handles.append(svc.open_rtdb(str(p)))
   p=svc.compose_preview({'selections':[{'handle_id':h['handle_id'],'all':True} for h in handles]});self.assertTrue(p['can_commit']);self.assertEqual(len(p['records']),1);self.assertEqual(len(p['records'][0]['references']),2);self.assertFalse(p['rename_decisions'])
