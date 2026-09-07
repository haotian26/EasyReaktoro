"""Safety regressions using disposable synthetic records, never personal data."""
import copy
import json
import math
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.easyreaktoro_runtime import models, repository
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.service import Service, _closure, _rename_conflicts, _yaml_species


def record(name="A", **changes):
    return repository.normalize_species({"name": name, "formula": "H", "composition": {"H": 1}, "charge": 0, "state": "Aqueous", "model": {"type": "extended-maier-kelley", "parameters": {"G298": -1000, "H298": -900, "S298": .3, "a": 2, "b": .001, "c": 5, "V": 1e-5}}, **changes})


class DataSafetyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "test.rtdb"
        repository.create(str(self.path), "test")
        self.service = Service()
        self.handle = self.service.handle(self.service.open_rtdb(str(self.path))["handle_id"])

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_never_overwrites_existing_file(self):
        before = self.path.read_bytes()
        with self.assertRaises(BridgeError): repository.create(str(self.path), "replace")
        self.assertEqual(self.path.read_bytes(), before)

    def test_open_invalid_and_failed_legacy_migration_never_modify_source(self):
        invalid = Path(self.tmp.name)/"wrong.rtdb"
        invalid.write_bytes(b"not sqlite")
        with self.assertRaises(BridgeError): repository.open_database(str(invalid))
        self.assertEqual(invalid.read_bytes(), b"not sqlite")
        legacy = Path(self.tmp.name)/"legacy.rtdb"
        conn = sqlite3.connect(legacy)
        conn.executescript("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES ('schema','easyreaktoro.rtdb/v1'); CREATE TABLE species(id TEXT,name TEXT); INSERT INTO species VALUES ('x','');")
        conn.close(); before = legacy.read_bytes()
        with self.assertRaises(BridgeError): repository.open_database(str(legacy))
        self.assertEqual(legacy.read_bytes(), before)

    def test_save_preserves_audit_and_validation(self):
        self.service.mutate_species(self.handle,"create",{"species":record()})
        self.service.validate(self.handle)
        self.service.save(self.handle)
        history = repository.history(str(self.path))
        self.assertEqual([x[0] for x in history["audit"]], ["create","species.create","save"])
        self.assertEqual(len(history["validation"]),1)
        current = self.handle["records"][0]
        self.service.mutate_species(self.handle,"update",{"species_id":current["id"],"species":{**current,"notes":"note"}})
        self.service.save(self.handle)
        self.assertEqual(len(repository.history(str(self.path))["audit"]),5)

    def test_save_failure_preserves_dirty_memory_and_original(self):
        self.service.mutate_species(self.handle,"create",{"species":record()})
        before = self.path.read_bytes()
        with patch.object(repository.os,"replace",side_effect=OSError("disk full")):
            with self.assertRaises(OSError): self.service.save(self.handle)
        self.assertTrue(self.handle["dirty"])
        self.assertEqual(self.path.read_bytes(),before)
        self.assertEqual(list(Path(self.tmp.name).glob("*.tmp")),[])

    def test_external_changes_and_deletion_block_save_but_allow_save_as(self):
        self.service.mutate_species(self.handle,"create",{"species":record()})
        conn=sqlite3.connect(self.path); conn.execute("UPDATE metadata SET value='external' WHERE key='name'");conn.commit();conn.close()
        before=self.path.read_bytes()
        with self.assertRaises(BridgeError): self.service.save(self.handle)
        self.assertEqual(self.path.read_bytes(),before)
        other=Path(self.tmp.name)/"rescued.rtdb"
        result=self.service.save(self.handle,str(other))
        self.assertEqual(result["summary"]["embedded_name"],"rescued")
        other.unlink()
        with self.assertRaises(BridgeError):self.service.save(self.handle)

    def test_duplicate_create_is_transactional(self):
        self.service.mutate_species(self.handle,"create",{"species":record()})
        before=copy.deepcopy(self.handle)
        with self.assertRaises(BridgeError): self.service.mutate_species(self.handle,"create",{"species":record()})
        self.assertEqual(self.handle,before)

    def test_active_sqlite_wal_is_not_overwritten(self):
        self.service.mutate_species(self.handle,"create",{"species":record()})
        conn=sqlite3.connect(self.path)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("UPDATE metadata SET value='writer' WHERE key='name'"); conn.commit()
            with self.assertRaisesRegex(BridgeError,"其他 SQLite"):
                self.service.save(self.handle)
            self.assertEqual(conn.execute("SELECT value FROM metadata WHERE key='name'").fetchone()[0],"writer")
            self.assertTrue(self.handle["dirty"])
        finally: conn.close()

    def test_update_rename_rewrites_references_and_delete_in_use_is_blocked(self):
        a=record(); b=record("B",dependencies=["A"],reaction={"reactants":{"A":1}})
        self.handle["records"]=[a,b]
        self.service.mutate_species(self.handle,"update",{"species_id":a["id"],"species":{**a,"name":"Renamed"}})
        self.assertEqual(self.handle["records"][1]["dependencies"],["Renamed"])
        self.assertEqual(self.handle["records"][1]["reaction"]["reactants"],{"Renamed":1})
        with self.assertRaises(BridgeError): self.service.mutate_species(self.handle,"delete",{"species_id":a["id"]})
        self.assertEqual(len(self.handle["records"]),2)

    def test_disabled_model_cannot_evaluate(self):
        self.handle["records"]=[record(disabled=True)]
        with self.assertRaisesRegex(BridgeError,"草稿"): self.service.evaluate(self.handle,{"name":"A","temperature_K":298.15,"pressure_Pa":1e5})

    def test_offline_local_edit_and_finite_evaluation(self):
        with patch("bridge.easyreaktoro_runtime.service.reaktoro",None):
            self.service.mutate_species(self.handle,"create",{"species":record()})
            result=self.service.evaluate(self.handle,{"name":"A","temperature_K":298.15,"pressure_Pa":1e5})
            self.assertEqual(result["properties"]["G0"],-1000)
            with self.assertRaises(BridgeError): self.service.catalog()
            self.service.save(self.handle)

    def test_runtime_switch_dirty_guard(self):
        self.handle["dirty"]=True
        with self.assertRaises(BridgeError): self.service.dispatch({"op":"runtime.can_switch"})

    def test_selected_import_includes_dependency_and_rewrites_conflicts(self):
        source=Path(self.tmp.name)/"records.json"
        a=record(); b=record("B",dependencies=["A"],reaction={"reactants":{"A":1}})
        source.write_text(json.dumps({"records":[a,b]}))
        self.handle["records"]=[record("A",notes="existing",charge=1)]
        preview=self.service.import_preview(self.handle,{"path":str(source)})
        target=next(x for x in preview["items"] if x["name"]=="B")
        report=self.service.import_commit(self.handle,{"path":str(source),"fingerprints":[target["fingerprint"]],"source_revision":preview["source_revision"]})
        self.assertEqual(report["import_count"],2)
        self.assertEqual(len({x["name"] for x in self.handle["records"]}),3)
        byname={x["name"]:x for x in self.handle["records"]}
        self.assertIn(byname["B"]["dependencies"][0],byname)
        self.service.save(self.handle)
        self.assertEqual(len(repository.open_database(str(self.path))[1]),3)

    def test_empty_selection_does_not_import_everything(self):
        source=Path(self.tmp.name)/"records.json"; source.write_text(json.dumps({"records":[record()]}))
        result=self.service.import_commit(self.handle,{"path":str(source),"fingerprints":[]})
        self.assertEqual(result["import_count"],0); self.assertFalse(self.handle["dirty"])

    def test_changed_import_source_requires_new_preview(self):
        source=Path(self.tmp.name)/"records.json"; source.write_text(json.dumps({"records":[record()]}))
        preview=self.service.import_preview(self.handle,{"path":str(source)})
        source.write_text(json.dumps({"records":[record("B")]}))
        with self.assertRaises(BridgeError): self.service.import_commit(self.handle,{"path":str(source),"source_revision":preview["source_revision"]})
        self.assertFalse(self.handle["dirty"])


