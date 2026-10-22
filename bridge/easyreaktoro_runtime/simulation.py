"""Equilibrium of user-defined material flows, with conservative inventories.

The numerical initial guess never supplies the target bulk composition. A run
uses an immutable record snapshot and explicit EquilibriumSpecs, so callbacks
are released before Python shutdown (Reaktoro 2.13 lifecycle requirement).
"""
from __future__ import annotations

from collections import Counter
import copy
import math
from typing import Any

from .errors import BridgeError, require

from .simulation_process import migrate_config, validate_process, validate_material_bases, actual_point, ProcessInventory
from .simulation_loops import normalize_loops, execution_config, LoopPlan
ACTIVITY_MODELS = {"nacl_edh", "phreeqc", "hkf", "davies", "ideal"}


def number(value, label, minimum=None, maximum=None):
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
            "SIMULATION_INPUT", "error.simulationInput", f"{label} 必须是有限数")
    value = float(value)
    require(minimum is None or value >= minimum, "SIMULATION_INPUT", "error.simulationInput", f"{label} 不能小于 {minimum}")
    require(maximum is None or value <= maximum, "SIMULATION_INPUT", "error.simulationInput", f"{label} 不能大于 {maximum}")
    return value


def phase_of(record):
    if record.get("state") == "Aqueous":
        return "aqueous"
    if record.get("state") == "Gas":
        return "gas"
    if record.get("state") in {"Solid", "CrystallineSolid"}:
        return "mineral"
    return None


def is_water(record):
    return phase_of(record) == "aqueous" and record.get("charge") == 0 and record.get("composition") == {"H": 2, "O": 1}


def catalog(records):
    counts = Counter(x["name"] for x in records)
    items = []
    for record in records:
        phase = phase_of(record)
        reason = ("草稿物种不能参与计算" if record.get("disabled") else
                  "存在同名记录，请先在数据库中消除名称歧义" if counts[record["name"]] > 1 else
                  "非水液相（Liquid）尚未接入模拟；不能当作水相或纯矿物使用" if record.get("state") == "Liquid" else
                  f"尚未支持此聚集态：{record.get('state', '未指定')}" if phase is None else "")
        param = record.get("activity_parameters") or {}
        size = None
        if param.get("model") == "extended-debye-huckel" and "ion_size_angstrom" in param:
            size = {"a_angstrom": param["ion_size_angstrom"], "source": param.get("source", ""),
                    "reason": param.get("reason", ""), "is_default": bool(param.get("is_default")),
                    "resolution": param.get("resolution", "RTDB 中保存的参数")}
        # Display priority only: never changes inclusion, feed, phase or thermodynamics.
        common_rank = 100
        if phase == "aqueous":
            common = [({"H": 2, "O": 1}, 0), ({"H": 1}, 1), ({"H": 1, "O": 1}, -1),
                      ({"Na": 1}, 1), ({"Cl": 1}, -1), ({"K": 1}, 1), ({"Ca": 1}, 2), ({"Mg": 1}, 2)]
            common_rank = next((i for i, (composition, charge) in enumerate(common)
                                if record.get("composition") == composition and record.get("charge") == charge), 100)
        # Browsing categories do not assign a thermodynamic basis or change reactions.
        composition = record.get("composition", {})
        simple = [({"H": 1, "O": 1}, -1), ({"C": 1, "O": 3}, -2), ({"C": 1, "H": 1, "O": 3}, -1),
                  ({"S": 1, "O": 4}, -2), ({"H": 1, "S": 1, "O": 4}, -1), ({"H": 1, "S": 1}, -1),
                  ({"H": 2, "S": 1}, 0), ({"C": 1, "O": 2}, 0), ({"H": 2}, 0), ({"O": 2}, 0),
                  ({"N": 1, "O": 3}, -1), ({"N": 1, "O": 2}, -1), ({"N": 1, "H": 4}, 1),
                  ({"N": 1, "H": 3}, 0), ({"P": 1, "O": 4}, -3), ({"H": 1, "P": 1, "O": 4}, -2), ({"H": 2, "P": 1, "O": 4}, -1)]
        chemical_rank = (0 if is_water(record) else 1 if len(composition) == 1 and sum(composition.values()) == 1 else
                         2 if any(composition == c and record.get("charge", 0) == z for c, z in simple) else 3) if phase == "aqueous" else 4 if phase == "mineral" else 5
        items.append({"id": record.get("id"), "name": record["name"], "formula": record.get("formula", ""), "phase": phase,
                      "chemical_rank": chemical_rank,
                      "state": record.get("state", ""), "common_rank": common_rank,
                      "charge": record.get("charge", 0), "elements": sorted(record.get("composition", {})),
                      "is_water": is_water(record), "disabled": bool(reason), "reason": reason,
                      "ion_size": size})
    return {"items": sorted(items, key=lambda x: (x["phase"] or "z", x["name"].casefold())),
            "elements": sorted({e for row in items if not row["disabled"] for e in row["elements"]})}


