"""Coordinate-based parameter schedules, independent of material-flow topology.

Every value is evaluated in execution order. Relative profiles can depend only
on an already evaluated neighbour; an override therefore participates in the
next relative value without changing a linear or explicit list profile.
"""
from __future__ import annotations
import copy
import math
from array import array
from decimal import Decimal, localcontext
from .errors import require
from .simulation_reactions import normalize_reaction_stages, reaction_routes, route_catalog


def _check(ok, message):
    require(ok, 'SIMULATION_INPUT', 'error.simulationInput', message)


def _number(value, label):
    _check(type(value) in (int, float) and math.isfinite(value), f'{label}须为有限数值')
    return float(value)


def missing_amount(value):
    """An unfilled base input, distinct from an invalid explicit parameter."""
    return value is None or value == {'easyreaktoro_empty_number': True} or type(value) is float and math.isnan(value)


def _arithmetic(start, *terms):
    # JSON parameters are decimal numbers. This avoids a nominal zero becoming
    # a negative dose after e.g. 0.3 + 3 * -0.1, without clipping small values.
    values = [(Decimal(str(start)), 1), *((Decimal(str(step)), index) for index, step in terms)]
    if any(not value.is_finite() for value, _ in values):
        # The per-point validator supplies the parameter location and message.
        return float('nan')
    nonzero = [(value, index) for value, index in values if value and index]
    if not nonzero:
        return 0.0
    lowest = min(value.as_tuple().exponent for value, _ in nonzero)
    highest = max(value.adjusted() + len(str(abs(index))) for value, index in nonzero)
    with localcontext() as context:
        # Cover every decimal place in the inputs and integer products, plus
        # carry digits for their sum. Cancellation then retains small terms.
        context.prec = max(1, highest - lowest + len(str(len(nonzero))) + 2)
        result = sum((value * index for value, index in nonzero), Decimal(0))
        return float(result)


def scope_indices(scope, count):
    _check(isinstance(scope, dict) and {'start'} <= set(scope) <= {'start', 'end', 'step'}, '适用范围需填写起始位置，可另填结束位置与间隔')
    start, end, step = scope['start'], scope.get('end', count), scope.get('step', 1)
    _check(type(start) is int and 1 <= start <= 10000, '适用范围起点须为 1–10,000 的整数')
    _check('end' not in scope or type(end) is int and start <= end <= 10000, '适用范围终点须为不小于起点的整数，最多 10,000')
    _check(type(step) is int and 1 <= step <= 10000, '适用范围间隔须为正整数，不能为零')
    return range(start-1, min(end, count), step)


def _identities(target):
    from .simulation_loops import route_bindings
    _check(isinstance(target, dict), '请选择需要设置的参数')
    kind = target.get('kind')
    fields = {'temperature': {'kind'}, 'pressure': {'kind'},
              'material_amount': {'kind', 'material_id', 'species'},
              'equilibrium_constraint': {'kind', 'constraint_id'},
              'route_fraction': {'kind', 'route_id', 'field'}}
    _check(isinstance(kind, str) and kind in fields and fields[kind] <= set(target) <= fields[kind] | ({'bindings'} if kind == 'route_fraction' else set()), '所选参数无法识别')
    _check(all(isinstance(value, str) and bool(value.strip()) for key, value in target.items() if key != 'bindings'), '所选参数缺少对应名称或编号')
    if kind == 'route_fraction':
        return [('route_fraction', row['route_id'], row['field']) for row in route_bindings(target)]
    if kind == 'equilibrium_constraint':
        return [(kind, target['constraint_id'])]
    if kind == 'material_amount':
        return [(kind, target['material_id'], target['species'])]
    return [(kind,)]


