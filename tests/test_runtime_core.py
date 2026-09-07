import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from bridge.easyreaktoro_runtime import models, repository
from bridge.easyreaktoro_runtime.service import Service, _closure, _rename_conflicts


class RepositoryTest(unittest.TestCase):
    def test_formula_is_generated_but_an_explicit_display_formula_is_preserved(self):
        base = {
            "name": "Sulfate",
            "composition": {"S": 1, "O": 4}, "charge": -2, "state": "Aqueous",
            "model": {"type": "extended-maier-kelley", "parameters": {
                "G298": 0, "H298": 0, "S298": 0, "a": 0, "b": 0, "c": 0, "V": 0,
            }},
        }
        generated = repository.normalize_species({**base, "formula": ""})
        customized = repository.normalize_species({**base, "formula": "[SO4]-2(aq)"})
        self.assertEqual(generated["formula"], "SO4-2")
        self.assertEqual(customized["formula"], "[SO4]-2(aq)")

    def test_model_registry_exposes_only_validated_creatable_models(self):
        definitions = {item["id"]: item for item in models.definitions()}
        self.assertFalse(definitions["reaktoro-native"]["creatable"])
        self.assertTrue(definitions["modified-ryzhenko-bryzgalin"]["reaction_based"])
        self.assertEqual(definitions["akinfiev-diamond"]["states"], ["Aqueous"])
        self.assertEqual(
            {key for key, value in definitions.items() if value["creatable"]},
            {"modified-ryzhenko-bryzgalin", "extended-maier-kelley", "akinfiev-diamond"},
        )

    def test_species_crud_atomic_save_reopen_and_dirty_close(self):
        service = Service()
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "editable.rtdb")
            repository.create(path, "Editable")
            summary = service.open_rtdb(path)
            record = {
                "name": "Test(aq)", "formula": "H2O", "composition": {"H": 2, "O": 1},
                "state": "Aqueous", "charge": 0,
                "model": {"type": "extended-maier-kelley", "parameters": {"G298": -10, "H298": -5, "S298": 0.02, "a": 1, "b": 0, "c": 0, "V": 1e-5}},
            }
            created = service.mutate_species(service.handle(summary["handle_id"]), "create", {"species": record})
            self.assertTrue(created["summary"]["dirty"])
            with self.assertRaises(Exception):
                service.dispatch({"op": "database.close", "handle_id": summary["handle_id"]})
            report = service.evaluate(service.handle(summary["handle_id"]), {"name": "Test(aq)", "temperature_K": 350, "pressure_Pa": 1e5})
            self.assertIn("G0", report["properties"])
            service.save(service.handle(summary["handle_id"]))
            reopened = service.open_rtdb(path)
            self.assertEqual(reopened["species_count"], 1)
            self.assertEqual(reopened["embedded_name"], "editable")
            self.assertEqual(repository.open_database(path)[0]["schema"], repository.SCHEMA_ID)

    def test_v1_migration_is_transactional(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "v1.rtdb"
            conn = sqlite3.connect(path)
            conn.executescript("""
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE species(id TEXT PRIMARY KEY,name TEXT,formula TEXT,state TEXT,charge REAL,tags_json TEXT,model_json TEXT,payload_json TEXT,disabled INTEGER);
            CREATE TABLE dependencies(species_id TEXT,dependency_id TEXT);
            INSERT INTO metadata VALUES ('schema','easyreaktoro.rtdb/v1');
            INSERT INTO metadata VALUES ('name','Legacy');
            INSERT INTO species VALUES ('a','Legacy','H2O','Aqueous',0,'[]','{"type":"unknown"}','{}',1);
            """)
            conn.commit(); conn.close()
            meta, records = repository.open_database(str(path))
            self.assertEqual(meta["schema"], repository.SCHEMA_ID)
            self.assertEqual(records[0]["name"], "Legacy")
            self.assertTrue(records[0]["disabled"])

    def test_yaml_import_commit_and_missing_dependency_rejection(self):
        service = Service()
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "import.rtdb"; repository.create(str(database), "Import")
            summary = service.open_rtdb(str(database)); handle = service.handle(summary["handle_id"])
            valid = Path(tmp) / "valid.yaml"
            valid.write_text("""Species:\n- Name: H+\n  Formula: H+\n  Elements: 1:H\n  Charge: 1\n  AggregateState: Aqueous\n  StandardThermoModel:\n    Constant:\n      G0: 0\n""", encoding="utf-8")
            preview = service.import_preview(handle, {"path": str(valid)})
            self.assertTrue(preview["can_commit"])
            report = service.import_commit(handle, {"path": str(valid), "fingerprints": [x["fingerprint"] for x in preview["items"]]})
            self.assertEqual(report["import_count"], 1)
            missing = Path(tmp) / "missing.yaml"
            missing.write_text("""Species:\n- Name: AB\n  Formula: AB\n  Elements: 1:H\n  AggregateState: Aqueous\n  FormationReaction:\n    Reactants: 1:DoesNotExist\n    ReactionStandardThermoModel:\n      ConstLgK:\n        lgKr: 1\n""", encoding="utf-8")
            blocked = service.import_preview(handle, {"path": str(missing)})
            self.assertFalse(blocked["can_commit"])
            self.assertEqual(blocked["missing_dependencies"][0]["dependency"], "DoesNotExist")


class CompositionAndExportTest(unittest.TestCase):
    @unittest.skipUnless(Path("/Applications/Reaktoro/envs/reaktoro/bin/python").exists(), "Reaktoro runtime unavailable")
    def test_compose_dependency_and_native_reload(self):
        service = Service()
        summary = service.open_official("PHREEQC", "phreeqc.dat")
        preview = service.compose_preview({"selections": [{"handle_id": summary["handle_id"], "names": ["Calcite"]}]})
        self.assertTrue(preview["can_commit"])
        self.assertEqual(preview["dependency_count"], 2)
        whole = service.compose_preview({"selections": [{"handle_id": summary["handle_id"], "all": True}]})
        self.assertFalse(whole["can_commit"])
        self.assertIn(["X-", "X-"], whole["cycles"])
        self.assertEqual(len(whole["records"]), 381)
        self.assertEqual(len({x["name"] for x in whole["records"]}), 381)
        with tempfile.TemporaryDirectory() as tmp:
            # PHREEQC reference species expose no serializable model. Never
            # invent zero-energy constants to make an export reload succeed.
            with self.assertRaisesRegex(Exception, "完整原生参数"):
                service.export_native(service.handle(summary["handle_id"]), {"path": str(Path(tmp) / "native.yaml")})
            native = service.open_official("SUPCRT", "supcrtbl")
            report = service.export_native(service.handle(native["handle_id"]), {"path": str(Path(tmp) / "native.yaml")})
            self.assertEqual(report["validation"]["status"], "valid")
            self.assertEqual(report["export_count"], 1108)
            self.assertEqual(report["exclude_count"], 0)

    @unittest.skipUnless(Path("/Applications/Reaktoro/envs/reaktoro/bin/python").exists(), "Reaktoro runtime unavailable")
    def test_interpolation_reload_and_independent_midpoint_tolerance(self):
        service = Service()
        summary = service.open_official("SUPCRT", "supcrtbl")
        handle = service.handle(summary["handle_id"])
        handle["records"] = [next(x for x in handle["records"] if x["name"] == "CO2(aq)")]
        with tempfile.TemporaryDirectory() as tmp:
            report = service.export_interpolation(handle, {
                "path": str(Path(tmp) / "interpolation.yaml"),
                "temperatures_K": [298.15 + 25 * i for i in range(12)],
                "pressures_Pa": [1e5, 2.5e6, 5e6, 7.5e6, 1e7],
                "tolerance": 0.05,
            })
            self.assertEqual(report["validation"]["status"], "valid")
            self.assertLessEqual(report["validation"]["maximum_relative_error"], 0.05)

    def test_conflicts_are_order_independent_and_cycles_block(self):
        base = {"name": "X", "formula": "H", "composition": {"H": 1}, "state": "Aqueous", "charge": 0, "model": {"type": "reaktoro-native"}, "dependencies": []}
        records = []
        for database, charge in (("one.dat", 0), ("two.dat", 1)):
            record = repository.normalize_species({**base, "charge": charge, "provenance": {"provider": "Reaktoro", "database": database}})
            records.append(record)
        first, _ = _rename_conflicts(records)
        second, _ = _rename_conflicts(list(reversed(records)))
        self.assertEqual(sorted(x["name"] for x in first), sorted(x["name"] for x in second))
        a = repository.normalize_species({**base, "name": "A", "dependencies": ["B"]})
        b = repository.normalize_species({**base, "name": "B", "dependencies": ["A"]})
        _, missing, cycles = _closure({"A": [a], "B": [b]}, [a])
        self.assertFalse(missing)
        self.assertTrue(cycles)


class ModelRegressionTest(unittest.TestCase):
    def test_mrb_parameters_can_be_recovered_from_multi_tp_equilibrium_constants(self):
        expected = {"pK0": 4.2, "Azz": 0.8, "Bzz": 120.0}
        points = ((298.15, 1e5), (348.15, 5e6), (423.15, 2e7), (523.15, 5e7), (623.15, 1e8))
        rows = [
            {
                "temperature_K": temperature,
                "pressure_Pa": pressure,
                "value": models.evaluate(
                    {"type": "modified-ryzhenko-bryzgalin", "parameters": expected},
                    temperature,
                    pressure,
                )["properties"]["pK"],
            }
            for temperature, pressure in points
        ]
        report = models.fit_mrb(rows, "pK")
        for key, value in expected.items():
            self.assertAlmostEqual(report["parameters"][key], value, delta=1e-7)
        self.assertLess(report["rmse"], 1e-10)

    def test_supported_models_are_finite_at_multiple_tp(self):
        fixtures = {
            "modified-ryzhenko-bryzgalin": {"pK0": 4.2, "Azz": 0.8, "Bzz": 120.0},
            "extended-maier-kelley": {"G298": -1000, "H298": -900, "S298": 0.3, "a": 2, "b": 1e-3, "c": 5, "V": 1e-5},
            "akinfiev-diamond": {"xi": 0.8, "A": 0.01, "B": 0.001, "gas_G298": -100000, "gas_H298": -95000, "gas_S298": 150, "gas_cp_a": 30, "gas_cp_b": 0.01, "gas_cp_c": 0},
        }
        for model_id, parameters in fixtures.items():
            values = [models.evaluate({"type": model_id, "parameters": parameters}, t, p)["properties"] for t, p in ((298.15, 1e5), (423.15, 5e6), (573.15, 1e7))]
            self.assertEqual(len(values), 3)
            self.assertTrue(all(all(float(v) == float(v) for v in row.values()) for row in values))
        expected = {
            "modified-ryzhenko-bryzgalin": [-23973.6189440, -39232.7382925, -68883.3853890],
            "extended-maier-kelley": [-1000.0, -1042.6285664, -1220.4814321],
            "akinfiev-diamond": [-97332.1179301, -111461.0833725, -130955.1999744],
        }
        keys = {"modified-ryzhenko-bryzgalin": "reaction_G0", "extended-maier-kelley": "G0", "akinfiev-diamond": "G0"}
        for model_id, parameters in fixtures.items():
            actual = [models.evaluate({"type": model_id, "parameters": parameters}, t, p)["properties"][keys[model_id]] for t, p in ((298.15, 1e5), (423.15, 5e6), (573.15, 1e7))]
            for got, want in zip(actual, expected[model_id]):
                self.assertAlmostEqual(got, want, delta=max(1e-6, abs(want) * 1e-9))


if __name__ == "__main__":
    unittest.main()
