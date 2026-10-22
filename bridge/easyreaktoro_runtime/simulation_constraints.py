"""Explicit equilibrium targets and signed exchanges with external reservoirs.

An exchange formula is a conserved-component vector, not an added equilibrium
species. Nothing here supplies finite material or changes the selected phases.
"""
from __future__ import annotations
import math
from .errors import BridgeError, require


def check(ok, message):
    require(ok, 'EQUILIBRIUM_CONSTRAINT', 'error.simulationInput', message)


def active_at(row, outer, inner, rounds, positions):
    from .simulation_schedule import scope_indices
    return outer in scope_indices(row.get('rounds', {'start': 1}), rounds) and inner in scope_indices(row.get('positions', {'start': 1}), positions)


def normalize_constraints(cfg):
    """Structural validation; inactive values/references remain editable drafts."""
    rows = cfg.get('equilibrium_constraints')
    if rows is None:
        cfg.pop('equilibrium_constraints', None)
        return []
    check(isinstance(rows, list), '平衡约束须为列表')
    if not rows:
        return []
    from .simulation_loops import execution_shape
    from .simulation_schedule import scope_indices
    positions, rounds = execution_shape(cfg)
    ids, output_fields = set(), set()
    for row in rows:
        check(isinstance(row, dict), '平衡约束格式无效')
        kind = row.get('kind')
        check(kind in ('ph', 'fugacity'), '请选择 pH 或气体逸度约束')
        fields = {'id', 'kind', 'value'} | ({'titrant', 'exchange'} if kind == 'ph' else {'species'})
        check(fields <= set(row) <= fields | {'rounds', 'positions'}, '平衡约束字段不完整或无法识别')
        key = row['id']
        check(isinstance(key, str) and bool(key.strip()) and key not in ids, '平衡约束编号须唯一且非空')
        ids.add(key)
        columns = {'constraint_'+key+'_'+suffix for suffix in ('target', 'actual', 'exchange_mol', 'cumulative_exchange_mol')}
        check(not output_fields.intersection(columns), '平衡约束编号会产生重复结果列，请使用不同编号')
        output_fields.update(columns)
        if kind == 'ph':
            check(isinstance(row['titrant'], str), '请填写中性滴定物质的化学式')
            check(row['exchange'] in ('add_only', 'both'), '滴定方式请选择只加入或允许加入与移除')
        else:
            check(isinstance(row['species'], str), '请选择参考气体 species')
        scope_indices(row.get('rounds', {'start': 1}), rounds)
        scope_indices(row.get('positions', {'start': 1}), positions)
    return rows


def active_definitions(cfg):
    from .simulation_loops import execution_shape
    from .simulation_schedule import scope_indices
    positions, rounds = execution_shape(cfg)
    return [row for row in cfg.get('equilibrium_constraints', [])
            if scope_indices(row.get('rounds', {'start': 1}), rounds) and scope_indices(row.get('positions', {'start': 1}), positions)]


def constraint_value(row, plan, outer, inner):
    identity = ('equilibrium_constraint', row['id'])
    values = getattr(plan, '_arrays', {}).get(identity)
    value = values[outer * plan.positions + inner] if values is not None else row['value']
    check(type(value) in (int, float) and math.isfinite(value), f"第 {outer+1} 轮、位置 {inner+1} 的 {row['id']} 目标值须为有限数")
    check(row['kind'] != 'fugacity' or value > 0, '气体逸度必须大于零，单位为 bar')
    return float(value)


def reference_species(cfg):
    return [row['species'] for row in active_definitions(cfg) if row['kind'] == 'fugacity']


