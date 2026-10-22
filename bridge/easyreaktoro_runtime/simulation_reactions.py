"""Reaction inputs depend on their position, never on execution order alone."""
from .errors import require

STAGE_KEYS = ('first_start', 'first_following', 'later_start', 'later_following')
STAGE_LABELS = {'first_start': '首次起点', 'first_following': '首轮后续位置',
                'later_start': '后续轮起点', 'later_following': '后续轮其余位置'}
STAGE_LABELS_EN = {'first_start': 'First start', 'first_following': 'Following positions in first round',
                   'later_start': 'Start of later rounds', 'later_following': 'Following positions in later rounds'}


def reaction_stage(cycle, index):
    return ('first_start' if index == 0 else 'first_following') if cycle == 0 else ('later_start' if index == 0 else 'later_following')


def active_reaction_stages(inner_count, outer_count, lengths=None):
    lengths = [inner_count]*outer_count if lengths is None else lengths
    used = {reaction_stage(outer, inner) for outer, count in enumerate(lengths)
            for inner in range(min(count, 2))}
    return tuple(key for key in STAGE_KEYS if key in used)


def normalize_reaction_stages(cfg):
    stages = cfg.get('reaction_stages')
    if stages is None:
        cfg.pop('reaction_stages', None)
        return
    require(isinstance(stages, dict) and set(stages) == set(STAGE_KEYS), 'SIMULATION_INPUT', 'error.simulationInput', '反应物料设置须包含四类位置')
    used = set()
    for stage in STAGE_KEYS:
        rows = stages[stage]
        require(isinstance(rows, list) and len(rows) <= 30, 'SIMULATION_INPUT', 'error.simulationInput', f'{STAGE_LABELS[stage]}最多设置 30 条物料来源')
        for route in rows:
            require(isinstance(route, dict), 'SIMULATION_INPUT', 'error.simulationInput', '物料来源规则须为对象')
            require(route.get('when', 'always') == 'always', 'SIMULATION_INPUT', 'error.simulationInput', f'{STAGE_LABELS[stage]}已明确反应位置；请将物料放到对应反应位置，不要另外限制使用轮次')
            if 'id' in route:
                key = route['id']
                require(isinstance(key, str) and bool(key.strip()) and key not in used, 'SIMULATION_INPUT', 'error.simulationInput', '四类位置中的物料规则 ID 须唯一且非空')
                used.add(key)
    for stage in STAGE_KEYS:
        for i, route in enumerate(stages[stage]):
            if 'id' not in route:
                key, suffix = f'{stage}-route-{i+1}', 1
                while key in used:
                    key, suffix = f'{stage}-route-{i+1}-{suffix}', suffix+1
                route['id'] = key
                used.add(key)


def reaction_routes(cfg, cycle, index):
    stages = cfg.get('reaction_stages')
    if stages is not None:
        return stages[reaction_stage(cycle, index)]
    if cfg.get('schedule') or cfg.get('loops'):
        return cfg['routes']
    return cfg['points'][index].get('routes', cfg['routes'])


def route_catalog(cfg, language="zh"):

    """Axis bindings see active definitions only; retained old rules are not targets."""
    stages = cfg.get('reaction_stages')
    labels, source = (STAGE_LABELS_EN, "Source") if language == "en" else (STAGE_LABELS, "来源")
    if stages is not None:
        return [(f'{labels[stage]} · {source} {i+1}', route) for stage in STAGE_KEYS for i, route in enumerate(stages[stage])]
    return [(f'{source} {i+1}', route) for i, route in enumerate(cfg.get('routes', []))]
