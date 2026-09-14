"""Executable, inspectable notebook cells, derived from the shipped solver.

Parsing and loading never execute user code. Only the isolated run worker calls
execute_program, with a fresh namespace for every run.
"""
from __future__ import annotations
import copy
import hashlib
import inspect
import json
import math
import textwrap
import traceback

PROGRAM_IDS = ('runtime', 'build', 'states', 'equilibrium', 'inventory', 'collect', 'process', 'execute')


def program_cells():
    from .simulation import Simulation
    from .simulation_process import ProcessInventory
    from .simulation_code import CELL_FIELDS
    bind_parameters = 'snapshot = copy.deepcopy(snapshot)\nsnapshot["config"].update({\n' + ''.join(f'    {name!r}: ' + (f"locals().get({name!r}, snapshot['config'].get({name!r}))" if name in ('schedule', 'loops', 'points', 'cycles', 'reaction_stages', 'routes') else name) + ',\n' for names in CELL_FIELDS.values() for name in names) + '})\n'
    def methods(*names):
        chunks = []
        for name in names:
            source = textwrap.dedent(inspect.getsource(getattr(Simulation, name)))
            source = source.replace('from .', 'from easyreaktoro_runtime.')
            chunks.append(source + f'\nSimulationProgram.{name} = {name}\n')
        return '\n'.join(chunks)
    definitions = [
        ('runtime', '运行环境', '导入计算工具，建立本次运行的类；参数来自上面的六个模块。',
         'import copy\nimport math\nfrom easyreaktoro_runtime.errors import BridgeError, require\n'
         'from easyreaktoro_runtime.simulation import normalize_config, required_records, phase_of\n'
         'from easyreaktoro_runtime.simulation_process import actual_point, resolve_source, route_active, route_species\n\n'
         'from easyreaktoro_runtime.simulation_loops import execution_config, LoopPlan\n\n'
         '# snapshot, progress, emit and output_directory are supplied by this isolated calculation process.\n'
         '# snapshot contains a copy of the calculation database; emit immediately saves each complete result point to the selected folder.\n'
         + bind_parameters + '\nclass SimulationProgram:\n    pass\n'),
        ('build', '建立体系与求解器', '从数据库建立各相、活度模型、ChemicalSystem 和 EquilibriumSolver，并换算投料单位。', methods('__init__')),
        ('states', '初始状态与组分', '建立 ChemicalState；组分由实际投料计算，数值初猜不改变物料约束。', methods('vector', 'component_amounts', 'state')),
        ('equilibrium', '平衡求解', '设置温压、组分约束并调用 solver.solve；检查收敛、非负量与守恒，必要时渐进初始化。', methods('solve', 'bootstrap')),
        ('inventory', '物料分配与库存', '按来源和比例组装每一点的物料，记录累计输入、转移和剩余库存。', textwrap.dedent(inspect.getsource(ProcessInventory)).replace('from .', 'from easyreaktoro_runtime.')),
        ('collect', '提取结果', '从 ChemicalProps / AqueousProps 读取物种量、活度、pH 与守恒记录。', methods('safe', 'collect')),
        ('process', '反应推进与物料传递', '按轮次和路径位置接收物料，求平衡，再保存完整结果点。可在这里修改实际计算逻辑。', methods('run')),
        ('execute', '运行并保存', '实例化上述程序并运行；emit 逐点保存，应用在结束或中断后生成表格和结果预览。',
         '# Each run executes all modules in order from the first, in a fresh Python namespace.\nsimulation = SimulationProgram(snapshot, progress)\nmetadata = simulation.run(emit)\n'),
    ]
    return [{'id': i, 'title': t, 'description': d, 'kind': 'execution', 'source': s, 'baseline_source': s}
            for i, t, d, s in definitions]


def execution_identity(document):
    default = {c['id']: c['source'] for c in program_cells()}
    cells = [c for c in document['cells'] if c['id'] in PROGRAM_IDS]
    changed = [c['id'] for c in cells if c['source'] != default[c['id']]]
    content = json.dumps([(c['id'], c['source']) for c in document['cells']], ensure_ascii=False).encode()
    return {'mode': 'custom' if changed else 'standard', 'changed_cells': changed,
            'sha256': hashlib.sha256(content).hexdigest()}


