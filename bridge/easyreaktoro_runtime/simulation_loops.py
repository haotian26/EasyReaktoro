"""Two nested parameter loops, independent of material inheritance and solver guesses."""
from __future__ import annotations
import copy
import math
from .errors import require
from .simulation_reactions import normalize_reaction_stages, reaction_routes, route_catalog


def _check(ok, message):
    require(ok, 'SIMULATION_INPUT', 'error.simulationInput', message)


def _number(value, label):
    _check(type(value) in (int, float) and math.isfinite(value), f'{label}须为有限数值')
    return float(value)


def axis_values(axis):
    """Return ordered values. The end is a bound, never an extra unequal step."""
    _check(isinstance(axis, dict), '反应路径设置无法读取，请重新载入或填写')
    mode = axis.get('mode')
    _check(mode in ('repeat', 'range', 'list'), '请按次数、固定步长或指定数列设置条件变化')
    if mode == 'repeat':
        count = axis.get('count')
        _check(type(count) is int and 1 <= count <= 10000, '路径位置数或总轮数须为 1–10,000 的整数')
        _check(set(axis) <= {'mode', 'count'}, '重复次数不应同时指定变化变量')
        return list(range(1, count + 1))
    if mode == 'list':
        _check(set(axis) <= {'mode', 'target', 'values'}, '指定数列设置中有无法识别的项目')
        values = axis.get('values')
        _check(isinstance(values, list) and 1 <= len(values) <= 10000, '指定数列须包含 1–10,000 个值')
        return [_number(v, '条件值') for v in values]
    _check(set(axis) <= {'mode', 'target', 'start', 'end', 'step'}, '固定步长设置中有无法识别的项目')
    start, end, step = (_number(axis.get(k), k) for k in ('start', 'end', 'step'))
    _check(step != 0 and (end == start or (end > start) == (step > 0)), '变化步长不能为零，且须朝向终值')
    distance = (end - start) / step
    _check(math.isfinite(distance) and 0 <= distance <= 10000, '路径位置数或总轮数最多 10,000 个值')
    nearest = round(distance)
    if abs(start + nearest * step - end) <= abs(step) * 1e-10:
        distance = nearest
    count = math.floor(distance) + 1
    _check(count <= 10000, '路径位置数或总轮数最多 10,000 个值')
    values = [start + i * step for i in range(count)]
    if len(values) > 1 and abs(values[-1] - end) <= abs(step) * 1e-10:
        values[-1] = end
    _check(all(math.isfinite(v) for v in values), '条件值超出有效范围')
    return values


def ensure_route_ids(routes):
    """Deterministic migration; never rebind existing named rules by their row order."""
    _check(isinstance(routes, list), '物料来源须为列表')
    used = set()
    for route in routes:
        _check(isinstance(route, dict), '物料来源规则须为对象')
        if 'id' in route:
            key = route['id']
            _check(isinstance(key, str) and bool(key.strip()) and key not in used, '物料规则 ID 须唯一且非空')
            used.add(key)
    for i, route in enumerate(routes):
        if 'id' not in route:
            key, suffix = f'route-{i+1}', 1
            while key in used:
                key, suffix = f'route-{i+1}-{suffix}', suffix + 1
            route['id'] = key
            used.add(key)


def route_bindings(target):
    bindings = target.get('bindings', [{'route_id': target.get('route_id'), 'field': target.get('field')}])
    _check(isinstance(bindings, list) and 1 <= len(bindings) <= 120, '比例变化需包含 1–120 个明确的规则字段')
    seen = set()
    for binding in bindings:
        _check(isinstance(binding, dict) and set(binding) == {'route_id', 'field'}, '比例变化绑定须包含 route_id 和 field')
        _check(isinstance(binding['route_id'], str) and bool(binding['route_id']) and binding['field'] in ('fraction', 'fallback_fraction'), '比例变化绑定的规则或字段无效')
        identity = (binding['route_id'], binding['field'])
        _check(identity not in seen, '比例变化不能重复绑定同一规则字段')
        seen.add(identity)
    _check(bindings[0]['route_id'] == target.get('route_id') and bindings[0]['field'] == target.get('field'), '比例变化的首个绑定须与主规则字段一致')
    return bindings