def normalize_config(raw, records, source):
    require(isinstance(raw, dict), "SIMULATION_INPUT", "error.simulationInput", "模拟设置必须是对象")
    from .simulation_schedule import missing_amount
    cfg = migrate_config(raw)
    cfg["name"] = str(cfg.get("name", "平衡模拟")).strip()[:100] or "平衡模拟"
    require(cfg.get("activity_model") in ACTIVITY_MODELS, "SIMULATION_INPUT", "error.simulationInput", "请选择水相活度模型")
    selected = cfg.get("species")
    require(isinstance(selected, list) and 0 < len(selected) <= 500 and all(isinstance(x, str) for x in selected),
            "SIMULATION_INPUT", "error.simulationInput", "请选择 1–500 个平衡物种")
    require(len(set(selected)) == len(selected), "SIMULATION_INPUT", "error.simulationInput", "物种名单有重复项")
    available = {x["name"]: x for x in catalog(records)["items"]}
    for name in selected:
        require(name in available, "SIMULATION_INPUT", "error.simulationInput", f"当前数据库没有物种：{name}")
        require(not available[name]["disabled"], "SIMULATION_INPUT", "error.simulationInput", f"{name}：{available[name]['reason']}")
    waters = [x for x in selected if available[x]["is_water"]]
    water = cfg.get("water_species") or (waters[0] if len(waters) == 1 else "")
    aqueous_selected = any(available[n]["phase"] == "aqueous" for n in selected)
    require(not aqueous_selected or (water in waters and len(waters) == 1), "SIMULATION_INPUT", "error.simulationInput", "水相须包含且仅包含一个中性 H₂O 溶剂物种")
    cfg["water_species"] = water
    gas = [x for x in selected if available[x]["phase"] == "gas"]
    require(not gas or cfg.get("gas_model") in {"ideal", "peng_robinson"}, "SIMULATION_INPUT", "error.simulationInput", "请选择气相逸度模型")
    if cfg["activity_model"] == "phreeqc" and aqueous_selected:
        require(source.get("kind") == "official" and source.get("group") == "PHREEQC",
                "SIMULATION_INPUT", "error.simulationInput", "PHREEQC 活度模型需要直接打开 PHREEQC 官方数据库及其参数")
    require(not aqueous_selected or cfg["activity_model"] != "phreeqc" or not any(n in str(source.get("name", "")).lower() for n in ("pitzer", "sit")), "ACTIVITY_DATABASE", "error.simulationInput", "此 PHREEQC 选项使用 Debye–Hückel / Davies / LLNL 分支，不支持 Pitzer 或 SIT 参数库")
    materials = cfg.get("materials")
    require(isinstance(materials, list) and 0 < len(materials) <= 100, "SIMULATION_INPUT", "error.simulationInput", "请定义 1–100 份物质配方")
    for material in materials:
        require(isinstance(material, dict), "SIMULATION_INPUT", "error.simulationInput", "物质配方无效")
        material["name"] = str(material.get("name", "物质"))[:100]
        rows = material.get("inputs")
        require(isinstance(rows, list) and len(rows) <= 500, "SIMULATION_INPUT", "error.simulationInput", "投料表无效")
        seen = set()
        for row in rows:
            require(isinstance(row, dict) and row.get("species") in selected, "SIMULATION_INPUT", "error.simulationInput", "所有初始物质须从系统物种中选择")
            name = row["species"]
            require(name not in seen, "SIMULATION_INPUT", "error.simulationInput", f"物质配方内物种重复：{name}")
            seen.add(name)
            if not missing_amount(row.get("amount")):
                row["amount"] = number(row.get("amount"), f"{name} 投料量", 0)
            else:
                row.setdefault("amount", None)
            require(row.get("unit") in {"mol", "g", "kg"}, "SIMULATION_INPUT", "error.simulationInput", "投料单位只支持 mol、g、kg")
    from .simulation_constraints import normalize_constraints, validate_constraints
    normalize_constraints(cfg)
    normalize_loops(cfg)
    loop_plan = LoopPlan(cfg) if cfg.get('schedule') or cfg.get('loops') else None
    if cfg.get('schedule'):
        varied_water = any(identity[0] == 'material_amount' and identity[2] == water and any(value > 0 for value in values)
                           for identity, values in loop_plan._arrays.items())
    else:
        varied_water = loop_plan is not None and any(
            axis.get('target', {}).get('kind') == 'material_amount' and axis['target'].get('species') == water
            and max(loop_plan.values[name]) > 0 for name, axis in ((n, cfg['loops'][n]) for n in ('inner', 'outer')))
    preserved_route = (copy.deepcopy(cfg.get('points', [])), cfg.get('cycles', 1)) if loop_plan else None
    preserved_loops = copy.deepcopy(cfg.get('loops'))
    cfg = execution_config(cfg, loop_plan, fill_missing=False)
    points = cfg.get("points")
    require(isinstance(points, list) and 0 < len(points) <= 10000, "SIMULATION_INPUT", "error.simulationInput", "温压点数量须在 1–10000 之间")
    for i, p in enumerate(points):
        require(isinstance(p, dict), "SIMULATION_INPUT", "error.simulationInput", f"温压点 {i+1} 无效")
        p["temperature_c"] = number(p.get("temperature_c"), f"第 {i+1} 点温度", -273.149999)
        require(p.get("pressure_mode", "fixed") in ("fixed", "water_saturation"), "SIMULATION_INPUT", "error.simulationInput", "请选择指定压力或纯水饱和蒸汽压")
        p["pressure_bar"] = number(p.get("pressure_bar"), f"第 {i+1} 点压力", 1e-9)
        p["label"] = str(p.get("label") or f"P{i+1}")[:100]
    cycles = cfg.get("cycles", 1)
    number(cycles, "循环次数", 1, 10000)
    require(int(cycles) == cycles, "SIMULATION_INPUT", "error.simulationInput", "循环次数必须是整数")
    cfg["cycles"] = int(cycles)
    require(len(points) * cfg["cycles"] <= 20000 and len(points) * cfg["cycles"] * len(selected) <= 2000000,
            "SIMULATION_INPUT", "error.simulationInput", "本次计算超过 20,000 个平衡点或 2,000,000 条物种结果，请缩小点集")
    for i, p in enumerate(points):
        for key in ("temperature_increment_c", "pressure_increment_bar"):
            p[key] = number(p.get(key, 0), key)
        require(p.get("pressure_mode") != "water_saturation" or p["pressure_increment_bar"] == 0,
                "SIMULATION_INPUT", "error.simulationInput", "饱和蒸汽压随温度自动变化，不可同时设置每轮压力增量")
        conditions = p.get("round_conditions", [])
        require(isinstance(conditions, list) and len(conditions) <= 10000,
                "SIMULATION_INPUT", "error.simulationInput", "指定轮次温压须为列表，最多 10,000 轮")
        seen_rounds = set()
        for condition in conditions:
            require(isinstance(condition, dict) and type(condition.get("round")) is int and 1 <= condition["round"] <= 10000,
                    "SIMULATION_INPUT", "error.simulationInput", "指定轮次须为 1–10,000 之间的整数")
            require(condition["round"] not in seen_rounds, "SIMULATION_INPUT", "error.simulationInput", f"第 {i+1} 点的第 {condition['round']} 轮温压重复")
            seen_rounds.add(condition["round"])
            condition["temperature_c"] = number(condition.get("temperature_c"), "指定轮次温度", -273.149999)
            condition["pressure_bar"] = number(condition.get("pressure_bar"), "指定轮次压力", 1e-9)
            require(condition.get("pressure_mode", "fixed") in ("fixed", "water_saturation"),
                    "SIMULATION_INPUT", "error.simulationInput", "指定轮次请选择指定压力或纯水饱和蒸汽压")
        # Check every active round, plus saved overrides outside the active run.
        # Checking only endpoints misses a changed middle round or a masked endpoint.
        for cycle in sorted(set(range(cfg["cycles"])) | {n - 1 for n in seen_rounds}):
            if hasattr(loop_plan, 'active') and not loop_plan.active(cycle, i): continue
            actual = loop_plan.point(cycle, i) if loop_plan else actual_point(p, cycle)
            require(all(math.isfinite(actual[k]) for k in ("temperature_c", "pressure_bar")) and actual["temperature_c"] > -273.15 and actual["pressure_bar"] > 0,
                    "SIMULATION_INPUT", "error.simulationInput", f"第 {i+1} 点在第 {cycle+1} 轮超出有效温压范围")
    groups = {phase: [n for n in selected if available[n]["phase"] == phase] for phase in ("aqueous", "mineral", "gas")}
    validate_constraints(cfg, records, loop_plan)
    validate_process(cfg, groups)
    validate_material_bases(cfg, groups, loop_plan)
    require(not aqueous_selected or varied_water or any(row["species"] == water and not missing_amount(row["amount"]) and row["amount"] > 0 for material in materials for row in material["inputs"]), "SIMULATION_INPUT", "error.simulationInput", "请在物质配方中添加正量的水溶剂")
    for key, default in (("bootstrap", True), ("allow_database_defaults", False), ("allow_recorded_assignments", False)):
        cfg.setdefault(key, default)
        require(isinstance(cfg[key], bool), "SIMULATION_INPUT", "error.simulationInput", f"{key} 必须是布尔值")
    cfg["balance_tolerance_mol"] = number(cfg.get("balance_tolerance_mol", 1e-10), "守恒误差限值", 1e-14, 1e-5)
    overrides = cfg.setdefault("ion_size_overrides", {})
    require(isinstance(overrides, dict), "SIMULATION_INPUT", "error.simulationInput", "离子尺寸覆盖值无效")
    for name, param in overrides.items():
        require(name in selected and available[name]["phase"] == "aqueous" and available[name]["charge"] != 0,
                "SIMULATION_INPUT", "error.simulationInput", f"离子尺寸覆盖项不属于所选带电水相：{name}")
        require(isinstance(param, dict), "SIMULATION_INPUT", "error.simulationInput", f"{name} 离子尺寸无效")
        param["a_angstrom"] = number(param.get("a_angstrom"), f"{name} aᵢ", 1e-9)
        require(bool(str(param.get("source", "")).strip()) and bool(str(param.get("reason", "")).strip()),
                "SIMULATION_INPUT", "error.simulationInput", f"{name} 的离子尺寸需填写来源及使用理由")
    audit = []
    if cfg["activity_model"] == "nacl_edh" and aqueous_selected:
        for name in selected:
            item = available[name]
            if item["phase"] != "aqueous" or not item["charge"]:
                continue
            param = ({**overrides[name], "is_default": False, "resolution": "本次模拟显式覆盖"}
                     if name in overrides else item["ion_size"])
            require(param is not None, "ION_SIZE_MISSING", "error.simulationInput", f"{name} 缺少离子尺寸，请在数据库或本次模拟中填写有来源的 aᵢ")
            number(param.get("a_angstrom"), f"{name} aᵢ", 1e-9)
            documented_assignment = bool(str(param.get("reason", "")).strip()) and name not in overrides
            require(bool(str(param.get("source", "")).strip()) or (documented_assignment and cfg["allow_recorded_assignments"]),
                    "ION_SIZE_SOURCE", "error.simulationInput", f"{name} 的离子尺寸未提供文献来源；若要沿用数据库已说明理由的现有赋值，请在高级设置中明确允许")
            require(not param.get("is_default") or cfg["allow_database_defaults"], "ION_SIZE_DEFAULT", "error.simulationInput", f"{name} 使用数据库明确保存的默认值，请勾选允许默认记录或填写有来源的覆盖值")
            audit.append({"species": name, **param, "documented_assignment_without_reference": not bool(str(param.get("source", "")).strip())})
        require(all(actual_point(p, cycle)["temperature_c"] + 273.15 > 228 for p in points for cycle in range(cfg["cycles"])), "SIMULATION_INPUT", "error.simulationInput", "当前 NaCl bγ 方程需要 T > 228 K")
    if preserved_route is not None:
        cfg['points'], cfg['cycles'] = preserved_route
    if cfg.get('schedule'):
        if preserved_loops is None:
            cfg.pop('loops', None)
        else:
            cfg['loops'] = preserved_loops
    return cfg, audit