def _profile_shape(profile, target, active):
    _check(isinstance(profile, dict), '参数变化方式无法读取')
    mode = profile.get('mode')
    fields = {'fixed': {'mode', 'value'}, 'linear': {'mode', 'start', 'path_step', 'round_step'},
              'list': {'mode', 'along', 'values'}, 'relative': {'mode', 'along', 'start', 'step', 'other_step'},
              'water_saturation': {'mode'}, 'expression': {'mode', 'expression'}}
    _check(isinstance(mode, str) and mode in fields and set(profile) == fields[mode], '参数变化方式或字段不完整')
    if mode == 'expression':
        _check(isinstance(profile['expression'], str) and len(profile['expression']) <= 2000, 'Formula must be text of up to 2,000 characters.')
        return
    if mode == 'water_saturation':
        _check(target['kind'] == 'pressure', '纯水饱和蒸汽压只能用于压力参数')
        return
    if mode in ('list', 'relative'):
        _check(profile['along'] in ('path', 'round'), '请选择沿路径位置或反应轮次变化')
    numeric = [profile[key] for key in fields[mode] - {'mode', 'along', 'values'}]
    if mode == 'list':
        _check(isinstance(profile['values'], list) and len(profile['values']) <= 10000, '参数数列须为列表，最多 10,000 项')
        _check(all(type(value) in (int, float) or value == {'easyreaktoro_empty_number': True} for value in profile['values']), '参数数列须为数值')
        # Only entries actually used by the current schedule are evaluated.
        if not active:
            return
    for number in numeric:
        _check(type(number) in (int, float) or number == {'easyreaktoro_empty_number': True}, '参数值须为数值')


def _reference(cfg, identity):
    kind = identity[0]
    if kind == 'equilibrium_constraint':
        matches = [row for row in cfg.get('equilibrium_constraints', []) if row.get('id') == identity[1]]
        _check(len(matches) == 1, '找不到唯一对应的平衡约束，请重新选择参数')
        return matches[0]
    if kind == 'material_amount':
        matches = [row for material in cfg.get('materials', []) if material.get('id') == identity[1]
                   for row in material.get('inputs', []) if row.get('species') == identity[2]]
        _check(len(matches) == 1, '找不到唯一对应的 composition 投料，请重新选择参数')
        return matches[0]
    if kind == 'route_fraction':
        matches = [route for _, route in route_catalog(cfg) if route.get('id') == identity[1]]
        _check(len(matches) == 1, '找不到唯一对应的物料来源，请重新选择参数')
        route = matches[0]
        if identity[2] == 'fallback_fraction':
            _check(not cfg.get('reaction_stages'), '反应位置已独立设置物料，请选择该位置的投料份数或传入比例')
            _check(route.get('source') != 'material' and route.get('fallback', 'material') == 'material', '此来源不使用首次 composition 投料')
        return route
    return None