def normalize_round_conditions(loops, outer_count):
    rows = loops.get('round_conditions', [])
    _check(isinstance(rows, list) and len(rows) <= 10000, '各轮压力设置须为列表，最多 10,000 轮')
    seen = set()
    for row in rows:
        _check(isinstance(row, dict) and {'round', 'pressure_mode'} <= set(row) <= {'round', 'pressure_mode', 'pressure_bar'}, '各轮压力需包含轮次和压力方式，可另填压力值')
        number = row['round']
        _check(type(number) is int and 1 <= number <= 10000, '指定轮次须为 1–10,000 之间的整数')
        _check(number not in seen, f'第 {number} 轮的压力设置重复，请保留一项')
        seen.add(number)
        _check(row['pressure_mode'] in ('fixed', 'water_saturation'), f'第 {number} 轮请选择指定压力或纯水饱和蒸汽压')
        if 'pressure_bar' in row:
            if number > outer_count and row['pressure_bar'] == {'easyreaktoro_empty_number': True}:
                continue
            _number(row['pressure_bar'], f'第 {number} 轮压力')
    return {row['round']: row for row in rows}


def pressure_axis_used(loops, outer_count, overrides):
    return any(overrides.get(i, {}).get('pressure_mode', loops['base'].get('pressure_mode', 'fixed')) == 'fixed'
               and 'pressure_bar' not in overrides.get(i, {}) for i in range(1, outer_count+1))


def normalize_loops(cfg, check_references=True):
    if cfg.get("schedule") is not None:
        from .simulation_schedule import normalize_schedule
        normalize_schedule(cfg, check_references=check_references)
        return
    normalize_reaction_stages(cfg)
    if not cfg.get('reaction_stages'):
        ensure_route_ids(cfg.get('routes', []))
    loops = cfg.get('loops')
    if loops is None:
        cfg.pop('loops', None)
        return
    _check(isinstance(loops, dict) and {'base', 'inner', 'outer'} <= set(loops) <= {'base', 'inner', 'outer', 'round_conditions'}, '起始条件、反应路径或反应轮次设置不完整')
    base = loops['base']
    _check(isinstance(base, dict) and {'temperature_c', 'pressure_bar'} <= set(base) <= {'temperature_c', 'pressure_bar', 'pressure_mode'}, '请填写基础温度与压力')
    _number(base['temperature_c'], '基础温度')
    _number(base['pressure_bar'], '基础压力')
    _check(base.get('pressure_mode', 'fixed') in ('fixed', 'water_saturation'), '请选择指定压力或纯水饱和蒸汽压')
    targets = set()
    sizes = []
    varies_pressure = False
    for name in ('inner', 'outer'):
        axis = loops[name]
        values = axis_values(axis)
        sizes.append(len(values))
        if axis['mode'] == 'repeat':
            continue
        target = axis.get('target')
        _check(isinstance(target, dict), '请选择要变化的量')
        kind = target.get('kind')
        fields = {'temperature': {'kind'}, 'pressure': {'kind'}, 'material_amount': {'kind', 'material_id', 'species'}, 'route_fraction': {'kind', 'route_id', 'field'}}
        _check(isinstance(kind, str) and kind in fields and fields[kind] <= set(target) <= fields[kind] | ({'bindings'} if kind == 'route_fraction' else set()), '所选变化量无法识别，请重新选择')
        _check(all(isinstance(v, str) and bool(v) for k, v in target.items() if k != 'bindings'), '所选变化量缺少对应的参数，请重新选择')
        identities = [('route_fraction', b['route_id'], b['field']) for b in route_bindings(target)] if kind == 'route_fraction' else [tuple(sorted(target.items()))]
        _check(all(identity not in targets for identity in identities), '路径变化和轮次变化不能同时指定同一个量')
        targets.update(identities)
        if kind == 'pressure':
            varies_pressure = True
        elif kind == 'material_amount':
            rows = [row for m in cfg.get('materials', []) if m.get('id') == target['material_id'] for row in m.get('inputs', []) if row.get('species') == target['species']]
            _check(not check_references or len(rows) == 1, '找不到唯一对应的配方投料，请重新选择')
            _check(min(values) >= 0, '投料量不能为负')
        elif kind == 'route_fraction':
            _check(min(values) >= 0, '物料比例不能为负')
            for binding in route_bindings(target):
                _check(not cfg.get('reaction_stages') or binding['field'] != 'fallback_fraction', '反应位置已独立设置物料，请改选该位置的配方份数或输出取用比例')
                matches = [r for _, r in route_catalog(cfg) if r.get('id') == binding['route_id']]
                _check(not check_references or len(matches) == 1, '所选物料来源已不存在，请重新选择')
                route = matches[0] if matches else {}
                if check_references and binding['field'] == 'fallback_fraction':
                    _check(route.get('source') != 'material' and route.get('fallback', 'material') == 'material', '此规则不使用首次配方投料，请重新选择变化量')
                if check_references and binding['field'] == 'fraction' and route.get('source') != 'material':
                    _check(max(values) <= 1, '历史输出的传入比例不能超过 100%')
    _check(sizes[0] * sizes[1] <= 20000, '本次模拟最多包含 20,000 个平衡点')
    overrides = normalize_round_conditions(loops, sizes[1])
    _check(not varies_pressure or pressure_axis_used(loops, sizes[1], overrides), '各轮均使用饱和蒸汽压或另定压力，当前压力变化没有生效；请调整轮次压力设置或移除压力变化')


