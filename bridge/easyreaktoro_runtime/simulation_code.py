"""UI-synchronized parameters and executable notebook cells; validation never executes."""
from __future__ import annotations

import ast
import copy
import json
import math
import operator
import pprint

CELLS = (
    ("system", "系统物种", "定义允许参与平衡的物种；是否投料在下一模块设置。",
     ("species", "water_species"),
     '# water_species = None identifies the unique water solvent among the selected species.'),
    ("materials", "初始物质", "每份配方有固定 id；amount 是数量，unit 支持 mol、g、kg。",
     ("materials",),
     '# In inputs, specify species names, amounts and units; each species must belong to the system.\n# amount=None retains an unset base amount. Fill it only where a material input actually uses that base amount.'),
    ("conditions", "反应路径与条件", "沿路径依次反应，完成后开始下一轮；按设置更新条件与投料量。",
     ("schedule", "loops", "points", "cycles", "equilibrium_constraints"),
     '# loops: base defines initial T/P; inner/outer support repeat(count), range(start,end,step) or list(values).\n# target.kind: temperature / pressure / material_amount(material_id,species) / route_fraction(route_id,field).\n# Values override the target parameter; composition amounts retain input-row units; fraction field is fraction or fallback_fraction.\n# loops.round_conditions sets pressure_mode and optional pressure_bar for a specific round, overriding pressure variation without changing temperature.\n# pressure_mode: fixed specifies pressure; water_saturation uses pure-water saturation pressure at the actual temperature (0.01 <= T < 373.946 degC).\n# loops=None uses the retained points/cycles below; an active loops definition does not run the old point table.\n# Legacy points: temperature_increment_c / pressure_increment_bar are per-round increments; round_conditions sets absolute T/P for a round.'),
    ("transfers", "反应物料", "四类位置独立选择反应物料；执行顺序本身不会转移任何物质。",
     ("reaction_stages", "routes"),
     '# reaction_stages: first_start = first round/start; first_following = first round/later positions; later_start = later rounds/start; later_following = later rounds/later positions.\n# Each position type uses its own source list. No other composition or legacy routes are added automatically; [] supplies no material.\n# source: material = new composition; previous_point = previous position in this round; previous_cycle = previous round at the same position; output = specified position.\n# phase: all / aqueous / mineral / gas / species; fraction is composition portions or the fraction of an existing output (0.5 = 50%).\n# fallback initializes a legacy source when its previous output does not yet exist; reaction_stages=None uses the retained routes.'),
    ("activity", "活度与气相模型", "模型与离子尺寸使用当前配置；覆盖值仅作用于本次模拟。",
     ("activity_model", "gas_model", "ion_size_overrides", "allow_database_defaults",
      "allow_recorded_assignments"),
     '# activity_model: nacl_edh / davies / hkf / phreeqc / ideal\n# gas_model: ideal / peng_robinson; use True / False for booleans.'),
    ("solver", "求解设置", "渐进初始化只改善初值；每点始终使用实际物料约束。",
     ("bootstrap", "balance_tolerance_mol"),
     '# balance_tolerance_mol: allowed absolute component-balance error, in mol.'),
)
CELL_FIELDS = {cell[0]: cell[3] for cell in CELLS}
# Read older parameter cells without continuing to advertise obsolete switches.
LEGACY_FIELDS = {"activity": {"allow_non_nacl", "allow_unsupported_water"}}
MAX_TEXT = 2_000_000
MAX_NODES = 400_000