def normalize_schedule(cfg, check_references=True):
    schedule = cfg.get('schedule')
    if schedule is None:
        cfg.pop('schedule', None)
        return
    _check(isinstance(schedule, dict) and {'version', 'positions', 'rounds', 'parameters', 'overrides'} <= set(schedule) <= {'version', 'positions', 'rounds', 'parameters', 'overrides', 'stop'} and type(schedule['version']) is int and schedule['version'] == 1, '反应计划格式无法识别')
    for key in ('positions', 'rounds'):
        _check(type(schedule[key]) is int and 1 <= schedule[key] <= 10000, '路径位置数和轮数须为 1–10,000 的整数')
    if 'stop' in schedule:
        _check(isinstance(schedule['stop'], dict) and set(schedule['stop']) <= {'first', 'later', 'rounds'} and all(isinstance(v, str) and len(v) <= 2000 for v in schedule['stop'].values()), 'Invalid end conditions.')
    _check(bool(schedule.get('stop')) or schedule['positions'] * schedule['rounds'] <= 20000, '本次模拟最多包含 20,000 个平衡点')
    normalize_reaction_stages(cfg)
    if not cfg.get('reaction_stages'):
        from .simulation_loops import ensure_route_ids
        ensure_route_ids(cfg.get('routes', []))
    _check(isinstance(schedule['overrides'], list), '局部参数设置须为列表')
    groups = [(None, schedule['parameters'], {'start': 1}, {'start': 1})]
    rule_ids, setting_ids = set(), set()
    for override in schedule['overrides']:
        _check(isinstance(override, dict) and {'id', 'rounds', 'positions', 'parameters'} <= set(override) <= {'id', 'name', 'rounds', 'positions', 'parameters'}, '局部参数设置不完整')
        key = override['id']
        _check(isinstance(key, str) and bool(key.strip()) and key not in rule_ids, '局部设置编号须唯一且非空')
        _check('name' not in override or isinstance(override['name'], str), '局部设置名称须为文字')
        rule_ids.add(key)
        groups.append((key, override['parameters'], override['rounds'], override['positions']))
    occupied, general, active_identities = {}, set(), set()
    for group_id, parameters, round_scope, position_scope in groups:
        rounds = scope_indices(round_scope, schedule['rounds'])
        positions = scope_indices(position_scope, schedule['positions'])
        active = bool(rounds) and bool(positions)
        _check(isinstance(parameters, list), '参数设置须为列表')
        targets = set()
        for setting in parameters:
            _check(isinstance(setting, dict) and set(setting) == {'id', 'target', 'value'}, '参数设置需包含编号、目标与变化方式')
            key = setting['id']
            _check(isinstance(key, str) and bool(key.strip()) and key not in setting_ids, '参数设置编号须唯一且非空')
            setting_ids.add(key)
            identities = _identities(setting['target'])
            _check(not targets.intersection(identities), '同一组中不能重复设置同一个参数')
            targets.update(identities)
            _profile_shape(setting['value'], setting['target'], active)
            if active:
                active_identities.update(identities)
                if check_references:
                    for identity in identities:
                        _reference(cfg, identity)
            if group_id is not None and active:
                for identity in identities:
                    for previous_rounds, previous_positions in occupied.setdefault(identity, []):
                        outer = next((number for number in rounds if number in previous_rounds), None)
                        inner = next((number for number in positions if number in previous_positions), None)
                        _check(outer is None or inner is None, f'同一个参数存在重叠的局部设置，请调整适用范围')
                    occupied[identity].append((rounds, positions))
        if group_id is None:
            general = targets
    _check(('temperature',) in general and ('pressure',) in general, '一般参数中必须分别设置温度和压力')


