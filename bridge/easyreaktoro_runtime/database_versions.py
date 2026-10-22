"""Managed, immutable snapshots of explicitly saved user databases.

Folders are scoped to the resolved source path, so Save As copies cannot prune
one another's history. No operation searches or deletes outside this namespace.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

from . import repository
from .errors import BridgeError, require

SCHEMA = "easyreaktoro.database-version/v1"
DEFAULT_SETTINGS = {"enabled": True, "keep": 10}
VERSION_ID = re.compile(r"[0-9a-f]{32}\Z")


def content_signature(meta: dict, records: list[dict]) -> str:
    # Save timestamps, validation and audit entries do not change the database's
    # scientific contents. Include references/notes, not just calculation params.
    values = {key: value for key, value in meta.items() if key not in {
        "modified_at", "migration_pending", "migrated_at", "legacy_columns", "schema"}}
    rows = [repository.normalize_species(row) for row in records]
    rows.sort(key=lambda row: row["id"])
    return repository.fingerprint({"metadata": values, "species": rows})


def _write(path: Path, data: bytes, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".version-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if exclusive:
            try: os.link(temporary, path)
            except FileExistsError as exc:
                raise BridgeError("RTDB_ALREADY_EXISTS", "error.rtdbAlreadyExists", "目标文件已存在，请选择新文件名。") from exc
        else: os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


class VersionStore:
    def __init__(self, root: str | Path, source: str | Path):
        given = Path(root).expanduser()
        require(not given.is_symlink(), "BACKUP_LOCATION", "error.backupLocation", "历史版本保存目录不能是符号链接。")
        self.root = given.resolve()
        self.source = Path(source).expanduser().resolve()
        self.key = hashlib.sha256(str(self.source).encode()).hexdigest()
        self.folder = self.root / self.key
        require(not self.folder.is_symlink(), "BACKUP_LOCATION", "error.backupLocation", "历史版本保存目录不能是符号链接。")

    def settings(self) -> dict:
        path = self.root / "preferences.json"
        require(not path.is_symlink(), "BACKUP_LOCATION", "error.backupLocation", "历史版本设置文件不能是符号链接。")
        if not path.exists(): return dict(DEFAULT_SETTINGS)
        try: return self.validate_settings(json.loads(path.read_text()))
        except BridgeError: raise
        except Exception as exc:
            raise BridgeError("BACKUP_SETTINGS", "error.backupSettings", "无法读取历史版本设置；数据库尚未保存。请在历史版本中重新设置。") from exc

    @staticmethod
    def validate_settings(value: Any) -> dict:
        require(isinstance(value, dict) and type(value.get("enabled")) is bool and type(value.get("keep")) is int and 1 <= value["keep"] <= 100,
                "BACKUP_SETTINGS", "error.backupSettings", "请选择是否保留历史版本，并输入 1 至 100 之间的保留份数。")
        return {"enabled": value["enabled"], "keep": value["keep"]}

    def save_settings(self, value: dict) -> dict:
        value = self.validate_settings(value)
        _write(self.root / "preferences.json", json.dumps(value).encode())
        return value

    def _paths(self, version_id: str) -> tuple[Path, Path]:
        require(bool(VERSION_ID.fullmatch(version_id)), "BACKUP_NOT_FOUND", "error.backupNotFound", "该历史版本不存在，请刷新列表。")
        data, info = self.folder / (version_id + ".rtdb"), self.folder / (version_id + ".json")
        require(not data.is_symlink() and not info.is_symlink(), "BACKUP_INVALID", "error.backupInvalid", "历史版本文件已改变，未执行操作。")
        return data, info

    def entry(self, version_id: str, verify: bool = False) -> dict:
        data, info = self._paths(version_id)
        require(info.is_file() and data.is_file(), "BACKUP_NOT_FOUND", "error.backupNotFound", "该历史版本不存在，请刷新列表。")
        try: item = json.loads(info.read_text())
        except Exception as exc:
            raise BridgeError("BACKUP_INVALID", "error.backupInvalid", "历史版本文件已改变，未执行操作。") from exc
        require(isinstance(item, dict) and item.get("schema") == SCHEMA and item.get("id") == version_id and item.get("source_path") == str(self.source)
                and all(isinstance(item.get(key), str) for key in ("name", "saved_at", "sha256"))
                and all(type(item.get(key)) is int and item[key] >= 0 for key in ("species_count", "element_count")),
                "BACKUP_INVALID", "error.backupInvalid", "历史版本文件已改变，未执行操作。")
        if verify:
            require(repository.revision(data) == item.get("sha256"), "BACKUP_INVALID", "error.backupInvalid", "历史版本文件已改变，未执行操作。")
        return {**item, "path": str(data), "bytes": data.stat().st_size}

    def listing(self) -> dict:
        entries, unavailable = [], 0
        if self.folder.is_dir():
            for path in self.folder.glob("*.json"):
                if not VERSION_ID.fullmatch(path.stem): continue
                try: entries.append(self.entry(path.stem))
                except BridgeError: unavailable += 1
        entries.sort(key=lambda row: (row["saved_at"], row["id"]), reverse=True)
        return {"entries": entries, "unavailable": unavailable, "settings": self.settings(), "directory": str(self.folder)}

    def capture(self, proposed_meta: dict, proposed_records: list[dict], expected_revision: str | None) -> str | None:
        if not self.settings()["enabled"]: return None
        require(self.source.is_file() and expected_revision is not None, "RTDB_CHANGED_EXTERNALLY", "error.rtdbChangedExternally", "原数据库已被修改或删除，请重新打开或另存为新文件。")
        require(repository.revision(self.source) == expected_revision, "RTDB_CHANGED_EXTERNALLY", "error.rtdbChangedExternally", "原数据库已被修改或删除，请重新打开或另存为新文件。")
        previous_meta, previous_records = repository.open_database(str(self.source))
        if content_signature(previous_meta, previous_records) == content_signature(proposed_meta, proposed_records): return None
        for entry in self.listing()["entries"]:
            if entry["sha256"] == expected_revision:
                try: self.entry(entry["id"], verify=True)
                except BridgeError: continue
                return None
        raw = self.source.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == expected_revision, "RTDB_CHANGED_EXTERNALLY", "error.rtdbChangedExternally", "原数据库已被修改或删除，请重新打开或另存为新文件。")
        version_id = uuid.uuid4().hex
        data, info = self._paths(version_id)
        item = {"schema": SCHEMA, "id": version_id, "source_path": str(self.source), "database_id": previous_meta.get("id", ""),
                "name": previous_meta.get("name") or self.source.stem, "saved_at": repository.now(),
                "database_modified_at": previous_meta.get("modified_at", ""), "species_count": len(previous_records),
                "element_count": len({element for row in previous_records for element in row.get("composition", {})}), "sha256": expected_revision}
        try:
            _write(data, raw, exclusive=True)
            _write(info, json.dumps(item, ensure_ascii=False, indent=2).encode(), exclusive=True)
        except Exception:
            if data.is_file(): data.unlink()
            if info.is_file(): info.unlink()
            raise
        return version_id

    def delete(self, version_id: str) -> None:
        # Verify ownership and contents; unrelated files, symlinks and edited
        # backups are never swept up by retention cleanup.
        self.entry(version_id, verify=True)
        data, info = self._paths(version_id)
        data.unlink(); info.unlink()

    def prune(self) -> None:
        keep = self.settings()["keep"]
        for entry in self.listing()["entries"][keep:]: self.delete(entry["id"])

    def preview(self, version_id: str) -> dict:
        item = self.entry(version_id, verify=True)
        old_meta, old = repository.open_database(item["path"])
        current_meta, current = repository.open_database(str(self.source)) if self.source.is_file() else ({}, [])
        before, after = {row["id"]: row for row in old}, {row["id"]: row for row in current}
        added = [row["name"] for key, row in after.items() if key not in before]
        removed = [row["name"] for key, row in before.items() if key not in after]
        changed = [{"name": row["name"], "previous_name": before[key]["name"],
                    "fields": [field for field in row if field not in ("fingerprint", "id") and row[field] != before[key].get(field)]}
                   for key, row in after.items() if key in before and row["fingerprint"] != before[key]["fingerprint"]]
        return {"entry": item, "compared_with": "saved_database", "current_available": self.source.is_file(),
                "changes": {"added": added, "removed": removed, "changed": changed},
                "records": [{"name": row["name"], "formula": row["formula"], "state": row["state"]} for row in old],
                "metadata_changed": {key: {"before": old_meta.get(key), "after": current_meta.get(key)}
                    for key in set(old_meta) | set(current_meta) if key not in ("modified_at", "schema") and old_meta.get(key) != current_meta.get(key)}}

    def restore(self, version_id: str, destination: str) -> dict:
        item = self.entry(version_id, verify=True)
        target = Path(destination).expanduser().resolve()
        require(target.suffix.lower() == ".rtdb", "RTDB_EXTENSION", "error.rtdbExtension", "请选择 .rtdb 数据库文件。")
        require(not target.is_relative_to(self.root), "BACKUP_RESTORE_LOCATION", "error.backupRestoreLocation", "请选择历史版本目录之外的位置保存副本。")
        raw = Path(item["path"]).read_bytes()
        require(hashlib.sha256(raw).hexdigest() == item["sha256"], "BACKUP_INVALID", "error.backupInvalid", "历史版本文件已改变，未执行操作。")
        _write(target, raw, exclusive=True)
        return {"path": str(target), "name": target.stem}

    def request(self, payload: dict) -> dict:
        action = payload.get("action", "list")
        if action == "list": return self.listing()
        if action == "settings": return {"settings": self.save_settings(payload.get("settings"))}
        version_id = str(payload.get("version_id", ""))
        if action == "preview": return self.preview(version_id)
        if action == "delete": self.delete(version_id); return self.listing()
        if action == "restore": return self.restore(version_id, str(payload.get("path", "")))
        raise BridgeError("BACKUP_ACTION", "error.backupAction", "无法识别历史版本操作。")