def syntax_issues(cells):
    errors = []
    for cell in cells:
        if cell['id'] not in PROGRAM_IDS:
            continue
        try:
            compile(cell['source'], f"cell:{cell['id']}", 'exec')
        except (SyntaxError, ValueError, RecursionError) as exc:
            errors.append({'cell_id': cell['id'], 'line': getattr(exc, 'lineno', 1),
                           'column': getattr(exc, 'offset', 1), 'message': str(exc)})
    return errors


def prepare_program(config, editor=None):
    from .simulation_code import parse_code, render_code, validate_editor, CELL_FIELDS
    from .errors import require
    from .simulation_process import migrate_config
    config = migrate_config(config)
    for key, default in {'gas_model': 'ideal', 'bootstrap': True, 'balance_tolerance_mol': 1e-10,
                         'ion_size_overrides': {}, 'allow_database_defaults': False,
                         'allow_recorded_assignments': False}.items():
        config.setdefault(key, default)
    if editor is not None:
        editor = validate_editor(editor)
    previous = editor and editor.get('document')
    # In UI mode, regenerate only changed parameter cells; always keep custom logic.
    if previous and editor['mode'] == 'code':
        checked = parse_code(previous, config)
        require(checked['valid'], 'SIMULATION_CODE', 'error.simulationInput',
                json.dumps(checked.get('errors', []), ensure_ascii=False))
        config = checked['config']
    document = render_code(config, {'cells': previous['cells'], 'config': editor['config']} if previous else None)
    # A code-mode draft is the authority for its parameter text and comments.
    if previous and editor['mode'] == 'code':
        old = {c['id']: c['source'] for c in previous['cells']}
        for cell in document['cells']:
            if cell['id'] in CELL_FIELDS and cell['id'] in old:
                cell['source'] = old[cell['id']]
    checked = parse_code(document, config)
    require(checked['valid'], 'SIMULATION_CODE', 'error.simulationInput',
            json.dumps(checked.get('errors', []), ensure_ascii=False))
    return checked['config'], document, execution_identity(document)


def readable_program(document):
    return '# EasyReaktoro Python program. Run with the EasyReaktoro runtime context.\n\n' + '\n'.join(
        f"# %% {c['title']} [{c['id']}]\n{c['source']}\n" for c in document['cells'])


def execute_program(document, snapshot, progress, emit, output_directory, namespace):
    from .simulation_loops import execution_config, LoopPlan
    namespace.update(__name__='__easyreaktoro_run__', snapshot=copy.deepcopy(snapshot),
                     progress=progress, emit=emit, output_directory=output_directory,
                     execution_config=execution_config, LoopPlan=LoopPlan)
    # Older custom runtime cells can refer to retained legacy coordinates even
    # when the visible conditions cell now defines only the active loops.
    namespace.update({name: copy.deepcopy(snapshot['config'].get(name)) for name in ('schedule', 'loops', 'points', 'cycles', 'reaction_stages', 'routes')})
    for cell in document['cells']:
        progress(code_cell=cell['id'], code_cell_title=cell['title'])
        exec(compile(cell['source'], f"cell:{cell['id']}", 'exec'), namespace)
    if not isinstance(namespace.get('metadata'), dict):
        raise ValueError('运行模块须生成 metadata 字典；请保留结果接口。')
    return namespace['metadata']


def code_diagnostic(exc, document):
    names = {c['id']: c['title'] for c in document['cells']}
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename.startswith('cell:')]
    if not frames:
        return str(exc)
    frame = frames[-1]
    return f"{names.get(frame.filename[5:], frame.filename[5:])} · 第 {frame.lineno} 行：{type(exc).__name__}: {exc}"


