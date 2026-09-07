from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable

from .errors import BridgeError, require

try:
    import reaktoro
except Exception:
    reaktoro = None


@dataclass(frozen=True)
class Parameter:
    name: str
    label: str
    unit: str
    help: str = ""
    required: bool = True


@dataclass(frozen=True)
class ModelDefinition:
    id: str
    label: str
    description: str
    parameters: tuple[Parameter, ...]
    evaluator: Callable[[dict[str, float], float, float], dict[str, float]] | None
    native: bool = False
    creatable: bool = True
    reaction_based: bool = False
    states: tuple[str, ...] = ()


R = 8.31446261815324


def check_tp(temperature_k: float, pressure_pa: float) -> None:
    require(all(math.isfinite(x) and x > 0 for x in (temperature_k, pressure_pa)), "INVALID_TP", "error.invalidTP", "温度 (K) 和压力 (Pa) 必须是大于 0 的有限数值")


def gibbs_properties(gibbs: Callable, t: float, p: float) -> dict[str, float]:
    # Symmetric stencils must remain strictly inside the positive T/P domain.
    dt, dp = min(max(0.01, t * 1e-4), t / 4), min(max(100.0, p * 1e-4), p / 4)
    gm, g0, gp = gibbs(t-dt, p), gibbs(t, p), gibbs(t+dt, p)
    dgt = (gp-gm)/(2*dt)
    gpm, gpp = gibbs(t, p-dp), gibbs(t, p+dp)
    vt = (gibbs(t+dt, p+dp)-gibbs(t+dt, p-dp)-gibbs(t-dt, p+dp)+gibbs(t-dt, p-dp))/(4*dt*dp)
    values = {"G0": g0, "H0": g0-t*dgt, "S0": -dgt, "Cp0": -t*(gp-2*g0+gm)/(dt*dt), "V0": (gpp-gpm)/(2*dp), "VT0": vt, "VP0": (gpp-2*g0+gpm)/(dp*dp)}
    require(all(math.isfinite(v) for v in values.values()), "EVALUATION_NONFINITE", "error.evaluationNonfinite", "模型返回非有限数值，请检查参数和有效温压范围")
    return values


def _poly(params: dict[str, float], temperature_k: float, pressure_pa: float) -> dict[str, float]:
    """Extended Maier-Kelley representation anchored at 298.15 K and 1 bar."""
    t0, p0 = 298.15, 100_000.0
    g0, h0, s0 = (params[k] for k in ("G298", "H298", "S298"))
    a, b, c = (params.get(k, 0.0) for k in ("a", "b", "c"))
    cp = a + b * temperature_k + c / (temperature_k * temperature_k)
    dh = a * (temperature_k - t0) + 0.5 * b * (temperature_k**2 - t0**2) - c * (1.0 / temperature_k - 1.0 / t0)
    ds = a * math.log(temperature_k / t0) + b * (temperature_k - t0) - 0.5 * c * (1.0 / temperature_k**2 - 1.0 / t0**2)
    h = h0 + dh
    s = s0 + ds
    volume = params.get("V", 0.0)
    pressure_term = volume * (pressure_pa - p0)
    return {"G0": g0 + dh - temperature_k * ds - s0 * (temperature_k - t0) + pressure_term, "H0": h + pressure_term, "S0": s, "Cp0": cp, "V0": volume, "VT0": 0.0, "VP0": 0.0}


def _water_density_g_cm3(temperature_k: float, pressure_pa: float) -> float:
    if reaktoro is None:
        raise BridgeError("RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", "MRB requires Reaktoro waterDensityHGK")
    density = reaktoro.waterDensityHGK(temperature_k, max(pressure_pa, 1.0), reaktoro.StateOfMatter.Liquid)
    return max(float(density) / 1000.0, 1e-12)


def _marshall_franck_pkw(temperature_k: float, pressure_pa: float) -> float:
    rho = _water_density_g_cm3(temperature_k, pressure_pa)
    a, b, c, d = -4.098, -3245.2, 2.2362e5, -3.984e7
    e, f, g = 13.957, -1262.3, 8.5641e5
    return -(a + b / temperature_k + c / temperature_k**2 + d / temperature_k**3 + (e + f / temperature_k + g / temperature_k**2) * math.log10(rho))