class ChemistrySafetyTest(unittest.TestCase):
    def test_native_copy_refuses_changed_source_or_runtime(self):
        try: import reaktoro
        except ImportError: self.skipTest("external Reaktoro unavailable")
        service=Service(); h=service.handle(service.open_official("PHREEQC","phreeqc.dat")["handle_id"])
        item=copy.deepcopy(next(x for x in h["records"] if x["name"]=="Calcite"))
        self.assertNotIn("object at",item["reaction"]["equation"])
        repeated=service.handle(service.open_official("PHREEQC","phreeqc.dat")["handle_id"])
        self.assertEqual(next(x for x in repeated["records"] if x["name"]=="Calcite")["fingerprint"],item["fingerprint"])
        self.assertEqual(str(service.native_species(h,item).name()),"Calcite")
        details=service.dispatch({"op":"species.details","handle_id":h["id"],"species_id":item["id"]})
        self.assertEqual(details["model"],item["model"])
        self.assertIn("PhreeqcLgK",str(details["model_parameters"]))
        item["provenance"]["source_fingerprint"]="changed"
        with self.assertRaises(BridgeError): service.native_species(h,item)
        item["provenance"]["runtime_version"]="different"
        with self.assertRaises(BridgeError): service.native_species(h,item)

    def test_native_duplicate_names_have_distinct_stable_record_handles(self):
        try: import reaktoro
        except ImportError: self.skipTest("external Reaktoro unavailable")
        service=Service(); h=service.handle(service.open_official("PHREEQC","phreeqc.dat")["handle_id"])
        self.assertEqual(len({x["id"] for x in h["records"]}),381)
        repeated=[x for x in h["records"] if x["name"]=="X-"]
        self.assertGreater(len(repeated),1)
        for record in repeated:
            self.assertEqual(service.species(h,{"species_id":record["id"]})["provenance"]["source_index"],record["provenance"]["source_index"])

    def test_composition_from_two_databases_has_unique_ids_and_reopens(self):
        try: import reaktoro
        except ImportError: self.skipTest("external Reaktoro unavailable")
        service=Service(); sources=[service.open_official("SUPCRT",name) for name in ("supcrtbl","supcrt98")]
        with tempfile.TemporaryDirectory() as tmp:
            path=str(Path(tmp)/"composed.rtdb")
            result=service.compose_commit({"selections":[{"handle_id":s["handle_id"],"names":["CO2(aq)"]} for s in sources],"path":path})
            _,records=repository.open_database(path)
            self.assertEqual(len(records),result["summary"]["species_count"])
            self.assertEqual(len({x["id"] for x in records}),len(records))

    def test_closure_detects_cycle_even_when_all_records_are_preselected(self):
        a=record("A",dependencies=["B"]);b=record("B",dependencies=["A"])
        _,_,cycles=_closure({"A":[a],"B":[b]},[a,b])
        self.assertIn(["A","B","A"],cycles)

    def test_closure_uses_same_source_dependency(self):
        a=record("A",dependencies=["B"],provenance={"database":"z"})
        wrong=record("B",provenance={"database":"a"},charge=1)
        right=record("B",provenance={"database":"z"})
        selected,_,_=_closure({"A":[a],"B":[wrong,right]},[a])
        self.assertIn(right,selected);self.assertNotIn(wrong,selected)

    def test_renaming_cannot_collide_with_an_existing_suffixed_name(self):
        records=[record("A",provenance={"provider":"p","database":"d"}),record("A",charge=1),record("A__p_d")]
        resolved,_=_rename_conflicts(records)
        self.assertEqual(len({x["name"] for x in resolved}),3)

    def test_nonfinite_model_and_tp_are_rejected(self):
        for value in [float("nan"),float("inf"),0,-1]:
            with self.assertRaises(BridgeError): models.evaluate(record()["model"],value,1e5)
        bad=record()["model"];bad["parameters"]["a"]=float("inf")
        self.assertTrue(models.validate_model(bad))
        with self.assertRaises(BridgeError): models.fit_mrb([{"temperature_K":float("inf"),"pressure_Pa":1e5,"value":1}]*3)

    def test_gibbs_mixed_derivative_is_real_and_low_pressure_stencil_is_symmetric(self):
        # Analytic fixture G = T*P*1e-6 + P^2*1e-12: dV/dT must not be zero.
        props=models.gibbs_properties(lambda t,p:t*p*1e-6+p*p*1e-12,298.15,10)
        self.assertAlmostEqual(props["VT0"],1e-6,delta=1e-10)
        self.assertAlmostEqual(props["VP0"],2e-12,delta=1e-14)

    def test_maier_kelley_matches_reaktoro_at_multiple_tp(self):
        try: import reaktoro as r
        except ImportError: self.skipTest("external Reaktoro unavailable")
        parameters=record()["model"]["parameters"]
        p=r.StandardThermoModelParamsMaierKelley()
        for key,value in {"Gf":-1000,"Hf":-900,"Sr":.3,"Vr":1e-5,"a":2,"b":.001,"c":5}.items():setattr(p,key,value)
        species=r.Species("H").withStandardThermoModel(r.StandardThermoModelMaierKelley(p))
        for t,p in [(298.15,1e5),(423.15,5e6),(573.15,1e7)]:
            actual=models._poly(parameters,t,p); expected=species.standardThermoProps(t,p)
            for key in ("G0","H0","Cp0","V0"):
                self.assertAlmostEqual(actual[key],float(getattr(expected,key)),delta=1e-7)

    def test_missing_native_model_is_not_fabricated_as_zero(self):
        with self.assertRaises(BridgeError): _yaml_species(record(model={"type":"reaktoro-native"}))

    def test_unbalanced_reaction_and_invalid_activity_are_reported(self):
        a=record();b=record("B",composition={"H":2},dependencies=["A"],reaction={"reactants":{"A":1}},activity_parameters={"ion_size_angstrom":-1},model={"type":"modified-ryzhenko-bryzgalin","parameters":{"pK0":1,"Azz":2,"Bzz":3}})
        codes={x["code"] for x in Service.record_issues([a,b])}
        self.assertIn("REACTION_UNBALANCED",codes);self.assertIn("ACTIVITY_PARAMETER_INVALID",codes)

    def test_interpolation_rejects_invalid_grid_and_tolerance(self):
        service=Service();handle={"records":[record()]}
        for args in [{"temperatures_K":[300,300],"pressures_Pa":[1e5,2e5]}, {"temperatures_K":[300,400],"pressures_Pa":[1e5,2e5],"tolerance":float("nan")}]:
            with self.assertRaises(BridgeError):service.export_interpolation(handle,args)
