import gzip
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.simulation_result_import import read_result_files

class ResultImportTests(unittest.TestCase):
    def test_html_and_unicode_csv_are_read_without_executing_or_rewriting(self):
        with tempfile.TemporaryDirectory() as directory:
            html = Path(directory) / '图表.html'
            text = '<script>throw new Error("inert source")</script><script id="payload">{"name":"对比"}</script>'
            html.write_text(text)
            csv = Path(directory) / 'summary.csv'
            csv.write_bytes(b'\xef\xbb\xbf' + 'pH,温度\n7,25\n'.encode())
            before = html.read_bytes()
            files = read_result_files([str(html), str(csv)])['files']
            self.assertEqual(files[0]['text'], text)
            self.assertEqual(files[0]['path'], str(html.resolve()))
            self.assertIsInstance(files[0]['last_modified'], int)
            self.assertTrue(files[1]['text'].startswith('pH,温度'))
            self.assertEqual(html.read_bytes(), before)

    def test_csv_gzip_decodes_once_and_bounds_total_expansion(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'species.csv.gz'
            file.write_bytes(gzip.compress(b'species,amount\nH+,0.1\n'))
            item = read_result_files([str(file)])['files'][0]
            self.assertEqual(item['name'], 'species.csv')
            self.assertIn('H+,0.1', item['text'])
            file.write_bytes(gzip.compress(b'x' * 9000))
            with patch('bridge.easyreaktoro_runtime.simulation_result_import.MAX_IMPORT_BYTES', 100):
                with self.assertRaisesRegex(BridgeError, '解压后的合计大小'): read_result_files([str(file)])

    def test_missing_invalid_and_oversized_batches_fail_without_partial_data(self):
        with tempfile.TemporaryDirectory() as directory:
            good = Path(directory) / 'good.json'; good.write_text('{"name":"safe"}')
            bad = Path(directory) / 'bad.csv.gz'; bad.write_bytes(b'not gzip')
            for paths in [[], ['relative.html'], [str(good), str(bad)], [str(Path(directory) / 'missing.html')], [str(Path(directory) / 'script.py')]]:
                with self.assertRaises(BridgeError): read_result_files(paths)
            second = Path(directory) / 'second.json'; second.write_text('123456789')
            with patch('bridge.easyreaktoro_runtime.simulation_result_import.MAX_IMPORT_BYTES', 18):
                with self.assertRaisesRegex(BridgeError, '合计大小'): read_result_files([str(good), str(second)])

if __name__ == '__main__': unittest.main()