def _mrb_basis(temperature_k: float, pressure_pa: float) -> tuple[float, float, float]:
    reference_t, reference_rho = 298.15, 0.997061
    a, b, c, d = -4.098, -3245.2, 2.2362e5, -3.984e7
    e, f, g = 13.957, -1262.3, 8.5641e5
    pkw_ref = -(a + b / reference_t + c / reference_t**2 + d / reference_t**3 + (e + f / reference_t + g / reference_t**2) * math.log10(reference_rho))
    solvent = (_marshall_franck_pkw(temperature_k, pressure_pa) - pkw_ref * reference_t / temperature_k) / 1.0107
    return reference_t / temperature_k, solvent, solvent / temperature_k


def _mrb(params: dict[str, float], temperature_k: float, pressure_pa: float) -> dict[str, float]:
    f0, f1, f2 = _mrb_basis(temperature_k, pressure_pa)
    pk = params["pK0"] * f0 + params["Azz"] * f1 + params["Bzz"] * f2
    return {"pK": pk, "reaction_G0": -R * temperature_k * math.log(10.0) * pk}


def _solve_3x3(matrix: list[list[float]], vector: list[float]) -> list[float]:
    augmented = [matrix[row][:] + [vector[row]] for row in range(3)]
    for column in range(3):
        pivot = max(range(column, 3), key=lambda row: abs(augmented[row][column]))
        require(abs(augmented[pivot][column]) > 1e-12, "MRB_FIT_SINGULAR", "error.mrbFitSingular", "温压点分布不足以唯一拟合三个 MRB 参数")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(3):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [left - factor * right for left, right in zip(augmented[row], augmented[column])]
    return [augmented[row][3] for row in range(3)]


def fit_mrb(rows: list[dict[str, Any]], value_kind: str = "pK") -> dict[str, Any]:
    require(len(rows) >= 3, "MRB_FIT_POINTS", "error.mrbFitPoints", "至少需要 3 组温度、压力和平衡常数数据")
    require(value_kind in ("pK", "logK"), "MRB_FIT_VALUE_KIND", "error.mrbFitValueKind", value_kind)
    samples = []
    for index, row in enumerate(rows):
        try:
            temperature = float(row["temperature_K"])
            pressure = float(row["pressure_Pa"])
            observed = float(row["value"])
        except (KeyError, TypeError, ValueError) as exc:
            raise BridgeError("MRB_FIT_ROW", "error.mrbFitRow", f"第 {index + 1} 行必须包含有效的 T、P 和数值") from exc
        require(all(math.isfinite(x) for x in (temperature, pressure, observed)) and temperature > 0 and pressure > 0, "MRB_FIT_ROW", "error.mrbFitRow", f"第 {index + 1} 行数据无效")
        pk = observed if value_kind == "pK" else -observed
        samples.append((temperature, pressure, observed, pk, _mrb_basis(temperature, pressure)))
    scales = [math.sqrt(sum(sample[4][column] ** 2 for sample in samples)) for column in range(3)]
    require(all(scale > 1e-14 for scale in scales), "MRB_FIT_SINGULAR", "error.mrbFitSingular", "温压点分布不足以拟合 MRB 参数")
    design = [[sample[4][column] / scales[column] for column in range(3)] for sample in samples]
    normal = [[sum(row[left] * row[right] for row in design) for right in range(3)] for left in range(3)]
    target = [sum(row[column] * sample[3] for row, sample in zip(design, samples)) for column in range(3)]
    scaled = _solve_3x3(normal, target)
    coefficients = [scaled[index] / scales[index] for index in range(3)]
    parameters = dict(zip(("pK0", "Azz", "Bzz"), coefficients))
    fitted_rows = []
    squared_errors = []
    observed_values = [sample[2] for sample in samples]
    for temperature, pressure, observed, _, basis in samples:
        fitted_pk = sum(coefficient * feature for coefficient, feature in zip(coefficients, basis))
        fitted = fitted_pk if value_kind == "pK" else -fitted_pk
        residual = observed - fitted
        squared_errors.append(residual * residual)
        fitted_rows.append({"temperature_K": temperature, "pressure_Pa": pressure, "observed": observed, "fitted": fitted, "residual": residual})
    mean = sum(observed_values) / len(observed_values)
    total = sum((value - mean) ** 2 for value in observed_values)
    residual_sum = sum(squared_errors)
    return {
        "parameters": parameters,
        "value_kind": value_kind,
        "rows": fitted_rows,
        "rmse": math.sqrt(residual_sum / len(samples)),
        "r_squared": 1.0 - residual_sum / total if total > 0 else (1.0 if residual_sum < 1e-20 else 0.0),
    }


