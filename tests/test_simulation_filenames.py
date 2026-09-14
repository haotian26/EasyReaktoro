"""Readable names and atomic collision protection, without launching a worker."""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.simulation_jobs import create_result_folder, result_folder_name

class ResultFolderTests(unittest.TestCase):
    def test_names_keep_spaces_and_unicode_but_cannot_escape_the_directory(self):
        self.assertEqual(result_folder_name('水岩反应 100 points'),'水岩反应 100 points')
        for name in ('../../escaped',r'folder\escaped','CON','..','测试'*100):
            clean=result_folder_name(name)
            self.assertEqual(Path(clean).name,clean)
            self.assertNotIn('\\',clean)
            self.assertLessEqual(len(clean.encode('utf-8')),240)
        with tempfile.TemporaryDirectory() as folder:
            path=create_result_folder(Path(folder),'../../escaped')
            self.assertEqual(path.parent,Path(folder))

    def test_concurrent_same_name_reserves_only_one_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            def create(_):
                try:return create_result_folder(Path(folder),'同名模拟')
                except BridgeError as error:
                    self.assertEqual(error.code,'SIMULATION_EXISTS')
                    return None
            with ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(create,range(20)))
            self.assertEqual(sum(x is not None for x in results),1)
            self.assertEqual([p.name for p in Path(folder).iterdir()],['同名模拟'])

    def test_collision_with_file_or_symlink_is_rejected_without_modifying_target(self):
        with tempfile.TemporaryDirectory() as folder:
            parent=Path(folder);sentinel=parent/'sentinel';sentinel.write_text('original')
            (parent/'linked').symlink_to(sentinel)
            for name in ('sentinel','linked'):
                with self.assertRaisesRegex(BridgeError,'已存在'):create_result_folder(parent,name)
            self.assertEqual(sentinel.read_text(),'original')

class ResultReplacementTests(unittest.TestCase):
    def test_only_a_confirmed_result_folder_can_be_replaced(self):
        import json
        from bridge.easyreaktoro_runtime.simulation_jobs import result_destination, reserve_result_folder
        with tempfile.TemporaryDirectory() as folder:
            parent=Path(folder);root=parent/'experiment';root.mkdir();(root/'run.json').write_text(json.dumps({'format':'easyreaktoro-run','schema_version':1,'job_id':'a'*32}));(root/'summary.csv').write_text('old data')
            info=result_destination(parent,'experiment');self.assertTrue(info['can_overwrite']);self.assertEqual(info['suggested_name'],'experiment 2')
            new,backup=reserve_result_folder(parent,'experiment',info['overwrite_token']);self.assertEqual(new,root.resolve());self.assertEqual(list(new.iterdir()),[]);self.assertEqual((backup/'summary.csv').read_text(),'old data')
            self.assertFalse(result_destination(parent,'experiment')['can_overwrite'])
    def test_changed_confirmation_and_arbitrary_directories_are_preserved(self):
        import json
        from bridge.easyreaktoro_runtime.simulation_jobs import result_destination,reserve_result_folder
        with tempfile.TemporaryDirectory() as folder:
            parent=Path(folder);root=parent/'experiment';root.mkdir();(root/'run.json').write_text(json.dumps({'format':'easyreaktoro-run','schema_version':1,'job_id':'a'*32}))
            info=result_destination(parent,'experiment');(root/'run.json').write_text(json.dumps({'format':'easyreaktoro-run','schema_version':1,'job_id':'b'*32}))
            with self.assertRaisesRegex(BridgeError,'已经变化'):reserve_result_folder(parent,'experiment',info['overwrite_token'])
            self.assertIn('bbbb',(root/'run.json').read_text());(root/'run.json').unlink();(root/'notes.txt').write_text('user file');self.assertFalse(result_destination(parent,'experiment')['can_overwrite']);self.assertEqual((root/'notes.txt').read_text(),'user file')

    def test_active_result_cannot_be_overwritten(self):
        import json
        from bridge.easyreaktoro_runtime.simulation_jobs import result_destination
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'active';root.mkdir();(root/'run.json').write_text(json.dumps({'format':'easyreaktoro-run','schema_version':1}));(root/'status.json').write_text(json.dumps({'status':'running'}))
            info=result_destination(folder,'active');self.assertTrue(info['exists']);self.assertFalse(info['can_overwrite']);self.assertIn('尚未结束',info['reason'])

    def test_worker_start_failure_restores_the_previous_result(self):
        import json
        from unittest.mock import patch
        from bridge.easyreaktoro_runtime.simulation_jobs import Jobs,result_destination
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'experiment';root.mkdir();(root/'run.json').write_text(json.dumps({'format':'easyreaktoro-run','schema_version':1,'job_id':'a'*32}));(root/'summary.csv').write_text('previous results')
            token=result_destination(folder,'experiment')['overwrite_token'];config={'name':'experiment'};jobs=Jobs()
            with patch('bridge.easyreaktoro_runtime.simulation_jobs.database_source',return_value={}), patch('bridge.easyreaktoro_runtime.simulation_program.prepare_program',return_value=(config,{},{})),patch('bridge.easyreaktoro_runtime.simulation_program.readable_program',return_value='# program'),patch('bridge.easyreaktoro_runtime.simulation.normalize_config',return_value=(config,[])),patch('bridge.easyreaktoro_runtime.simulation_jobs.execution_shape',return_value=(1,1)),patch('bridge.easyreaktoro_runtime.simulation_jobs.subprocess.Popen',side_effect=OSError('cannot launch')):
                with self.assertRaisesRegex(OSError,'cannot launch'):jobs.start({'records':[]},config,folder,overwrite_token=token)
            self.assertEqual((root/'summary.csv').read_text(),'previous results');self.assertEqual(sorted(p.name for p in Path(folder).iterdir()),['experiment']);self.assertEqual(jobs.jobs,{})
