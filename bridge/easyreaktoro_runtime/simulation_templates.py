"""Read declarative Notebook settings; never import or execute Notebook code."""
from __future__ import annotations
import ast
import hashlib
import json
import math
from pathlib import Path

from .errors import require


def static_value(node, values, depth=0):
    if depth > 30:
        raise ValueError("表达式嵌套过深")
    read = lambda n, v=values: static_value(n, v, depth+1)
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool, type(None))):
        return node.value
    if isinstance(node, ast.Name) and node.id in values:
        return values[node.id]
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [read(n) for n in node.elts]
    if isinstance(node, ast.Dict):
        result = {}
        for k, v in zip(node.keys, node.values):
            try:
                result[read(k)] = read(v)
            except (ValueError, KeyError, TypeError):
                continue
        return result
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        x = read(node.operand)
        if not isinstance(x, (int, float)):
            raise ValueError("只允许数值运算")
        return -x if isinstance(node.op, ast.USub) else x
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
        a, b = read(node.left), read(node.right)
        if not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or abs(a) > 1e12 or abs(b) > 1e12:
            raise ValueError("只允许有界数值运算")
        if isinstance(node.op, ast.Pow) and abs(b) > 20:
            raise ValueError("幂次过大")
        value = {ast.Add: lambda: a+b, ast.Sub: lambda: a-b, ast.Mult: lambda: a*b,
                 ast.Div: lambda: a/b, ast.Pow: lambda: a**b}[type(node.op)]()
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("数值无效")
        return value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(str(v.value))
            elif isinstance(v, ast.FormattedValue):
                spec = read(v.format_spec) if v.format_spec else ""
                if spec not in {"", "g", ".0f", ".1f", ".2f"}:
                    raise ValueError("格式不支持")
                parts.append(format(read(v.value), spec))
        return "".join(parts)
    if isinstance(node, ast.ListComp) and len(node.generators) == 1:
        gen = node.generators[0]
        if not isinstance(gen.target, ast.Name) or gen.ifs or gen.is_async:
            raise ValueError("列表推导不支持")
        rows = read(gen.iter)
        if not isinstance(rows, list) or len(rows) > 10000:
            raise ValueError("点集过大")
        return [read(node.elt, {**values, gen.target.id: item}) for item in rows]
    if isinstance(node, ast.Call):
        name = ast.unparse(node.func)
        if name == "os.environ.get" and len(node.args) == 2:
            return read(node.args[1])
        if name == "float" and len(node.args) == 1:
            return float(read(node.args[0]))
        if name in {"np.array", "np.asarray"} and len(node.args) == 1:
            return read(node.args[0])
        if name in {"np.arange", "np.linspace"} and 2 <= len(node.args) <= 3 and not node.keywords:
            args = [float(read(n)) for n in node.args]
            if not all(math.isfinite(x) for x in args):
                raise ValueError("网格非有限")
            start, end = args[:2]
            step = args[2] if len(args) == 3 else 1.0
            if name == "np.linspace":
                count = int(step) if len(args) == 3 else 50
                if count != (step if len(args) == 3 else 50) or not 1 <= count <= 10000:
                    raise ValueError("网格过大")
                return [start + (end-start)*i/max(1, count-1) for i in range(count)]
            if step == 0 or (end-start)/step < 0:
                raise ValueError("步长方向不匹配")
            count = math.ceil((end-start)/step)
            if not 0 <= count <= 10000:
                raise ValueError("网格过大")
            return [start+i*step for i in range(count)]
    raise ValueError("不是支持的静态设置表达式")