def validate_constraints(cfg, records, plan=None):
    """Validate active definitions and every effective target before solving."""
    rows = normalize_constraints(cfg)
    if not rows:
        return
    import reaktoro as r
    import numpy as np
    from .simulation_loops import execution_shape
    from .simulation_schedule import scope_indices
    positions, rounds = execution_shape(cfg)
    lookup = {}
    for record in records:
        lookup.setdefault(record['name'], []).append(record)
    selected = [lookup[n][0] for n in cfg['species']]
    elements = sorted({e for rec in selected for e in rec['composition']})
    # Exchange material must be representable by the selected system; matching
    # element names alone is insufficient (e.g. a system containing only H2O).
    matrix = np.array([[rec['composition'].get(e, 0) for rec in selected] for e in elements] + [[rec.get('charge', 0) for rec in selected]], dtype=float)
    vectors, domains = {}, {}
    for row in active_definitions(cfg):
        label = row['id']
        if row['kind'] == 'ph':
            protons = [rec for rec in selected if rec['state'] == 'Aqueous' and rec.get('composition') == {'H': 1} and rec.get('charge') == 1]
            check(len(protons) == 1, '固定 pH 需要在体系中选择唯一的水相 H⁺ species')
            try:
                formula = r.ChemicalFormula(row['titrant'])
                composition = dict(zip(formula.symbols(), formula.coefficients()))
                charge = float(formula.charge())
            except Exception as exc:
                raise BridgeError('EQUILIBRIUM_CONSTRAINT', 'error.simulationInput', f"无法读取滴定物质化学式：{row['titrant']}") from exc
            check(composition and charge == 0 and all(math.isfinite(v) and v > 0 for v in composition.values()), 'pH 滴定物质须为有明确元素组成的中性化学式；不会自动补入反离子')
        else:
            found = lookup.get(row['species'], [])
            check(len(found) == 1 and not found[0].get('disabled') and found[0].get('state') == 'Gas' and found[0].get('charge', 0) == 0, f"{row['species']} 须为当前数据库中唯一、可计算的中性气体记录")
            composition, charge = found[0]['composition'], 0
        check(set(composition) <= set(elements), f'{label} 的交换物质包含当前体系没有的元素，请先补充允许参与平衡的 species')
        vector = np.array([composition.get(e, 0) for e in elements] + [charge], dtype=float)
        coefficients = np.linalg.lstsq(matrix, vector, rcond=None)[0]
        check(np.max(np.abs(matrix @ coefficients-vector)) <= 1e-10 * max(1, np.max(np.abs(vector))), f'{label} 的交换组成无法由所选 species 表示，请补充相应 species')
        vectors[label] = vector
        domains[label] = (scope_indices(row.get('rounds', {'start': 1}), rounds), scope_indices(row.get('positions', {'start': 1}), positions))
    checked_sets = set()
    for outer in range(rounds):
        for inner in range(positions):
            if hasattr(plan, 'active') and not plan.active(outer, inner): continue
            active = [row for row in rows if row['id'] in domains and outer in domains[row['id']][0] and inner in domains[row['id']][1]]
            for row in active:
                constraint_value(row, plan, outer, inner)
            signature = tuple(row['id'] for row in active)
            if signature in checked_sets:
                continue
            checked_sets.add(signature)
            check(sum(row['kind'] == 'ph' for row in active) <= 1, '同一位置不能同时指定多个 pH 目标，请调整适用范围')
            gases = [row['species'] for row in active if row['kind'] == 'fugacity']
            check(len(gases) == len(set(gases)), '同一位置不能重复约束同一个气体的逸度')
            if active:
                vectors_here = np.column_stack([vectors[row['id']] for row in active])
                check(np.linalg.matrix_rank(vectors_here) == len(active), '这些约束依赖相同或相互重复的交换组成，无法独立调节；请减少约束或改选滴定物质')


def field_info(cfg):
    result = {}
    for row in cfg.get('equilibrium_constraints', []):
        label = f"pH · {row['titrant']}" if row['kind'] == 'ph' else f"f({row['species']})"
        unit = '' if row['kind'] == 'ph' else 'bar'
        prefix = f"constraint_{row['id']}_"
        for suffix, zh, en, units in [('target', '目标', 'Target', unit), ('actual', '实际', 'Actual', unit),
                                     ('exchange_mol', '本点净交换', 'Net exchange at this point', 'mol'),
                                     ('cumulative_exchange_mol', '累计净交换', 'Cumulative net exchange', 'mol')]:
            result[prefix+suffix] = [label+' · '+zh, label+' · '+en, units]
    return result