def _water_standard_g(temperature_k: float, pressure_pa: float) -> float:
    if reaktoro is None:
        raise BridgeError("RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", "Akinfiev-Diamond requires Reaktoro HGK water properties")
    state = reaktoro.waterThermoPropsHGK(temperature_k, max(pressure_pa, 1.0), reaktoro.StateOfMatter.Liquid)
    molar_mass, triple_t, triple_s, triple_g, triple_h = 0.01801528, 273.16, 63.312288, -235517.36, -287721.128
    water_h = float(state.H) * molar_mass
    entropy = float(state.S) * molar_mass + triple_s
    return water_h - temperature_k * entropy + triple_t * triple_s + triple_g + triple_h - triple_h


def _water_ideal_g(temperature_k: float) -> float:
    coefficients = (19.730271018,20.9662681977,-0.483429455355,6.05743189245,22.56023885,-9.87532442,-4.3135538513,0.458155781,-0.047754901883,0.0041238460633,-0.00027929052852,0.000014481695261,-0.00000056473658748,0.000000016200446,-0.0000000003303822796,0.00000000000451916067368,-0.0000000000000370734122708,0.000000000000000137546068238)
    reduced = temperature_k / 100.0
    dimensionless = -(coefficients[0] / reduced + coefficients[1]) * math.log(reduced)
    for index in range(2, 18): dimensionless -= coefficients[index] * reduced ** (index - 5)
    return dimensionless * 8.31451 * temperature_k - 182161.88


def _ad_gibbs(params: dict[str, float], temperature_k: float, pressure_pa: float) -> float:
    if reaktoro is None:
        raise BridgeError("RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", "Akinfiev-Diamond requires Reaktoro")
    xi, coefficient_a, coefficient_b = params["xi"], params["A"], params["B"]
    density = _water_density_g_cm3(temperature_k, pressure_pa)
    r_ad, r_cm3_bar, water_molar_mass_g = 8.31451, 83.1451, 18.01528
    residual_g = _water_standard_g(temperature_k, pressure_pa) - _water_ideal_g(temperature_k)
    log_fugacity = residual_g / (r_ad * temperature_k)
    hydration = (-r_ad*temperature_k*math.log(1000.0/water_molar_mass_g)+(1.0-xi)*r_ad*temperature_k*log_fugacity+r_ad*temperature_k*xi*math.log(r_cm3_bar*temperature_k/water_molar_mass_g*density)+r_ad*temperature_k*density*(coefficient_a+coefficient_b*math.sqrt(1000.0/temperature_k)))
    gas_params = {"G298":params["gas_G298"],"H298":params["gas_H298"],"S298":params["gas_S298"],"a":params["gas_cp_a"],"b":params["gas_cp_b"],"c":params["gas_cp_c"],"V":0.0}
    return _poly(gas_params, temperature_k, 100_000.0)["G0"] + hydration


def _ad(params: dict[str, float], temperature_k: float, pressure_pa: float) -> dict[str, float]:
    return gibbs_properties(lambda t, p: _ad_gibbs(params, t, p), temperature_k, pressure_pa)