class CodeProblem(ValueError):
    def __init__(self, message, node=None):
        super().__init__(message)
        self.node = node


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def literal(node, depth=0):
    if depth > 24:
        raise CodeProblem("参数嵌套超过 24 层。", node)
    read = lambda item: literal(item, depth + 1)
    if isinstance(node, ast.Constant):
        value = node.value
        if value is None or type(value) in (str, bool):
            return value
        if type(value) in (int, float):
            try:
                if math.isfinite(value):
                    return value
            except OverflowError:
                pass
        raise CodeProblem("参数必须是有限数值、字符串、布尔值或 None。", node)
    if isinstance(node, (ast.List, ast.Tuple)):
        return [read(item) for item in node.elts]
    if isinstance(node, ast.Dict):
        result = {}
        for key_node, value_node in zip(node.keys, node.values):
            if key_node is None:
                raise CodeProblem("请显式填写字典字段，不使用 ** 展开。", node)
            key = read(key_node)
            if not isinstance(key, str):
                raise CodeProblem("字典字段名称必须是字符串。", key_node)
            if key in result:
                raise CodeProblem(f"字典字段 {key!r} 重复，无法确定应采用哪一个。", key_node)
            result[key] = read(value_node)
        return result
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = read(node.operand)
        if not finite_number(value):
            raise CodeProblem("正负号只能用于数值。", node)
        return -value if isinstance(node.op, ast.USub) else value
    operations = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
                  ast.Div: operator.truediv, ast.Pow: operator.pow}
    if isinstance(node, ast.BinOp) and type(node.op) in operations:
        left, right = read(node.left), read(node.right)
        if not finite_number(left) or not finite_number(right) or abs(left) > 1e100 or abs(right) > 1e100:
            raise CodeProblem("数值表达式的操作数必须有限且绝对值不超过 1e100。", node)
        if isinstance(node.op, ast.Pow) and abs(right) > 20:
            raise CodeProblem("幂次的绝对值不能超过 20。", node)
        try:
            value = operations[type(node.op)](left, right)
            if not finite_number(value) or abs(value) > 1e100:
                raise ValueError()
            return value
        except (ArithmeticError, ValueError, TypeError):
            raise CodeProblem("该数值表达式无效、除以零或超出数值范围。", node) from None
    raise CodeProblem("这里支持参数值、列表、字典和数值四则运算；函数调用、循环和自定义程序不能同步到图形界面。", node)


def displayed_parameter(key, value):
    if key != 'materials' or not isinstance(value, list):
        return value
    from .simulation_schedule import missing_amount
    result = copy.deepcopy(value)
    for material in result:
        for row in material.get('inputs', []):
            if missing_amount(row.get('amount')):
                row['amount'] = None
    return result


def parameter_source(config, fields, comment, ordered_stages=True):
    assignments = []
    for key in fields:
        value = displayed_parameter(key, config.get(key))
        if key == 'reaction_stages' and ordered_stages and isinstance(value, dict):
            from .simulation_reactions import STAGE_KEYS
            # Display order only; never rearrange the user's configuration.
            value = {**{stage: value[stage] for stage in STAGE_KEYS if stage in value},
                     **{name: rows for name, rows in value.items() if name not in STAGE_KEYS}}
        assignments.append(f"{key} = {pprint.pformat(value, width=88, sort_dicts=False, compact=False)}")
    return comment + "\n\n" + "\n\n".join(assignments) + "\n"


def parameter_comment(cell_id, comment, explicit_stages):
    if explicit_stages:
        if cell_id == 'conditions':
            comment = comment.replace(
                'fraction field is fraction or fallback_fraction.',
                "use field='fraction' for the composition portions or output fraction at this position.")
        elif cell_id == 'transfers':
            comment = comment.replace(
                '# fallback initializes a legacy source when its previous output does not yet exist; reaction_stages=None uses the retained routes.',
                "# when must be 'always'; the four groups already determine the applicable positions.\n# fallback and fallback_fraction retain legacy settings only; they do not add material in explicit reaction_stages.\n# A missing source output stops the calculation; check its source position. material_id selects a composition only for source='material'.\n# reaction_stages=None restores the retained routes and their legacy initialization settings.")
    return comment