class LoopPlan:
    """Coordinates are zero based internally; result coordinates are one based."""
    def __new__(cls, cfg):
        if cfg.get("schedule") is not None:
            from .simulation_schedule import SchedulePlan
            return SchedulePlan(cfg)
        return super().__new__(cls)

    def __init__(self, cfg):
        self.cfg = cfg
        self.loops = cfg['loops']
        self.values = {name: axis_values(self.loops[name]) for name in ('inner', 'outer')}
        self.round_conditions = {row['round']: row for row in self.loops.get('round_conditions', [])}

    def assignments(self, outer, inner):
        for name, index in (('outer', outer), ('inner', inner)):
            axis = self.loops[name]
            if axis['mode'] != 'repeat':
                yield axis['target'], self.values[name][index]

    def point(self, outer, inner):
        point = {'id': f'loop-{inner+1}', 'label': f'路径位置 {inner+1}', **self.loops['base']}
        for target, value in self.assignments(outer, inner):
            if target['kind'] in ('temperature', 'pressure'):
                point['temperature_c' if target['kind'] == 'temperature' else 'pressure_bar'] = value
        override = self.round_conditions.get(outer+1)
        if override is not None:
            point['pressure_mode'] = override['pressure_mode']
            if override['pressure_mode'] == 'fixed' and 'pressure_bar' in override:
                point['pressure_bar'] = override['pressure_bar']
        from .simulation_process import actual_point
        return actual_point(point, 0)

    def routes(self, outer, inner):
        routes = reaction_routes(self.cfg, outer, inner)
        updates = [(t, v) for t, v in self.assignments(outer, inner) if t['kind'] == 'route_fraction']
        if not updates:
            return routes
        routes = copy.deepcopy(routes)
        for target, value in updates:
            for binding in route_bindings(target):
                for route in routes:
                    if route['id'] == binding['route_id']:
                        route[binding['field']] = value
        return routes

    def material_amounts(self, base_moles, database, outer, inner):
        amounts = base_moles
        updates = [(t, v) for t, v in self.assignments(outer, inner) if t['kind'] == 'material_amount']
        if not updates:
            return amounts
        amounts = {key: dict(rows) for key, rows in amounts.items()}
        for target, value in updates:
            material, name = target['material_id'], target['species']
            unit = next(row['unit'] for m in self.cfg['materials'] if m['id'] == material for row in m['inputs'] if row['species'] == name)
            if unit != 'mol':
                value *= (1e-3 if unit == 'g' else 1) / float(database.species(name).molarMass())
            amounts[material][name] = value
        return amounts

    def common(self, outer, inner):
        return {'outer_index': outer+1, 'inner_index': inner+1,
                'outer_value': self.values['outer'][outer], 'inner_value': self.values['inner'][inner]}

    def metadata(self):
        result = {}
        for name in ('inner', 'outer'):
            axis = self.loops[name]
            target = axis.get('target')
            unit = ''
            label, label_en = ('路径位置', 'Path position') if name == 'inner' else ('反应轮次', 'Reaction round')
            if target:
                kind = target['kind']
                unit = {'temperature': '°C', 'pressure': 'bar', 'route_fraction': '1'}.get(kind, '')
                if kind in ('temperature', 'pressure'):
                    label, label_en = ('温度', 'Temperature') if kind == 'temperature' else ('压力', 'Pressure')
                if kind == 'material_amount':
                    material = next(m for m in self.cfg['materials'] if m['id'] == target['material_id'])
                    unit = next(row['unit'] for row in material['inputs'] if row['species'] == target['species'])
                    label = f"{material['name']} · {target['species']} 投料量"
                    label_en = f"{material['name']} · {target['species']} input amount"
                elif kind == 'route_fraction':
                    title, route = next((title, r) for title, r in route_catalog(self.cfg) if r['id'] == target['route_id'])
                    meaning = ('首次投料倍数', 'initial feed multiplier') if target['field'] == 'fallback_fraction' else (('投料倍数', 'feed multiplier') if route['source'] == 'material' else ('传入比例', 'transfer fraction'))
                    title_en = next(t for t, r in route_catalog(self.cfg, 'en') if r['id'] == target['route_id'])
                    label, label_en = f'{title} · {meaning[0]}', f'{title_en} · {meaning[1]}'
                    if len(route_bindings(target)) > 1:
                        label += f'（共 {len(route_bindings(target))} 处）'
                        label_en += f' ({len(route_bindings(target))} inputs)'
            result[name] = {'mode': axis['mode'], 'target': copy.deepcopy(target), 'unit': unit, 'values': self.values[name],
                            'label': label, 'label_en': label_en, 'value_field': name+'_value', 'index_field': name+'_index'}
        return result

    def field_info(self):
        result = {'inner_index': ['路径位置', 'Path position', ''], 'outer_index': ['反应轮次', 'Reaction round', ''],
                  'pass': ['反应轮次', 'Reaction round', ''], 'step': ['路径位置', 'Path position', '']}
        for name, axis in self.metadata().items():
            result[name+'_value'] = [axis['label'], axis['label_en'], axis['unit']]
        return result