def required_records(records, selected):
    """Thermodynamic dependencies are loaded, but are not added to phases."""
    from .service import _closure
    index = {}
    for row in records:
        if not row.get("disabled"):
            index.setdefault(row["name"], []).append(row)
    seeds = [index[name][0] for name in selected]
    result, missing, cycles = _closure(index, seeds)
    require(not missing and not cycles, "SIMULATION_DEPENDENCY", "error.simulationInput", f"标准态依赖不完整或有歧义：{missing or cycles}")
    return result


class Simulation:
    def __init__(self, snapshot, progress=lambda **kwargs: None):
        import reaktoro as r
        import numpy as np
        from .loader import build_database
        from .activity_nacl import NaClActivity
        self.r, self.np, self.progress = r, np, progress
        self.cfg, self.audit = normalize_config(snapshot["config"], snapshot["records"], snapshot["source"])
        self.original_config = copy.deepcopy(self.cfg)
        self.loop_plan = LoopPlan(self.cfg) if self.cfg.get('schedule') or self.cfg.get('loops') else None
        self.cfg = execution_config(self.cfg, self.loop_plan)
        self.source = snapshot["source"]
        self.records = {x["name"]: x for x in snapshot["records"]}
        cfg = self.cfg
        if cfg.get("equilibrium_constraints"):
            for index, point in enumerate(cfg["points"]):
                point["_inner"] = index
        from .simulation_constraints import reference_species, ConstraintEngine
        database_species = list(dict.fromkeys([*cfg["species"], *reference_species(cfg)]))
        if self.source["kind"] == "official":
            from .service import _database, official_record
            self.database = _database(self.source["group"], self.source["name"])
            for name in database_species:
                live = official_record(self.database.species(name), self.source["group"], self.source["name"])
                expected = self.records[name].get("provenance", {}).get("source_fingerprint")
                require(live["provenance"]["source_fingerprint"] == expected, "NATIVE_SOURCE_CHANGED", "error.simulationInput", f"运行时物种数据已改变：{name}")
        else:
            self.database = build_database(required_records(snapshot["records"], database_species),
                                           runtime_version=self.source.get("required_reaktoro_version"), enforce_declared_ranges=False)
        self.groups = {phase: [name for name in cfg["species"] if phase_of(self.records[name]) == phase]
                       for phase in ("aqueous", "mineral", "gas")}
        self.mobile = self.groups["aqueous"] + self.groups["gas"]
        self.water = cfg["water_species"]
        self.dynamic = None
        aqueous = r.AqueousPhase(r.StringList(self.groups["aqueous"])) if self.groups["aqueous"] else None
        model = cfg["activity_model"]
        if aqueous is None:
            pass
        elif model == "nacl_edh":
            sizes = {x["species"]: x["a_angstrom"] for x in self.audit}
            self.dynamic = NaClActivity(self.groups["aqueous"],
                [float(self.database.species(x).charge()) for x in self.groups["aqueous"]],
                [sizes.get(x, 0) for x in self.groups["aqueous"]], self.water)
            for point in (actual_point(pt, cycle) for cycle in range(cfg["cycles"]) for pt in cfg["points"]):
                t, p = point["temperature_c"], point["pressure_bar"]
                self.dynamic.activate(t, p)
            aqueous.setActivityModel(self.dynamic.generator)
        elif model == "phreeqc":
            aqueous.setActivityModel(r.ActivityModelPhreeqc(self.database))
        else:
            aqueous.setActivityModel({"hkf": r.ActivityModelHKF, "davies": r.ActivityModelDavies,
                                      "ideal": r.ActivityModelIdealAqueous}[model]())
        phases = [aqueous] if aqueous is not None else []
        if self.groups["gas"]:
            gas = r.GaseousPhase(r.StringList(self.groups["gas"]))
            gas.setActivityModel(r.ActivityModelIdealGas() if cfg["gas_model"] == "ideal" else r.ActivityModelPengRobinson())
            phases.append(gas)
        if self.groups["mineral"]:
            phases.append(r.MineralPhases(r.StringList(self.groups["mineral"])))
        self.system = r.ChemicalSystem(self.database, *phases)
        self.specs = r.EquilibriumSpecs(self.system)
        self.specs.temperature()
        self.specs.pressure()
        self.solver = r.EquilibriumSolver(self.specs)
        options = r.EquilibriumOptions()
        options.epsilon = 1e-30
        self.solver.setOptions(options)
        self.names = [str(x.name()) for x in self.system.species()]
        self.indices = {n: i for i, n in enumerate(self.names)}
        self.formula = np.vstack([np.asarray(self.system.formulaMatrixElements(), dtype=float),
                                  np.asarray(self.system.formulaMatrixCharge(), dtype=float).reshape(1, -1)])
        self.components = [str(x.symbol()) for x in self.system.elements()] + ["charge"]
        self.materials = {}
        for material in cfg["materials"]:
            amounts = {}
            for row in material["inputs"]:
                n, amount = row["species"], row["amount"]
                if row["unit"] != "mol":
                    amount *= (1e-3 if row["unit"] == "g" else 1) / float(self.database.species(n).molarMass())
                amounts[n] = amount
            self.materials[material["id"]] = amounts
        self.tolerance = cfg["balance_tolerance_mol"]
        self.process_balance = []
        self.warnings = set()
        self.constraints = ConstraintEngine(self)

    def vector(self, amounts):
        return self.np.array([amounts.get(n, 0) for n in self.names], dtype=float)

    def component_amounts(self, amounts):
        return self.formula @ self.vector(amounts)

    def state(self, amounts, point):
        state = self.r.ChemicalState(self.system)
        state.setSpeciesAmounts(0.0)
        state.temperature(point["temperature_c"], "celsius")
        state.pressure(point["pressure_bar"], "bar")
        for name, amount in amounts.items():
            state.set(name, amount, "mol")
        return state

    def solve(self, fluid, rock, point, guesses=()):
        amounts = {**fluid, **rock}
        require(not self.water or amounts.get(self.water, 0) > 0, "WATER_INPUT", "error.simulationInput", "此点没有正量水溶剂；请检查物料来源及首次来源")
        require(any(v > 0 for v in amounts.values()), "EMPTY_INPUT", "error.simulationInput", "此点没有接收到物质")
        target = self.state(amounts, point)
        target_components = self.component_amounts(amounts)
        require(abs(target_components[-1]) <= self.tolerance, "INPUT_CHARGE", "error.simulationInput", f"本次汇合物料净电荷为 {target_components[-1]:.3e} mol；当前计算要求总输入电中性，请调整此处加入的物种及用量。各份配方不必单独中性")
        if self.dynamic:
            self.dynamic.activate(point["temperature_c"], point["pressure_bar"])
        specs, solver, active_constraints = self.constraints.prepare(point)
        self.constraints.validate_input(target_components, active_constraints)
        conditions = self.r.EquilibriumConditions(specs)
        conditions.setInitialComponentAmountsFromState(target)
        conditions.temperature(point["temperature_c"], "celsius")
        conditions.pressure(point["pressure_bar"], "bar")
        self.constraints.set_conditions(conditions, active_constraints)
        diagnostics = []
        for guess in [*guesses, None]:
            work = (guess if guess is not None else target).clone()
            work.setSpeciesAmounts(self.np.maximum(self.np.asarray(work.speciesAmounts(), dtype=float), 1e-30))
            work.temperature(point["temperature_c"], "celsius")
            work.pressure(point["pressure_bar"], "bar")
            try:
                result = solver.solve(work, conditions)
                if not result.succeeded():
                    directions = [row["titrant"] for row, _ in active_constraints if row["kind"] == "ph" and row["exchange"] == "add_only"]
                    diagnostics.append("求解器未收敛" + ("；当前仅允许加入 " + "、".join(directions) + "，请检查目标能否通过该物质达到" if directions else ""))
                    continue
            except Exception as exc:
                diagnostics.append(str(exc))
                continue
            values = self.np.asarray(work.speciesAmounts(), dtype=float)
            require(bool(self.np.all(self.np.isfinite(values))) and bool(self.np.all(values >= 0)),
                    "INVALID_EQUILIBRIUM", "error.simulationFailed", "平衡输出包含非有限或负物种量")
            try:
                external_exchange = self.constraints.audit(work, active_constraints)
            except BridgeError as exc:
                diagnostics.append(str(exc))
                continue
            delta = self.formula @ values - target_components - external_exchange
            error = float(self.np.max(self.np.abs(delta)))
            if error <= self.tolerance:
                return work, target_components, delta, "warm" if guess is not None else "cold"
            diagnostics.append(f"守恒误差 {error:.3e} mol 超过 {self.tolerance:.3e}")
        raise BridgeError("EQUILIBRIUM_FAILED", "error.simulationFailed", f"{point['temperature_c']:g} °C / {point['pressure_bar']:g} bar：" + "；".join(diagnostics)[-4000:])

    def bootstrap(self, point, fluid, rock):
        """Same-model continuation is only a numerical guess for full rock."""
        self.progress(stage="bootstrap", message="同一活度模型下逐步加入岩石，建立第一个点的初值")
        state, *_ = self.solve(fluid, {}, point)
        fraction, step, tries = 0.0, 0.1, 0
        while fraction < 1.0-1e-12:
            tries += 1
            require(tries <= 200, "BOOTSTRAP_FAILED", "error.simulationFailed", "岩石初始化超过 200 次尝试")
            trial = min(1.0, fraction+step)
            try:
                candidate, *_ = self.solve(fluid, {n: a*trial for n, a in rock.items()}, point, [state])
            except BridgeError:
                step *= 0.5
                if step < 1e-5:
                    raise
                continue
            state, fraction, step = candidate, trial, min(.25, step*1.5)
            self.progress(stage="bootstrap", message=f"岩石初始化 {fraction:.0%}")
        return state

    @staticmethod
    def safe(fn):
        try:
            value = float(fn())
            return value if math.isfinite(value) else None
        except Exception:
            return None

    def collect(self, work, target, delta, method, fluid, rock, point, cycle, step, run_index):
        props = self.r.ChemicalProps(work)
        try:
            aqueous = self.r.AqueousProps(work)
        except Exception:
            aqueous = None
        water_mass = float(work.speciesAmount(self.water)) * float(self.database.species(self.water).molarMass()) if self.water else None
        require(water_mass is None or water_mass > 0, "WATER_DEPLETED", "error.simulationFailed", "水相溶剂耗尽")
        ionic = sum(.5 * float(work.speciesAmount(n))/water_mass * float(self.database.species(n).charge())**2
                    for n in self.groups["aqueous"] if n != self.water) if self.water else None
        coordinates = self.loop_plan.common(cycle-1, step-1) if getattr(self, 'loop_plan', None) else {}
        common = {**coordinates, "run_index": run_index, "pass": cycle, "step": step, "point_id": point["id"], "point_label": point["label"],
                  "temperature_c": point["temperature_c"], "pressure_bar": point["pressure_bar"]}
        summary = {**common, "pH": self.safe(lambda: aqueous.pH()), "Eh_V": self.safe(lambda: aqueous.Eh()),
                   "ionic_strength_molal": ionic, "water_activity": self.safe(lambda: props.speciesActivity(self.water)),
                   "water_mass_kg": water_mass, "max_component_balance_error_mol": float(self.np.max(self.np.abs(delta))),
                   "initial_guess": method}
        if self.dynamic:
            summary.update(self.dynamic.activate(point["temperature_c"], point["pressure_bar"]))
            ions = {}
            for element, charge in (("Na", 1), ("Cl", -1)):
                ions[element] = sum(float(work.speciesAmount(n))/water_mass for n in self.groups["aqueous"]
                    if self.records[n].get("composition") == {element: 1} and self.records[n].get("charge") == charge)
            fraction = min(ions.values())/ionic if ionic > 1e-12 else None
            summary["paired_nacl_ionic_strength_fraction"] = fraction
        rows = []
        inlet = {**fluid, **rock}
        for phase, names in self.groups.items():
            for name in names:
                amount = float(work.speciesAmount(name))
                rows.append({**common, "species": name, "formula": self.records[name].get("formula", ""), "phase_type": phase,
                    "inlet_amount_mol": inlet.get(name, 0), "amount_mol": amount,
                    "delta_amount_mol": amount-inlet.get(name, 0),
                    "molality": amount/water_mass if phase == "aqueous" and name != self.water else None,
                    "activity": self.safe(lambda: props.speciesActivity(name)),
                    "activity_coefficient": self.safe(lambda: props.speciesActivityCoefficient(name))})
        output_components = self.formula @ self.np.asarray(work.speciesAmounts(), dtype=float)
        balances = [{**common, "component": n, "input_mol": float(v), "output_mol": float(output_components[i]), "error_mol": float(d),
                     **({"external_exchange_mol": float(self.constraints.exchange[i])} if self.constraints.rows else {})}
                    for i, (n, v, d) in enumerate(zip(self.components, target, delta))]
        constraints = self.constraints.collect(summary)
        return {"summary": summary, "species": rows, "balances": balances, **({"constraints": [{**common, **row} for row in constraints]} if self.constraints.rows else {})}

    def run(self, emit):
        cfg = self.cfg
        inventory = ProcessInventory(self)
        run_index = 0
        for cycle in range(cfg["cycles"]):
            neighbour = None
            for i, base in enumerate(cfg["points"]):
                if hasattr(self.loop_plan, 'active') and not self.loop_plan.active(cycle, i): continue
                point = actual_point(base, cycle)
                point.update(_outer=cycle, _inner=i)
                self.progress(stage="solving", current={"pass": cycle+1, "step": i+1, **point},
                              message=f"反应轮次 {cycle+1}/{cfg['cycles']} · {point['label']} ({i+1}/{len(cfg['points'])})")
                amounts, fresh, consumed, transfers = inventory.assemble(cycle, i)
                fluid = {n: v for n, v in amounts.items() if n not in self.groups["mineral"]}
                rock = {n: v for n, v in amounts.items() if n in self.groups["mineral"]}
                guesses = []
                if run_index == 0 and cfg["bootstrap"] and self.water and any(rock.values()):
                    try:
                        guesses.append(self.bootstrap(point, fluid, rock))
                    except BridgeError:
                        # Continuation is an optional guess, not an extra
                        # requirement imposed on the actual assembled input.
                        self.progress(stage="solving", message="渐进初始值未建立，改用实际汇合物料直接求解")
                previous = inventory.outputs.get((cycle-1, i))
                old_temperature = (inventory.loops.point(cycle-1, i) if inventory.loops else actual_point(base, cycle-1))["temperature_c"] if previous else None
                prior = (old_temperature, self.state(previous, point)) if previous and old_temperature == point["temperature_c"] else None
                for entry in (prior, neighbour):
                    if entry is not None and entry[0] == point["temperature_c"]:
                        guesses.append(entry[1])
                work, target, delta, method = self.solve(fluid, rock, point, guesses)
                record = self.collect(work, target, delta, method, fluid, rock, point, cycle+1, i+1, run_index)
                output = {n: float(work.speciesAmount(n)) for n in self.names}
                ledger = inventory.commit(cycle, i, output, fresh, consumed, self.constraints.exchange)
                record["transfers"] = transfers
                record["process_balance"] = ledger
                self.process_balance = ledger  # Latest cumulative balance, also streamed per point.
                emit(record)
                run_index += 1
                neighbour = (point["temperature_c"], work)
                self.progress(completed=run_index, warnings=sorted(self.warnings))
            inventory.finish_cycle(cycle)
        loop_metadata = {'loop_axes': inventory.loops.metadata(), 'field_info': inventory.loops.field_info()} if inventory.loops else {}
        from .simulation_constraints import field_info
        loop_metadata["field_info"] = {**loop_metadata.get("field_info", {}), **field_info(cfg)}
        return {**loop_metadata, "config": getattr(self, 'original_config', cfg), "ion_size_audit": self.audit, "process_balance": self.process_balance,
                "warnings": sorted(self.warnings), "dynamic_parameter_evaluations": len(self.dynamic.cache) if self.dynamic else 0,
                "species_count": len(self.names), "runtime_version": self.r.__version__,
                "method": "Sequential constrained Gibbs-energy minimization with explicitly allocated material flows",
                "inventory_definition": "All untransferred output remains in the process inventory; transfers consume fractions of original output."}
