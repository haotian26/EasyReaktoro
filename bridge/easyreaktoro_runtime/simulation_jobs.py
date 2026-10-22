"""Isolated calculations with durable user-selected run directories."""
from __future__ import annotations
import atexit
import base64
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

from .errors import require
from .simulation_storage import atomic_json, records, rebuild_tables, explorer_payload, packed_payload, write_explorer
from .simulation_loops import execution_shape, LoopPlan

PREVIEW_SPECIES_ROWS = 500_000


def result_folder_name(name):
    """Keep readable names while making one portable path component."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', '_', str(name)).strip(' .') or '平衡模拟'
    if re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', name, re.IGNORECASE):
        name = '_' + name
    while len(name.encode('utf-8')) > 240:
        name = name[:-1]
    return name


def create_result_folder(parent, name):
    path = parent / result_folder_name(name)
    try:
        path.mkdir()  # One atomic reservation; an existing file or symlink also collides.
    except FileExistsError:
        require(False, 'SIMULATION_EXISTS', 'error.simulationInput',
                f'“{path.name}”已存在。请修改模拟名称或选择其他保存位置。')
    return path


def result_destination(parent, name):
    """Describe a collision before the user chooses how to save this result."""
    parent = Path(parent).expanduser().resolve()
    require(parent.is_dir(), 'SIMULATION_DIRECTORY', 'error.simulationInput', '请先选择一个现有文件夹保存本次计算')
    path = parent / result_folder_name(name)
    info = {'path': str(path), 'name': path.name, 'exists': path.exists() or path.is_symlink(), 'can_overwrite': False}
    if not info['exists']:
        return info
    index = 2
    while (parent / result_folder_name(f'{name} {index}')).exists():
        index += 1
    info['suggested_name'] = result_folder_name(f'{name} {index}')
    try:
        require(path.is_dir() and not path.is_symlink(), 'SIMULATION_FILE', 'error.simulationInput', '此位置不是计算结果文件夹，请另存为其他名称。')
        manifest = path / 'run.json'
        require(not manifest.is_symlink(), 'SIMULATION_FILE', 'error.simulationInput', '此位置不是可替换的计算结果文件夹，请另存。')
        raw = manifest.read_bytes()
        run = json.loads(raw)
        require(run.get('format') == 'easyreaktoro-run' and run.get('schema_version') == 1, 'SIMULATION_FILE', 'error.simulationInput', '此文件夹包含其他内容，请另存为其他名称。')
        status_path = path / 'status.json'
        if status_path.exists():
            require(not status_path.is_symlink(), 'SIMULATION_FILE', 'error.simulationInput', '结果状态文件不可使用符号链接，请另存。')
            report = json.loads(status_path.read_bytes())
            require(report.get('status') != 'running', 'SIMULATION_RUNNING', 'error.simulationInput', '此结果尚未结束。请先打开结果确认状态，或另存为其他名称。')
        require(not (path / 'worker.lock').is_symlink(), 'SIMULATION_FILE', 'error.simulationInput', '计算占用文件不可使用符号链接，请另存。')
        if (path / 'worker.lock').exists():
            with (path / 'worker.lock').open('r') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    require(False, 'SIMULATION_RUNNING', 'error.simulationInput', '此结果仍在计算，请等待结束或另存。')
        stamp = path.stat()
        # A decision applies only to the folder/run that was shown to the user.
        info.update(can_overwrite=True, overwrite_token=hashlib.sha256(raw + f'{stamp.st_dev}:{stamp.st_ino}:{stamp.st_mtime_ns}'.encode()).hexdigest())
    except Exception as error:
        info['reason'] = str(error)
    return info


def reserve_result_folder(parent, name, overwrite_token=None):
    info = result_destination(parent, name)
    if not overwrite_token:
        return create_result_folder(Path(parent), name), None
    require(info['exists'] and info['can_overwrite'] and info.get('overwrite_token') == overwrite_token,
            'SIMULATION_EXISTS', 'error.simulationInput', '保存位置已经变化，请重新选择覆盖或另存为。')
    path = Path(info['path'])
    backup = path.with_name('.' + path.name + '.replaced-' + uuid.uuid4().hex)
    path.rename(backup)
    try:
        path.mkdir()
    except Exception:
        backup.rename(path)
        raise
    return path, backup


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def database_source(handle):
    source = {'kind': handle['kind'], 'name': handle.get('name'), 'group': handle.get('group'),
              'path': handle.get('path'), 'dirty': bool(handle.get('dirty')),
              'required_reaktoro_version': handle.get('meta', {}).get('required_reaktoro_version')}
    source['records_sha256'] = hashlib.sha256(json.dumps(handle['records'], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if source['path'] and Path(source['path']).is_file():
        source['file_sha256'] = digest(source['path'])
    return source


class Jobs:
    def __init__(self):
        self.jobs = {}
        atexit.register(self.close)

    def close(self):
        for job_id, job in list(self.jobs.items()):
            process = job.get('process')
            if process is not None:
                if process.poll() is None:
                    self.cancel(job_id, finalize=False)
                if process.stdin:
                    process.stdin.close()
                job['log'].close()
        self.jobs.clear()  # Saved run files are never deleted on app exit.

    def start(self, handle, config, directory, code_editor=None, result_name=None, overwrite_token=None):
        from .simulation import normalize_config
        source = database_source(handle)
        from .simulation_program import prepare_program, readable_program
        config, program, execution = prepare_program(config, code_editor)
        config, audit = normalize_config(config, handle['records'], source)
        if code_editor is not None:
            from .simulation_code import validate_editor
            code_editor = validate_editor(code_editor)
        require(not any(x.get('process') is not None and x['process'].poll() is None for x in self.jobs.values()), 'SIMULATION_RUNNING', 'error.simulationInput', '已有模拟在运行，请先停止或等待完成')
        parent = Path(directory).expanduser().resolve()
        require(parent.is_dir(), 'SIMULATION_DIRECTORY', 'error.simulationInput', '请先选择一个现有文件夹保存本次计算')
        job_id = uuid.uuid4().hex
        root, replaced = reserve_result_folder(parent, result_name or config['name'], overwrite_token)
        log = None
        try:
            snapshot = {'config': config, 'records': handle['records'], 'source': source, 'program': program, 'execution': execution}
            atomic_json(root/'input.json', snapshot)
            (root/'program.py').write_text(readable_program(program), encoding='utf-8')
            saved_editor = {'version': 1, 'mode': (code_editor or {}).get('mode', 'ui'), 'document': program, 'config': config, 'dirty': False}
            atomic_json(root/'simulation.ersim.json', {'format': 'easyreaktoro-simulation', 'schema_version': 2, 'config': config, 'database': source, 'code_editor': saved_editor})
            atomic_json(root/'run.json', {'format': 'easyreaktoro-run', 'schema_version': 1, 'job_id': job_id, 'created_at': time.time()})
            loop_metadata = {'loop_axes': LoopPlan(config).metadata(), 'field_info': LoopPlan(config).field_info()} if config.get('schedule') or config.get('loops') else {}
            from .simulation_constraints import field_info
            loop_metadata['field_info'] = {**loop_metadata.get('field_info', {}), **field_info(config)}
            atomic_json(root/'metadata.json', {**loop_metadata, 'config': config, 'database': source, 'ion_size_audit': audit, 'process_balance': [], 'partial_results': True, 'execution': execution})
            inner_count, outer_count = execution_shape(config)
            atomic_json(root/'status.json', {'status': 'running', 'stage': 'preparing', 'message': '正在建立计算体系',
                'completed': 0, 'total': LoopPlan(config).total if config.get('schedule') else inner_count * outer_count, 'started_at': time.time(), 'warnings': [], 'execution': execution})
            log = (root/'worker.log').open('w')
            env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
            try:
                process = subprocess.Popen([sys.executable, '-B', '-m', 'easyreaktoro_runtime.simulation_worker', str(root)], stdin=subprocess.PIPE, stdout=log, stderr=log, env=env)
            except Exception as exc:
                log.close()
                status = json.loads((root/'status.json').read_text())
                atomic_json(root/'status.json', {**status, 'status': 'failed', 'message': '计算进程启动失败', 'diagnostic': str(exc), 'finished_at': time.time()})
                raise
        except Exception:
            if log is not None and not log.closed:
                log.close()
            if replaced is not None:
                shutil.rmtree(root)
                replaced.rename(root)
            raise
        if replaced is not None:
            # Startup succeeded and the user explicitly chose replacement.
            try:
                shutil.rmtree(replaced)
            except OSError as error:
                log.write(f'Previous result backup retained at {replaced}: {error}\n');log.flush()
            for old_id, old_job in list(self.jobs.items()):
                if old_job['root'] == root:
                    if old_job.get('log'):
                        old_job['log'].close()
                    self.jobs.pop(old_id, None)
        self.jobs[job_id] = {'root': root, 'process': process, 'log': log, 'source': source, 'config': config, 'ion_size_audit': audit}
        return self.status(job_id)

    def job(self, job_id):
        require(job_id in self.jobs, 'SIMULATION_NOT_FOUND', 'error.simulationInput', '请重新打开已保存的结果文件夹')
        return self.jobs[job_id]

    def open_run(self, path):
        root = Path(path).expanduser().resolve()
        if root.is_file():
            root = root.parent
        require(root.is_dir() and (root/'run.json').is_file(), 'SIMULATION_FILE', 'error.simulationInput', '请选择含 run.json 的 EasyReaktoro 结果文件夹')
        for name in ('run.json', 'status.json', 'metadata.json', 'simulation.ersim.json', 'points.ndjson'):
            require(not (root/name).is_symlink(), 'SIMULATION_FILE', 'error.simulationInput', '结果文件不能使用符号链接')
        manifest = json.loads((root/'run.json').read_text())
        require(manifest.get('format') == 'easyreaktoro-run' and manifest.get('schema_version') == 1 and re.fullmatch('[0-9a-f]{32}', str(manifest.get('job_id', ''))), 'SIMULATION_FILE', 'error.simulationInput', '运行文件格式不支持')
        job_id = manifest['job_id']
        existing = self.jobs.get(job_id)
        if existing and existing['root'] == root and existing.get('process') is not None:
            return self.status(job_id)
        # A copied folder has the same persistent run identity; give this view
        # a unique handle so it cannot replace a currently running job.
        if existing and existing['root'] != root:
            job_id = uuid.uuid4().hex
        settings = json.loads((root/'simulation.ersim.json').read_text())
        metadata = json.loads((root/'metadata.json').read_text())
        report = json.loads((root/'status.json').read_text())
        was_running = report['status'] == 'running'
        if was_running:
            # Opening results is read-only, including stale lock files. A held
            # lock still means another process owns the result and must finish.
            if (root/'worker.lock').exists():
                with (root/'worker.lock').open('r') as worker_lock:
                    try:
                        fcntl.flock(worker_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        require(False, 'SIMULATION_RUNNING', 'error.simulationInput', '此结果仍由另一计算进程写入；请在该进程结束后打开')
        committed = sum(1 for _ in records(root))
        incomplete = committed != report['completed'] or (report['status'] == 'completed' and committed != report['total'])
        if was_running or incomplete:
            message = '上次运行未完成' if was_running else '结果记录不完整'
            report.update(status='interrupted', stage='stopped', completed=committed,
                          message=f'{message}，当前显示 {committed} 个完整保存的点；源文件未改动')
            report.setdefault('finished_at', (root/'status.json').stat().st_mtime)
        job = {'root': root, 'process': None, 'source': settings.get('database', {}), 'config': settings['config'],
               'ion_size_audit': metadata.get('ion_size_audit', []), 'opened_report': report}
        self.jobs[job_id] = job
        # CSV/HTML may be incomplete after a stop. Preview reads the committed
        # NDJSON directly; repairing derived files belongs to an exported copy.
        return self.status(job_id)

    def status(self, job_id):
        job = self.job(job_id)
        report = copy.deepcopy(job['opened_report']) if 'opened_report' in job else json.loads((job['root']/'status.json').read_text())
        process = job.get('process')
        code = process.poll() if process is not None else None
        if process is not None and code is not None and (report['status'] == 'running' or (code != 0 and report['status'] == 'completed')):
            report.update(status='failed', stage='failed', message='计算进程已中断', diagnostic=f'计算进程提前退出（{code}）', finished_at=time.time())
            report['completed'] = sum(1 for _ in self.records(job))
            atomic_json(job['root']/'status.json', report)
            (job['root']/'worker.lock').unlink(missing_ok=True)
        if process is not None and code is None and report['status'] in {'completed', 'failed'}:
            report['status'] = 'running'
            report['stage'] = 'finalizing'
        report['elapsed_seconds'] = max(0, report.get('finished_at', time.time()) - report['started_at'])
        return {**report, 'job_id': job_id, 'source': job['source'], 'output_path': str(job['root']), 'name': job['config']['name']}

    def cancel(self, job_id, finalize=True):
        job = self.job(job_id)
        process = job.get('process')
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            report = json.loads((job['root']/'status.json').read_text())
            if report['status'] != 'completed':
                report.update(status='cancelled', stage='stopped', message='已停止，已完成的点已保存', finished_at=time.time())
                report['completed'] = sum(1 for _ in self.records(job))
                atomic_json(job['root']/'status.json', report)
            (job['root']/'worker.lock').unlink(missing_ok=True)
            if finalize:
                rebuild_tables(job['root'])
                write_explorer(job['root'])
        return self.status(job_id)

    @staticmethod
    def records(job):
        return records(job['root'])

    @staticmethod
    def result_metadata(job):
        metadata = json.loads((job['root']/'metadata.json').read_text())
        last = None
        for last in records(job['root']):
            pass
        metadata['process_balance'] = last.get('process_balance', []) if last else []
        if 'opened_report' in job:
            metadata['partial_results'] = job['opened_report']['status'] != 'completed'
        return metadata

    def result(self, job_id, run_index=None, species=None):
        job = self.job(job_id)
        summary, rows = [], []
        selected = set(species or [])
        for record in self.records(job):
            summary.append(record['summary'])
            if run_index is not None and record['summary']['run_index'] == run_index:
                rows = record['species']
            elif run_index is None and selected:
                rows.extend(x for x in record['species'] if x['species'] in selected)
        return {'summary': summary, 'species': rows, 'metadata': self.result_metadata(job), 'status': self.status(job_id)}

    def explorer(self, job_id, cycle=None, page=None):
        job = self.job(job_id)
        status = self.status(job_id)
        if cycle is not None:
            require(type(cycle) is int and cycle > 0, 'SIMULATION_INPUT', 'error.simulationInput', '预览循环无效')
        # A running simulation may finish more rounds after the user has already
        # selected one. Every response carries the completed rounds so the picker
        # can grow without resetting the user's current selection.
        cycle_counts = {}
        for record in self.records(job):
            key = record['summary']['pass']
            cycle_counts[key] = cycle_counts.get(key, 0) + 1
        cycles = sorted(cycle_counts)
        completed = sum(cycle_counts.values())
        size = completed * len(job['config']['species'])
        if cycle is None and size > PREVIEW_SPECIES_ROWS:
            return {'choose_cycle': True, 'cycles': cycles, 'row_count': size}
        point_count = completed if cycle is None else cycle_counts.get(cycle, 0)
        per_page = max(1, PREVIEW_SPECIES_ROWS // len(job['config']['species']))
        pages = max(1, (point_count + per_page - 1) // per_page)
        if page is None and pages > 1:
            return {'choose_page': True, 'cycles': cycles, 'page_count': pages, 'points_per_page': per_page, 'cycle_points': point_count}
        page = 1 if page is None else page
        require(type(page) is int and 1 <= page <= pages, 'SIMULATION_INPUT', 'error.simulationInput', '预览分段无效')
        start = (page - 1) * per_page
        payload = explorer_payload(job['root'], cycle, start, start + per_page)
        return {'encoding': 'gzip-base64', 'cycles': cycles, 'data': packed_payload(payload), 'point_count': len(payload['summary']['rows']), 'status': status,
                'page_count': pages, 'points_per_page': per_page, 'cycle_points': point_count}

    def export(self, job_id, directory):
        job = self.job(job_id)
        status = self.status(job_id)
        require(status['status'] != 'running', 'SIMULATION_RUNNING', 'error.simulationInput', '请在计算结束后另存结果副本')
        parent = Path(directory).expanduser().resolve()
        require(parent.is_dir(), 'SIMULATION_DIRECTORY', 'error.simulationInput', '请选择现有文件夹')
        require(parent != job['root'] and job['root'] not in parent.parents, 'SIMULATION_DIRECTORY', 'error.simulationInput', '请在当前结果文件夹之外选择副本的保存位置')
        target = create_result_folder(parent, job['config']['name'])
        try:
            shutil.copytree(job['root'], target, dirs_exist_ok=True)
            # copytree preserves source permissions; the new copy must be
            # writable even when the original lives on a read-only share.
            target.chmod(target.stat().st_mode | 0o700)
            if 'opened_report' in job:
                atomic_json(target/'status.json', job['opened_report'])
            (target/'worker.lock').unlink(missing_ok=True)
            counts = rebuild_tables(target)
            atomic_json(target/'metadata.json', {**self.result_metadata(job), 'row_counts': counts})
            write_explorer(target)
        except Exception:
            shutil.rmtree(target)
            raise
        return {'success': True, 'output_path': str(target), 'row_counts': counts}

    def dispatch(self, service, args):
        from .simulation import catalog, normalize_config
        from .simulation_templates import load_settings
        action = args.get('action')
        if action in {'code_render', 'code_parse'}:
            from .simulation_code import render_code, parse_code
            require(isinstance(args.get('config'), dict), 'SIMULATION_INPUT', 'error.simulationInput', '代码需要一份有效的模拟配置')
            if action == 'code_render': return render_code(args['config'], args.get('previous'))
            return parse_code(args.get('document'), args['config'], parameters_only=args.get('parameters_only') is True)
        if action == 'status': return self.status(args['job_id'])
        if action == 'result': return self.result(args['job_id'], args.get('run_index'), args.get('species'))
        if action == 'explorer': return self.explorer(args['job_id'], args.get('cycle'), args.get('page'))
        if action == 'open_run': return self.open_run(args['path'])
        if action == 'cancel': return self.cancel(args['job_id'])
        if action == 'export': return self.export(args['job_id'], args['directory'])
        if action == 'result_destination': return result_destination(args['directory'], args['name'])
        if action == 'load_settings': return load_settings(args['path'], args.get('size', 'full'))
        if action == 'read_result_files':
            from .simulation_result_import import read_result_files
            return read_result_files(args.get('paths'))
        if action == 'save_artifact':
            path = Path(args['path']).expanduser()
            require(path.suffix.lower() in {'.html', '.svg', '.png', '.csv', '.json'} and not path.is_symlink(), 'SIMULATION_FILE', 'error.simulationInput', '请选择 HTML、SVG、PNG、CSV 或 JSON 文件')
            encoded = args.get('data', '')
            require(isinstance(encoded, str) and len(encoded) <= 150000000, 'SIMULATION_FILE', 'error.simulationInput', '导出文件过大')
            data = base64.b64decode(encoded, validate=True)
            temp = path.with_name('.'+path.name+'.'+uuid.uuid4().hex+'.tmp')
            try:
                temp.write_bytes(data)
                os.replace(temp, path)
            finally: temp.unlink(missing_ok=True)
            return {'success': True, 'output_path': str(path.resolve())}
        handle = service.handle(args.get('handle_id', ''))
        if action == 'catalog': return {**catalog(handle['records']), 'source': database_source(handle)}
        if action == 'validate':
            from .simulation_program import prepare_program
            config, _, _ = prepare_program(args['config'], args.get('code_editor'))
            config, audit = normalize_config(config, handle['records'], database_source(handle))
            inner_count, outer_count = execution_shape(config)
            return {'config': config, 'ion_size_audit': audit, 'total': LoopPlan(config).total if config.get('schedule') else inner_count*outer_count}
        if action == 'start':
            require(service.probe()['available'], 'RUNTIME_UNAVAILABLE', 'error.simulationInput', '请先连接 Reaktoro 运行时')
            return self.start(handle, args['config'], args['directory'], args.get('code_editor'), args.get('result_name'), args.get('overwrite_token'))
        if action == 'save_settings':
            path = Path(args['path']).expanduser()
            require(path.name.lower().endswith('.ersim.json') and not path.is_symlink(), 'SIMULATION_FILE', 'error.simulationInput', '设置文件须以 .ersim.json 结尾，且不能是符号链接')
            require(isinstance(args.get('config'), dict), 'SIMULATION_INPUT', 'error.simulationInput', '设置内容无效')
            payload = {'format': 'easyreaktoro-simulation', 'schema_version': 2, 'config': args['config'], 'database': database_source(handle)}
            if args.get('code_editor') is not None:
                from .simulation_code import validate_editor
                payload['code_editor'] = validate_editor(args['code_editor'])
            atomic_json(path, payload)
            return {'success': True, 'output_path': str(path.resolve())}
        raise ValueError(f'未知模拟操作：{action}')