def execution_config(cfg, plan=None, *, fill_missing=True):
    """Private runtime projection; never use it to overwrite saved user inputs.

    Preflight retains missing base amounts to check their actual use. After
    validation, unused missing amounts can be represented by zero internally;
    the original configuration and saved code keep the user's unfilled input.
    """
    from .simulation_schedule import missing_amount
    has_plan = bool(cfg.get('loops') or cfg.get('schedule'))
    needs_fill = fill_missing and any(missing_amount(row.get('amount')) for material in cfg.get('materials', []) for row in material.get('inputs', []))
    if not has_plan and not needs_fill:
        return cfg
    result = copy.deepcopy(cfg)
    if needs_fill:
        for material in result['materials']:
            for row in material['inputs']:
                if missing_amount(row.get('amount')):
                    row['amount'] = 0.0
    if not has_plan:
        return result
    plan = plan or LoopPlan(cfg)
    points = []
    for inner in range(len(plan.values['inner'])):
        point = plan.point(0, inner)
        conditions = []
        for outer in range(1, len(plan.values['outer'])):
            actual = plan.point(outer, inner)
            if any(actual[k] != point[k] for k in ('temperature_c', 'pressure_bar', 'pressure_mode')):
                conditions.append({'round': outer+1, **{k: actual[k] for k in ('temperature_c', 'pressure_bar', 'pressure_mode')}})
        if conditions:
            point['round_conditions'] = conditions
        points.append(point)
    result['points'], result['cycles'] = points, len(plan.values['outer'])
    if cfg.get('schedule') and not result.get('loops'):
        # Runtime-only adapter for older custom cells that check cfg['loops'].
        # LoopPlan itself delegates to SchedulePlan, so this is never the authority.
        result['loops'] = {'base': {key: points[0][key] for key in ('temperature_c', 'pressure_bar', 'pressure_mode')},
                           'inner': {'mode': 'repeat', 'count': len(points)},
                           'outer': {'mode': 'repeat', 'count': result['cycles']}}
    return result


def execution_shape(cfg):
    if cfg.get("schedule"):
        return cfg["schedule"]["positions"], cfg["schedule"]["rounds"]
    if cfg.get('loops'):
        return len(axis_values(cfg['loops']['inner'])), len(axis_values(cfg['loops']['outer']))
    return len(cfg['points']), cfg['cycles']