def validate_record(record, index, schemas=None):
    """Keep invalid custom output out of the durable result stream."""
    if not isinstance(record, dict) or not isinstance(record.get('summary'), dict):
        raise ValueError('emit 需要含 summary、species、balances 的完整结果点。')
    if index >= 20000 or not isinstance(record.get('species'), list) or not 1 <= len(record['species']) <= 500:
        raise ValueError('结果最多包含 20,000 个点，每点 1–500 个物种。')
    summary = record['summary']
    required = ('run_index', 'pass', 'step', 'temperature_c', 'pressure_bar')
    if any(k not in summary for k in required) or type(summary['run_index']) is not int or summary['run_index'] != index:
        raise ValueError(f'结果点 run_index 必须从 0 连续递增；当前应为 {index}。')
    if any(type(summary[k]) is not int or summary[k] < 1 for k in ('pass', 'step')):
        raise ValueError('结果点的 pass 和 step 必须是正整数。')
    for kind, keys in [('species', ('species', 'phase_type', 'run_index', 'amount_mol')),
                       ('balances', ('component', 'input_mol', 'output_mol', 'error_mol'))]:
        if not isinstance(record.get(kind), list) or any(not isinstance(row, dict) or any(k not in row for k in keys) for row in record[kind]):
            raise ValueError(f'结果点的 {kind} 表不完整。')
    names = [row['species'] for row in record['species']]
    if any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
        raise ValueError('一个结果点的物种名称不能重复或为空。')
    for row in record['species']:
        if row['phase_type'] not in ('aqueous', 'mineral', 'gas') or row['run_index'] != index:
            raise ValueError('物种结果的相态或 run_index 无效。')
    def number(value, label, minimum=None):
        if type(value) not in (int, float) or not math.isfinite(value) or (minimum is not None and value < minimum):
            raise ValueError(f'{label} 需要有效的有限数值。')
    number(summary['temperature_c'], 'temperature_c', -273.149999)
    number(summary['pressure_bar'], 'pressure_bar', 1e-9)
    number(summary.get('max_component_balance_error_mol'), 'max_component_balance_error_mol', 0)
    for row in record['species']:
        if not isinstance(row['species'], str) or not row['species']:
            raise ValueError('物种名称必须为非空字符串。')
        number(row['amount_mol'], 'amount_mol', 0)
    for row in record['balances']:
        for key in ('input_mol', 'output_mol', 'error_mol'):
            number(row[key], key)
    ledger = record.get('process_balance', [])
    if not isinstance(ledger, list):
        raise ValueError('process_balance 需要列表。')
    for row in ledger:
        if not isinstance(row, dict) or not isinstance(row.get('component'), str):
            raise ValueError('累计守恒记录需要组分名称。')
        for key in ('input_mol', 'inventory_mol', 'error_mol'):
            number(row.get(key), key)
    transfers = record.get('transfers', [])
    if not isinstance(transfers, list):
        raise ValueError('transfers 需要列表。')
    for transfer in transfers:
        if not isinstance(transfer, dict) or not isinstance(transfer.get('source'), str) or not isinstance(transfer.get('amounts_mol'), dict):
            raise ValueError('转移记录需要 source 和 amounts_mol 字典。')
        number(transfer.get('fraction'), 'fraction', 0)
        for name, value in transfer['amounts_mol'].items():
            if not isinstance(name, str):
                raise ValueError('转移物种名称必须为字符串。')
            number(value, 'amounts_mol', 0)
    json.dumps(record, allow_nan=False)
    if schemas is not None:
        candidate = dict(schemas)
        row_groups = [('summary', [summary]), ('component_balance', record['balances']),
                      ('process_balance', record.get('process_balance', []))]
        row_groups.extend((phase, [r for r in record['species'] if r['phase_type'] == phase]) for phase in ('aqueous', 'mineral', 'gas'))
        for kind, rows in row_groups:
            if not isinstance(rows, list):
                raise ValueError(f'{kind} 需要列表。')
            for row in rows:
                if not isinstance(row, dict) or candidate.setdefault(kind, set(row)) != set(row):
                    raise ValueError(f'{kind} 的列在本次运行中须保持一致；请对暂缺值使用 None。')
        schemas.update(candidate)
