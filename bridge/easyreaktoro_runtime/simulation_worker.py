"""One worker per run; a verified NDJSON record is the durable commit point."""
import json
from pathlib import Path
import sys
import time
import os
import signal
import threading
import fcntl

from .simulation_jobs import digest
from .simulation_storage import atomic_json, TableWriter, write_explorer, records, rebuild_tables


def main(root):
    root = Path(root)
    lock = (root/'worker.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    lock.write(str(os.getpid()))
    lock.flush()
    def parent_closed():
        while os.read(0, 1):
            pass
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=parent_closed, daemon=True).start()
    snapshot = json.loads((root/'input.json').read_text())
    status = json.loads((root/'status.json').read_text())
    simulation, tables = None, TableWriter(root)
    namespace, committed, schemas, species_rows = {}, 0, {}, 0
    program = snapshot.get('program')
    def progress(**changes):
        status.update(changes)
        atomic_json(root/'status.json', status)
    def interrupted(signum, frame):
        raise InterruptedError('运行已中断；完整保存的点仍可重新打开')
    signal.signal(signal.SIGTERM, interrupted)
    try:
        from .simulation_program import execute_program, validate_record
        if program is None:
            from .simulation import Simulation
            simulation = Simulation(snapshot, progress)
        with (root/'points.ndjson').open('w', encoding='utf-8') as stream:
            def emit(record):
                nonlocal committed, species_rows
                validate_record(record, committed, schemas)
                species_rows += len(record['species'])
                if species_rows > 2000000:
                    raise ValueError('物种结果超过 2,000,000 行，请缩小计算。')
                stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False)+'\n')
                stream.flush()
                os.fsync(stream.fileno())
                committed += 1
                progress(completed=committed)
                tables.record(record)
            if program is not None:
                metadata = execute_program(program, snapshot, progress, emit, root, namespace)
                simulation = namespace.get('simulation')
            else:
                metadata = simulation.run(emit)
        if not committed:
            raise ValueError('程序没有保存任何结果点；请在求解流程中调用 emit(record)。')
        if snapshot.get('execution', {}).get('mode') != 'custom' and committed != status['total']:
            raise ValueError('已保存点数与计算计划不一致。')
        for key, value in {'config': snapshot['config'], 'ion_size_audit': getattr(simulation, 'audit', []),
                           'process_balance': getattr(simulation, 'process_balance', []), 'warnings': []}.items():
            metadata.setdefault(key, value)
        if (not isinstance(metadata['config'], dict) or not isinstance(metadata['ion_size_audit'], list)
                or not isinstance(metadata['process_balance'], list) or not isinstance(metadata['warnings'], list)
                or not all(isinstance(w, str) for w in metadata['warnings'])):
            raise ValueError('metadata 的 config 须为字典，ion_size_audit、process_balance 和 warnings 须为列表。')
        metadata['execution'] = snapshot.get('execution', {'mode': 'standard'})
        if metadata['execution']['mode'] == 'custom':
            metadata.setdefault('warnings', []).append('使用自定义 Python 求解逻辑；请核对修改后的模型、约束与结果。')
        progress(completed=committed, total=committed)
        source = snapshot['source']
        metadata['source_file_unchanged'] = (digest(source['path']) == source.get('file_sha256')) if source.get('path') and Path(source['path']).is_file() else None
        metadata['database'] = source
        metadata['row_counts'] = tables.counts
        atomic_json(root/'metadata.json', metadata)
        progress(stage='finalizing', message='正在保存独立结果探索器')
        write_explorer(root)
        progress(status='completed', stage='complete', message='计算完成，结果已保存', finished_at=time.time())
    except Exception as exc:
        from .errors import BridgeError
        diagnostic = exc.response()['error']['diagnostic'] if isinstance(exc, BridgeError) else str(exc)
        completed, committed_balance = 0, []
        for record in records(root):
            completed += 1
            committed_balance = record.get('process_balance', [])
        if program is not None:
            from .simulation_program import code_diagnostic
            diagnostic = code_diagnostic(exc, program)
        simulation = simulation or namespace.get('simulation')
        from .simulation_loops import LoopPlan
        saved_config = getattr(simulation, 'original_config', snapshot['config'])
        loop_metadata = {'loop_axes': LoopPlan(saved_config).metadata(), 'field_info': LoopPlan(saved_config).field_info()} if saved_config.get('schedule') or saved_config.get('loops') else {}
        from .simulation_constraints import field_info
        loop_metadata['field_info'] = {**loop_metadata.get('field_info', {}), **field_info(saved_config)}
        atomic_json(root/'metadata.json', {**loop_metadata, 'config': saved_config, 'database': snapshot['source'],
            'ion_size_audit': getattr(simulation, 'audit', []), 'process_balance': committed_balance,
            'warnings': sorted(getattr(simulation, 'warnings', [])), 'partial_results': True,
            'execution': snapshot.get('execution', {'mode': 'standard'})})
        tables.close()
        # Derived files can lag the durable record if a write or signal failed.
        # Preserve the original diagnostic even when finalization also fails.
        try:
            rebuild_tables(root)
            write_explorer(root)
        except Exception as finalization_error:
            print(f'Result finalization: {finalization_error}', file=sys.stderr, flush=True)
        progress(status='interrupted' if isinstance(exc, InterruptedError) else 'failed', stage='stopped', diagnostic=diagnostic,
                 completed=completed, message=f'计算已停止，已保存 {completed} 个完整结果点', finished_at=time.time())
    finally:
        # Drop function-global cycles before Reaktoro/Python callback teardown.
        namespace.clear()
        simulation = None
        import gc
        gc.collect()
        tables.close()
        lock.close()
        (root/'worker.lock').unlink(missing_ok=True)


if __name__ == '__main__':
    main(sys.argv[1])