class SchedulePlan:
    """Compile final parameter values once, iteratively, then expose pure frames."""
    def __init__(self, cfg, check_references=True):
        self.cfg = cfg
        normalize_schedule(cfg, check_references=check_references)
        self.schedule = cfg['schedule']
        self.positions, self.rounds = self.schedule['positions'], self.schedule['rounds']
        stop = self.schedule.get('stop', {})
        if 'rounds' in stop:
            for n in range(10000):
                def round_variable(name):
                    _check(name == 'N', 'The simulation completion condition can only use N.')
                    return n
                if self._stop(stop['rounds'], round_variable):
                    self.rounds = n+1
                    break
            else:
                _check(False, 'The completion condition is not reached within 10,000 rounds.')
        has_stop = 'first' in stop or 'later' in stop
        if has_stop: self.positions = 10000
        self.lengths = []
        self.values = {'inner': list(range(1, self.positions+1)), 'outer': list(range(1, self.rounds+1))}
        self._settings, self._targets = {}, {}
        self._general, self._local = {}, {}
        groups = [(None, self.schedule['parameters'], {'start': 1}, {'start': 1})]
        groups.extend((row['id'], row['parameters'], row['rounds'], row['positions']) for row in self.schedule['overrides'])
        for group_id, settings, round_scope, position_scope in groups:
            rounds, positions = scope_indices(round_scope, self.rounds), scope_indices(position_scope, self.positions)
            if not rounds or not positions:
                continue
            for setting in settings:
                descriptor = (setting, round_scope, position_scope, group_id)
                self._settings[setting['id']] = setting
                for identity in _identities(setting['target']):
                    self._targets[identity] = setting['target']
                    if group_id is None:
                        self._general[identity] = descriptor
                    else:
                        self._local.setdefault(identity, []).append((rounds, positions, descriptor))
        self._arrays = {}
        self._pressure_modes = set()
        self._scalars, self._evaluating = {}, set()
        self._references = {identity: _reference(cfg, identity) if check_references else None for identity in self._targets}
        if has_stop:
            for outer in range(self.rounds):
                rule = stop.get('first' if outer == 0 else 'later')
                limit = 10000 if rule is not None else self.schedule['positions']
                for inner in range(limit):
                    temperature = self._raw(('temperature',), outer, inner)
                    pressure = self._raw(('pressure',), outer, inner)
                    _check(math.isfinite(temperature) and temperature > -273.15 and math.isfinite(pressure) and pressure > 0,
                           f'Invalid conditions at round {outer+1}, position {inner+1}, before the end condition is reached.')
                    def variable(name):
                        env = {'i': inner, 'N': outer, 'T': temperature, 'P': pressure}
                        _check(name in env, f'Invalid variable in the end condition: {name}.')
                        return env[name]
                    if rule is not None and self._stop(rule, variable): break
                else:
                    _check(rule is None, 'The end condition is not reached within 10,000 steps.')
                self.lengths.append(inner+1)
                _check(sum(self.lengths) <= 20000, 'This simulation exceeds 20,000 equilibrium points.')
            self.positions = max(self.lengths)
        else:
            self.lengths = [self.positions]*self.rounds
        self.total = sum(self.lengths)
        _check(self.positions*self.rounds <= 20000, 'The path and round grid exceeds 20,000 positions. Reduce its extent.')
        self.values = {'inner': list(range(1, self.positions+1)), 'outer': list(range(1, self.rounds+1))}
        for identity in sorted(self._targets, key=lambda key: (key[0] == 'pressure', key)):
            reference = self._references[identity]
            values = array('d')
            self._arrays[identity] = values
            for outer in range(self.rounds):
                for inner in range(self.positions):
                    index = outer*self.positions+inner
                    if not self.active(outer, inner):
                        values.append(float('nan'))
                        continue
                    descriptor = self._descriptor(identity, outer, inner)
                    from .simulation_constraints import active_at
                    constraint_active = identity[0] != 'equilibrium_constraint' or reference is None or active_at(reference, outer, inner, self.rounds, self.positions)
                    if not constraint_active:
                        values.append(float('nan'))
                        continue
                    self._raw(('temperature',), outer, inner)
                    self._raw(('pressure',), outer, inner)
                    raw = self._raw(identity, outer, inner)
                    if raw == {'easyreaktoro_empty_number': True}:
                        raw = float('nan')
                    if identity[0] == 'material_amount' and descriptor is None and missing_amount(raw):
                        # Whether this base value is required depends on actual
                        # material sources and phase filters, checked at preflight.
                        values.append(float('nan'))
                        continue
                    if not constraint_active:
                        values.append(float(raw) if type(raw) in (int, float) else float('nan'))
                        continue
                    reference_active = identity[0] != 'route_fraction' or any(route.get('id') == identity[1] for route in reaction_routes(cfg, outer, inner))
                    if not reference_active:
                        values.append(float(raw))
                        continue
                    raw = _number(raw, f'第 {outer+1} 轮、路径位置 {inner+1} 的参数')
                    _check(identity[0] != 'temperature' or raw > -273.15, '温度必须高于绝对零度')
                    _check(identity[0] != 'pressure' or raw > 0, '指定压力必须大于零')
                    _check(identity[0] != 'equilibrium_constraint' or not reference or reference['kind'] != 'fugacity' or raw > 0, '气体逸度必须大于零，单位为 bar')
                    _check(identity[0] not in ('material_amount', 'route_fraction') or raw >= 0, '投料量和物料比例不能为负')
                    if identity[0] == 'route_fraction' and identity[2] == 'fraction' and reference and reference.get('source') != 'material':
                        _check(raw <= 1, '历史输出取用比例不能超过 100%')
                    values.append(raw)

    @staticmethod
    def _stop(expression, variable):
        import ast
        from .reaction_expression import parse_expression, evaluate_expression
        _check(isinstance(parse_expression(expression), ast.Compare), 'Use a comparison to end the calculation, for example i = 3 or P < 150.')
        return evaluate_expression(expression, variable) != 0

    def active(self, outer, inner):
        return 0 <= outer < len(self.lengths) and 0 <= inner < self.lengths[outer]

    def run_index(self, outer, inner):
        return sum(self.lengths[:outer])+inner

    def _raw(self, identity, outer, inner):
        _check(inner >= 0 and outer >= 0 and (outer >= len(self.lengths) or inner < self.lengths[outer]),
               'The referenced round ended before this position. Specify conditions or amounts for the new position.')
        key = (identity, outer, inner)
        if key in self._scalars:
            return self._scalars[key]
        _check(key not in self._evaluating, 'Expressions refer to each other in a cycle.')
        self._evaluating.add(key)
        try:
            reference = self._references.get(identity)
            descriptor = self._descriptor(identity, outer, inner)
            if descriptor is None:
                raw = reference.get('value') if identity[0] == 'equilibrium_constraint' and reference else reference.get('amount', 0) if identity[0] == 'material_amount' and reference else reference.get(identity[2], 1) if reference else 0
            else:
                setting, rs, ps, _ = descriptor
                profile = setting['value']
                mode = profile['mode']
                pi, ri = (inner+1-ps['start']) // ps.get('step', 1), (outer+1-rs['start']) // rs.get('step', 1)
                if mode == 'fixed': raw = profile['value']
                elif mode == 'linear': raw = _arithmetic(profile['start'], (pi, profile['path_step']), (ri, profile['round_step']))
                elif mode == 'list':
                    ordinal = pi if profile['along'] == 'path' else ri
                    _check(0 <= ordinal < len(profile['values']), f'第 {outer+1} 轮、路径位置 {inner+1} 缺少对应的参数数列值')
                    raw = profile['values'][ordinal]
                elif mode == 'relative':
                    path = profile['along'] == 'path'
                    previous = inner if path else outer
                    raw = _arithmetic(self._raw(identity, outer if path else outer-1, inner-1 if path else inner), (1, profile['step'])) if previous else _arithmetic(profile['start'], (outer if path else inner, profile['other_step']))
                elif mode == 'water_saturation':
                    raw = self._psat(self._raw(('temperature',), outer, inner))
                    self._pressure_modes.add((outer, inner))
                elif identity[0] == 'route_fraction' and not any(r.get('id') == identity[1] for r in reaction_routes(self.cfg, outer, inner)):
                    raw = reference.get(identity[2], 1) if reference else 1
                else:
                    from .reaction_expression import evaluate_expression
                    def previous(kind, above=False):
                        x, y = (inner, outer-1) if above else (inner-1, outer) if inner else (inner, outer-1)
                        _check(y >= 0, 'The first step has no previous conditions. Enter an initial value.')
                        _check(y >= len(self.lengths) or x < self.lengths[y], 'The previous round ended before this position; its conditions are unavailable.')
                        return self._raw((kind,), y, x)
                    def variable(name):
                        if name == 'i': return inner
                        if name == 'N': return outer
                        if name == 'T': return previous('temperature') if identity[0] == 'temperature' else self._raw(('temperature',), outer, inner)
                        if name == 'P': return previous('pressure') if identity[0] in ('temperature', 'pressure') else self._raw(('pressure',), outer, inner)
                        if name == 'Tr': return previous('temperature', True)
                        if name == 'Pr': return previous('pressure', True)
                        if name == 'Xr':
                            _check(outer > 0, 'The first round has no previous-round amount.')
                            return self._raw(identity, outer-1, inner)
                        if name == 'X':
                            _check(inner > 0 or outer > 0, 'The first step has no previous amount. Enter an initial value.')
                            return self._raw(identity, outer if inner else outer-1, inner-1 if inner else inner)
                        raise ValueError(f'Unknown variable: {name}.')
                    raw = evaluate_expression(profile['expression'], variable, self._psat)
                    import re
                    if identity[0] == 'pressure' and re.fullmatch(r'\s*Psat\(\s*T\s*\)\s*', profile['expression']):
                        self._pressure_modes.add((outer, inner))
            if raw == {'easyreaktoro_empty_number': True}: raw = float('nan')
            self._scalars[key] = raw
            return raw
        finally:
            self._evaluating.remove(key)

    @staticmethod
    def _psat(temperature):
        _check(0.01 <= temperature < 373.946, 'Psat(T) requires 0.01 <= T < 373.946 C.')
        import reaktoro as rkt
        return float(rkt.waterSaturationPressureWagnerPruss(temperature+273.15))/1e5

    def _descriptor(self, identity, outer, inner):
        for rounds, positions, descriptor in self._local.get(identity, []):
            if outer in rounds and inner in positions:
                return descriptor
        return self._general.get(identity)

    def _index(self, outer, inner):
        _check(type(outer) is int and type(inner) is int and 0 <= outer < self.rounds and 0 <= inner < self.positions, '反应轮次或路径位置超出计划范围')
        return outer*self.positions+inner

    def point(self, outer, inner):
        index = self._index(outer, inner)
        return {'id': f'loop-{inner+1}', 'label': f'路径位置 {inner+1}', 'temperature_c': self._arrays[('temperature',)][index],
                'pressure_bar': self._arrays[('pressure',)][index], 'pressure_mode': 'water_saturation' if (outer, inner) in self._pressure_modes else 'fixed'}

    def assignments(self, outer, inner):
        index = self._index(outer, inner)
        for identity, values in self._arrays.items():
            value = values[index]
            target = {'kind': identity[0]}
            if identity[0] == 'equilibrium_constraint':
                target.update(constraint_id=identity[1])
            elif identity[0] == 'material_amount':
                target.update(material_id=identity[1], species=identity[2])
            elif identity[0] == 'route_fraction':
                target.update(route_id=identity[1], field=identity[2])
            yield target, value

    def routes(self, outer, inner):
        routes = reaction_routes(self.cfg, outer, inner)
        index = self._index(outer, inner)
        values = {key: array[index] for key, array in self._arrays.items()}
        if not any(key[0] == 'route_fraction' for key in values):
            return routes
        routes = copy.deepcopy(routes)
        for route in routes:
            for field in ('fraction', 'fallback_fraction'):
                if ('route_fraction', route['id'], field) in values:
                    route[field] = values[('route_fraction', route['id'], field)]
        return routes

    def material_amounts(self, base_moles, database, outer, inner):
        updates = [(target, value) for target, value in self.assignments(outer, inner) if target['kind'] == 'material_amount']
        if not updates:
            return base_moles
        result = {key: dict(rows) for key, rows in base_moles.items()}
        for target, value in updates:
            identity = ('material_amount', target['material_id'], target['species'])
            unit = _reference(self.cfg, identity)['unit']
            if unit != 'mol':
                value *= (1e-3 if unit == 'g' else 1)/float(database.species(target['species']).molarMass())
            result[target['material_id']][target['species']] = value
        return result

    def common(self, outer, inner):
        return {'outer_index': outer+1, 'inner_index': inner+1}

    def metadata(self):
        return {name: {'mode': 'repeat', 'target': None, 'unit': '', 'values': self.values[name],
                       'label': label, 'label_en': english, 'index_field': name+'_index', 'value_field': name+'_index'}
                for name, label, english in [('inner', '路径位置', 'Path position'), ('outer', '反应轮次', 'Reaction round')]}

    def field_info(self):
        from .simulation_constraints import field_info
        return {**field_info(self.cfg), 'inner_index': ['路径位置', 'Path position', ''], 'outer_index': ['反应轮次', 'Reaction round', ''],
                'step': ['路径位置', 'Path position', ''], 'pass': ['反应轮次', 'Reaction round', '']}

    def frame(self, outer, inner):
        parameters = []
        for target, value in self.assignments(outer, inner):
            descriptor = self._descriptor(_identities(target)[0], outer, inner)
            origin = {'setting_id': descriptor[0]['id'], 'override_id': descriptor[3]} if descriptor else {}
            parameters.append({'target': target, 'value': value, **origin})
        return {**self.common(outer, inner), 'point': self.point(outer, inner), 'parameters': parameters}


