"""Real equilibrium, inventory, process isolation, and settings regressions."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest

from bridge.easyreaktoro_runtime.service import Service
from bridge.easyreaktoro_runtime.simulation import catalog, normalize_config, Simulation
from bridge.easyreaktoro_runtime.simulation_jobs import database_source
from bridge.easyreaktoro_runtime.simulation_templates import load_settings
from bridge.easyreaktoro_runtime.errors import BridgeError

try:
    import reaktoro
except ImportError:
    reaktoro = None


def config(**changes):
    return {"name": "Synthetic brine", "mode": "single_point", "activity_model": "ideal",
        "species": ["H2O(aq)", "H+", "OH-", "Na+", "Cl-", "NaCl(aq)"],
        "inputs": [{"species": "H2O(aq)", "amount": 1, "unit": "kg"}, {"species": "NaCl(aq)", "amount": .1, "unit": "mol"}],
        "points": [{"label": "P1", "temperature_c": 25, "pressure_bar": 1}], "bootstrap": False, **changes}


class CatalogPresentationTests(unittest.TestCase):
    def test_basic_and_complex_order_keeps_competing_parameter_records_and_identity(self):
        rows=[{"id":"chloride","name":"Cl-","formula":"Cl-","state":"Aqueous","composition":{"Cl":1},"charge":-1},
              {"id":"ligand","name":"OH-","formula":"OH-","state":"Aqueous","composition":{"H":1,"O":1},"charge":-1},
              {"id":"complex-a","name":"CuCl+ A","formula":"CuCl+","state":"Aqueous","composition":{"Cu":1,"Cl":1},"charge":1},
              {"id":"complex-b","name":"CuCl+ B","formula":"CuCl+","state":"Aqueous","composition":{"Cu":1,"Cl":1},"charge":1}]
        before=copy.deepcopy(rows);found={r['id']:r for r in catalog(rows)['items']}
        self.assertEqual([found[i]['chemical_rank'] for i in ['chloride','ligand','complex-a','complex-b']],[1,2,3,3])
        self.assertFalse(any(r['disabled'] for r in found.values()));self.assertEqual(rows,before)
    def test_common_priority_uses_aqueous_composition_and_charge_not_record_name(self):
        rows=[{"name":"unusual-solvent-name","state":"Aqueous","composition":{"H":2,"O":1},"charge":0},
              {"name":"H","state":"Aqueous","composition":{"H":1},"charge":1},
              {"name":"OH version","state":"Aqueous","composition":{"H":1,"O":1},"charge":-1},
              {"name":"OH neutral radical","state":"Aqueous","composition":{"H":1,"O":1},"charge":0},
              {"name":"water gas","state":"Gas","composition":{"H":2,"O":1},"charge":0}]
        found={r["name"]:r for r in catalog(rows)["items"]}
        self.assertEqual([found[n]["common_rank"] for n in ["unusual-solvent-name","H","OH version"]],[0,1,2])
        self.assertEqual(found["OH neutral radical"]["common_rank"],100)
        self.assertEqual(found["water gas"]["common_rank"],100)

    def test_non_aqueous_liquid_has_an_explicit_reason_and_is_not_reclassified(self):
        row=catalog([{"name":"Au(l)","formula":"Au","state":"Liquid","composition":{"Au":1},"charge":0}])["items"][0]
        self.assertTrue(row["disabled"]);self.assertIsNone(row["phase"])
        self.assertEqual(row["state"],"Liquid");self.assertIn("非水液相",row["reason"])


class SettingsTests(unittest.TestCase):
    def test_notebook_reader_never_executes_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"template.ipynb"; sentinel=Path(directory)/"must-not-exist"
            source=f'''from pathlib import Path
Path({str(sentinel)!r}).write_text("executed")
AQUEOUS_SPECIES = ["H2O(aq)", "H+", "OH-"]
MINERAL_SPECIES = []
GAS_SPECIES = []
FLUID_INPUT = [("H2O(aq)", 1, "kg")]
SOLID_INPUT = []
SIMULATION_MODE = "single_point"
POINT_SETS = {{"preview": [("A", 25, 1)]}}
'''
            path.write_text(json.dumps({"cells":[{"cell_type":"code","source":source}]}))
            result=load_settings(path)
            self.assertFalse(sentinel.exists())
            self.assertEqual(result["config"]["inputs"][0]["amount"],1)
            self.assertEqual(len(result["config"]["points"]),1)

    def test_unsupported_or_oversized_notebook_settings_are_not_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"template.ipynb"
            path.write_text(json.dumps({"cells":[{"cell_type":"code","source":'AQUEOUS_SPECIES = fetch_unknown_species()'}]}))
            with self.assertRaises(BridgeError):load_settings(path)
            path.write_text(json.dumps({"cells":[{"cell_type":"code","source":'AQUEOUS_SPECIES = ["water"]\nPRESSURES_PREVIEW_BAR = np.arange(0, 1e20, 1)'}]}))
            with self.assertRaises(BridgeError):load_settings(path)


@unittest.skipIf(reaktoro is None,"External Reaktoro required")
class EquilibriumTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.output=tempfile.TemporaryDirectory(prefix="easyreaktoro-test-")
        cls.service=Service()
        cls.handle=cls.service.handle(cls.service.open_official("SUPCRT","supcrtbl")["handle_id"])
        cls.source=database_source(cls.handle)

    @classmethod
    def tearDownClass(cls):
        cls.service.simulation_jobs.close()
        cls.output.cleanup()

    def run_config(self, cfg, records=None):
        sim=Simulation({"config":cfg,"records":records or self.handle["records"],"source":self.source})
        rows=[];meta=sim.run(rows.append)
        return sim,rows,meta

    def test_exact_species_selection_and_single_point_balance(self):
        cfg=config();sim,rows,_=self.run_config(cfg)
        self.assertEqual(set(sim.names),set(cfg["species"]))
        self.assertLess(rows[0]["summary"]["max_component_balance_error_mol"],1e-10)
        self.assertTrue(6<rows[0]["summary"]["pH"]<8)
        self.assertEqual({x["species"] for x in rows[0]["species"]},set(cfg["species"]))

    def test_native_simulation_extrapolates_declared_range_but_database_evaluation_retains_its_check(self):
        from bridge.easyreaktoro_runtime import repository
        names=['H2O(aq)','H+','OH-']
        records=[copy.deepcopy(row) for row in self.handle['records'] if row['name'] in names]
        water=next(row for row in records if row['name']=='H2O(aq)');water['valid_tp']={'temperature_K':[290,310]}
        cfg=config(species=names,inputs=[{'species':'H2O(aq)','amount':1,'unit':'kg'}],points=[{'label':'outside','temperature_c':100,'pressure_bar':10}])
        source={**self.source,'kind':'rtdb'};simulation=Simulation({'config':cfg,'records':records,'source':source});rows=[];simulation.run(rows.append)
        self.assertEqual(len(rows),1);self.assertLess(rows[0]['summary']['max_component_balance_error_mol'],1e-10)
        with self.assertRaises(BridgeError):
            self.service.evaluate({'records':records},{'name':'H2O(aq)','temperature_K':373.15,'pressure_Pa':1e6})

    def test_input_errors_include_missing_and_disabled_species_and_units(self):
        for value in (float("nan"),float("inf"),-1):
            cfg=config();cfg["inputs"][0]["amount"]=value
            with self.assertRaises(BridgeError):normalize_config(cfg,self.handle["records"],self.source)
        for edit in ({"unit":"litre"},{"amount":0},{"species":"missing"}):
            cfg=config();cfg["inputs"][0].update(edit)
            with self.assertRaises(BridgeError):normalize_config(cfg,self.handle["records"],self.source)
        cfg=config(mode="repeated_flushing",passes=1.5)
        with self.assertRaises(BridgeError):normalize_config(cfg,self.handle["records"],self.source)
        records=copy.deepcopy(self.handle["records"])
        next(x for x in records if x["name"]=="Na+")["disabled"]=True
        with self.assertRaises(BridgeError):normalize_config(config(),records,self.source)

    def test_net_charge_is_rejected_without_automatic_titration(self):
        cfg=config();cfg["inputs"].append({"species":"Na+","amount":.1,"unit":"mol"})
        with self.assertRaisesRegex(BridgeError,"净电荷"):self.run_config(cfg)

    def test_warm_start_matches_cold_and_retains_canonical_totals(self):
        points=[{"label":str(p),"temperature_c":100,"pressure_bar":p} for p in (300,200,100)]
        _,warm,_=self.run_config(config(mode="closed_path",points=points))
        _,cold,_=self.run_config(config(mode="independent_points",points=points))
        self.assertEqual(warm[1]["summary"]["initial_guess"],"warm")
        for a,b in zip(warm,cold):
            for x,y in zip(a["species"],b["species"]):
                self.assertAlmostEqual(x["amount_mol"],y["amount_mol"],delta=1e-9)
            for x,y in zip(a["balances"],warm[0]["balances"]):
                self.assertAlmostEqual(x["input_mol"],y["input_mol"],delta=1e-10)

    def flushing(self,distribution="per_point"):
        cfg=config(mode="repeated_flushing",passes=2,solid_distribution=distribution)
        cfg["species"] += ["Ca+2","HCO3-","CO3-2","CO2(aq)","Calcite"]
        cfg["inputs"].append({"species":"Calcite","amount":.1,"unit":"mol"})
        cfg["points"]=[{"label":str(p),"temperature_c":100,"pressure_bar":p} for p in (300,200)]
        return self.run_config(cfg)

    def test_flushing_transfers_fluid_and_retains_each_cells_solids(self):
        sim,rows,meta=self.flushing()
        self.assertEqual(len(rows),4)
        lookup=lambda point,name:next(x for x in rows[point]["species"] if x["species"]==name)
        for n in sim.mobile:
            self.assertAlmostEqual(lookup(1,n)["inlet_amount_mol"],lookup(0,n)["amount_mol"],places=13)
        self.assertEqual(lookup(2,"Calcite")["inlet_amount_mol"],lookup(0,"Calcite")["amount_mol"])
        self.assertEqual(lookup(3,"Calcite")["inlet_amount_mol"],lookup(1,"Calcite")["amount_mol"])
        self.assertAlmostEqual(lookup(2,"NaCl(aq)")["inlet_amount_mol"],.1)
        self.assertTrue(all(abs(x["error_mol"])<1e-9 for x in meta["process_balance"]))

    def test_total_rock_is_distributed_without_multiplying_inventory(self):
        _,_,meta=self.flushing("total_evenly")
        calcium=next(x for x in meta["process_balance"] if x["component"]=="Ca" and x["pass"]==2)
        self.assertAlmostEqual(calcium["input_mol"],.1,places=13)

    def test_dynamic_model_radii_cache_and_low_ionic_strength_limits(self):
        from bridge.easyreaktoro_runtime.activity_nacl import stable_alpha,stable_sigma
        import math
        self.assertAlmostEqual(stable_sigma(0),1)
        self.assertAlmostEqual(stable_alpha(0),-1/math.log(10))
        records=copy.deepcopy(self.handle["records"])
        sizes={"H+":9,"OH-":3.5,"Na+":4,"Cl-":3}
        for row in records:
            if row["name"] in sizes:
                row["activity_parameters"]={"model":"extended-debye-huckel","ion_size_angstrom":sizes[row["name"]],"source":"Synthetic test parameters"}
        cfg=config(activity_model="nacl_edh",mode="independent_points",points=[{"temperature_c":100,"pressure_bar":100}]*2)
        _,rows,meta=self.run_config(cfg,records)
        self.assertEqual(meta["dynamic_parameter_evaluations"],1)
        na=next(x for x in rows[0]["species"] if x["species"]=="Na+")
        cl=next(x for x in rows[0]["species"] if x["species"]=="Cl-")
        self.assertNotAlmostEqual(na["activity_coefficient"],cl["activity_coefficient"],places=5)
        self.assertTrue(0<rows[0]["summary"]["water_activity"]<1)

    def test_non_sodium_chloride_solution_runs_without_composition_gate_or_warning(self):
        cfg=config(activity_model="nacl_edh",species=['H2O(aq)','H+','OH-','Cl-'],
                   inputs=[{'species':'H2O(aq)','amount':1,'unit':'kg'},
                           {'species':'H+','amount':.01,'unit':'mol'}, {'species':'Cl-','amount':.01,'unit':'mol'}],
                   allow_non_nacl=False,allow_unsupported_water=False)
        cfg['ion_size_overrides']={n:{'a_angstrom':4,'source':'Synthetic test','reason':'No composition gate regression'} for n in ['H+','OH-','Cl-']}
        _,rows,meta=self.run_config(cfg)
        self.assertEqual(rows[0]['summary']['paired_nacl_ionic_strength_fraction'],0)
        self.assertLess(rows[0]['summary']['max_component_balance_error_mol'],1e-10)
        self.assertEqual(meta['warnings'],[])

    def test_missing_ion_size_requires_an_explicit_sourced_override(self):
        cfg=config(activity_model="nacl_edh")
        with self.assertRaisesRegex(BridgeError,"缺少离子尺寸"):normalize_config(cfg,self.handle["records"],self.source)
        cfg["ion_size_overrides"]={n:{"a_angstrom":4,"source":"Synthetic test","reason":"Controlled regression"} for n in ["H+","OH-","Na+","Cl-"]}
        normalized,audit=normalize_config(cfg,self.handle["records"],self.source)
        self.assertEqual(len(audit),4)
        cfg["ion_size_overrides"]["Na+"]["source"]=""
        with self.assertRaises(BridgeError):normalize_config(cfg,self.handle["records"],self.source)

    def test_worker_completes_and_exports_real_rows_and_metadata(self):
        manager=self.service.simulation_jobs
        job=manager.start(self.handle,config(),self.output.name)
        deadline=time.monotonic()+20
        while manager.status(job["job_id"])["status"]=="running" and time.monotonic()<deadline:time.sleep(.05)
        status=manager.status(job["job_id"])
        self.assertEqual(status["status"],"completed",status)
        result=manager.result(job["job_id"],run_index=0)
        self.assertEqual(len(result["species"]),6)
        with tempfile.TemporaryDirectory() as directory:
            exported=manager.export(job["job_id"],directory)
            path=Path(exported["output_path"])
            self.assertEqual(exported["row_counts"]["aqueous"],6)
            self.assertTrue((path/"component_balance.csv").is_file())
            self.assertEqual(path.name,config()['name'])
            preserved=(path/'run.json').read_bytes()
            with self.assertRaisesRegex(BridgeError,'已存在'):manager.export(job['job_id'],directory)
            self.assertEqual((path/'run.json').read_bytes(),preserved)
            meta=json.loads((path/"metadata.json").read_text())
            self.assertEqual(meta["database"]["records_sha256"],self.source["records_sha256"])
            loaded=load_settings(path/"simulation.ersim.json")
            self.assertEqual(loaded["config"]["species"],config()["species"])

    def test_cancel_keeps_bridge_and_database_available(self):
        manager=self.service.simulation_jobs
        cfg=config(name="Cancellation run",mode="independent_points",points=[{"temperature_c":25,"pressure_bar":1}]*5000)
        job=manager.start(self.handle,cfg,self.output.name)
        with self.assertRaises(BridgeError):manager.start(self.handle,config(),self.output.name)
        status=manager.cancel(job["job_id"])
        self.assertEqual(status["status"],"cancelled")
        self.assertIsNotNone(manager.job(job["job_id"])["process"].poll())
        self.assertEqual(self.service.probe()["status"],"ready")
        self.assertEqual(len(self.service.handle(self.handle["id"])["records"]),len(self.handle["records"]))

    def test_settings_cannot_overwrite_a_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"protected.rtdb";path.write_text("original")
            with self.assertRaises(BridgeError):self.service.simulation_jobs.dispatch(self.service,{"action":"save_settings","handle_id":self.handle["id"],"path":str(path),"config":config()})
            self.assertEqual(path.read_text(),"original")


if __name__ == '__main__': unittest.main()
