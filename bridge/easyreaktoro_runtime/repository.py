from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .errors import BridgeError, require


SCHEMA_ID = "easyreaktoro.rtdb/v2"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value: Any) -> str:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


DDL = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS species (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, original_name TEXT NOT NULL DEFAULT '', formula TEXT NOT NULL DEFAULT '',
 composition_json TEXT NOT NULL DEFAULT '{}', charge REAL NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'Unknown',
 tags_json TEXT NOT NULL DEFAULT '[]', model_json TEXT NOT NULL DEFAULT '{}', valid_tp_json TEXT NOT NULL DEFAULT '{}',
 reaction_json TEXT NOT NULL DEFAULT '{}', activity_json TEXT NOT NULL DEFAULT '{}', provenance_json TEXT NOT NULL DEFAULT '{}',
 references_json TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', disabled INTEGER NOT NULL DEFAULT 0,
 fingerprint TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS dependencies (species_id TEXT NOT NULL REFERENCES species(id) ON DELETE CASCADE, dependency_name TEXT NOT NULL, PRIMARY KEY(species_id, dependency_name));
CREATE TABLE IF NOT EXISTS validation (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, report_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
"""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _loads(value: str, fallback: Any) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return fallback


def formula_from_composition(composition: dict[str, Any], charge: float) -> str:
    def coefficient(value: Any) -> str:
        number = float(value)
        if abs(number - 1.0) < 1e-12: return ""
        return str(int(number)) if number.is_integer() else f"{number:g}"
    formula = "".join(f"{symbol}{coefficient(value)}" for symbol, value in composition.items())
    rounded = int(round(charge))
    if abs(charge - rounded) < 1e-12 and rounded:
        formula += ("+" if rounded > 0 else "-") + (str(abs(rounded)) if abs(rounded) != 1 else "")
    elif charge:
        formula += ("+" if charge > 0 else "-") + f"{abs(charge):g}"
    return formula


def initialize(conn: sqlite3.Connection) -> None:
    # executescript implicitly commits an active transaction, including migrations.
    for statement in DDL.split(";"):
        if statement.strip(): conn.execute(statement)


def metadata(conn: sqlite3.Connection) -> dict[str, str]:
    return {str(k): str(v) for k, v in conn.execute("SELECT key,value FROM metadata")}


def set_metadata(conn: sqlite3.Connection, values: dict[str, Any]) -> None:
    conn.executemany("INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)", [(k, v if isinstance(v, str) else _json(v)) for k, v in values.items()])


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def migrate_in_transaction(conn: sqlite3.Connection) -> None:
    meta = metadata(conn)
    current = meta.get("schema", "easyreaktoro.rtdb/v1")
    if current == SCHEMA_ID:
        return
    require(current == "easyreaktoro.rtdb/v1", "RTDB_SCHEMA_UNSUPPORTED", "error.rtdbSchemaUnsupported", current)
    old = _columns(conn, "species")
    old_dependencies = []
    try: old_dependencies = list(conn.execute("SELECT species_id,dependency_id FROM dependencies"))
    except sqlite3.Error: pass
    conn.execute("ALTER TABLE species RENAME TO species_v1")
    conn.execute("DROP TABLE IF EXISTS dependencies")
    initialize(conn)
    rows = conn.execute("SELECT * FROM species_v1").fetchall()
    names = [description[0] for description in conn.execute("SELECT * FROM species_v1 LIMIT 0").description]
    id_to_name = {}
    for raw in rows:
        row = dict(zip(names, raw))
        payload = _loads(row.get("payload_json", "{}"), {})
        model = _loads(row.get("model_json", "{}"), {})
        record = {
            "id": row.get("id") or uuid.uuid4().hex, "name": row.get("name", ""), "original_name": row.get("name", ""),
            "formula": row.get("formula", ""), "composition": payload.get("composition", {}), "charge": row.get("charge", 0),
            "state": row.get("state", "Unknown"), "tags": _loads(row.get("tags_json", "[]"), []), "model": model,
            "valid_tp": payload.get("valid_tp", {}), "reaction": payload.get("reaction", {}), "activity_parameters": payload.get("activity_parameters", {}),
            "provenance": payload.get("provenance", {}), "references": payload.get("references", []), "notes": payload.get("notes", ""),
            "disabled": bool(row.get("disabled", 0)),
        }
        inserted = insert_species(conn, record); id_to_name[inserted["id"]] = inserted["name"]
    for species_id, dependency_id in old_dependencies:
        dependency_name = id_to_name.get(str(dependency_id), str(dependency_id))
        conn.execute("INSERT OR IGNORE INTO dependencies(species_id,dependency_name) VALUES (?,?)", (str(species_id), dependency_name))
    conn.execute("DROP TABLE species_v1")
    set_metadata(conn, {"schema": SCHEMA_ID, "migrated_at": now(), "legacy_columns": sorted(old)})
    audit(conn, "migrate", {"from": current, "to": SCHEMA_ID})


def audit(conn: sqlite3.Connection, action: str, details: dict[str, Any]) -> None:
    conn.execute("INSERT INTO audit(action,details_json,created_at) VALUES (?,?,?)", (action, _json(details), now()))


def normalize_species(record: dict[str, Any]) -> dict[str, Any]:
    result = {
        "id": str(record.get("id") or uuid.uuid4().hex), "name": str(record.get("name", "")).strip(),
        "original_name": str(record.get("original_name") or record.get("name", "")).strip(), "formula": str(record.get("formula", "")),
        "composition": dict(record.get("composition") or {}), "charge": float(record.get("charge", 0) or 0),
        "state": str(record.get("state", "Unknown")), "tags": list(record.get("tags") or []), "model": dict(record.get("model") or {}),
        "valid_tp": dict(record.get("valid_tp") or {}), "reaction": dict(record.get("reaction") or {}),
        "dependencies": sorted(set(str(x) for x in record.get("dependencies") or [] if x)),
        "activity_parameters": dict(record.get("activity_parameters") or {}), "provenance": dict(record.get("provenance") or {}),
        "references": list(record.get("references") or []), "notes": str(record.get("notes", "")), "disabled": bool(record.get("disabled", False)),
    }
    require(bool(result["name"]), "SPECIES_NAME_REQUIRED", "error.speciesNameRequired", "Species name is required")
    require(math.isfinite(result["charge"]), "CHARGE_INVALID", "error.chargeInvalid", "电荷必须是有限数值")
    if result["composition"] and not result["formula"] and result["model"].get("type") != "reaktoro-native":
        result["formula"] = formula_from_composition(result["composition"], result["charge"])
    result["fingerprint"] = fingerprint({k: v for k, v in result.items() if k not in ("id", "fingerprint")})
    return result


def insert_species(conn: sqlite3.Connection, record: dict[str, Any]) -> dict[str, Any]:
    r = normalize_species(record)
    conn.execute("""INSERT INTO species(id,name,original_name,formula,composition_json,charge,state,tags_json,model_json,valid_tp_json,reaction_json,activity_json,provenance_json,references_json,notes,disabled,fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (r["id"], r["name"], r["original_name"], r["formula"], _json(r["composition"]), r["charge"], r["state"], _json(r["tags"]), _json(r["model"]), _json(r["valid_tp"]), _json(r["reaction"]), _json(r["activity_parameters"]), _json(r["provenance"]), _json(r["references"]), r["notes"], int(r["disabled"]), r["fingerprint"]))
    conn.executemany("INSERT INTO dependencies(species_id,dependency_name) VALUES (?,?)", [(r["id"], dep) for dep in r["dependencies"]])
    return r


def update_species(conn: sqlite3.Connection, species_id: str, record: dict[str, Any]) -> dict[str, Any]:
    require(conn.execute("SELECT 1 FROM species WHERE id=?", (species_id,)).fetchone() is not None, "SPECIES_NOT_FOUND", "error.speciesNotFound", species_id)
    conn.execute("DELETE FROM species WHERE id=?", (species_id,))
    record = dict(record); record["id"] = species_id
    return insert_species(conn, record)


def read_species(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    deps: dict[str, list[str]] = {}
    for sid, dep in conn.execute("SELECT species_id,dependency_name FROM dependencies ORDER BY dependency_name"):
        deps.setdefault(str(sid), []).append(str(dep))
    rows = conn.execute("SELECT id,name,original_name,formula,composition_json,charge,state,tags_json,model_json,valid_tp_json,reaction_json,activity_json,provenance_json,references_json,notes,disabled,fingerprint FROM species ORDER BY name COLLATE NOCASE").fetchall()
    result = []
    for row in rows:
        result.append({"id": row[0], "name": row[1], "original_name": row[2], "formula": row[3], "composition": _loads(row[4], {}), "charge": row[5], "state": row[6], "tags": _loads(row[7], []), "model": _loads(row[8], {}), "valid_tp": _loads(row[9], {}), "reaction": _loads(row[10], {}), "activity_parameters": _loads(row[11], {}), "provenance": _loads(row[12], {}), "references": _loads(row[13], []), "notes": row[14], "disabled": bool(row[15]), "fingerprint": row[16], "dependencies": deps.get(str(row[0]), []), "read_only": False})
    return result


def revision(path: str | Path) -> str | None:
    target = Path(path)
    return hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None


@contextmanager
def atomic_database(target: Path, *, expected_revision: str | None = None, exclusive: bool = False) -> Iterator[sqlite3.Connection]:
    target = target.expanduser().resolve(); target.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent); os.close(fd)
    temp = Path(raw)
    try:
        conn = sqlite3.connect(temp)
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback(); raise
        finally:
            conn.close()
        with temp.open("rb") as stream: os.fsync(stream.fileno())
        require(not Path(str(target) + "-wal").exists() and not Path(str(target) + "-journal").exists(), "RTDB_IN_USE", "error.rtdbInUse", "数据库正在被其他 SQLite 程序使用。请关闭其他程序后重试，或另存为新文件。")
        if expected_revision is not None:
            require(revision(target) == expected_revision, "RTDB_CHANGED_EXTERNALLY", "error.rtdbChangedExternally", "文件已被其他程序修改或删除。请另存为新文件，避免覆盖外部更改。")
        if exclusive:
            try: os.link(temp, target)
            except FileExistsError as exc:
                raise BridgeError("RTDB_ALREADY_EXISTS", "error.rtdbAlreadyExists", "目标文件已存在，请选择新文件名。") from exc
        else: os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()


def create(path: str, name: str, runtime_version: str = "", base: dict[str, Any] | None = None, records: list[dict[str, Any]] | None = None) -> None:
    target = Path(path)
    require(target.suffix.lower() == ".rtdb", "RTDB_EXTENSION", "error.rtdbExtension", str(target))
    with atomic_database(target, exclusive=True) as conn:
        initialize(conn)
        stamp = now(); base = base or {}
        set_metadata(conn, {"schema": SCHEMA_ID, "id": uuid.uuid4().hex, "name": name or target.stem, "base_provider": base.get("provider", ""), "base_name": base.get("name", ""), "runtime_version": runtime_version, "fingerprint": base.get("fingerprint", ""), "created_at": stamp, "modified_at": stamp})
        for record in records or []:
            insert_species(conn, record)
        audit(conn, "create", {"species_count": len(records or [])})


def open_database(path: str) -> tuple[dict[str, str], list[dict[str, Any]]]:
    target = Path(path).expanduser().resolve()
    require(target.exists(), "RTDB_NOT_FOUND", "error.rtdbNotFound", str(target))
    try:
        # Never modify a file merely by opening it. Legacy migration takes place
        # in an isolated SQLite copy; a successful explicit Save upgrades the file.
        source = sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)
        conn = sqlite3.connect(":memory:")
        try:
            source.backup(conn)
            current = metadata(conn).get("schema")
            require(current in (SCHEMA_ID, "easyreaktoro.rtdb/v1"), "RTDB_SCHEMA_UNSUPPORTED", "error.rtdbSchemaUnsupported", str(current))
            conn.execute("BEGIN")
            migrate_in_transaction(conn)
            meta, records = metadata(conn), read_species(conn)
            if current != SCHEMA_ID: meta["migration_pending"] = "true"
            return meta, records
        finally:
            source.close(); conn.close()
    except BridgeError:
        raise
    except Exception as exc:
        raise BridgeError("RTDB_INVALID", "error.rtdbInvalid", str(exc)) from exc


def history(path: str) -> dict[str, list[tuple]]:
    conn = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        tables = {x[0] for x in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {table: list(conn.execute(f"SELECT {columns} FROM {table} ORDER BY id")) if table in tables else [] for table, columns in (("audit", "action,details_json,created_at"), ("validation", "status,report_json,created_at"))}
    finally: conn.close()


def save(path: str, meta: dict[str, Any], records: list[dict[str, Any]], action: str = "save", *, expected_revision: str | None = None, histories: dict | None = None, pending: list | None = None, validation: dict | None = None, exclusive: bool = False) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    require(target.suffix.lower() == ".rtdb", "RTDB_EXTENSION", "error.rtdbExtension", str(target))
    with atomic_database(target, expected_revision=expected_revision, exclusive=exclusive) as conn:
        initialize(conn)
        updated = dict(meta); updated.update({"schema": SCHEMA_ID, "modified_at": now()})
        updated.pop("migration_pending", None)
        set_metadata(conn, updated)
        for record in records:
            insert_species(conn, record)
        for table, columns in (("audit", "action,details_json,created_at"), ("validation", "status,report_json,created_at")):
            conn.executemany(f"INSERT INTO {table}({columns}) VALUES (?,?,?)", (histories or {}).get(table, []))
        for item in pending or []: audit(conn, item["action"], item)
        if validation:
            conn.execute("INSERT INTO validation(status,report_json,created_at) VALUES (?,?,?)", (validation["status"], _json(validation), validation["checked_at"]))
        audit(conn, action, {"species_count": len(records)})
    return updated