def to_schedule(cfg):
    """Return a lossless migration, or None for nonuniform legacy point routes."""
    if cfg.get('schedule') is not None:
        return copy.deepcopy(cfg['schedule'])
    from .simulation_loops import axis_values, normalize_loops
    source = copy.deepcopy(cfg)
    if source.get('loops'):
        normalize_loops(source)
        loops = source['loops']
        sizes = {name: axis_values(loops[name]) for name in ('inner', 'outer')}
        result = {'version': 1, 'positions': len(sizes['inner']), 'rounds': len(sizes['outer']), 'parameters': [], 'overrides': []}
        base = loops['base']
        targets = {('temperature',): ({'kind': 'temperature'}, {'mode': 'fixed', 'value': base['temperature_c']}),
                   ('pressure',): ({'kind': 'pressure'}, {'mode': 'water_saturation'} if base.get('pressure_mode') == 'water_saturation' else {'mode': 'fixed', 'value': base['pressure_bar']})}
        pressure_axis = None
        for name in ('inner', 'outer'):
            axis = loops[name]
            if axis['mode'] == 'repeat':
                continue
            target = copy.deepcopy(axis['target'])
            profile = {'mode': 'list', 'along': 'path' if name == 'inner' else 'round', 'values': sizes[name]}
            if target['kind'] == 'pressure':
                pressure_axis = profile
                if base.get('pressure_mode') == 'water_saturation':
                    continue
            targets[tuple(_identities(target)) if target['kind'] == 'route_fraction' else _identities(target)[0]] = (target, profile)
        for i, (target, profile) in enumerate(targets.values()):
            result['parameters'].append({'id': f'legacy-parameter-{i+1}', 'target': target, 'value': profile})
        for row in loops.get('round_conditions', []):
            profile = {'mode': 'water_saturation'}
            if row['pressure_mode'] == 'fixed':
                if 'pressure_bar' in row:
                    profile = {'mode': 'fixed', 'value': row['pressure_bar']}
                elif pressure_axis:
                    profile = copy.deepcopy(pressure_axis)
                    if profile['along'] == 'round':
                        # The old outer axis has no value beyond its declared size.
                        if row['round'] <= len(profile['values']):
                            profile = {'mode': 'fixed', 'value': profile['values'][row['round']-1]}
                        else:
                            profile = {'mode': 'fixed', 'value': {'easyreaktoro_empty_number': True}}
                else:
                    profile = {'mode': 'fixed', 'value': base['pressure_bar']}
            result['overrides'].append({'id': f'legacy-round-{row["round"]}', 'rounds': {'start': row['round'], 'end': row['round']}, 'positions': {'start': 1},
                                        'parameters': [{'id': f'legacy-round-pressure-{row["round"]}', 'target': {'kind': 'pressure'}, 'value': profile}]})
        return result
    points = source.get('points', [])
    if not points or (not source.get('reaction_stages') and any('routes' in point for point in points)) or any(route.get('source') == 'output' for _, route in route_catalog(source)):
        return None
    rounds = source.get('cycles', 1)
    # Keep the common editable parameters authoritative for ordinary point
    # tables, instead of hiding their whole run under equivalent overrides.
    def general_profile(field, increment):
        values = [point[field] for point in points]
        steps = [point.get(increment, 0) for point in points]
        if all(value == values[0] for value in values) and all(step == steps[0] for step in steps):
            return {'mode': 'fixed', 'value': values[0]} if steps[0] == 0 else {
                'mode': 'linear', 'start': values[0], 'path_step': 0, 'round_step': steps[0]}
        if all(step == 0 for step in steps):
            return {'mode': 'list', 'along': 'path', 'values': values}
        return None

    if not any(point.get('round_conditions') for point in points) and len({point.get('pressure_mode', 'fixed') for point in points}) == 1:
        temperature = general_profile('temperature_c', 'temperature_increment_c')
        pressure = {'mode': 'water_saturation'} if points[0].get('pressure_mode') == 'water_saturation' else general_profile('pressure_bar', 'pressure_increment_bar')
        if temperature is not None and pressure is not None:
            return {'version': 1, 'positions': len(points), 'rounds': rounds, 'parameters': [
                {'id': 'legacy-temperature', 'target': {'kind': 'temperature'}, 'value': temperature},
                {'id': 'legacy-pressure', 'target': {'kind': 'pressure'}, 'value': pressure}], 'overrides': []}
    result = {'version': 1, 'positions': len(points), 'rounds': rounds, 'parameters': [
        {'id': 'legacy-temperature', 'target': {'kind': 'temperature'}, 'value': {'mode': 'fixed', 'value': points[0]['temperature_c']}},
        {'id': 'legacy-pressure', 'target': {'kind': 'pressure'}, 'value': {'mode': 'fixed', 'value': points[0]['pressure_bar']}}], 'overrides': []}
    # Each point gets disjoint round intervals. The final open-ended interval
    # retains the old increments when the user later increases the round count;
    # saved future round conditions remain explicit, inactive scopes.
    for inner, point in enumerate(points):
        conditions = sorted(point.get('round_conditions', []), key=lambda row: row['round'])
        seen = set()
        for row in conditions:
            _check(type(row.get('round')) is int and 1 <= row['round'] <= 10000 and row['round'] not in seen, '指定轮次须唯一，并为 1–10,000 的整数')
            seen.add(row['round'])

        def append_segment(start, end=None, condition=None):
            if start > 10000 or end is not None and start > end:
                return
            key = f'legacy-position-{inner+1}-round-{start}'
            if condition is None:
                temperature = {'mode': 'linear', 'start': _arithmetic(point['temperature_c'], (start-1, point.get('temperature_increment_c', 0))),
                               'path_step': 0, 'round_step': point.get('temperature_increment_c', 0)}
                pressure = {'mode': 'water_saturation'} if point.get('pressure_mode') == 'water_saturation' else {
                    'mode': 'linear', 'start': _arithmetic(point['pressure_bar'], (start-1, point.get('pressure_increment_bar', 0))),
                    'path_step': 0, 'round_step': point.get('pressure_increment_bar', 0)}
            else:
                temperature = {'mode': 'fixed', 'value': condition['temperature_c']}
                pressure = {'mode': 'water_saturation'} if condition.get('pressure_mode', 'fixed') == 'water_saturation' else {'mode': 'fixed', 'value': condition['pressure_bar']}
            result['overrides'].append({'id': key, 'rounds': {'start': start, **({'end': end} if end is not None else {})},
                'positions': {'start': inner+1, 'end': inner+1}, 'parameters': [
                    {'id': key+'-temperature', 'target': {'kind': 'temperature'}, 'value': temperature},
                    {'id': key+'-pressure', 'target': {'kind': 'pressure'}, 'value': pressure}]})

        previous = 1
        for row in conditions:
            append_segment(previous, row['round']-1)
            append_segment(row['round'], row['round'], row)
            previous = row['round']+1
        append_segment(previous)
    return result