def parameter_assignments(source, cell_id):
    """Read parameter text without executing it; None keeps unfinished drafts."""
    try:
        tree = ast.parse(source, mode='exec')
        if sum(1 for _ in ast.walk(tree)) > MAX_NODES:
            return None
        values = {}
        for statement in tree.body:
            if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
                return None
            name = statement.targets[0].id
            if name not in (*CELL_FIELDS[cell_id], *LEGACY_FIELDS.get(cell_id, ())) or name in values:
                return None
            values[name] = literal(statement.value)
        return values
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None


def render_code(config, previous=None):
    # Keep untouched cells verbatim, including comments and the user's formatting.
    old_cells = {c.get("id"): c.get("source") for c in (previous or {}).get("cells", []) if isinstance(c, dict)}
    old_config = (previous or {}).get("config", {})
    cells = []
    for cell_id, title, description, fields, comment in CELLS:
        if cell_id == 'conditions' and config.get('schedule'):
            fields = ('schedule', 'equilibrium_constraints')
            comment = ("# schedule: positions/rounds give fixed counts when stop rules are absent. stop.first/stop.later end each path; stop.rounds ends the model. The triggering reaction is included.\n# With stop rules, actual path lengths may differ between rounds. i and N are zero-based position/round indices.\n# value.mode expression accepts arithmetic, comparisons, min/max/abs/sqrt/ln/log10/exp, list(index,...), and Psat(T).\n# For temperature, T/P refer to the previous step (previous round start at i=0); for pressure, T is the current temperature and P is the previous pressure.\n# For amounts/fractions, T/P are current conditions. Tr/Pr are the previous round at the same position; X/Xr are the previous value of this target.\n# parameters sets general values; overrides defines local ranges.\n# target.kind: temperature / pressure / material_amount(material_id,species) / route_fraction(route_id,field).\n# value.mode: fixed holds a value; linear varies over selected positions/rounds; list uses a sequence; relative continues from the actual neighboring final parameter value.\n# pressure also accepts water_saturation, using pure-water saturation pressure at this point's final temperature.\n# Numeric pressure values specify pressure. Composition amounts retain input-row units; source fractions apply only to the selected material.\n# Local start/end/step use 1-based positions; an omitted end means the current endpoint. linear/list follow selected ordinals; relative follows actual adjacent positions or rounds.\n# Local ranges for the same parameter cannot overlap. Other parameters use general settings; retained loops/points/cycles are inactive in this schedule.")
        elif cell_id == 'conditions' and config.get('loops'):
            fields = ('loops', 'equilibrium_constraints')
            comment = '\n'.join(line for line in comment.splitlines() if not line.startswith(('# loops=None', '# Legacy points')))
        if cell_id == 'transfers' and config.get('reaction_stages') is not None:
            fields = ('reaction_stages',)
        pre_constraints_comment = comment
        if cell_id == "conditions":
            comment += "\n# equilibrium_constraints: kind ph uses neutral titrant formula and exchange add_only/both; fugacity uses a database Gas species and a target in bar.\n# Each constraint has id, value and optional rounds/positions scopes; schedule target equilibrium_constraint(constraint_id) varies its value.\n# Exchange is external and is recorded separately from finite composition inputs; constraints outside their scopes are inactive."
        legacy_comment = comment
        comment = parameter_comment(cell_id, comment, config.get('reaction_stages') is not None)
        unchanged = all(config.get(key) == old_config.get(key) for key in fields)
        source = old_cells.get(cell_id) if unchanged else None
        if isinstance(source, str):
            assigned = parameter_assignments(source, cell_id)
            # A restored editor baseline can already equal the new UI config
            # while its parameter text still describes an older calculation.
            # Keep comments and formatting only when the actual values agree.
            if assigned is not None and any(displayed_parameter(key, assigned.get(key)) != displayed_parameter(key, config.get(key)) for key in fields):
                source = None
        # Upgrade only text identical to the previous generated cell. A user's
        # comments, formatting, parameter edits, and unfinished code stay intact.
        if source is not None and cell_id in ('conditions', 'transfers'):
            old_comment = parameter_comment(cell_id, legacy_comment, old_config.get('reaction_stages') is not None)
            standards = (parameter_source(old_config, fields, legacy_comment, ordered_stages=False),
                         parameter_source(old_config, fields, old_comment),
                         parameter_source(old_config, tuple(key for key in fields if key != "equilibrium_constraints"), pre_constraints_comment, ordered_stages=False))
            if source in standards:
                source = None
        if not isinstance(source, str):
            source = parameter_source(config, fields, comment)
        cells.append({"id": cell_id, "title": title, "description": description, "source": source})
    from .simulation_program import program_cells
    previous_cells = {c.get('id'): c for c in (previous or {}).get('cells', []) if isinstance(c, dict)}
    for cell in program_cells():
        prior = previous_cells.get(cell['id'], {})
        if isinstance(prior.get('source'), str) and prior.get('source') != prior.get('baseline_source'):
            cell['source'] = prior['source']
        cells.append(cell)
    return {"version": 2, "cells": cells}


