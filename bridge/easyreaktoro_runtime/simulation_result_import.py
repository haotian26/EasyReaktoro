"""Read user-selected result files for the existing browser-side result parser."""
from __future__ import annotations
import gzip
from pathlib import Path
from .errors import BridgeError, require

MAX_IMPORT_BYTES = 112 * 1024 * 1024

def read_result_files(paths):
    require(isinstance(paths, list) and 1 <= len(paths) <= 64,
            'SIMULATION_FILE', 'error.simulationInput', '请选择 1–64 个配套结果文件。')
    files, remaining = [], MAX_IMPORT_BYTES
    for value in paths:
        require(isinstance(value, str) and Path(value).is_absolute(),
                'SIMULATION_FILE', 'error.simulationInput', '请重新选择结果文件的完整保存位置。')
        path = Path(value)
        compressed = path.name.lower().endswith('.csv.gz')
        require(compressed or path.suffix.lower() in {'.csv', '.json', '.html', '.htm'},
                'SIMULATION_FILE', 'error.simulationInput', '请选择 CSV、CSV.GZ、JSON 或 HTML 结果文件。')
        try:
            path = path.resolve(strict=True)
            require(path.is_file(), 'SIMULATION_FILE', 'error.simulationInput', '请选择结果文件，不能选择文件夹。')
            stat = path.stat()
            require(stat.st_size <= MAX_IMPORT_BYTES, 'SIMULATION_FILE', 'error.simulationInput', '结果文件超过 112 MB，请分批打开。')
            # Bound decompressed bytes too: a small gzip file may expand far beyond its size.
            with (gzip.open(path, 'rb') if compressed else path.open('rb')) as source:
                data = source.read(remaining + 1)
            require(len(data) <= remaining, 'SIMULATION_FILE', 'error.simulationInput', '结果文件解压后的合计大小超过 112 MB，请分批打开。')
            remaining -= len(data)
            text = data.decode('utf-8-sig')
        except (OSError, EOFError, UnicodeError, ValueError) as error:
            raise BridgeError('SIMULATION_FILE', 'error.simulationInput', f'无法读取“{path.name}”：请检查文件是否仍在原位置、格式是否完整。') from error
        # readFiles receives decoded text; stripping .gz prevents a second decompression.
        files.append({'path': str(path), 'name': path.name[:-3] if compressed else path.name,
                      'text': text, 'size': stat.st_size, 'last_modified': int(stat.st_mtime * 1000)})
    return {'files': files}
