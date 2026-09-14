"""Portable-reader regressions using synthetic data only."""
import copy
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from bridge.easyreaktoro_runtime import repository, load_database, ion_size_parameters, resolve_ion_size_parameter
from bridge.easyreaktoro_runtime import converted
from bridge.easyreaktoro_runtime.loader import build_database
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.service import Service

try:
    import reaktoro as r
except ImportError:
    r = None


def species(name="solid", kind="piecewise-cp", **changes):
    model = {"type": converted.MODEL_TYPE, "version": "1", "kind": kind,
             "is_gas": False, "parameters": {"Param": [-1000, 10, 2], "nEqu": 1,
             "Cp": [30]+[0]*9, "T": [0], "dH": [0], "dV": [0], "dVdT": [0]}}
    return repository.normalize_species({"name":name,"formula":"H2O","composition":{"H":2,"O":1},
        "charge":0,"state":"CrystallineSolid","model":model,**changes})


class PortableDataTest(unittest.TestCase):
    def test_model_vectors_offsets_and_versions_are_required(self):
        model=species()["model"]
        self.assertEqual(converted.validate(model),[])
        for changed in ({**model,"version":"999"},{**model,"parameters":{}},
                        {**model,"kind":"execute-python","path":"untrusted.py"}):
            self.assertTrue(converted.validate(changed))
        ad={"type":converted.MODEL_TYPE,"version":"1","kind":"akinfiev-diamond",
            "parameters":{"Param":[0,0,0,.5,0,0],"nCp":0,"Cp":[]}}
        self.assertTrue(converted.validate(ad))
        ad["parameters"]["reference_offsets"]={key:0 for key in converted.OFFSET_KEYS}
        self.assertEqual(converted.validate(ad),[])

    def test_nested_parameters_have_units_without_guessing_source_fields(self):
        rows={x["name"]:x for x in converted.parameter_definition(species()["model"])["parameters"]}
        self.assertEqual(rows["Param / 1"]["unit"],"J/mol")
        self.assertEqual(rows["dVdT / 1"]["unit"],"K/kbar")
        self.assertEqual(rows["Cp / 2"]["unit"],"J·mol⁻¹·K^(-2)")
        mrb={"kind":"mrb","parameters":{"pK0":1,"Azz":2,"Bzz":3,"return_code":0,"Names":["raw"]}}
        self.assertEqual(converted.visible_parameters(mrb),{"pK0":1,"Azz":2,"Bzz":3})
        self.assertIn("return_code",mrb["parameters"])

    def test_save_as_preserves_data_archives_and_current_activity_assignment(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"source.rtdb"; other=Path(tmp)/"copy.rtdb"
            item=species("ion",state="Aqueous",formula="H+",composition={"H":1},charge=1,
                activity_parameters={"model":"extended-debye-huckel","ion_size_angstrom":4,
                    "source":"Example source","is_default":True,"reason":"Source rule"})
            repository.create(str(path),"source",records=[item])
            meta,records=repository.open_database(str(path)); meta["source_archive"]=json.dumps({"example.txt":"original"})
            repository.save(str(path),meta,records)
            service=Service(); handle=service.handle(service.open_rtdb(str(path))["handle_id"])
            original=copy.deepcopy(handle["records"][0]); update=copy.deepcopy(original)
            update["notes"]="note"; update["activity_parameters"]["ion_size_angstrom"]=5
            service.mutate_species(handle,"update",{"species_id":original["id"],"species":update})
            service.save(handle,str(other))
            saved_meta,saved=repository.open_database(str(other))
            self.assertEqual(saved_meta["source_archive"],meta["source_archive"])
            self.assertEqual(saved[0]["model"],original["model"])
            self.assertEqual(saved[0]["provenance"],original["provenance"])
            current=ion_size_parameters(other)["ion"]
            self.assertEqual(current["ion_size_angstrom"],5)
            self.assertEqual(current["source"],""); self.assertFalse(current["is_default"])
            self.assertEqual(current["original_assignment"]["ion_size_angstrom"],4)
            self.assertEqual(resolve_ion_size_parameter(other,"ion")["a_angstrom"],5)
            self.assertEqual(resolve_ion_size_parameter(path,"ion")["a_angstrom"],4)


@unittest.skipIf(r is None,"External Reaktoro is required")
class ReaktoroReaderTest(unittest.TestCase):
    def test_piecewise_cp_and_gas_reference_at_multiple_tp(self):
        item=species(); db=build_database([item])
        for t,p in ((298.15,1e5),(450,2e7),(600,7e7)):
            props=db.species("solid").standardThermoProps(t,p)
            entropy=10+30*math.log(t/298.15)
            gibbs=-1000-10*(t-298.15)+30*(t-298.15)-t*30*math.log(t/298.15)+(p-1e5)*2e-5
            self.assertAlmostEqual(float(props.G0),gibbs,places=8)
            self.assertAlmostEqual(float(props.H0),gibbs+t*entropy,places=8)
            self.assertEqual(float(props.Cp0),30)
        model={"type":converted.MODEL_TYPE,"version":"1","kind":"gas-reference-cp","parameters":{"Param":[-1000,10],"nCp":1,"Cp":[30]}}
        gas=build_database([species("gas",state="Gas",model=model)]).species("gas")
        self.assertEqual(float(gas.standardThermoProps(450,1e5).V0),0)
        self.assertEqual(float(gas.standardThermoProps(450,1e5).G0),float(gas.standardThermoProps(450,7e7).G0))

    def test_ad_reference_offsets_are_record_data_not_global_constants(self):
        p={"Param":[-1000,10,0,.25,.1,.2],"nCp":1,"Cp":[30],
           "reference_offsets":{key:0 for key in converted.OFFSET_KEYS}}
        model={"type":converted.MODEL_TYPE,"version":"1","kind":"akinfiev-diamond","parameters":p}
        first=species("neutral",state="Aqueous",model=model)
        second=copy.deepcopy(first); second["model"]["parameters"]["reference_offsets"]["water_dH_J_mol"]=12
        a,b=build_database([first]),build_database([second])
        for t,p in ((298.15,1e5),(450,2e7),(600,7e7)):
            x,y=a.species("neutral").standardThermoProps(t,p),b.species("neutral").standardThermoProps(t,p)
            self.assertAlmostEqual(float(y.G0)-float(x.G0),9,places=7)
            self.assertTrue(all(math.isfinite(float(getattr(x,k))) for k in ("G0","H0","Cp0","V0")))

    def test_invalid_dependency_and_runtime_are_not_silently_ignored(self):
        with self.assertRaises(BridgeError): build_database([species()],runtime_version="0.0.0")
        with self.assertRaises(BridgeError): build_database([species(dependencies=["missing"])])
        with self.assertRaises(BridgeError): build_database([species(dependencies=["solid"])])
        self.assertEqual(len(build_database([species(disabled=True)]).species()),0)

    def test_notebook_range_checks_match_app_checks(self):
        db=build_database([species(valid_tp={"temperature_K":[290,500],"pressure_Pa":[1e5,1e8]})])
        self.assertTrue(math.isfinite(float(db.species("solid").standardThermoProps(350,1e5).G0)))
        with self.assertRaises(Exception): db.species("solid").standardThermoProps(550,1e5)

    def test_simulation_range_policy_allows_evaluable_extrapolation_without_changing_records(self):
        record=species(valid_tp={"temperature_K":[290,500],"pressure_Pa":[1e5,1e8]});original=copy.deepcopy(record)
        db=build_database([record],enforce_declared_ranges=False)
        self.assertTrue(math.isfinite(float(db.species("solid").standardThermoProps(550,1e5).G0)))
        self.assertEqual(record,original)

    def test_native_reaction_declaration_order_and_reload(self):
        model={"type":"reaktoro-native","parameters_yaml":"Constant:\n  G0: 0"}
        base=species("Z",state="Aqueous",model=model)
        product=species("A",state="Aqueous",model=model,dependencies=["Z"],reaction={"reactants":{"Z":1},"model_parameters_yaml":"ConstLgK:\n  lgKr: 1"})
        db=build_database([product,base])
        self.assertEqual(len(db.species()),2)
        with tempfile.TemporaryDirectory() as tmp:
            service=Service(); handle={"records":[product,base]}
            report=service.export_native(handle,{"path":str(Path(tmp)/"native.yaml")})
            self.assertEqual(report["export_count"],2)

    def test_fresh_process_load_evaluate_solve_repeat_and_exit(self):
        water=species("solvent",state="Aqueous",model={"type":converted.MODEL_TYPE,"version":"1","kind":"water-hkf","parameters":{}})
        hydroxide=species("hydroxide",formula="OH-",composition={"H":1,"O":1},charge=-1,state="Aqueous",
            model={"type":converted.MODEL_TYPE,"version":"1","kind":"hydroxide-marshall-franck","parameters":{}})
        proton=species("proton",formula="H+",composition={"H":1},charge=1,state="Aqueous",model={"type":"reaktoro-native","parameters_yaml":"Constant:\n  G0: 0"})
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"synthetic.rtdb"; repository.create(str(path),"synthetic",records=[water,proton,hydroxide])
            code='''import sys
import reaktoro as r
from easyreaktoro_runtime import load_database
for _ in range(3):
    db=load_database(sys.argv[1])
    phase=r.AqueousPhase("solvent proton hydroxide")
    phase.setActivityModel(r.ActivityModelIdealAqueous())
    system=r.ChemicalSystem(db,phase)
    specs=r.EquilibriumSpecs(system); specs.temperature(); specs.pressure()
    state=r.ChemicalState(system); state.temperature(25,"celsius"); state.pressure(1,"bar"); state.set("solvent",1,"kg")
    assert r.EquilibriumSolver(specs).solve(state).succeeded()
    assert len(db.species())==3
print("repeat/solve/exit checked")
'''
            env={**os.environ,"PYTHONPATH":str(Path(__file__).resolve().parents[1]/"bridge")}
            result=subprocess.run([sys.executable,"-B","-c",code,str(path)],env=env,cwd=tmp,capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn("repeat/solve/exit checked",result.stdout)


if __name__ == "__main__": unittest.main()