def validate_editor(editor):
    """Validate the saved envelope, while deliberately accepting unfinished Python."""
    if not isinstance(editor, dict) or editor.get('version') != 1 or editor.get('mode') not in ('ui', 'code'):
        raise ValueError('代码草稿格式无效。')
    def document(value):
        issue = document_issue(value)
        if issue:
            raise ValueError(issue)
    if editor.get('document') is not None:
        document(editor['document'])
    if editor.get('recovery') is not None:
        if not isinstance(editor['recovery'], dict):
            raise ValueError('代码恢复副本格式无效。')
        document(editor['recovery'].get('document'))
    if len(json.dumps(editor, ensure_ascii=False, allow_nan=False)) > 12_000_000:
        raise ValueError('代码草稿过大，请缩小点表后保存。')
    return copy.deepcopy(editor)


def check_parameter(name, value, context=None):
    """Validate the UI-representable shape; chemistry is checked by normal preflight."""
    def require(ok, path, text):
        if not ok:
            raise CodeProblem(f'{path}：{text}')
    def fields(obj, path, required, optional=()):
        require(isinstance(obj, dict), path, '必须是字典')
        require(set(required) <= set(obj), path, '缺少字段 ' + ', '.join(sorted(set(required)-set(obj))))
        require(set(obj) <= set(required) | set(optional), path, '未知字段 ' + ', '.join(sorted(set(obj)-set(required)-set(optional))))
    def number(n, path): require(finite_number(n), path, '必须是有限数值')
    def string(s, path): require(isinstance(s, str), path, '必须是字符串')
    def routes(rows, path, allow_draft=False):
        require(isinstance(rows, list) and len(rows) <= 30, path, '需要列表，最多 30 条来源')
        for i, row in enumerate(rows):
            p = f'{path}[{i}]'
            fields(row, p, ('source','phase','fraction','material_id','fallback','fallback_fraction','when'), ('id','point_id','lag','species'))
            if 'id' in row: string(row['id'],p+'.id')
            for key, options in (('source', ('material','previous_point','previous_cycle','output')), ('phase', ('all','aqueous','mineral','gas','species')), ('fallback', ('material','none','error')), ('when', ('always','first_cycle','after_first_cycle'))):
                require(row[key] in options, p+'.'+key, '可用值为 ' + ', '.join(options))
            for key in ('fraction', 'fallback_fraction'):
                if not (allow_draft and row[key] == {'easyreaktoro_empty_number': True}):
                    number(row[key], p+'.'+key)
            string(row['material_id'], p+'.material_id')
            if row['source'] == 'output':
                require(isinstance(row.get('point_id'), str) and type(row.get('lag')) is int and row['lag'] in (0,1), p, '指定点来源需要 point_id，以及 0 或 1 的 lag')
            if 'species' in row:
                require(isinstance(row['species'], list) and all(isinstance(s, str) for s in row['species']), p+'.species', '必须是物种名称列表')
    if name == 'species':
        require(isinstance(value, list) and len(value) <= 500 and all(isinstance(s, str) for s in value), name, '必须是物种名称列表，最多 500 个')
    elif name == 'materials':
        require(isinstance(value, list) and 1 <= len(value) <= 100, name, '需要 1–100 份配方')
        for i, material in enumerate(value):
            p=f'materials[{i}]';fields(material,p,('id','name','inputs'));string(material['id'],p+'.id');string(material['name'],p+'.name')
            require(isinstance(material['inputs'], list) and len(material['inputs']) <= 500, p+'.inputs', '需要投料列表，最多 500 行')
            for j, row in enumerate(material['inputs']):
                q=f'{p}.inputs[{j}]';fields(row,q,('species','amount','unit'));string(row['species'],q+'.species')
                from .simulation_schedule import missing_amount
                if not missing_amount(row['amount']):
                    number(row['amount'],q+'.amount')
                require(row['unit'] in ('mol','g','kg'),q+'.unit','使用 mol、g 或 kg')
    elif name in ('points', 'cycles', 'loops') and (context or {}).get('schedule'):
        return
    elif name == 'points':
        require(isinstance(value, list) and 1 <= len(value) <= 10000, name, '需要 1–10,000 个点')
        for i, point in enumerate(value):
            p=f'points[{i}]';fields(point,p,('id','temperature_c','pressure_bar'),('label','pressure_mode','temperature_increment_c','pressure_increment_bar','routes','round_conditions'));string(point['id'],p+'.id')
            for k in ('temperature_c','pressure_bar','temperature_increment_c','pressure_increment_bar'):
                if k in point: number(point[k],p+'.'+k)
            if 'pressure_mode' in point: require(point['pressure_mode'] in ('fixed','water_saturation'),p+'.pressure_mode','使用 fixed 或 water_saturation')
            if 'label' in point: string(point['label'],p+'.label')
            if 'routes' in point and not (context or {}).get('reaction_stages'): routes(point['routes'],p+'.routes')
            if 'round_conditions' in point:
                conditions = point['round_conditions']
                require(isinstance(conditions, list) and len(conditions) <= 10000, p+'.round_conditions', '需要指定轮次温压列表，最多 10,000 轮')
                seen = set()
                for j, row in enumerate(conditions):
                    q = f'{p}.round_conditions[{j}]'
                    fields(row,q,('round','temperature_c','pressure_bar'),('pressure_mode',))
                    require(type(row['round']) is int and 1 <= row['round'] <= 10000,q+'.round','使用 1–10,000 之间的整数')
                    require(row['round'] not in seen,q+'.round','同一个点不能重复指定同一轮的温压')
                    seen.add(row['round'])
                    number(row['temperature_c'],q+'.temperature_c');number(row['pressure_bar'],q+'.pressure_bar')
                    if 'pressure_mode' in row: require(row['pressure_mode'] in ('fixed','water_saturation'),q+'.pressure_mode','使用 fixed 或 water_saturation')
    elif name == 'equilibrium_constraints':
        from .simulation_constraints import normalize_constraints
        from .errors import BridgeError
        try:
            checked = copy.deepcopy(context or {})
            checked['equilibrium_constraints'] = value
            normalize_constraints(checked)
        except BridgeError as exc:
            raise CodeProblem(str(exc)) from None
    elif name == 'schedule':
        from .simulation_schedule import normalize_schedule
        from .errors import BridgeError
        try:
            checked = copy.deepcopy(context or {})
            checked['schedule'] = copy.deepcopy(value)
            normalize_schedule(checked, check_references=False)
        except BridgeError as exc:
            raise CodeProblem(str(exc)) from None
    elif name == 'loops':
        from .simulation_loops import normalize_loops
        from .errors import BridgeError
        try:
            normalize_loops({'loops': copy.deepcopy(value), 'routes': [], 'materials': []}, check_references=False)
        except BridgeError as exc:
            raise CodeProblem(str(exc)) from None
    elif name == 'reaction_stages':
        if value is not None:
            from .simulation_reactions import normalize_reaction_stages
            from .errors import BridgeError
            try:
                normalize_reaction_stages({'reaction_stages': copy.deepcopy(value)})
            except BridgeError as exc:
                raise CodeProblem(str(exc)) from None
            from .simulation_reactions import active_reaction_stages, STAGE_KEYS
            from .simulation_loops import execution_shape
            try:
                active = active_reaction_stages(*execution_shape(context or {}))
            except (BridgeError, KeyError, TypeError, ValueError):
                active = STAGE_KEYS
            for stage, rows in value.items():
                routes(rows, name+'.'+stage, allow_draft=stage not in active)
    elif name == 'routes' and not (context or {}).get('reaction_stages'): routes(value, name)
    elif name == 'cycles': require(type(value) is int and value >= 1, name, '必须是大于等于 1 的整数')
    elif name == 'balance_tolerance_mol': require(finite_number(value) and value > 0, name, '必须是大于零的有限数值')
    elif name == 'ion_size_overrides':
        require(isinstance(value, dict), name, '必须是字典')
        for species, param in value.items():
            p=f'{name}[{species!r}]';fields(param,p,('a_angstrom','source','reason'),('is_default','resolution'));number(param['a_angstrom'],p+'.a_angstrom');string(param['source'],p+'.source');string(param['reason'],p+'.reason')
    elif name in ('activity_model','gas_model'):
        options=('nacl_edh','phreeqc','hkf','davies','ideal') if name == 'activity_model' else ('ideal','peng_robinson')
        require(value in options,name,'可用值为 '+', '.join(options))


