"""Closed, versioned adapters for data-only converted thermodynamic records.

No Python source, imports, file paths, or executable callbacks are read from a
database. Equations are shipped with the reader; coefficients live in RTDB.
"""
from __future__ import annotations

import math
import hashlib
from typing import Any

from .errors import BridgeError, require

MODEL_TYPE = "converted-standard-state"
VERSION = "1"
KINDS = {
    "water-hkf": "Water HKF / HGK",
    "hydroxide-marshall-franck": "OH · Marshall–Franck",
    "mrb": "Modified Ryzhenko–Bryzgalin",
    "piecewise-cp": "Extended Maier–Kelley · 分段热容",
    "gas-reference-cp": "Gas reference · 扩展热容",
    "akinfiev-diamond": "Akinfiev–Diamond · 气相参考态",
}
OFFSET_KEYS = ("water_dH_J_mol", "water_dS_J_mol_K", "ideal_water_dH_J_mol", "ideal_water_dS_J_mol_K")


def validate(model: dict[str, Any]) -> list[dict[str, str]]:
    issues = []
    def need(condition: bool, message: str) -> None:
        if not condition: issues.append({"code": "CONVERTED_MODEL_INVALID", "message": message})
    def finite(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    def vector(key: str, length: int) -> None:
        value = p.get(key)
        need(isinstance(value, list) and len(value) >= length and all(finite(x) for x in value), f"{key} 必须包含至少 {length} 个有限系数")
    need(str(model.get("version")) == VERSION, "不支持此转换模型版本")
    kind = model.get("kind")
    need(kind in KINDS, "未识别的转换模型类型")
    p = model.get("parameters")
    if not isinstance(p, dict): return issues + [{"code": "CONVERTED_MODEL_INVALID", "message": "模型参数必须是结构化对象"}]
    if kind == "piecewise-cp":
        count = p.get("nEqu")
        need(isinstance(count, int) and 1 <= count <= 32, "分段热容方程数量无效")
        if isinstance(count, int) and 1 <= count <= 32:
            vector("Param", 3); vector("Cp", count * 10)
            for key in ("T", "dH", "dV", "dVdT"): vector(key, count)
            bounds = p.get("T", [])[:count-1]
            if all(finite(x) for x in bounds): need(all(x > 0 for x in bounds) and bounds == sorted(set(bounds)), "相变温度必须为递增的正数")
        need(isinstance(model.get("is_gas"), bool), "必须明确气相或凝聚相体积约定")
    elif kind in ("gas-reference-cp", "akinfiev-diamond"):
        count = p.get("nCp")
        need(isinstance(count, int) and 0 <= count <= 10, "气相热容系数数量无效")
        if isinstance(count, int) and 0 <= count <= 10: vector("Cp", count)
        vector("Param", 6 if kind == "akinfiev-diamond" else 2)
        if kind == "akinfiev-diamond":
            offsets = p.get("reference_offsets", {})
            need(isinstance(offsets, dict) and all(finite(offsets.get(k)) for k in OFFSET_KEYS), "必须明确 AD 参考态偏移，不能猜测或使用其他数据库的常数")
    elif kind == "mrb":
        for key in ("pK0", "Azz", "Bzz"): need(finite(p.get(key)), f"{key} 必须是有限数值")
        refs = model.get("reference_evaluators", {})
        need(isinstance(refs, dict) and all(x == "water-hgk-reference-v1" for x in refs.values()), "参考态约定必须来自已支持的版本")
        terms = model.get("auxiliary_reactants", [])
        need(isinstance(terms, list), "外部参考必须是原生记录快照列表")
        if isinstance(terms, list):
            for term in terms:
                need(isinstance(term, dict) and bool(term.get("name")) and isinstance(term.get("native_yaml"), str) and finite(term.get("coefficient")) and term.get("coefficient") != 0, "外部参考记录或系数无效")
    return issues


def parameter_definition(model: dict) -> dict:
    """Describe stored equation fields; source-only fields are never inferred."""
    p = model.get("parameters", {}); kind = model.get("kind"); rows = []
    def field(name: str, label: str, unit: str) -> None:
        rows.append({"name": name, "label": label, "unit": unit, "required": False})
    for i, (label, unit) in enumerate((("G°(298.15 K)", "J/mol"), ("S°(298.15 K)", "J/mol/K")), 1):
        field(f"Param / {i}", label, unit)
    if kind == "piecewise-cp":
        field("Param / 3", "参考摩尔体积（气体标准态不使用此项）", "J/bar/mol")
        for key, label, unit in (("T", "相变温度 / 末项存在上限", "K"), ("dH", "相变焓", "J/mol"), ("dV", "相变体积", "J/bar/mol"), ("dVdT", "相变边界 dT/dP", "K/kbar")):
            for i in range(len(p.get(key, []))): field(f"{key} / {i+1}", f"{label} · {i+1}", unit)
    if kind == "akinfiev-diamond":
        for i, label, unit in ((4,"ξ","1"),(5,"a","cm³/g"),(6,"b · √(1000 K/T) 约定","cm³/g")):
            field(f"Param / {i}", label, unit)
        for key in OFFSET_KEYS: field(f"reference_offsets / {key}", key, "J/mol/K" if "dS" in key else "J/mol")
    for key, label, unit in (("pK0","pK₀","1"),("Azz","Azz","1"),("Bzz","Bzz","K"),("nEqu","热容分段数","1"),("nCp","气相热容系数数目","1")):
        field(key,label,unit)
    exponents = (0, 1, -2, -.5, 2, 3, 4, -3, -1, .5)
    for i in range(len(p.get("Cp", []))):
        power = exponents[i % 10]
        field(f"Cp / {i+1}", f"热容系数 · 第 {i//10+1} 段 · T^{power:g}", f"J·mol⁻¹·K^({-1-power:g})")
    return {"id": MODEL_TYPE, "label": KINDS.get(kind, MODEL_TYPE), "creatable": False, "calculable": True, "parameters": rows}


def visible_parameters(model: dict) -> dict:
    """Only equation inputs belong in the parameter UI, not extraction status."""
    import copy
    p = model.get("parameters", {}); kind = model.get("kind")
    if kind == "mrb": return {k:p[k] for k in ("pK0", "Azz", "Bzz") if k in p}
    if kind == "piecewise-cp":
        n = p.get("nEqu", 0)
        return {"Param":p.get("Param", [])[:3], "nEqu":n, "Cp":p.get("Cp", [])[:n*10],
                **{key:p.get(key, [])[:n] for key in ("T", "dH", "dV", "dVdT")}}
    if kind in ("gas-reference-cp", "akinfiev-diamond"):
        n = p.get("nCp", 0)
        return {"Param":p.get("Param", [])[:6 if kind == "akinfiev-diamond" else 2],
                "nCp":n,"Cp":p.get("Cp", [])[:n],
                **({"reference_offsets":copy.deepcopy(p.get("reference_offsets", {}))} if kind == "akinfiev-diamond" else {})}
    return {}


def model_for(record: dict, resolve: Any, native: Any) -> Any:
    from . import converted_equations as eq
    import reaktoro as r
    model = record["model"]; issues = validate(model)
    require(not issues, "CONVERTED_MODEL_INVALID", "error.convertedModelInvalid", "; ".join(x["message"] for x in issues))
    kind = model["kind"]; p = model["parameters"]
    if kind == "water-hkf": return eq.water_model()
    if kind == "hydroxide-marshall-franck": return eq.hydroxide_model()
    if kind == "piecewise-cp": return eq.pure_phase_model(p, model["is_gas"])
    if kind == "gas-reference-cp": return eq.real_gas_reference_model(p)
    if kind == "akinfiev-diamond": return eq.akinfiev_diamond_model(p)
    if kind == "mrb":
        reactants = []
        internal = record.get("reaction", {}).get("reactants", {})
        require(set(internal) == set(record.get("dependencies", [])), "REACTION_DEPENDENCIES", "error.reactionDependencies", record["name"])
        require(set(model.get("reference_evaluators", {})).issubset(internal), "REFERENCE_CONVENTION", "error.referenceConvention", "参考态约定引用了反应中不存在的物种")
        for name, coefficient in internal.items():
            require(isinstance(coefficient, (float, int)) and math.isfinite(coefficient) and coefficient != 0, "REFERENCE_COEFFICIENT", "error.referenceCoefficient", name)
            species = resolve(name)
            # A versioned reference convention is explicit record data.
            mode = model.get("reference_evaluators", {}).get(name)
            if mode is not None:
                require(mode == "water-hgk-reference-v1", "REFERENCE_CONVENTION", "error.referenceConvention", str(mode))
                require(species.formula() == "H2O" and float(species.charge()) == 0, "REFERENCE_CONVENTION", "error.referenceConvention", "水参考约定只能引用中性 H2O")
            reactants.append((float(coefficient), eq.water_standard_props if mode else species.standardThermoProps))
        for term in model.get("auxiliary_reactants", []):
            coefficient = term.get("coefficient")
            require(isinstance(coefficient, (int, float)) and math.isfinite(coefficient) and coefficient != 0, "REFERENCE_COEFFICIENT", "error.referenceCoefficient", "外部参考系数无效")
            require(isinstance(term.get("native_yaml"), str) and bool(term.get("name")), "REFERENCE_MISSING", "error.referenceMissing", "缺少原生参考记录快照")
            expected = term.get("snapshot_sha256")
            require(not expected or hashlib.sha256(term["native_yaml"].encode()).hexdigest() == expected, "REFERENCE_CHANGED", "error.referenceChanged", "原生参考快照与保存的校验值不一致")
            reactants.append((float(coefficient), native(term["native_yaml"], term["name"]).standardThermoProps))
        require(bool(reactants), "REACTION_REQUIRED", "error.reactionRequired", record["name"])
        return eq.complex_model(p, reactants)
    raise BridgeError("CONVERTED_MODEL_UNKNOWN", "error.convertedModelUnknown", str(kind))
