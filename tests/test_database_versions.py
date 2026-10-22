"""Real-file regressions for database version history; no personal data touched."""
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.easyreaktoro_runtime import database_versions, repository
from bridge.easyreaktoro_runtime.database_versions import VersionStore
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.service import Service


def species(name="Water", **changes):
    return repository.normalize_species({"name": name, "formula": "H2O", "composition": {"H": 2, "O": 1}, "charge": 0, "state": "Aqueous", "model": {"type": "extended-maier-kelley", "parameters": {"G298": -1000, "H298": -900, "S298": .3, "a": 2, "b": .001, "c": 5, "V": 1e-5}}, **changes})


class DatabaseVersionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "water.rtdb"
        self.backups = self.root / "DatabaseBackups"
        repository.create(str(self.path), "Water chemistry", records=[species()])
        self.service = Service()
        self.handle = self.service.handle(self.service.open_rtdb(str(self.path))["handle_id"])
        self.store = VersionStore(self.backups, self.path)

    def tearDown(self): self.temp.cleanup()

    def edit(self, note):
        row = self.handle["records"][0]
        self.service.mutate_species(self.handle, "update", {"species_id": row["id"], "species": {**row, "notes": note}})

    def save(self): return self.service.save(self.handle, backups_root=str(self.backups))

    def test_only_explicit_changed_save_creates_original_byte_snapshot(self):
        original = self.path.read_bytes()
        self.edit("unsaved text")
        self.assertEqual(self.store.listing()["entries"], [])
        self.assertEqual(self.path.read_bytes(), original)
        result = self.save()
        self.assertTrue(result["success"])
        self.assertFalse(self.handle["dirty"])
        entries = self.store.listing()["entries"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(Path(entries[0]["path"]).read_bytes(), original)
        self.assertEqual(entries[0]["species_count"], 1)
        self.assertEqual(entries[0]["element_count"], 2)
        self.assertEqual(entries[0]["name"], "Water chemistry")
        self.save()  # audit/modified timestamps alone do not create new versions
        self.assertEqual(len(self.store.listing()["entries"]), 1)
        self.edit("unsaved text")  # an edit that returns identical content
        self.save()
        self.assertEqual(len(self.store.listing()["entries"]), 1)

    def test_preview_compares_saved_content_not_current_dirty_edits(self):
        self.edit("saved reference"); self.save()
        entry = self.store.listing()["entries"][0]
        self.edit("another unsaved change")
        preview = self.store.preview(entry["id"])
        self.assertEqual(preview["changes"]["changed"][0]["fields"], ["notes"])
        self.assertEqual(preview["records"][0]["name"], "Water")
        self.assertEqual(self.handle["records"][0]["notes"], "another unsaved change")
        self.assertTrue(self.handle["dirty"])

    def test_restore_is_exact_new_file_and_cannot_overwrite_source_or_existing_copy(self):
        original = self.path.read_bytes()
        self.edit("new"); self.save()
        current = self.path.read_bytes()
        entry = self.store.listing()["entries"][0]
        output = self.root / "Recovered.rtdb"
        self.store.restore(entry["id"], str(output))
        self.assertEqual(output.read_bytes(), original)
        for path in (self.path, output, self.store.folder / "bad.rtdb"):
            with self.assertRaises(BridgeError): self.store.restore(entry["id"], str(path))
        self.assertEqual(self.path.read_bytes(), current)
        self.assertEqual(output.read_bytes(), original)

    def test_default_retention_is_ten_and_settings_can_disable_without_erasing_history(self):
        self.assertEqual(self.store.settings(), {"enabled": True, "keep": 10})
        for i in range(12): self.edit(f"revision {i}"); self.save()
        entries = self.store.listing()["entries"]
        self.assertEqual(len(entries), 10)
        self.store.save_settings({"enabled":False, "keep":2})
        self.edit("off"); self.save()
        self.assertEqual(len(self.store.listing()["entries"]), 10)
        self.store.save_settings({"enabled":True, "keep":2})
        self.edit("on"); self.save()
        self.assertEqual(len(self.store.listing()["entries"]), 2)

    def test_retention_never_crosses_database_path_or_removes_foreign_files(self):
        twin = self.root / "twin.rtdb"
        twin.write_bytes(self.path.read_bytes())  # same internal DB id, separate file
        twin_store = VersionStore(self.backups, twin)
        twin_handle = self.service.handle(self.service.open_rtdb(str(twin))["handle_id"])
        twin_handle["records"][0]["notes"] = "twin"
        self.service.save(twin_handle, backups_root=str(self.backups))
        twin_history = twin_store.listing()["entries"][0]
        self.store.save_settings({"enabled":True,"keep":1})
        for i in range(3): self.edit(str(i)); self.save()
        foreign = self.store.folder / "personal.rtdb"; foreign.write_bytes(b"keep me")
        bad = self.store.folder / ("a"*32 + ".json"); bad.write_text(json.dumps({"schema":"other"}))
        self.edit("last"); self.save()
        self.assertEqual(foreign.read_bytes(), b"keep me")
        self.assertTrue(bad.exists())
        self.assertTrue(Path(twin_history["path"]).exists())
        with self.assertRaises(BridgeError): self.store.delete(twin_history["id"])
        with self.assertRaises(BridgeError): self.store.delete("../twin")

    def test_backup_write_failure_blocks_save_and_preserves_original_and_dirty_state(self):
        original=self.path.read_bytes(); self.edit("new")
        with patch.object(database_versions,"_write",side_effect=OSError("disk full")):
            with self.assertRaises(BridgeError) as failure: self.save()
        self.assertEqual(failure.exception.code,"BACKUP_SAVE_FAILED")
        self.assertEqual(self.path.read_bytes(),original)
        self.assertTrue(self.handle["dirty"])
        self.assertEqual(self.store.listing()["entries"],[])
        self.assertEqual(list(self.root.rglob("*.tmp")),[])

    def test_external_change_during_backup_does_not_get_overwritten(self):
        self.edit("my pending edit")
        original_capture = VersionStore.capture
        external=[]
        def capture_then_external(store,*args):
            version_id=original_capture(store,*args)
            with sqlite3.connect(self.path) as conn:
                conn.execute("UPDATE metadata SET value='external edit' WHERE key='name'")
            external.append(self.path.read_bytes())
            return version_id
        with patch.object(VersionStore,"capture",capture_then_external):
            with self.assertRaises(BridgeError) as failure:self.save()
        self.assertEqual(failure.exception.code,"RTDB_CHANGED_EXTERNALLY")
        self.assertEqual(self.path.read_bytes(),external[0])
        self.assertTrue(self.handle["dirty"])
        self.assertEqual(self.store.listing()["entries"],[])

    def test_external_sqlite_writer_starting_during_backup_blocks_replacement(self):
        original=self.path.read_bytes();self.edit("new")
        original_capture=VersionStore.capture
        journal=Path(str(self.path)+"-wal")
        def capture_then_writer(store,*args):
            version_id=original_capture(store,*args)
            journal.write_bytes(b"writer started")
            return version_id
        with patch.object(VersionStore,"capture",capture_then_writer):
            with self.assertRaises(BridgeError) as failure:self.save()
        self.assertEqual(failure.exception.code,"RTDB_IN_USE")
        self.assertEqual(self.path.read_bytes(),original)
        self.assertTrue(self.handle["dirty"])
        self.assertEqual(self.store.listing()["entries"],[])

    def test_retention_failure_reports_saved_success_and_keeps_revision_current(self):
        self.edit("new")
        with patch.object(VersionStore,"prune",side_effect=PermissionError("blocked")):
            result=self.save()
        self.assertTrue(result["success"])
        self.assertIn("已保存",result["backup_warning"])
        self.assertFalse(self.handle["dirty"])
        self.assertEqual(self.handle["revision"],repository.revision(self.path))
        self.assertEqual(repository.open_database(str(self.path))[1][0]["notes"],"new")

    def test_save_as_does_not_back_up_or_mutate_original(self):
        original=self.path.read_bytes(); self.edit("copy")
        self.service.save(self.handle,str(self.root/"copy.rtdb"),backups_root=str(self.backups))
        self.assertEqual(self.path.read_bytes(),original)
        self.assertEqual(self.store.listing()["entries"],[])

    def test_missing_and_tampered_versions_do_not_restore_or_get_deleted(self):
        self.edit("new");self.save()
        entry=self.store.listing()["entries"][0]
        Path(entry["path"]).write_bytes(b"not the original")
        with self.assertRaises(BridgeError):self.store.restore(entry["id"],str(self.root/"bad.rtdb"))
        with self.assertRaises(BridgeError):self.store.delete(entry["id"])
        self.assertEqual(Path(entry["path"]).read_bytes(),b"not the original")
        Path(entry["path"]).unlink()
        self.assertEqual(self.store.listing()["entries"],[])
        self.assertEqual(self.store.listing()["unavailable"],1)

    def test_dispatch_actions_and_validation(self):
        args={"op":"rtdb.versions","handle_id":self.handle["id"],"backups_root":str(self.backups)}
        self.assertEqual(self.service.dispatch(args)["settings"]["keep"],10)
        for settings in ({"enabled":1,"keep":10},{"enabled":True,"keep":0},{"enabled":True,"keep":101},{"enabled":True,"keep":2.5}):
            with self.assertRaises(BridgeError):self.service.dispatch({**args,"payload":{"action":"settings","settings":settings}})
        self.edit("new");self.save();entry=self.store.listing()["entries"][0]
        self.service.dispatch({**args,"payload":{"action":"delete","version_id":entry["id"]}})
        self.assertEqual(self.store.listing()["entries"],[])

    def test_symlinks_cannot_redirect_managed_cleanup(self):
        self.edit("new");self.save();entry=self.store.listing()["entries"][0]
        version_path=Path(entry["path"]);version_path.unlink();version_path.symlink_to(self.path)
        original=self.path.read_bytes()
        with self.assertRaises(BridgeError):self.store.delete(entry["id"])
        self.assertEqual(self.path.read_bytes(),original)
        other=self.root/"redirect";other.symlink_to(self.backups)
        with self.assertRaises(BridgeError):VersionStore(other,self.path)


if __name__ == '__main__': unittest.main()