def ph_residual(species_index, input_index):
    return lambda props, w: -props.speciesActivityLg(species_index)-w[input_index]


class ConstraintEngine:
    """Cache solver specifications by active set, not by target value."""
    def __init__(self, sim):
        self.sim = sim
        self.rows = sim.cfg.get('equilibrium_constraints', [])
        self.positions, self.rounds = len(sim.cfg['points']), sim.cfg['cycles']
        self.cache = {}
        self.cumulative = {row['id']: 0.0 for row in self.rows}
        self.last = []
        self.exchange = sim.np.zeros(len(sim.components))

    def for_point(self, point):
        if not self.rows:
            return []
        outer = point.get('_outer', 0 if self.rounds == 1 else None)
        indices = {row['id']: index for index, row in enumerate(self.sim.cfg['points'])}
        inner = point.get('_inner', indices.get(point.get('id'), 0 if self.positions == 1 else None))
        check(type(outer) is int and type(inner) is int and 0 <= outer < self.rounds and 0 <= inner < self.positions,
              '无法确定此点的轮次与位置，不能应用平衡约束；请保留标准反应推进模块或明确传入点坐标')
        rows = [row for row in self.rows if active_at(row, outer, inner, self.rounds, self.positions)]
        return [(row, constraint_value(row, self.sim.loop_plan, outer, inner)) for row in rows]

    def prepare(self, point):
        sim, r = self.sim, self.sim.r
        active = self.for_point(point)
        signature = tuple(row['id'] for row, _ in active)
        self.last, self.exchange = [], sim.np.zeros(len(sim.components))
        if not signature:
            return sim.specs, sim.solver, active
        if signature not in self.cache:
            specs = r.EquilibriumSpecs(sim.system)
            specs.temperature(); specs.pressure()
            for row, _ in active:
                if row['kind'] == 'ph':
                    proton = next(n for n in sim.groups['aqueous'] if sim.records[n]['composition'] == {'H': 1} and sim.records[n].get('charge') == 1)
                    species_index = sim.indices[proton]
                    input_index = specs.addInput('constraint_'+row['id'])
                    equation = r.EquationConstraint()
                    equation.id = 'constraint_'+row['id']
                    equation.fn = r.EquationConstraintFn(ph_residual(species_index, input_index))
                    specs.addConstraint(equation)
                    specs.openTo(row['titrant'])
                else:
                    specs.fugacity(row['species'])
            solver = r.EquilibriumSolver(specs)
            options = r.EquilibriumOptions(); options.epsilon = 1e-30
            solver.setOptions(options)
            self.cache[signature] = (specs, solver)
        specs, solver = self.cache[signature]
        return specs, solver, active

    def validate_input(self, target_components, active):
        if not active:
            return
        sim = self.sim
        columns = []
        for row, _ in active:
            if row['kind'] == 'ph':
                formula = sim.r.ChemicalFormula(row['titrant'])
                composition = dict(zip(formula.symbols(), formula.coefficients()))
            else:
                composition = sim.records[row['species']]['composition']
            columns.append([composition.get(e, 0) for e in sim.components])
        matrix = sim.np.asarray(columns, dtype=float).T
        projection = matrix @ sim.np.linalg.lstsq(matrix, target_components, rcond=None)[0]
        scale = float(sim.np.max(sim.np.abs(target_components)))
        roundoff = sim.np.finfo(float).eps * max(matrix.shape) * scale * 10
        check(float(sim.np.max(sim.np.abs(target_components-projection))) > roundoff,
              '当前所有输入组成都可以与外界交换，缺少封闭组分确定物质总量；请减少外部交换约束或保留不会被交换的物料组成')

    def set_conditions(self, conditions, active):
        for row, value in active:
            if row['kind'] == 'ph':
                conditions.set('constraint_'+row['id'], value)
                if row['exchange'] == 'add_only':
                    # Reaktoro 2.13 stores the explicit control variable with
                    # the opposite sign to reported titrantAmount (input).
                    conditions.setUpperBoundTitrant('['+row['titrant']+']', 0.0, 'mol')
            else:
                conditions.fugacity(row['species'], value, 'bar')

    def audit(self, work, active):
        sim, r, np = self.sim, self.sim.r, self.sim.np
        props = r.ChemicalProps(work)
        exchange, rows = np.zeros(len(sim.components)), []
        for row, target in active:
            if row['kind'] == 'ph':
                formula = r.ChemicalFormula(row['titrant'])
                composition = dict(zip(formula.symbols(), formula.coefficients()))
                amount = float(work.equilibrium().titrantAmount(row['titrant']))
                proton = next(n for n in sim.groups['aqueous'] if sim.records[n]['composition'] == {'H': 1} and sim.records[n].get('charge') == 1)
                actual = -float(props.speciesActivityLg(proton))
                residual = actual-target
                check(abs(residual) <= 1e-6, f'pH 未达到目标：目标 {target:g}，实际 {actual:g}')
                check(row['exchange'] != 'add_only' or amount >= -sim.tolerance, f"此 pH 目标需要移除 {row['titrant']}；当前仅允许加入，请改变目标或交换方式")
                substance = row['titrant']
            else:
                gas = sim.database.species(row['species'])
                composition = sim.records[row['species']]['composition']
                substance = str(gas.formula())
                # Reaktoro 2.13 names this implicit titrant by gas species.
                amount = float(work.equilibrium().titrantAmount(row['species']))
                vector = np.array([composition.get(e, 0) for e in sim.components], dtype=float)
                # Reconstruct reservoir chemical potential from a basis of
                # present equilibrium species, never from the requested target.
                # Aqueous, gas and mineral phases use the same element balance.
                basis, rank = [], 0
                amounts = np.asarray(work.speciesAmounts(), dtype=float)
                for index in np.argsort(-amounts):
                    if amounts[index] <= 0:
                        continue
                    candidate = basis+[int(index)]
                    new_rank = np.linalg.matrix_rank(sim.formula[:, candidate])
                    if new_rank > rank:
                        basis, rank = candidate, new_rank
                coefficients = np.linalg.lstsq(sim.formula[:, basis], vector, rcond=None)[0]
                check(np.max(np.abs(sim.formula[:, basis] @ coefficients-vector)) <= 1e-9, f"无法从当前平衡组成核对 {row['species']} 逸度；必要物质可能已耗尽")
                chemical_potential = float(coefficients @ np.asarray(props.speciesChemicalPotentials(), dtype=float)[basis])
                standard = float(gas.props(props.temperature(), props.pressure()).G0)
                log_actual = (chemical_potential-standard)/(float(r.universalGasConstant)*float(props.temperature()))
                residual = log_actual-math.log(target)
                check(math.isfinite(residual) and abs(residual) <= 1e-6, f"{row['species']} 逸度未达到目标 {target:g} bar")
                actual = math.exp(log_actual)
            check(math.isfinite(amount), '外部交换量不是有限数')
            exchange += np.array([composition.get(e, 0) for e in sim.components], dtype=float)*amount
            rows.append({'constraint_id': row['id'], 'kind': row['kind'], 'subject': row.get('species', row.get('titrant')),
                         'target': target, 'actual': actual, 'unit': '' if row['kind'] == 'ph' else 'bar',
                         'residual': residual, 'residual_kind': 'pH_difference' if row['kind'] == 'ph' else 'ln_f_ratio',
                         'exchange_formula': substance, 'exchange_mol': amount})
        self.last, self.exchange = rows, exchange
        return exchange

    def collect(self, summary):
        """Commit exchange only for accepted full points, never bootstrap trials."""
        for row in self.last:
            self.cumulative[row['constraint_id']] += row['exchange_mol']
            row['cumulative_exchange_mol'] = self.cumulative[row['constraint_id']]
        found = {row['constraint_id']: row for row in self.last}
        for definition in self.rows:
            key = definition['id']; row = found.get(key)
            prefix = 'constraint_'+key+'_'
            summary.update({prefix+'target': row['target'] if row else None, prefix+'actual': row['actual'] if row else None,
                            prefix+'exchange_mol': row['exchange_mol'] if row else 0.0,
                            prefix+'cumulative_exchange_mol': self.cumulative[key]})
        return [dict(row) for row in self.last]