def document_issue(document):
    from .simulation_program import PROGRAM_IDS
    if not isinstance(document, dict) or document.get('version') not in (1, 2):
        return '代码文档格式不支持。'
    expected = list(CELL_FIELDS) + (list(PROGRAM_IDS) if document['version'] == 2 else [])
    cells = document.get('cells')
    if (not isinstance(cells, list) or len(cells) != len(expected)
            or any(not isinstance(c, dict) or not all(isinstance(c.get(k), str) for k in ('id', 'title', 'description', 'source')) or not isinstance(c.get('baseline_source', ''), str) for c in cells)
            or [c['id'] for c in cells] != expected):
        return '代码文档须保留全部模块及其执行顺序。'
    if sum(len(c['source']) + len(c.get('baseline_source', '')) for c in cells) > MAX_TEXT:
        return '代码文本超过 2,000,000 字符，请缩小点表或配方。'
    return None


def parse_code(document, config, parameters_only=False):
    errors, parsed, pending_checks = [], copy.deepcopy(config), []
    issue = document_issue(document)
    if issue:
        return {'valid': False, 'errors': [{'message': issue}]}
    cells = [c for c in document['cells'] if c['id'] in CELL_FIELDS]
    for cell in cells:
        field_nodes = {}
        try:
            tree = ast.parse(cell["source"], mode="exec")
            if sum(1 for _ in ast.walk(tree)) > MAX_NODES:
                raise CodeProblem("本模块参数结构过大。")
            values = {}
            for statement in tree.body:
                if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
                    raise CodeProblem("请保留模块中的参数赋值；不支持导入、函数、循环或其他程序语句。", statement)
                name = statement.targets[0].id
                if name not in (*CELL_FIELDS[cell["id"]], *LEGACY_FIELDS.get(cell["id"], ())):
                    raise CodeProblem(f"本模块不包含参数 {name!r}。可修改：" + "、".join(CELL_FIELDS[cell["id"]]), statement)
                if name in values:
                    raise CodeProblem(f"参数 {name!r} 重复赋值，请保留一个值。", statement)
                values[name] = literal(statement.value)
                field_nodes[name] = statement
            # Accept older cell formats and explicit None switches. The actual
            # assignments below determine which representation remains active.
            optional = {'schedule', 'loops', 'reaction_stages', 'equilibrium_constraints'} | ({'points', 'cycles'} if cell['id'] == 'conditions' and ('schedule' in values or 'loops' in values) else set()) | ({'routes'} if cell['id'] == 'transfers' and 'reaction_stages' in values else set())
            missing = set(CELL_FIELDS[cell["id"]]) - set(values) - optional
            if missing:
                raise CodeProblem("缺少参数：" + "、".join(sorted(missing)))
            # Visible parameter assignments select the active representation.
            # A schedule introduced during UI migration must not mask edits to
            # an older loops/points cell; the same applies to stages/routes.
            if cell['id'] == 'conditions' and 'equilibrium_constraints' not in values:
                parsed.pop('equilibrium_constraints', None)
            if cell['id'] == 'conditions' and 'schedule' not in values:
                parsed.pop('schedule', None)
                if 'loops' not in values:
                    parsed.pop('loops', None)
            if cell['id'] == 'transfers' and 'reaction_stages' not in values and 'routes' in values:
                parsed.pop('reaction_stages', None)
            for name, value in values.items():
                if name in ('schedule', 'loops', 'reaction_stages', 'equilibrium_constraints') and value is None:
                    parsed.pop(name, None)
                    continue
                if name == "water_species" and value is None:
                    parsed.pop(name, None)
                    continue
                if name in ("species", "materials", "points", "routes") and not isinstance(value, list):
                    raise CodeProblem(f"{name} 必须是列表。", field_nodes[name])
                if name == "ion_size_overrides" and not isinstance(value, dict):
                    raise CodeProblem("ion_size_overrides 必须是字典。", field_nodes[name])
                if name in ("activity_model", "gas_model", "water_species") and not isinstance(value, str):
                    raise CodeProblem(f"{name} 必须是字符串。", field_nodes[name])
                if name in ("cycles", "balance_tolerance_mol") and not finite_number(value):
                    raise CodeProblem(f"{name} 必须是有限数值。", field_nodes[name])
                if (name.startswith("allow_") or name == "bootstrap") and type(value) is not bool:
                    raise CodeProblem(f"{name} 必须为 True 或 False。", field_nodes[name])
                pending_checks.append((name, value, field_nodes[name], cell['id']))
                parsed[name] = value
        except (SyntaxError, ValueError, RecursionError, MemoryError) as exc:
            node = getattr(exc, "node", None)
            line = getattr(exc, "lineno", None) or getattr(node, "lineno", None) or 1
            column = getattr(exc, "offset", None) or 1
            if node is not None:
                raw_line = cell["source"].splitlines()[line - 1] if cell["source"].splitlines() else ""
                column = len(raw_line.encode()[:getattr(node, "col_offset", 0)].decode(errors="ignore")) + 1
            message = "Python 语法不完整：" + exc.msg if isinstance(exc, SyntaxError) else str(exc)
            errors.append({"cell_id": cell["id"], "line": line, "column": column, "message": message or "参数结构无法读取。"})
    for name, value, node, cell_id in pending_checks:
        try:
            check_parameter(name, value, parsed)
        except CodeProblem as exc:
            errors.append({'cell_id': cell_id, 'line': node.lineno, 'column': node.col_offset+1, 'message': str(exc)})
    if not parameters_only:
        from .simulation_program import syntax_issues
        errors.extend(syntax_issues(document['cells']))
    if errors:
        return {"valid": False, "errors": errors}
    # Return the same stable identities used by execution, including when the
    # parameter cell was imported without IDs or omitted this optional field.
    from .simulation_reactions import normalize_reaction_stages
    from .errors import BridgeError
    try:
        normalize_reaction_stages(parsed)
    except BridgeError as exc:
        return {"valid": False, "errors": [{"cell_id": "transfers", "line": 1, "column": 1, "message": str(exc)}]}
    # JSON conversion also verifies the boundary used by the simulation bridge.
    json.dumps(parsed, allow_nan=False)
    return {"valid": True, "config": parsed, "errors": []}
