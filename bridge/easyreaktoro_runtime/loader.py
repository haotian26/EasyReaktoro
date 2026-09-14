"""Load a data-only RTDB as an ordinary Reaktoro Database in Python/notebooks."""
from __future__ import annotations

import copy
import math
from pathlib import Path
from typing import Any

from . import repository, converted
from .errors import require


def build_database(records: list[dict], *, runtime_version: str | None = None, enforce_declared_ranges: bool = True) -> Any:
    import reaktoro as r
    from . import models
    from .service import Service, _yaml_species, _order_native_records
    if runtime_version:
        require(r.__version__ == runtime_version, "NATIVE_RUNTIME_CHANGED", "error.nativeRuntimeChanged", f"数据库审核环境为 Reaktoro {runtime_version}，当前为 {r.__version__}；请先完成兼容审核")
    active = copy.deepcopy([x for x in records if not x.get("disabled")])
    index = {x["name"]: x for x in active}
    require(len(index) == len(active), "DUPLICATE_NAME", "error.duplicateName", "RTDB 中有重复物种名称")
    errors = [x for x in Service.record_issues(active) if x["severity"] == "error"]
    require(not errors, "DATABASE_INVALID", "error.databaseInvalid", "; ".join(x["message"] for x in errors))
    for record in active:
        required = record.get("model", {}).get("runtime_version") or record.get("provenance", {}).get("runtime_version")
        require(not required or required == r.__version__, "NATIVE_RUNTIME_CHANGED", "error.nativeRuntimeChanged", f"{record['name']}: 记录环境为 {required}，当前为 {r.__version__}")
        issues = models.validate_model(record.get("model", {}))
        require(not issues, "MODEL_INVALID", "error.modelInvalid", f"{record['name']}: {issues}")
        require(all(name in index for name in record.get("dependencies", [])), "DEPENDENCY_MISSING", "error.dependencyMissing", record["name"])
    native_records = [x for x in active if x.get("model", {}).get("type") == "reaktoro-native"]
    objects: dict[str, Any] = {}; owners = []; visiting = []
    if native_records:
        native_records = _order_native_records(native_records)
        text = "Species:\n" + "\n".join(line for item in native_records for line in _yaml_species(item)) + "\n"
        native_db = r.Database.fromStringYAML(text); owners.append(native_db)
        objects.update({str(x.name()): x for x in native_db.species()})
    auxiliary: dict[str, Any] = {}
    def native(text: str, name: str) -> Any:
        key = repository.fingerprint(text)
        if key not in auxiliary:
            auxiliary[key] = r.Database.fromStringYAML(text); owners.append(auxiliary[key])
        return auxiliary[key].species(name)
    def resolve(name: str) -> Any:
        if name in objects: return objects[name]
        require(name in index, "DEPENDENCY_MISSING", "error.dependencyMissing", " → ".join([*visiting, name]))
        require(name not in visiting, "DEPENDENCY_CYCLE", "error.dependencyCycle", " → ".join([*visiting, name]))
        visiting.append(name)
        try:
            record = index[name]; model = record.get("model", {})
            require(record.get("composition") and all(isinstance(x, (int, float)) and math.isfinite(x) and x > 0 for x in record["composition"].values()), "COMPOSITION_INVALID", "error.compositionInvalid", name)
            if model.get("type") == converted.MODEL_TYPE:
                thermo = converted.model_for(record, resolve, native)
            else:
                # Existing GUI-created EMK/AD/MRB records use the same evaluator
                # in notebooks and the app. Unknown models never become zeros.
                dependencies = {dep: resolve(dep) for dep in record.get("dependencies", [])}
                def callback(T: Any, P: Any) -> Any:
                    t, p = float(T), float(P)
                    if model.get("type") == "modified-ryzhenko-bryzgalin":
                        def gibbs(t: float, p: float) -> float:
                            value = models.evaluate(model, t, p)["properties"]["reaction_G0"]
                            return value + sum(float(coef)*float(dependencies[dep].standardThermoProps(t,p).G0) for dep,coef in record.get("reaction",{}).get("reactants",{}).items())
                        values = models.gibbs_properties(gibbs,t,p)
                    else: values = models.evaluate(model,t,p)["properties"]
                    result = r.StandardThermoProps()
                    for key in ("G0", "H0", "Cp0", "V0", "VT0", "VP0"): setattr(result,key,values[key])
                    return result
                require(model.get("type") in models.REGISTRY and models.REGISTRY[model["type"]].evaluator is not None, "MODEL_NOT_CALCULABLE", "error.modelNotCalculable", str(model.get("type")))
                thermo = r.StandardThermoModel(callback)
            species = (r.Species().withName(name).withFormula(record["formula"])
                .withElements(r.ElementalComposition([(symbol, float(amount)) for symbol,amount in record["composition"].items()]))
                .withCharge(float(record["charge"])).withAggregateState(getattr(r.AggregateState,record["state"]))
                .withStandardThermoModel(thermo))
            if enforce_declared_ranges and record.get("valid_tp"):
                valid = copy.deepcopy(record["valid_tp"])
                def bounded(T: Any, P: Any) -> Any:
                    models.check_tp(float(T), float(P))
                    for key, value in (("temperature_K", float(T)), ("pressure_Pa", float(P))):
                        bounds = valid.get(key)
                        require(not bounds or bounds[0] <= value <= bounds[1], "TP_OUT_OF_RANGE", "error.tpOutOfRange", f"{name}: {key}={value}")
                    return thermo(T, P)
                species = species.withStandardThermoModel(r.StandardThermoModel(bounded))
            objects[name] = species
            return species
        finally: visiting.pop()
    database = r.Database()
    for record in active: database.addSpecies(resolve(record["name"]))
    return database


def load_database(path: str | Path) -> Any:
    """Return a Reaktoro Database, without reading the original source folder.

    Reads RTDB only. Does not choose activity/fugacity models or modify data.
    Requires Reaktoro/Python and this library, not database-embedded Python.
    """
    meta, records = repository.open_database(str(path))
    return build_database(records, runtime_version=meta.get("required_reaktoro_version"))


def ion_size_parameters(path: str | Path) -> dict:
    """Return current per-species ion parameters in one read, including GUI edits.

    This is not the archived source table and applies no fallback to new species.
    Values are activity parameter records, indexed by exact species name.
    """
    _, records = repository.open_database(str(path))
    return {x["name"]: copy.deepcopy(x["activity_parameters"]) for x in records
            if not x.get("disabled") and x.get("activity_parameters", {}).get("model") == "extended-debye-huckel"}


def activity_parameters(path: str | Path, species_name: str) -> dict:
    """Return the stored effective parameter and provenance, never a new guess."""
    _, records = repository.open_database(str(path))
    record = next((x for x in records if x["name"] == species_name), None)
    require(record is not None, "SPECIES_NOT_FOUND", "error.speciesNotFound", species_name)
    return copy.deepcopy(record.get("activity_parameters", {}))


def resolve_ion_size_parameter(path: str | Path, species_name: str) -> dict | None:
    value = activity_parameters(path, species_name)
    if value.get("model") != "extended-debye-huckel" or "ion_size_angstrom" not in value: return None
    return {"a_angstrom": value["ion_size_angstrom"], "source": value.get("source", ""), "is_default": value.get("is_default", False), "resolution": value.get("resolution", "RTDB 中保存的物种参数"), "reason": value.get("reason", "")}