def load_settings(path, size="preview"):
    source = Path(path).expanduser().resolve()
    require(source.suffix.lower() in {".ipynb", ".json"}, "SIMULATION_FILE", "error.simulationInput", "请选择 .ipynb 或模拟设置 .json")
    require(source.stat().st_size <= 25*1024*1024, "SIMULATION_FILE", "error.simulationInput", "设置文件不能超过 25 MiB")
    payload = json.loads(source.read_text())
    if source.suffix.lower() == ".json":
        require(isinstance(payload, dict) and payload.get("format") == "easyreaktoro-simulation" and payload.get("schema_version") in (1, 2),
                "SIMULATION_FILE", "error.simulationInput", "文件不是受支持的 EasyReaktoro 模拟设置")
        from .simulation_reactions import normalize_reaction_stages
        require(isinstance(payload.get("config"), dict), "SIMULATION_FILE", "error.simulationInput", "模拟设置须包含有效配置")
        normalize_reaction_stages(payload["config"])
        editor = payload.get("code_editor")
        if isinstance(editor, dict) and isinstance(editor.get("config"), dict):
            normalize_reaction_stages(editor["config"])
        return {"config": payload["config"], "code_editor": editor, "notices": [], "database": payload.get("database")}
    require(size in {"preview", "full"}, "SIMULATION_FILE", "error.simulationInput", "模板规模无效")
    values = {}
    for cell in payload.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        try:
            nodes = ast.parse("".join(cell.get("source", []))).body
        except SyntaxError:
            continue
        for node in nodes:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                if name.isupper():
                    try:
                        values[name] = static_value(node.value, values)
                    except (ValueError, TypeError, KeyError, ZeroDivisionError, OverflowError):
                        pass
    aqueous = values.get("AQUEOUS_SPECIES", [])
    require(isinstance(aqueous, list) and bool(aqueous), "SIMULATION_FILE", "error.simulationInput", "未找到静态 AQUEOUS_SPECIES 名单；请保存为模拟设置 JSON 或在界面选择")
    config = {"name": values.get("RUN_NAME", source.stem), "mode": "closed_path", "species": aqueous + values.get("MINERAL_SPECIES", []) + values.get("GAS_SPECIES", []),
              "activity_model": "nacl_edh", "gas_model": values.get("GAS_ACTIVITY_MODEL") or "ideal",
              "water_species": values.get("WATER_SPECIES", ""), "inputs": [], "points": [], "passes": 1,
              "solid_distribution": values.get("SOLID_DISTRIBUTION", "per_point"), "bootstrap": True,
              "allow_database_defaults": values.get("ALLOW_DATABASE_DEFAULT_ION_SIZE", True),
              "allow_recorded_assignments": True,
              "allow_non_nacl": values.get("ALLOW_NON_NACL_DOMINANT_BACKGROUND", False),
              "allow_unsupported_water": values.get("ALLOW_UNSUPPORTED_WATER_STATE", False),
              "ion_size_overrides": values.get("ION_SIZE_OVERRIDES", {}), "balance_tolerance_mol": 1e-10}
    pressures = values.get(f"PRESSURES_{size.upper()}_BAR", [])
    temp = values.get("TEMPERATURE_C", 350.0)
    if "COMPOSITION2_FLUID_G" in values:
        config["mode"] = "repeated_flushing"
        config["inputs"] = [{"species": n, "amount": a, "unit": "g"} for k in ("COMPOSITION2_FLUID_G", "COMPOSITION1_ROCK_G") for n, a in values[k].items()]
        config["passes"] = values.get("N_PREVIEW_PASSES" if size == "preview" else "N_FLUID_PASSES", 1)
        config["points"] = [{"label": f"P{p:g}", "temperature_c": temp, "pressure_bar": p} for p in pressures]
    elif "FLUID_INPUT" in values:
        config["mode"] = values.get("SIMULATION_MODE", "independent_points")
        config["inputs"] = [{"species": n, "amount": a, "unit": u} for k in ("FLUID_INPUT", "SOLID_INPUT") for n, a, u in values.get(k, [])]
        config["passes"] = values.get("FLUID_PASSES", {}).get(size, 1)
        config["points"] = [{"label": n, "temperature_c": t, "pressure_bar": p} for n, t, p in values.get("POINT_SETS", {}).get(size, [])]
    elif "WATER_KG" in values:
        # Basic template exposes material names separately from their amounts.
        config["inputs"] = [{"species": next((n for n in aqueous if n == "H2O(l)"), ""), "amount": values["WATER_KG"], "unit": "kg"}]
        for key in ("AUHS", "NACL", "H2S"):
            require(f"INPUT_{key}" in values and f"{key}_MOL" in values, "SIMULATION_FILE", "error.simulationInput", f"模板缺少 INPUT_{key} 或 {key}_MOL")
            config["inputs"].append({"species": values[f"INPUT_{key}"], "amount": values[f"{key}_MOL"], "unit": "mol"})
        temperatures = values.get(f"TEMPERATURES_{size.upper()}_C", [temp])
        config["points"] = [{"label": f"T{t:g}-P{p:g}", "temperature_c": t, "pressure_bar": p} for t in temperatures for p in pressures]
    require(bool(config["points"]) and bool(config["inputs"]), "SIMULATION_FILE", "error.simulationInput", "未能完整读取投料和温压设置；不会执行 Notebook 来猜测配置")
    if config["mode"] == "single_point":
        config["points"] = config["points"][:1]
    config["template_source"] = {"filename": source.name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "size": size}
    return {"config": config, "notices": [f"已读取{('预览' if size == 'preview' else '完整')}点集和投料；运行前可在界面修改。Notebook 中的代码、输出及自定义方程未执行。水相采用界面明确显示的模板 NaCl 活度模型。"]}
