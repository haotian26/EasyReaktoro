import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.easyreaktoro_runtime import repository
from bridge.easyreaktoro_runtime.service import Service


class DatabaseCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_counts_all_species_and_distinct_elements_without_loading_models(self):
        path = self.root / 'sample.rtdb'
        records = [
            {'name': 'water', 'composition': {'H': 2, 'O': 1}},
            {'name': 'hydrogen', 'composition': {'H': 1}},
            {'name': 'draft', 'composition': {'Na': 1, 'Cl': 1}, 'disabled': True},
        ]
        repository.create(str(path), 'sample', records=records)
        with sqlite3.connect(path) as conn:
            conn.execute("UPDATE species SET model_json='not a model'")
        before = path.read_bytes()
        self.assertEqual(repository.database_info(str(path)), {'species_count': 3, 'element_count': 4})
        self.assertEqual(path.read_bytes(), before)

    def test_legacy_statistics_never_migrate_or_modify_the_file(self):
        path = self.root / 'old.rtdb'
        with sqlite3.connect(path) as conn:
            conn.executescript("CREATE TABLE metadata(key TEXT,value TEXT); INSERT INTO metadata VALUES ('schema','easyreaktoro.rtdb/v1'); CREATE TABLE species(payload_json TEXT);")
            conn.executemany('INSERT INTO species VALUES (?)', [(json.dumps({'composition': c}),) for c in [{'C': 1, 'O': 2}, {'Na': 1}]])
        before = path.read_bytes()
        self.assertEqual(repository.database_info(str(path)), {'species_count': 2, 'element_count': 3})
        self.assertEqual(path.read_bytes(), before)

    def test_offline_batch_isolates_failed_files_and_creates_no_workspaces(self):
        good = self.root / 'empty.rtdb'; broken = self.root / 'broken.rtdb'; missing = self.root / 'missing.rtdb'
        repository.create(str(good), 'empty'); broken.write_text('invalid')
        with patch('bridge.easyreaktoro_runtime.service.reaktoro', None):
            service = Service()
            response = service.dispatch({'op': 'rtdb.list_info', 'paths': [str(good), str(broken), str(missing), str(good)]})
        self.assertEqual(len(response['items']), 3)
        self.assertEqual(response['items'][0]['species_count'], 0)
        self.assertEqual(response['items'][0]['element_count'], 0)
        for item in response['items'][1:]:
            self.assertEqual(item['status'], 'error')
            self.assertNotIn('species_count', item)
        self.assertEqual(service.handles, {})
        self.assertFalse(missing.exists())

    def test_refresh_reads_new_counts_and_bad_composition_does_not_become_zero(self):
        path = self.root / 'editable.rtdb'
        repository.create(str(path), 'editable')
        self.assertEqual(repository.database_info(str(path))['species_count'], 0)
        with sqlite3.connect(path) as conn:
            repository.insert_species(conn, {'name': 'salt', 'composition': {'Na': 1, 'Cl': 1}})
        self.assertEqual(repository.database_info(str(path)), {'species_count': 1, 'element_count': 2})
        with sqlite3.connect(path) as conn:
            conn.execute("UPDATE species SET composition_json='[]'")
        response = Service().dispatch({'op': 'rtdb.list_info', 'paths': [str(path)]})
        self.assertEqual(response['items'][0]['status'], 'error')
        self.assertNotIn('element_count', response['items'][0])
