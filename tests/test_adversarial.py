"""Adversarial fixtures: all records and files are synthetic and disposable."""
import copy
import tempfile
import unittest
from pathlib import Path
from bridge.easyreaktoro_runtime import repository
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.service import Service, _closure, _rename_conflicts

def record(name, **changes):
    return repository.normalize_species({"name":name,"formula":"H","composition":{"H":1},"charge":0,"state":"Aqueous","model":{"type":"extended-maier-kelley","parameters":{"G298":-1000,"H298":-900,"S298":.3,"a":2,"b":.001,"c":5,"V":1e-5}},**changes})

class AdversarialSafetyTest(unittest.TestCase):
    def test_details_exposes_parameter_schema_without_mutating_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'source.rtdb';repository.create(str(path),'source',records=[record('X')]);service=Service();summary=service.open_rtdb(str(path));handle=service.handle(summary['handle_id']);before=copy.deepcopy(handle['records'])
            details=service.dispatch({'op':'species.details','handle_id':summary['handle_id'],'name':'X'})
            parameter=next(x for x in details['model_definition']['parameters'] if x['name']=='G298')
            self.assertEqual(parameter['unit'],'J/mol');self.assertEqual(before,handle['records'])
    def test_deep_dependency_graph_does_not_overflow_python_stack(self):
        records=[record(str(i),dependencies=[str(i+1)] if i<1199 else []) for i in range(1200)]
        chosen,missing,cycles=_closure({r['name']:[r] for r in records},records[:1])
        self.assertEqual(len(chosen),1200);self.assertFalse(missing or cycles)

    def test_ambiguous_dependency_is_not_silently_bound_to_lexical_variant(self):
        target=record('Target',dependencies=['Base'],provenance={'database':'C'})
        variants=[record('Base',charge=z,provenance={'database':str(z)}) for z in (0,1)]
        _,missing,_=_closure({'Target':[target],'Base':variants},[target])
        self.assertTrue(missing);self.assertEqual(missing[0]['code'],'AMBIGUOUS_DEPENDENCY')

    def test_export_never_overwrites_an_rtdb_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'source.rtdb';repository.create(str(path),'source',records=[record('X')]);before=path.read_bytes()
            service=Service();handle=service.handle(service.open_rtdb(str(path))['handle_id'])
            with self.assertRaisesRegex(BridgeError,'YAML'):
                service.export_interpolation(handle,{'path':str(path),'temperatures_K':[298.15,310.15],'pressures_Pa':[1e5,2e5],'tolerance':1})
            self.assertEqual(path.read_bytes(),before)

    def test_yaml_symlink_cannot_overwrite_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'source.rtdb';repository.create(str(path),'source',records=[record('X')]);before=path.read_bytes()
            link=Path(tmp)/'export.yaml';link.symlink_to(path)
            service=Service();handle=service.handle(service.open_rtdb(str(path))['handle_id'])
            for export in (service.export_native,service.export_interpolation):
                with self.assertRaisesRegex(BridgeError,'YAML'):export(handle,{'path':str(link)})
            self.assertEqual(path.read_bytes(),before)

    def test_interpolation_reports_duplicate_names_instead_of_evaluating_wrong_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'source.rtdb';repository.create(str(path),'source',records=[record('X'),record('X',charge=1),record('Y')])
            service=Service();handle=service.handle(service.open_rtdb(str(path))['handle_id'])
            report=service.export_interpolation(handle,{'path':str(Path(tmp)/'export.yaml'),'temperatures_K':[298.15,300.15],'pressures_Pa':[1e5,2e5],'tolerance':1})
            self.assertEqual(report['export_count'],1);self.assertEqual(report['exclude_count'],2)

if __name__=='__main__':unittest.main()