REGISTRY: dict[str, ModelDefinition] = {
    "reaktoro-native": ModelDefinition("reaktoro-native", "Reaktoro 原生记录", "由已连接 Reaktoro 数据库或可重新加载的原生 YAML 提供；它不是手工建模选项。", (), None, True, False),
    "modified-ryzhenko-bryzgalin": ModelDefinition("modified-ryzhenko-bryzgalin", "Modified Ryzhenko–Bryzgalin", "根据形成反应的平衡常数模型和依赖物种计算目标物种标准态性质。", (
        Parameter("pK0", "参考 pK", "1", "298.15 K 参考项"), Parameter("Azz", "溶剂项 Azz", "1", "MRB 溶剂修正系数"), Parameter("Bzz", "溶剂项 Bzz", "K", "MRB 温度修正系数")), _mrb, reaction_based=True),
    "extended-maier-kelley": ModelDefinition("extended-maier-kelley", "Extended Maier–Kelley", "以 298.15 K、1 bar 的标准态量和热容系数计算 G°、H°、S°、Cp° 与 V°。", (
        Parameter("G298", "G°(298.15 K)", "J/mol"), Parameter("H298", "H°(298.15 K)", "J/mol"), Parameter("S298", "S°(298.15 K)", "J/mol/K"),
        Parameter("a", "Cp 系数 a", "J/mol/K"), Parameter("b", "Cp 系数 b", "J/mol/K²"), Parameter("c", "Cp 系数 c", "J·K/mol"), Parameter("V", "标准摩尔体积", "m³/mol")), _poly),
    "akinfiev-diamond": ModelDefinition("akinfiev-diamond", "Akinfiev–Diamond", "由气相参考态和水合参数计算中性水溶物种标准态性质。", (
        Parameter("xi", "水合参数 ξ", "1"), Parameter("A", "水合参数 A", "cm³/g"), Parameter("B", "水合参数 B", "cm³·K⁰·⁵/g"),
        Parameter("gas_G298", "气相 G°(298.15 K)", "J/mol"), Parameter("gas_H298", "气相 H°(298.15 K)", "J/mol"), Parameter("gas_S298", "气相 S°(298.15 K)", "J/mol/K"),
        Parameter("gas_cp_a", "气相 Cp 系数 a", "J/mol/K"), Parameter("gas_cp_b", "气相 Cp 系数 b", "J/mol/K²"), Parameter("gas_cp_c", "气相 Cp 系数 c", "J·K/mol")), _ad, states=("Aqueous",)),
    "water-special": ModelDefinition("water-special", "特殊 water/OH 模型", "仅用于导入并保留已有的受验证记录；当前通用编辑器不能从零创建。", (), None, creatable=False),
    "gas-reference": ModelDefinition("gas-reference", "Gas reference 模型", "仅用于导入并保留已有的受验证记录；当前通用编辑器不能从零创建。", (), None, creatable=False),
}


def definitions() -> list[dict[str, Any]]:
    return [{"id": m.id, "label": m.label, "description": m.description, "native": m.native, "creatable": m.creatable, "calculable": m.evaluator is not None, "reaction_based": m.reaction_based, "states": list(m.states), "parameters": [p.__dict__ for p in m.parameters]} for m in REGISTRY.values()]


def validate_model(model: dict[str, Any], disabled: bool = False) -> list[dict[str, str]]:
    model_id = str(model.get("type", ""))
    definition = REGISTRY.get(model_id)
    if not definition:
        return [] if disabled else [{"code": "UNKNOWN_MODEL", "message": "未知模型只能保存为 disabled draft"}]
    params = model.get("parameters") or {}
    issues = [{"code": "MISSING_MODEL_PARAMETER", "message": f"缺少参数 {p.label}"} for p in definition.parameters if p.required and (p.name not in params or params[p.name] in (None, ""))]
    for parameter in definition.parameters:
        if parameter.name in params and params[parameter.name] not in (None, ""):
            try:
                if not math.isfinite(float(params[parameter.name])): raise ValueError("nonfinite")
            except (TypeError, ValueError): issues.append({"code": "INVALID_MODEL_PARAMETER", "message": f"参数 {parameter.label} 必须是数值"})
    return issues


def evaluate(model: dict[str, Any], temperature_k: float, pressure_pa: float) -> dict[str, Any]:
    check_tp(temperature_k, pressure_pa)
    definition = REGISTRY.get(str(model.get("type", "")))
    if not definition or not definition.evaluator:
        raise BridgeError("MODEL_NOT_CALCULABLE", "error.modelNotCalculable", str(model.get("type", "Unknown")))
    issues = validate_model(model)
    require(not issues, "MODEL_INVALID", "error.modelInvalid", "; ".join(x["message"] for x in issues))
    params = {k: float(v) for k, v in (model.get("parameters") or {}).items()}
    properties = definition.evaluator(params, temperature_k, pressure_pa)
    require(all(math.isfinite(v) for v in properties.values()), "EVALUATION_NONFINITE", "error.evaluationNonfinite", "模型返回非有限数值")
    return {"model": definition.id, "temperature_K": temperature_k, "pressure_Pa": pressure_pa, "properties": properties}
