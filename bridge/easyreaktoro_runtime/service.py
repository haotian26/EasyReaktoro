from __future__ import annotations

import json
import copy
import math
import os
import re
import sys
import tempfile
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from . import models, repository
from .errors import BridgeError, require
from .references import phreeqc_references, reference_tokens

try:
    import reaktoro
except Exception as exc:  # external interpreter can legitimately be offline
    reaktoro = None
    IMPORT_ERROR = str(exc)
else:
    IMPORT_ERROR = ""


VERSION = getattr(reaktoro, "__version__", None) if reaktoro else None


def _float(value: Any) -> float | str:
    try:
        return float(value)
    except Exception:
        return str(value)


def _state(species: Any) -> str:
    try:
        return species.aggregateState().name
    except Exception:
        return "Unknown"


def _composition(species: Any) -> dict[str, float]:
    try:
        return {str(element.symbol()): float(coefficient) for element, coefficient in species.elements()}
    except Exception:
        try:
            formula = species.formula()
            return {str(symbol): float(formula.coefficient(symbol)) for symbol in formula.symbols()}
        except Exception:
            return {}


def _model(species: Any) -> dict[str, Any]:
    model = species.standardThermoModel()
    label = type(model).__name__
    raw = ""
    try:
        raw = str(model.params().dumpYaml()).strip()
        first = raw.lstrip("- ").split(":", 1)[0].strip()
        if first:
            label = first
    except Exception:
        pass
    return {"type": "reaktoro-native", "native_type": label, "parameters_yaml": raw, "runtime_version": VERSION}


def _reaction(species: Any) -> dict[str, Any]:
    try:
        reaction = species.reaction()
        if not reaction.initialized():
            return {}
        reactants = {str(item.name() if hasattr(item, "name") else item): float(value) for item, value in reaction.reactants()}
        raw = ""
        try: raw = str(reaction.reactionThermoModel().params().dumpYaml()).strip()
        except Exception: pass
        # str(FormationReaction) is a Python repr with a process-specific address,
        # not an equation; it must never enter UI, persisted data or fingerprints.
        term = lambda name, value: name if abs(value) == 1 else f"{abs(value):g} {name}"
        left = [term(name, value) for name, value in sorted(reactants.items()) if value > 0]
        right = [str(species.name())] + [term(name, value) for name, value in sorted(reactants.items()) if value < 0]
        return {"equation": " + ".join(left) + " → " + " + ".join(right), "reactants": reactants, "model_parameters_yaml": raw}
    except Exception:
        return {}


def official_record(species: Any, group: str, database: str, contents: str = "") -> dict[str, Any]:
    formula = str(species.formula()) if hasattr(species, "formula") else ""
    reaction = _reaction(species)
    name = str(species.name())
    record = {
        "name": name, "original_name": name, "formula": formula, "composition": _composition(species),
        "charge": _float(species.charge()), "state": _state(species), "tags": list(species.tags()),
        "model": _model(species), "valid_tp": {}, "reaction": reaction,
        "dependencies": sorted(reaction.get("reactants", {}).keys()), "activity_parameters": {},
        "provenance": {"provider": "Reaktoro", "group": group, "database": database, "runtime_version": VERSION, "original_name": name},
        "references": [{"raw": token, "kind": "species-reference-token", "verified_from": database} for token in reference_tokens(contents, name)],
        "notes": "", "disabled": False, "read_only": True, "molar_mass_kg_mol": _float(species.molarMass()),
    }
    record["fingerprint"] = repository.fingerprint({k: v for k, v in record.items() if k not in ("read_only", "fingerprint")})
    record["provenance"]["source_fingerprint"] = repository.fingerprint({k: record[k] for k in ("name", "formula", "composition", "charge", "state", "model", "reaction")})
    return record


def _dependency_options(record: dict, candidates: list[dict]) -> list[dict]:
    source = record.get("provenance", {})
    same = [x for x in candidates if all(x.get("provenance", {}).get(k) == source.get(k) for k in ("provider", "group", "database"))]
    options = same or candidates
    # A name alone cannot identify conflicting thermodynamic records. Equal
    # definitions are interchangeable here; otherwise require disambiguation.
    groups = {}
    for item in options:
        signature = repository.fingerprint({k: item.get(k) for k in ("formula", "composition", "charge", "state", "model", "reaction", "dependencies", "activity_parameters")})
        groups.setdefault(signature, []).append(item)
    return [sorted(group, key=lambda x: (x["name"], x["fingerprint"]))[0] for group in groups.values()]


def _closure(index: dict[str, list[dict[str, Any]]], seeds: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[list[str]]]:
    selected = {}; missing = []; cycles = []; visited = set(); active = {}; path = []
    # Iterative DFS: imported deep chains must not exhaust Python's call stack.
    events = [("visit", seed, None) for seed in reversed(seeds)]
    while events:
        action, record, dependency = events.pop()
        identity = record["fingerprint"]
        if action == "leave":
            active.pop(identity, None); path.pop(); visited.add(identity); continue
        if action == "dependency":
            chain = [x["name"] for x in path] + [dependency]
            if dependency == record["name"]:
                cycles.append([record["name"], dependency]); continue
            options = _dependency_options(record, index.get(dependency, []))
            if len(options) != 1:
                missing.append({"code": "AMBIGUOUS_DEPENDENCY" if options else "MISSING_DEPENDENCY", "species": record["name"], "dependency": dependency, "chain": chain, "candidates": [x["name"] + " / " + str(x.get("provenance", {}).get("database", "")) for x in options]})
            else: events.append(("visit", options[0], None))
            continue
        if identity in active:
            cycles.append([x["name"] for x in path[active[identity]:]] + [record["name"]]); continue
        if identity in visited: continue
        selected[identity] = record; active[identity] = len(path); path.append(record)
        events.append(("leave", record, None))
        events.extend(("dependency", record, dep) for dep in reversed(record.get("dependencies", [])))
    return list(selected.values()), missing, cycles


def _safe_suffix(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "source"


def _rename_conflicts(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_name: dict[str, list[dict[str, Any]]] = {}
    for record in records: by_name.setdefault(record["name"], []).append(record)
    output = []; decisions = []; used: set[str] = set(by_name)
    for original in sorted(by_name, key=str.casefold):
        unique = {}
        for record in by_name[original]:
            signature = repository.calculation_signature(record)
            if signature in unique:
                first = unique[signature]
                merged = repository.merge_supplemental(first, record)
                # Keep the source identity while resolving dependent names below.
                merged["fingerprint"] = first["fingerprint"]
                unique[signature] = merged
            else:
                unique[signature] = record
        variants = sorted(unique.values(), key=lambda x: (x.get("provenance", {}).get("provider", ""), x.get("provenance", {}).get("database", ""), x["fingerprint"]))
        for record in variants:
            item = dict(record)
            if len(variants) > 1:
                provenance = item.get("provenance", {}); suffix = _safe_suffix(f"{provenance.get('provider','source')}_{provenance.get('database','database')}")
                candidate = f"{original}__{suffix}"
                if candidate in used: candidate += f"__{item['fingerprint'][:8]}"
                while candidate in used: candidate += "_"
                item["name"] = candidate
                decisions.append({"original_name": original, "resolved_name": candidate, "source": provenance, "fingerprint": item["fingerprint"]})
            used.add(item["name"]); output.append(item)
    # Rewrite dependencies to resolved identities. With multiple variants, prefer
    # the dependency from the same provider/database, then a stable lexical choice.
    name_targets: dict[str, list[dict[str, Any]]] = {}
    original_names = {x["fingerprint"]: x["name"] for x in records}
    for item in output: name_targets.setdefault(original_names[item["fingerprint"]], []).append(item)
    for item in output:
        resolved = []
        source = item.get("provenance", {})
        for dependency in item.get("dependencies", []):
            candidates = name_targets.get(dependency, [])
            if not candidates: resolved.append(dependency); continue
            options = _dependency_options(item, candidates)
            if len(options) != 1: resolved.append(dependency); continue
            chosen = options[0]
            resolved.append(chosen["name"])
        item["dependencies"] = resolved
        reaction = dict(item.get("reaction") or {})
        reactants = reaction.get("reactants") or {}
        if reactants:
            rewritten = {}
            for dependency, coefficient in reactants.items():
                candidates = name_targets.get(dependency, [])
                options = _dependency_options(item, candidates)
                chosen = options[0] if len(options) == 1 else None
                rewritten[chosen["name"] if chosen else dependency] = coefficient
            reaction["reactants"] = rewritten; item["reaction"] = reaction
        refs = item.get("model", {}).get("reference_evaluators", {})
        if refs:
            rewritten_refs = {}
            for dependency, convention in refs.items():
                options = _dependency_options(item, name_targets.get(dependency, []))
                rewritten_refs[options[0]["name"] if len(options) == 1 else dependency] = convention
            item["model"] = {**item["model"], "reference_evaluators": rewritten_refs}
    return output, decisions


def _order_native_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Place formation reactants before products for Reaktoro's YAML reader."""
    pending = {x["name"]: x for x in records}; ordered = []; seen = set()
    require(len(pending) == len(records), "DUPLICATE_NAME", "error.duplicateName", "原生记录名称重复")
    while pending:
        ready = [x for x in pending.values() if set(x.get("dependencies", [])).issubset(seen)]
        require(bool(ready), "NATIVE_DEPENDENCY_ORDER", "error.nativeDependencyOrder", "原生 YAML 存在缺失、循环或非原生依赖，无法独立重新加载")
        for item in ready:
            ordered.append(item); seen.add(item["name"]); pending.pop(item["name"])
    return ordered


def _yaml_species(record: dict[str, Any], interpolation: dict[str, Any] | None = None) -> list[str]:
    composition = " ".join(f"{float(value):g}:{symbol}" for symbol, value in sorted(record.get("composition", {}).items()))
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    lines = [f"- Name: {quote(record['name'])}", f"  Formula: {quote(record.get('formula') or record['name'])}", f"  Elements: {quote(composition)}", f"  Charge: {float(record.get('charge', 0))}", f"  AggregateState: {quote(record.get('state', 'Unknown'))}"]
    if interpolation:
        lines += ["  StandardThermoModel:", "    Interpolation:"]
        for key, value in interpolation.items(): lines.append(f"      {key}: {json.dumps(value, separators=(',', ':'))}")
        return lines
    reaction = record.get("reaction") or {}; reaction_yaml = reaction.get("model_parameters_yaml", "")
    if reaction.get("reactants") and reaction_yaml:
        reactants = " ".join(f"{float(value):g}:{name}" for name, value in reaction["reactants"].items())
        lines += ["  FormationReaction:", f"    Reactants: {quote(reactants)}", "    ReactionStandardThermoModel:"] + ["      " + line for line in reaction_yaml.splitlines()]
    else:
        raw = str(record.get("model", {}).get("parameters_yaml", "")).strip()
        require(bool(raw), "NATIVE_MODEL_MISSING", "error.nativeModelMissing", f"{record['name']} 没有可导出的原生模型参数")
        lines += ["  StandardThermoModel:"] + ["    " + line for line in raw.splitlines()]
    return lines


def _atomic_text(path: Path, text: str) -> None:
    path = path.expanduser().resolve(); path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream: stream.write(text); stream.flush(); os.fsync(stream.fileno())
        os.replace(raw, path)
    finally:
        if os.path.exists(raw): os.unlink(raw)


def _database(group: str, name: str) -> Any:
    require(reaktoro is not None, "RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", IMPORT_ERROR)
    constructors = {"PHREEQC": reaktoro.PhreeqcDatabase, "SUPCRT": reaktoro.SupcrtDatabase, "NASA": reaktoro.NasaDatabase}
    require(group in constructors, "CATALOG_GROUP", "error.catalogGroup", group)
    return constructors[group](name)


def _candidates() -> list[tuple[str, str]]:
    require(reaktoro is not None, "RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", IMPORT_ERROR)
    # PHREEQC is enumerated live. Other families expose no names API in 2.13;
    # candidates are adapters and are returned only after a successful live open.
    return [("PHREEQC", str(x)) for x in reaktoro.PhreeqcDatabase.namesEmbeddedDatabases()] + [("SUPCRT", x) for x in ("supcrt98", "supcrt07", "supcrtbl", "supcrt16")] + [("NASA", "nasa-cea")]


class Service:
    def __init__(self) -> None:
        self.handles: dict[str, dict[str, Any]] = {}
        self.native_databases: dict[tuple[str, str], Any] = {}
        self.verified_native: dict[tuple, Any] = {}
        from .simulation_jobs import Jobs
        self.simulation_jobs = Jobs()

    def probe(self) -> dict[str, Any]:
        if not reaktoro:
            return {"status": "error", "available": False, "version": None, "diagnostic": IMPORT_ERROR, "python": sys.executable}
        return {"status": "ready", "available": True, "version": VERSION, "python": sys.executable, "environment_root": str(Path(sys.prefix).resolve()), "pid": os.getpid()}

    def catalog_entry(self, item: tuple[str, str]) -> dict[str, Any]:
        group, name = item
        try:
            database = _database(group, name)
            return {"id": f"{group.lower()}:{name}", "group": group, "provider": "Reaktoro", "embedded_name": name, "status": "ready", "species_count": len(database.species()), "element_count": len(database.elements()), "read_only": True}
        except Exception as exc:
            return {"id": f"{group.lower()}:{name}", "group": group, "provider": "Reaktoro", "embedded_name": name, "status": "error", "species_count": None, "element_count": None, "read_only": True, "diagnostic": str(exc)}

    def catalog(self) -> dict[str, Any]:
        with ThreadPoolExecutor(max_workers=2) as pool:
            entries = [future.result() for future in as_completed([pool.submit(self.catalog_entry, item) for item in _candidates()])]
        # Candidate adapters that fail live-open are not catalog entries.
        entries = [x for x in entries if x["status"] == "ready"]
        entries.sort(key=lambda x: ({"PHREEQC": 0, "SUPCRT": 1, "NASA": 2}.get(x["group"], 9), x["embedded_name"].lower()))
        return {"status": "ready", "entries": entries, "runtime_version": VERSION}

    def catalog_details(self, group: str, name: str) -> dict[str, Any]:
        database = _database(group, name)
        states: dict[str, int] = {}; families: dict[str, int] = {}
        for species in database.species():
            state = _state(species); states[state] = states.get(state, 0) + 1
            family = _model(species)["native_type"]; families[family] = families.get(family, 0) + 1
        references = []
        if group == "PHREEQC":
            try:
                references = phreeqc_references(str(reaktoro.PhreeqcDatabase.contents(name)))
            except Exception:
                references = []
        return {"group": group, "embedded_name": name, "runtime_version": VERSION, "read_only": True, "phase_counts": states, "model_family_counts": families, "reference_availability": "embedded" if references else "not_provided", "references": references, "diagnostic": "Live-opened by selected Reaktoro runtime"}

    def summary(self, handle: dict[str, Any]) -> dict[str, Any]:
        records = handle["records"]
        elements = sorted({symbol for record in records for symbol in record.get("composition", {})})
        name_counts: dict[str,int] = {}
        for record in records: name_counts[record["name"]] = name_counts.get(record["name"],0)+1
        native = {x["name"]:x for x in records if not x.get("disabled") and name_counts[x["name"]] == 1 and x.get("model",{}).get("type") == "reaktoro-native" and (x["model"].get("parameters_yaml") or x.get("reaction",{}).get("model_parameters_yaml"))}
        while True:
            blocked = [name for name,x in native.items() if any(dep not in native or dep == name for dep in x.get("dependencies",[]))]
            if not blocked: break
            for name in blocked: native.pop(name)
        return {"handle_id": handle["id"], "kind": handle["kind"], "group": handle.get("group"), "provider": handle.get("provider"), "embedded_name": handle.get("name"), "path": handle.get("path"), "read_only": handle["read_only"], "dirty": handle["dirty"], "species_count": len(records), "element_count": len(elements), "runtime_version": VERSION if handle["kind"] == "official" else handle.get("meta", {}).get("runtime_version", ""), "modified_time": handle.get("meta", {}).get("modified_at"), "schema_version": handle.get("meta", {}).get("schema"), "native_exportable_count": len(native)}

    def open_official(self, group: str, name: str) -> dict[str, Any]:
        database = _database(group, name); contents = ""
        if group == "PHREEQC":
            try: contents = str(reaktoro.PhreeqcDatabase.contents(name))
            except Exception: pass
        species = list(database.species())
        records = [official_record(item, group, name, contents) for item in species]
        for index, record in enumerate(records):
            record["id"] = f"native-{index}"
            record["provenance"]["source_index"] = index
        if contents:
            database_references = phreeqc_references(contents)
            for record in records:
                record["references"] = record["references"] + database_references
        for record in records:
            record["fingerprint"] = repository.fingerprint({k: v for k, v in record.items() if k not in ("id", "read_only", "fingerprint")})
        hid = "official-" + uuid.uuid4().hex
        custom_elements = []
        for element in database.elements():
            try: reaktoro.Element(str(element.symbol()))
            except Exception: custom_elements.append({"symbol": str(element.symbol()), "molar_mass": float(element.molarMass())})
        self.handles[hid] = {"id": hid, "kind": "official", "group": group, "name": name, "provider": "Reaktoro", "read_only": True, "dirty": False, "database": database, "species_objects": {str(x.name()): x for x in species}, "species_by_id": {record["id"]: item for record, item in zip(records, species)}, "records": records, "contents": contents, "custom_elements": custom_elements}
        return self.summary(self.handles[hid])

    def open_rtdb(self, path: str) -> dict[str, Any]:
        meta, records = repository.open_database(path); hid = "rtdb-" + uuid.uuid4().hex
        self.handles[hid] = {"id": hid, "kind": "rtdb", "path": str(Path(path).expanduser().resolve()), "name": Path(path).stem, "provider": meta.get("base_provider") or "EasyReaktoro", "read_only": False, "dirty": False, "meta": meta, "records": records}
        self.handles[hid].update({"revision": repository.revision(path), "histories": repository.history(path), "dirty": meta.get("migration_pending") == "true"})
        return self.summary(self.handles[hid])

    def handle(self, handle_id: str) -> dict[str, Any]:
        handle = self.handles.get(handle_id)
        require(handle is not None, "HANDLE_NOT_FOUND", "error.handleNotFound", handle_id)
        return handle

    def page(self, handle: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        from .species_search import search_records
        rows = search_records(handle['records'], args)
        offset = max(0, int(args.get("offset", 0))); limit = min(500, max(1, int(args.get("limit", 100))))
        compact = [{"id": x.get("id"), "name": x["name"], "original_name": x.get("original_name"), "formula": x["formula"], "state": x["state"], "charge": x["charge"], "model": x.get("model", {}).get("native_type", x.get("model", {}).get("type", "Unknown")), "elements": sorted(x.get("composition", {})), "provider": x.get("provenance", {}).get("provider", handle.get("provider")), "read_only": handle["read_only"], "disabled": x.get("disabled", False), "fingerprint": x.get("fingerprint", "")} for x in rows[offset:offset + limit]]
        return {"items": compact, "total": len(rows), "offset": offset, "limit": limit, "models": sorted({x.get("model", {}).get("native_type") or x.get("model", {}).get("type", "Unknown") for x in handle["records"]}), "states": sorted({x["state"] for x in handle["records"]})}

    def species(self, handle: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        species_id, name = args.get("species_id"), args.get("name")
        record = next((x for x in handle["records"] if (species_id and x.get("id") == species_id) or (not species_id and x["name"] == name)), None)
        require(record is not None, "SPECIES_NOT_FOUND", "error.speciesNotFound", str(species_id or name))
        return record

    def species_options(self, handle: dict[str, Any]) -> dict[str, Any]:
        return {"items": [{"id": item.get("id"), "name": item["name"], "formula": item.get("formula", ""), "state": item.get("state", "Unknown")} for item in sorted(handle["records"], key=lambda row: row["name"].casefold())]}

    def native_species(self, handle: dict[str, Any], record: dict[str, Any]) -> Any:
        require(reaktoro is not None, "RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", IMPORT_ERROR)
        if any(x.get("model", {}).get("type") == "converted-standard-state" for x in handle["records"]):
            return self.rtdb_runtime(handle).species(record["name"])
        provenance = record.get("provenance") or {}
        group, database_name = str(provenance.get("group") or ""), str(provenance.get("database") or "")
        original_name = str(record.get("original_name") or provenance.get("original_name") or record["name"])
        if group and database_name:
            key = (group, database_name)
            version = provenance.get("runtime_version")
            require(not version or version == VERSION, "NATIVE_RUNTIME_CHANGED", "error.nativeRuntimeChanged", f"此记录来自 Reaktoro {version}，当前为 {VERSION}。请使用原环境，或从当前环境重新创建副本。")
            identity = (group, database_name, provenance.get("source_index"), original_name, provenance.get("source_fingerprint"))
            if identity in self.verified_native: return self.verified_native[identity]
            def verified(item: Any) -> Any:
                expected = provenance.get("source_fingerprint")
                if expected:
                    live = official_record(item, group, database_name)
                    require(live["provenance"]["source_fingerprint"] == expected, "NATIVE_SOURCE_CHANGED", "error.nativeSourceChanged", "来源数据库的物种参数已改变。请重新创建副本，避免使用与保存记录不一致的数据。")
                self.verified_native[identity] = item
                return item
            if key not in self.native_databases: self.native_databases[key] = _database(group, database_name)
            if isinstance(provenance.get("source_index"), int):
                try:
                    item = list(self.native_databases[key].species())[provenance["source_index"]]
                    require(str(item.name()) == original_name, "NATIVE_SOURCE_CHANGED", "error.nativeSourceChanged", "来源数据库的物种顺序已改变，请从当前运行时重新创建副本")
                    return verified(item)
                except IndexError as exc: raise BridgeError("NATIVE_SOURCE_CHANGED", "error.nativeSourceChanged", "来源数据库的物种顺序已改变") from exc
            matches = [item for item in self.native_databases[key].species() if str(item.name()) == original_name]
            require(len(matches) <= 1, "NATIVE_SOURCE_AMBIGUOUS", "error.nativeSourceAmbiguous", "来源库包含多个同名物种，旧记录没有唯一定位信息。请从当前运行时重新创建副本。")
            try: return verified(self.native_databases[key].species(original_name))
            except BridgeError: raise
            except Exception as exc: raise BridgeError("NATIVE_SOURCE_SPECIES_MISSING", "error.nativeSourceSpeciesMissing", f"{group}/{database_name}: {original_name}: {exc}") from exc
        native_records = [item for item in handle["records"] if not item.get("disabled") and item.get("model", {}).get("type") == "reaktoro-native" and (item.get("model", {}).get("parameters_yaml") or (item.get("reaction") or {}).get("model_parameters_yaml"))]
        require(bool(native_records), "NATIVE_SOURCE_UNAVAILABLE", "error.nativeSourceUnavailable", "原生记录没有可重新加载的来源数据库或模型参数")
        text = "# EasyReaktoro in-memory native database\nSpecies:\n" + "\n".join(line for item in _order_native_records(native_records) for line in _yaml_species(item)) + "\n"
        try: return reaktoro.Database.fromStringYAML(text).species(record["name"])
        except Exception as exc: raise BridgeError("NATIVE_RELOAD_FAILED", "error.nativeReloadFailed", str(exc)) from exc

    def rtdb_runtime(self, handle: dict[str, Any]) -> Any:
        from .loader import build_database
        key = tuple((x.get("id"), x.get("fingerprint"), x.get("disabled")) for x in handle["records"])
        if handle.get("_runtime_key") != key:
            database = build_database(handle["records"], runtime_version=handle.get("meta", {}).get("required_reaktoro_version"))
            handle.update({"_runtime_key": key, "_runtime_database": database})
        return handle["_runtime_database"]

    @staticmethod
    def thermo_result(name: str, species: Any, temperature: float, pressure: float, model: str | None = None) -> dict[str, Any]:
        try: props = species.standardThermoProps(temperature, pressure)
        except Exception as exc: raise BridgeError("EVALUATION_FAILED", "error.evaluationFailed", str(exc)) from exc
        units = {"G0": "J/mol", "H0": "J/mol", "S0": "J/mol/K", "Cp0": "J/mol/K", "V0": "m³/mol", "VP0": "m³/mol/Pa", "VT0": "m³/mol/K"}
        values = {}
        for key in units:
            try: values[key] = _float(getattr(props, key))
            except Exception: values[key] = None
        result = {"name": name, "temperature_K": temperature, "pressure_Pa": pressure, "properties": values, "units": units}
        if model: result["model"] = model
        return result

    def evaluate(self, handle: dict[str, Any], args: dict[str, Any], _stack: tuple[str, ...] = ()) -> dict[str, Any]:
        record = self.species(handle, args); temperature = float(args["temperature_K"]); pressure = float(args["pressure_Pa"])
        require(not record.get("disabled"), "SPECIES_DISABLED", "error.speciesDisabled", "草稿物种不能计算或正式导出")
        require(record["name"] not in _stack, "DEPENDENCY_CYCLE", "error.dependencyCycle", " → ".join((*_stack, record["name"])))
        models.check_tp(temperature, pressure)
        valid = record.get("valid_tp", {}); t_range = valid.get("temperature_K"); p_range = valid.get("pressure_Pa")
        require(not t_range or t_range[0] <= temperature <= t_range[1], "TP_OUT_OF_RANGE", "error.tpOutOfRange", f"T={temperature}")
        require(not p_range or p_range[0] <= pressure <= p_range[1], "TP_OUT_OF_RANGE", "error.tpOutOfRange", f"P={pressure}")
        if handle["kind"] == "official":
            species = handle.get("species_by_id", {}).get(record.get("id"))
            if species is None: species = handle["species_objects"][record["name"]]
            return self.thermo_result(record["name"], species, temperature, pressure)
        model = record.get("model", {})
        if model.get("type") == "converted-standard-state":
            return self.thermo_result(record["name"], self.rtdb_runtime(handle).species(record["name"]), temperature, pressure, model.get("native_type"))
        if model.get("type") == "reaktoro-native":
            return self.thermo_result(record["name"], self.native_species(handle, record), temperature, pressure, model.get("native_type") or "Reaktoro native")
        if model.get("type") == "modified-ryzhenko-bryzgalin":
            def gibbs(t: float, p: float) -> float:
                reaction = models.evaluate(model, t, p)["properties"]
                reactants = (record.get("reaction") or {}).get("reactants") or {name: 1.0 for name in record.get("dependencies", [])}
                total = float(reaction["reaction_G0"])
                for dependency, coefficient in reactants.items():
                    dep = self.evaluate(handle, {"name": dependency, "temperature_K": t, "pressure_Pa": p}, (*_stack, record["name"]))["properties"]
                    total += float(coefficient) * float(dep["G0"])
                return total
            properties = models.gibbs_properties(gibbs, temperature, pressure)
            return {"name":record["name"],"model":model["type"],"temperature_K":temperature,"pressure_Pa":pressure,"properties":properties,"units":{"G0":"J/mol","H0":"J/mol","S0":"J/mol/K","Cp0":"J/mol/K","V0":"m³/mol","VT0":"m³/mol/K","VP0":"m³/mol/Pa"}}
        return {"name": record["name"], **models.evaluate(model, temperature, pressure), "units": {"G0": "J/mol", "H0": "J/mol", "S0": "J/mol/K", "Cp0": "J/mol/K", "V0": "m³/mol", "VT0":"m³/mol/K", "VP0":"m³/mol/Pa", "logK": "1"}}

    def mutate_species(self, handle: dict[str, Any], action: str, args: dict[str, Any]) -> dict[str, Any]:
        require(not handle["read_only"], "READ_ONLY", "error.readOnly", "Official databases are read-only")
        proposed = copy.deepcopy(handle["records"])
        if action == "create":
            record = repository.normalize_species(args["species"])
            issues = models.validate_model(record.get("model") or {}, record.get("disabled", False))
            require(not issues, "MODEL_INVALID", "error.modelInvalid", "; ".join(item["message"] for item in issues))
            definition = models.REGISTRY.get(record.get("model", {}).get("type"))
            require(bool(definition and definition.creatable) or record["disabled"], "MODEL_NOT_CREATABLE", "error.modelNotCreatable", str(record.get("model", {}).get("type")))
            require(bool(record.get("composition")), "COMPOSITION_REQUIRED", "error.compositionRequired", "请先选择元素并填写化学计量数")
            require(all(float(value) > 0 for value in record["composition"].values()), "COMPOSITION_INVALID", "error.compositionInvalid", "元素化学计量数必须大于 0")
            proposed.append(record)
        elif action == "update":
            current = self.species(handle, args); record = repository.normalize_species({**args["species"], "id": current["id"]})
            if current.get("model", {}).get("type") in ("reaktoro-native", "converted-standard-state"):
                require(all(record.get(k) == current.get(k) for k in ("formula", "composition", "charge", "state", "model", "reaction", "dependencies")), "NATIVE_RECORD_IMMUTABLE", "error.nativeRecordImmutable", "来源记录的热力学身份和模型不能直接改写；可编辑名称、来源、参考文献、活度参数和备注。自定义模型请新建物种。")
            old_activity, new_activity = current.get("activity_parameters", {}), record.get("activity_parameters", {})
            if (old_activity.get("model") == new_activity.get("model") == "extended-debye-huckel"
                and old_activity.get("ion_size_angstrom") != new_activity.get("ion_size_angstrom")
                and old_activity.get("source") == new_activity.get("source")):
                # Changing a number must not keep claiming the original citation
                # or fallback rule supplied that new number.
                record["activity_parameters"] = {**new_activity, "source": "", "reference": "", "source_entry": None,
                    "is_default": False, "resolution": "用户指定", "reason": "手动修改离子尺寸；原赋值保留在 original_assignment。",
                    "original_assignment": copy.deepcopy(old_activity.get("original_assignment", old_activity))}
                record = repository.normalize_species(record)
            issues = models.validate_model(record.get("model") or {}, record.get("disabled", False)); require(not issues, "MODEL_INVALID", "error.modelInvalid", "; ".join(item["message"] for item in issues))
            proposed[handle["records"].index(current)] = record
            if record["name"] != current["name"]:
                for other in proposed:
                    other["dependencies"] = [record["name"] if x == current["name"] else x for x in other.get("dependencies", [])]
                    reactants = other.get("reaction", {}).get("reactants", {})
                    if current["name"] in reactants: reactants[record["name"]] = reactants.pop(current["name"])
                    refs = other.get("model", {}).get("reference_evaluators", {})
                    if current["name"] in refs: refs[record["name"]] = refs.pop(current["name"])
                    other["fingerprint"] = repository.normalize_species(other)["fingerprint"]
        else:
            current = self.species(handle, args)
            dependents = [x["name"] for x in proposed if current["name"] in x.get("dependencies", [])]
            require(not dependents, "SPECIES_IN_USE", "error.speciesInUse", "以下物种仍使用该物种：" + "、".join(dependents))
            proposed = [x for x in proposed if x["id"] != current["id"]]; record = current
        issues = self.record_issues(proposed)
        errors = [x for x in issues if x["severity"] == "error"]
        require(not errors, "SPECIES_INVALID", "error.speciesInvalid", "; ".join(x["message"] for x in errors))
        handle["records"] = proposed
        handle["dirty"] = True
        handle.pop("validation", None)
        handle.setdefault("pending_audit", []).append({"action": f"species.{action}", "species_id": record.get("id"), "name": record["name"]})
        return {"species": record, "summary": self.summary(handle)}

    def save(self, handle: dict[str, Any], path: str | None = None, backups_root: str | None = None) -> dict[str, Any]:
        require(not handle["read_only"], "READ_ONLY", "error.readOnly", "Official databases cannot be saved")
        target = str(Path(path or handle["path"]).expanduser().resolve()); meta = dict(handle["meta"])
        same = target == handle["path"]
        from .database_versions import VersionStore
        store = VersionStore(backups_root, target) if backups_root and same else None
        captured: list[str] = []
        def preserve_previous() -> None:
            if store is None: return
            try:
                version_id = store.capture(meta, handle["records"], handle.get("revision"))
                if version_id: captured.append(version_id)
            except BridgeError:
                raise
            except Exception as exc:
                raise BridgeError("BACKUP_SAVE_FAILED", "error.backupSaveFailed", "无法保存历史版本，原数据库尚未改动。请检查保存位置的权限或可用空间，然后重试。") from exc
        try:
            meta = repository.save(target, meta, handle["records"], "save_as" if path else "save", expected_revision=handle.get("revision") if same else None, exclusive=not same, histories=handle.get("histories"), pending=handle.get("pending_audit"), validation=handle.get("validation"), before_replace=preserve_previous if store else None)
        except Exception:
            for version_id in captured:
                try: store.delete(version_id)
                except Exception: pass  # Retaining a valid old snapshot is safer than removing unknown data.
            raise
        backup_warning = None
        if store and captured:
            try: store.prune()
            except Exception:
                backup_warning = "数据库及本次历史版本已保存，但未能清理较早版本。请在历史版本中检查。"

        handle.update({"path": target, "name": Path(target).stem, "dirty": False, "meta": meta, "pending_audit": [], "revision": repository.revision(target), "histories": repository.history(target)})
        handle.pop("validation", None)
        return {"success": True, "output_path": target, "summary": self.summary(handle), "backup_warning": backup_warning}

    @staticmethod
    def record_issues(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        issues = []
        index: dict[str, list[dict]] = {}
        for record in records: index.setdefault(record["name"], []).append(record)
        for name, items in index.items():
            if len(items) > 1: issues.append({"code": "DUPLICATE_NAME", "severity": "error", "species": name, "message": f"物种名称重复：{name}"})
        for record in records:
            name = record["name"]
            def issue(code: str, message: str) -> None:
                issues.append({"code": code, "severity": "warning" if record.get("disabled") else "error", "species": name, "message": f"{name}：{message}"})
            if record.get("disabled"): issue("DISABLED_DRAFT", "草稿不参与计算或正式导出")
            for x in models.validate_model(record.get("model", {}), record.get("disabled", False)): issue(x["code"], x["message"])
            composition = record.get("composition", {})
            if not composition or any(not isinstance(v, (float, int)) or not math.isfinite(v) or v <= 0 for v in composition.values()): issue("COMPOSITION_INVALID", "元素组成必须包含大于 0 的有限数值")
            definition = models.REGISTRY.get(record.get("model", {}).get("type"))
            if definition and definition.states and record.get("state") not in definition.states: issue("MODEL_STATE_MISMATCH", "相态不适用于该模型")
            if record.get("model", {}).get("type") == "akinfiev-diamond" and record.get("charge") != 0: issue("MODEL_CHARGE_MISMATCH", "Akinfiev–Diamond 仅适用于中性水溶物种")
            for key, value in record.get("valid_tp", {}).items():
                if not isinstance(value, list) or len(value) != 2 or any(not isinstance(x, (int, float)) or not math.isfinite(x) or x <= 0 for x in value) or value[0] >= value[1]: issue("INVALID_TP_RANGE", f"{key} 必须是正数且下限小于上限")
            activity = record.get("activity_parameters", {})
            if "ion_size_angstrom" in activity:
                size = activity["ion_size_angstrom"]
                if not isinstance(size, (int, float)) or not math.isfinite(size) or size <= 0: issue("ACTIVITY_PARAMETER_INVALID", "离子尺寸 aᵢ 必须大于 0 Å")
            reactants = record.get("reaction", {}).get("reactants", {})
            if definition and definition.reaction_based:
                if not reactants: issue("REACTION_REQUIRED", "需要填写形成反应")
                if set(reactants) != set(record.get("dependencies", [])): issue("REACTION_DEPENDENCIES", "形成反应与引用物种不一致")
                if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v == 0 for v in reactants.values()): issue("REACTION_COEFFICIENT", "反应系数必须是非零有限数值")
                elif reactants and all(x in index for x in reactants):
                    balance: dict[str, float] = {}; charge = 0.0
                    for dep, coefficient in reactants.items():
                        source = index[dep][0]; charge += coefficient * source.get("charge", 0)
                        for symbol, amount in source.get("composition", {}).items(): balance[symbol] = balance.get(symbol, 0) + coefficient * amount
                    if any(abs(balance.get(e, 0)-composition.get(e, 0)) > 1e-7 for e in set(balance) | set(composition)) or abs(charge-record.get("charge", 0)) > 1e-7: issue("REACTION_UNBALANCED", "形成反应的元素或电荷不守恒，请检查已有物种与计量系数")
            for dependency in record.get("dependencies", []):
                if dependency not in index: issue("MISSING_DEPENDENCY", f"缺少已有物种 {dependency}")
                elif index[dependency][0].get("disabled") and not record.get("disabled"): issue("DISABLED_DEPENDENCY", f"引用的物种 {dependency} 是草稿")
        _, _, cycles = _closure(index, [x for x in records if not x.get("disabled")])
        for cycle in cycles: issues.append({"code": "DEPENDENCY_CYCLE", "severity": "error", "species": cycle[0], "message": "反应循环：" + " → ".join(cycle)})
        return issues

    def validate(self, handle: dict[str, Any]) -> dict[str, Any]:
        issues = self.record_issues(handle["records"])
        status = "error" if any(x["severity"] == "error" for x in issues) else "warning" if issues else "valid"
        report = {"status": status, "species_count": len(handle["records"]), "issues": issues, "checked_at": repository.now()}
        if not handle["read_only"]: handle["validation"] = report
        return report

    def compose_preview(self, args: dict[str, Any]) -> dict[str, Any]:
        selections = args.get("selections") or []
        source_handles = [self.handle(str(item["handle_id"])) for item in selections]
        require(all(x["kind"] in ("official", "rtdb") for x in source_handles), "COMPOSE_SOURCE", "error.composeSource", "请选择已打开的系统数据库或个人数据库")
        index: dict[str, list[dict[str, Any]]] = {}; seeds = []
        for selection, handle in zip(selections, source_handles):
            for record in handle["records"]: index.setdefault(record["name"], []).append(record)
            names = set(str(x) for x in selection.get("names", []))
            seeds.extend(handle["records"] if selection.get("all") else (x for x in handle["records"] if x["name"] in names))
        require(bool(seeds), "COMPOSE_EMPTY", "error.composeEmpty", "Select at least one species")
        closure, missing, cycles = _closure(index, seeds); renamed, decisions = _rename_conflicts(closure)
        preview = {"preview_id": uuid.uuid4().hex, "selected_count": len(seeds), "dependency_count": len(closure) - len({x['fingerprint'] for x in seeds}), "records": renamed, "rename_decisions": decisions, "missing_dependencies": missing, "cycles": cycles, "can_commit": not missing and not cycles, "source_databases": [{"kind": h["kind"], "group": h.get("group", "RTDB"), "name": h["name"]} for h in source_handles]}
        if args.get("target_handle_id"):
            merged = self.merge_preview(self.handle(args["target_handle_id"]), renamed, {})
            preview.update({"can_commit": preview["can_commit"] and merged["can_commit"], "rename_decisions": merged["rename_decisions"], "issues": merged["issues"]})
        return preview

    def compose_commit(self, args: dict[str, Any]) -> dict[str, Any]:
        preview = self.compose_preview(args)
        require(preview["can_commit"], "COMPOSE_BLOCKED", "error.composeBlocked", json.dumps({"missing": preview["missing_dependencies"], "cycles": preview["cycles"]}, ensure_ascii=False))
        if args.get("target_handle_id"):
            target = self.handle(args["target_handle_id"])
            merged = self.merge_preview(target, preview["records"], {})
            require(merged["can_commit"], "IMPORT_BLOCKED", "error.importBlocked", json.dumps(merged["issues"], ensure_ascii=False))
            self.commit_merge(target, merged, "compose.commit")
            return {"success": True, "summary": self.summary(target), "import_count": merged["import_count"], "update_count": merged.get("update_count", 0)}
        base = {"provider": "Reaktoro", "name": ", ".join(x["name"] for x in preview["source_databases"]), "fingerprint": repository.fingerprint(preview["source_databases"])}
        records = [{**record, "id": uuid.uuid4().hex} for record in preview["records"]]
        repository.create(str(args["path"]), str(args.get("name") or Path(args["path"]).stem), VERSION or "", base, records)
        return {"success": True, "summary": self.open_rtdb(str(args["path"])), "preview": {k: v for k, v in preview.items() if k != "records"}}

    def import_preview(self, handle: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        require(not handle["read_only"], "READ_ONLY", "error.readOnly", "Import requires an editable database")
        requested = Path(args["path"]).expanduser().resolve(); path = requested; records = []
        if requested.suffix.lower() == ".rtdb":
            _, records = repository.open_database(str(requested))
        else:
            if requested.is_dir():
                yaml_files = sorted([*requested.glob("*.yaml"), *requested.glob("*.yml")])
                json_files = [x for x in (requested / "records.json", requested / "database.json") if x.exists()]
                require(bool(yaml_files or json_files), "IMPORT_FOLDER_STRUCTURE", "error.importFolderStructure", "Folder must contain YAML or records.json/database.json")
                files = json_files or yaml_files
                require(len(files) == 1, "IMPORT_FOLDER_AMBIGUOUS", "error.importFolderAmbiguous", "文件夹包含多个候选数据文件，请直接选择要导入的 YAML；不能自动忽略其他文件。")
                path = files[0]
            require(path.suffix.lower() in (".yaml", ".yml", ".json"), "IMPORT_FORMAT", "error.importFormat", str(path))
            try:
                if path.suffix.lower() == ".json": data = json.loads(path.read_text(encoding="utf-8"))
                else:
                    import yaml
                    data = yaml.safe_load(path.read_text(encoding="utf-8"))
            except Exception as exc:
                raise BridgeError("IMPORT_READ", "error.importRead", str(exc)) from exc
            raw = data.get("Species", data.get("species", data.get("records", []))) if isinstance(data, dict) else []
            if isinstance(raw, dict): raw = list(raw.values())
            require(isinstance(raw, list), "IMPORT_SCHEMA", "error.importSchema", "Species must be a list or mapping")
            for index, item in enumerate(raw):
                require(isinstance(item, dict) and (item.get("Name") or item.get("name")), "IMPORT_SCHEMA", "error.importSchema", f"Species[{index}] has no name")
                if item.get("model", {}).get("type"):
                    source = item.get("provenance") or {"provider": "Imported records JSON", "database": path.name, "source_path": str(requested)}
                    records.append(repository.normalize_species({**item, "provenance": source})); continue
                try: import yaml
                except ImportError as exc: raise BridgeError("YAML_UNAVAILABLE", "error.yamlUnavailable", "当前 Python 环境缺少 PyYAML，无法读取原生 YAML 模型；.rtdb 和结构化模型 JSON 仍可使用。") from exc
                name = str(item.get("Name") or item.get("name")); formula = str(item.get("Formula") or item.get("formula") or name)
                elements_raw = item.get("Elements") or item.get("elements") or ""; composition = {}
                if isinstance(elements_raw, str):
                    for token in elements_raw.split():
                        if ":" in token:
                            coefficient, symbol = token.split(":", 1); composition[symbol] = float(coefficient)
                elif isinstance(elements_raw, dict): composition = {str(k): float(v) for k, v in elements_raw.items()}
                standard = item.get("StandardThermoModel") or item.get("model") or {}; reaction_raw = item.get("FormationReaction") or item.get("reaction") or {}
                reactants_raw = reaction_raw.get("Reactants", {}) if isinstance(reaction_raw, dict) else {}; reactants = {}
                if isinstance(reactants_raw, str):
                    for token in reactants_raw.split():
                        if ":" in token:
                            coefficient, dep = token.split(":", 1); reactants[dep] = float(coefficient)
                elif isinstance(reactants_raw, dict): reactants = {str(k): float(v) for k, v in reactants_raw.items()}
                standard_yaml = yaml.safe_dump(standard, allow_unicode=True, sort_keys=False).strip() if standard else ""
                reaction_model = reaction_raw.get("ReactionStandardThermoModel", {}) if isinstance(reaction_raw, dict) else {}
                reaction_yaml = yaml.safe_dump(reaction_model, allow_unicode=True, sort_keys=False).strip() if reaction_model else ""
                records.append(repository.normalize_species({"name": name, "formula": formula, "composition": composition, "charge": item.get("Charge", item.get("charge", 0)), "state": item.get("AggregateState", item.get("state", "Unknown")), "model": {"type": "reaktoro-native", "parameters": standard, "parameters_yaml": standard_yaml}, "reaction": {"reactants": reactants, "model_parameters_yaml": reaction_yaml}, "dependencies": list(reactants), "provenance": {"provider": "Imported YAML" if path.suffix.lower() != ".json" else "Imported records JSON", "database": path.name, "source_path": str(requested)}}))
        preview = self.merge_preview(handle, records, args)
        return {**preview, "path": str(requested), "detected_source": str(path), "source_revision": repository.revision(path) if path.is_file() else None}

    def merge_preview(self, handle: dict[str, Any], records: list[dict[str, Any]], args: dict[str, Any]) -> dict[str, Any]:
        require(not handle["read_only"], "READ_ONLY", "error.readOnly", "需要可编辑数据库")
        signature = repository.calculation_signature
        existing = {signature(x): x for x in handle["records"]}
        incoming = {}
        for raw in records:
            record = repository.normalize_species(raw)
            key = signature(record)
            incoming[key] = repository.merge_supplemental(incoming[key], record) if key in incoming else record
        additions, updates = [], []
        labels = {"references": "文献", "notes": "备注", "tags": "标签", "valid_tp": "适用温压", "provenance": "来源记录"}
        for sig, record in incoming.items():
            if sig not in existing:
                additions.append({**record, "id": uuid.uuid4().hex})
                continue
            target = existing[sig]
            updated = repository.merge_supplemental(target, record)
            fields = [label for key, label in labels.items() if updated.get(key) != target.get(key)]
            if fields:
                # Selection identity is stable across preview and commit, independent of UUIDs.
                updates.append({**updated, "fingerprint": repository.fingerprint({"target": target["id"], "updated": updated["fingerprint"]}),
                    "merge_kind": "metadata", "merge_fields": fields,
                    "range_conflict": updated.get("provenance", {}).get("valid_tp_alternatives") != target.get("provenance", {}).get("valid_tp_alternatives")})
        combined, decisions = _rename_conflicts(handle["records"] + additions)
        imported_fingerprints = {x["fingerprint"] for x in additions}
        imported = [x for x in combined if x["fingerprint"] in imported_fingerprints]
        graph: dict[str, list[dict[str, Any]]] = {}
        for record in combined: graph.setdefault(record["name"], []).append(record)
        selectable = imported_fingerprints | {x["fingerprint"] for x in updates}
        selected = set(args["fingerprints"]) if "fingerprints" in args else selectable
        require(selected.issubset(selectable), "IMPORT_SOURCE_CHANGED", "error.importSourceChanged", "源文件或选择已经改变，请重新预览")
        seeds = [x for x in imported if x["fingerprint"] in selected]
        closure, missing, cycles = _closure(graph, seeds)
        required = {x["fingerprint"] for x in closure}
        chosen = [x for x in imported if x["fingerprint"] in required]
        chosen_updates = [x for x in updates if x["fingerprint"] in selected]
        by_id = {x["id"]: repository.normalize_species(x) for x in chosen_updates}
        originals = [by_id.get(x["id"], x) for x in handle["records"]]
        chosen_sources = [x for x in additions if x["fingerprint"] in required]
        final, decisions = _rename_conflicts(originals + chosen_sources)
        issues = self.record_issues(final)
        return {"items": imported + updates, "new_count": len(imported), "update_count": len(chosen_updates),
                "selected_count": len(seeds) + len(chosen_updates), "import_count": len(chosen),
                "dependency_count": len(chosen)-len(seeds), "combined_records": final, "rename_decisions": decisions,
                "missing_dependencies": missing, "cycles": cycles, "issues": issues,
                "can_commit": not missing and not cycles and not any(x["severity"] == "error" for x in issues),
                "reused_count": len(records)-len(additions)}

    def commit_merge(self, handle: dict[str, Any], preview: dict[str, Any], action: str) -> None:
        if preview["import_count"] == 0 and preview.get("update_count", 0) == 0: return
        handle["records"] = [repository.normalize_species({**x, "id": x.get("id") or uuid.uuid4().hex}) for x in preview["combined_records"]]
        handle["dirty"] = True
        handle.pop("validation", None)
        handle.setdefault("pending_audit", []).append({"action": action, "count": preview["import_count"], "updated": preview.get("update_count", 0), "renames": preview["rename_decisions"]})

    def import_commit(self, handle: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        preview = self.import_preview(handle, args)
        require(not args.get("source_revision") or preview["source_revision"] == args["source_revision"], "IMPORT_SOURCE_CHANGED", "error.importSourceChanged", "源文件已改变，请重新预览")
        require(preview["can_commit"], "IMPORT_BLOCKED", "error.importBlocked", json.dumps(preview["issues"] + preview["missing_dependencies"], ensure_ascii=False))
        self.commit_merge(handle, preview, "import.commit")
        return {"success": True, "import_count": preview["import_count"], "update_count": preview.get("update_count", 0), "summary": self.summary(handle)}

    def export_native(self, handle: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        require(all(path.suffix.lower() in (".yaml", ".yml") for path in (Path(str(args.get("path", ""))), Path(str(args.get("path", ""))).expanduser().resolve())), "EXPORT_EXTENSION", "error.exportExtension", "导出路径及其实际目标必须使用 YAML 扩展名（.yaml 或 .yml），不能覆盖数据库文件。")
        require(reaktoro is not None, "RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", IMPORT_ERROR)
        included = []; excluded = []; name_counts: dict[str, int] = {}
        for record in handle["records"]: name_counts[record["name"]] = name_counts.get(record["name"], 0) + 1
        for record in handle["records"]:
            if record.get("disabled"):
                excluded.append({"name": record["name"], "reason": "disabled draft"})
            elif name_counts[record["name"]] > 1:
                excluded.append({"name": record["name"], "reason": "duplicate species name is not representable in Reaktoro YAML"})
            elif record.get("model", {}).get("type") != "reaktoro-native":
                excluded.append({"name": record["name"], "reason": "model is not natively expressible"})
            elif not record.get("model", {}).get("parameters_yaml") and not record.get("reaction", {}).get("model_parameters_yaml"):
                excluded.append({"name": record["name"], "reason": "缺少原生模型参数"})
            else: included.append(record)
        while True:
            names = {x["name"] for x in included}
            blocked = [x for x in included if any(dep not in names or dep == x["name"] for dep in x.get("dependencies", []))]
            if not blocked: break
            for record in blocked:
                included.remove(record); excluded.append({"name": record["name"], "reason": "形成反应包含被排除、缺失或自身引用的物种"})
        require(bool(included), "EXPORT_EMPTY", "error.exportEmpty", "没有具备完整原生参数及形成反应的记录；可尝试经过真实采样验证的插值导出。")
        lines = ["# EasyReaktoro native YAML"]
        if handle.get("custom_elements"):
            lines.append("Elements:")
            for element in handle["custom_elements"]: lines.extend([f"- Symbol: {element['symbol']}", f"  MolarMass: {element['molar_mass']}"])
        lines.append("Species:")
        for record in _order_native_records(included): lines.extend(_yaml_species(record))
        text = "\n".join(lines) + "\n"; path = Path(args["path"])
        try:
            loaded = reaktoro.Database.fromStringYAML(text)
            require(len(loaded.species()) == len(included), "EXPORT_RELOAD_COUNT", "error.exportReloadCount", f"{len(loaded.species())} != {len(included)}")
        except BridgeError: raise
        except Exception as exc: raise BridgeError("EXPORT_RELOAD_FAILED", "error.exportReloadFailed", str(exc)) from exc
        _atomic_text(path, text)
        return {"success": True, "output_path": str(path.expanduser().resolve()), "export_count": len(included), "exclude_count": len(excluded), "exclusions": excluded, "validation": {"status": "valid", "reload": "Reaktoro Database.fromStringYAML", "species_count": len(loaded.species()), "runtime_version": VERSION}}

    def export_interpolation(self, handle: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        require(all(path.suffix.lower() in (".yaml", ".yml") for path in (Path(str(args.get("path", ""))), Path(str(args.get("path", ""))).expanduser().resolve())), "EXPORT_EXTENSION", "error.exportExtension", "导出路径及其实际目标必须使用 YAML 扩展名（.yaml 或 .yml），不能覆盖数据库文件。")
        require(reaktoro is not None, "RUNTIME_UNAVAILABLE", "error.runtimeUnavailable", IMPORT_ERROR)
        temperatures = [float(x) for x in args.get("temperatures_K", [])]; pressures = [float(x) for x in args.get("pressures_Pa", [])]
        require(len(temperatures) >= 2 and len(pressures) >= 2, "INTERPOLATION_GRID", "error.interpolationGrid", "At least 2 temperatures and 2 pressures are required")
        tolerance = float(args.get("tolerance", 1e-6)); included = []; excluded = []
        require(all(math.isfinite(x) and x > 0 for x in temperatures + pressures) and all(a < b for axis in (temperatures, pressures) for a, b in zip(axis, axis[1:])), "INTERPOLATION_GRID", "error.interpolationGrid", "温压网格必须为严格递增的正数，不能重复")
        require(math.isfinite(tolerance) and 0 < tolerance <= 1, "INTERPOLATION_TOLERANCE_INVALID", "error.interpolationToleranceInvalid", "误差容限必须大于 0 且不超过 1")
        require(len(temperatures)*len(pressures)*len(handle["records"]) <= 500_000, "INTERPOLATION_GRID_TOO_LARGE", "error.interpolationGridTooLarge", "采样总量超过 500,000 点，请缩小网格或数据库")
        keys = ("G0", "H0", "V0", "Cp0", "VT0", "VP0")
        name_counts: dict[str, int] = {}
        for record in handle["records"]: name_counts[record["name"]] = name_counts.get(record["name"], 0) + 1
        for record in handle["records"]:
            if name_counts[record["name"]] > 1:
                excluded.append({"name": record["name"], "reason": "同名物种无法在 Reaktoro YAML 中区分，请先重命名"}); continue
            if record.get("disabled"):
                excluded.append({"name": record["name"], "reason": "disabled draft"}); continue
            matrices = {key: [] for key in keys}
            try:
                for pressure in pressures:
                    row_values = {key: [] for key in keys}
                    for temperature in temperatures:
                        values = self.evaluate(handle, {"species_id": record.get("id"), "name": record["name"], "temperature_K": temperature, "pressure_Pa": pressure})["properties"]
                        for key in keys:
                            value = values.get(key)
                            require(isinstance(value, (float, int)) and math.isfinite(value), "INTERPOLATION_MISSING_PROPERTY", "error.interpolationMissingProperty", f"{record['name']}: {key} 未提供或非有限值")
                            row_values[key].append(float(value))
                    for key in keys: matrices[key].append(row_values[key])
                included.append((record, {"Temperatures": temperatures, "Pressures": pressures, **matrices}))
            except Exception as exc: excluded.append({"name": record["name"], "reason": str(exc)})
        require(bool(included), "EXPORT_EMPTY", "error.exportEmpty", "No records could be sampled")
        lines = ["# EasyReaktoro interpolation YAML"]
        if handle.get("custom_elements"):
            lines.append("Elements:")
            for element in handle["custom_elements"]: lines.extend([f"- Symbol: {element['symbol']}", f"  MolarMass: {element['molar_mass']}"])
        lines.append("Species:")
        for record, interpolation in included: lines.extend(_yaml_species(record, interpolation))
        text = "\n".join(lines) + "\n"
        try: loaded = reaktoro.Database.fromStringYAML(text)
        except Exception as exc: raise BridgeError("EXPORT_RELOAD_FAILED", "error.exportReloadFailed", str(exc)) from exc
        require(len(loaded.species()) == len(included), "EXPORT_RELOAD_COUNT", "error.exportReloadCount", f"{len(loaded.species())} != {len(included)}")
        errors = []
        for record, _ in included:
            target_species = loaded.species(record["name"])
            check_temperatures = [(a + b) / 2.0 for a, b in zip(temperatures, temperatures[1:])]
            check_pressures = [(a + b) / 2.0 for a, b in zip(pressures, pressures[1:])]
            for temperature in check_temperatures:
                for pressure in check_pressures:
                    source = self.evaluate(handle, {"species_id": record.get("id"), "name": record["name"], "temperature_K": temperature, "pressure_Pa": pressure})["properties"]
                    target = target_species.standardThermoProps(temperature, pressure)
                    for key in keys:
                        expected = float(source[key]); actual = float(getattr(target, key)); scale = max(1.0, abs(expected))
                        require(math.isfinite(expected) and math.isfinite(actual), "INTERPOLATION_NONFINITE", "error.interpolationNonfinite", f"{record['name']}: {key}")
                        errors.append(abs(actual - expected) / scale)
        maximum = max(errors, default=0.0); require(maximum <= tolerance, "INTERPOLATION_TOLERANCE", "error.interpolationTolerance", f"relative error {maximum} > {tolerance}")
        path = Path(args["path"]); _atomic_text(path, text)
        return {"success": True, "output_path": str(path.expanduser().resolve()), "export_count": len(included), "exclude_count": len(excluded), "exclusions": excluded, "validation": {"status": "valid", "reload": "Reaktoro Database.fromStringYAML", "maximum_relative_error": maximum, "tolerance": tolerance}}

    def dispatch(self, args: dict[str, Any]) -> dict[str, Any]:
        op = args.get("op")
        if op == "simulation.request": return self.simulation_jobs.dispatch(self, args)
        if op == "runtime.probe": return self.probe()
        if op == "runtime.can_switch":
            require(not any(x["dirty"] for x in self.handles.values()), "DIRTY_DATABASE", "error.dirtyDatabase", "请先保存或关闭未保存的数据库")
            return {"can_switch": True}
        if op == "runtime.diagnostics": return {"probe": self.probe(), "bridge": {"pid": os.getpid(), "handles": len(self.handles), "python": sys.executable}, "model_registry": models.definitions()}
        if op == "model.definitions": return {"items": models.definitions()}
        if op == "model.fit_mrb": return models.fit_mrb(list(args.get("rows") or []), str(args.get("value_kind") or "pK"))
        if op == "catalog.list": return self.catalog()
        if op == "catalog.entry_details": return self.catalog_details(str(args["group"]), str(args["name"]))
        if op == "database.open": return {"summary": self.open_official(str(args["group"]), str(args["name"]))}
        if op == "compose.preview": return self.compose_preview(args)
        if op == "compose.commit": return self.compose_commit(args)
        if op == "rtdb.create":
            repository.create(str(args["path"]), str(args.get("name") or Path(args["path"]).stem), VERSION or "", args.get("base"), args.get("records")); return {"summary": self.open_rtdb(str(args["path"]))}
        if op == "rtdb.open": return {"summary": self.open_rtdb(str(args["path"]))}
        if op == "rtdb.list_info":
            paths = args.get("paths", [])
            require(isinstance(paths, list) and len(paths) <= 200 and all(isinstance(p, str) for p in paths), "RTDB_PATHS_INVALID", "error.rtdbPathsInvalid", "数据库列表无法读取，请重新打开数据库页面。")
            items = []
            for path in dict.fromkeys(paths):
                try:
                    items.append({"path": path, "status": "ready", **repository.database_info(path)})
                except BridgeError as exc:
                    items.append({"path": path, "status": "error", "message": exc.diagnostic})
            return {"items": items}
        if op == "database.close":
            handle = self.handle(str(args["handle_id"])); require(not handle["dirty"] or bool(args.get("discard")), "DIRTY_DATABASE", "error.dirtyDatabase", "Save or discard changes before closing"); self.handles.pop(handle["id"]); return {"closed": True, "handle_id": handle["id"]}
        handle = self.handle(str(args.get("handle_id", "")))
        if op == "database.summary": return {"summary": self.summary(handle)}
        if op == "database.species_page": return self.page(handle, args)
        if op == "database.species_options": return self.species_options(handle)
        if op == "species.details":
            details = copy.deepcopy(self.species(handle, args))
            mass = details.get("provenance", {}).get("molar_mass_kg_mol")
            if isinstance(mass, (int, float)) and math.isfinite(mass): details["molar_mass_kg_mol"] = mass
            details["model_definition"] = next((item for item in models.definitions() if item["id"] == details.get("model", {}).get("type")), None)
            if details.get("model", {}).get("type") == "converted-standard-state":
                from .converted import parameter_definition, visible_parameters
                details["model_definition"] = parameter_definition(details["model"])
                details["model_parameters"] = visible_parameters(details["model"])
            raw = details.get("model", {}).get("parameters_yaml")
            if raw:
                try:
                    import yaml
                    parsed = yaml.safe_load(raw)
                    if isinstance(parsed, list): parsed = [item for item in parsed if item is not None]
                    if isinstance(parsed, (dict, list)) and parsed: details["model_parameters"] = parsed
                except Exception: pass  # Formatting must not prevent opening a record.
            return details
        if op == "species.evaluate": return self.evaluate(handle, args)
        if op == "species.create": return self.mutate_species(handle, "create", args)
        if op == "species.update": return self.mutate_species(handle, "update", args)
        if op == "species.delete": return self.mutate_species(handle, "delete", args)
        if op == "rtdb.save": return self.save(handle, backups_root=args.get("backups_root"))
        if op == "rtdb.save_as": return self.save(handle, str(args["path"]), backups_root=args.get("backups_root"))
        if op == "rtdb.versions":
            from .database_versions import VersionStore
            require(not handle["read_only"], "READ_ONLY", "error.readOnly", "系统数据库没有个人历史版本。")
            return VersionStore(str(args["backups_root"]), handle["path"]).request(args.get("payload") or {})
        if op == "validate.database": return self.validate(handle)
        if op == "import.preview": return self.import_preview(handle, args)
        if op == "import.commit": return self.import_commit(handle, args)
        if op == "export.native_yaml": return self.export_native(handle, args)
        if op == "export.interpolation": return self.export_interpolation(handle, args)
        raise BridgeError("UNSUPPORTED_OPERATION", "error.unsupportedOperation", str(op))


SERVICE = Service()


def dispatch(args: dict[str, Any]) -> dict[str, Any]:
    try:
        result = SERVICE.dispatch(args)
        if isinstance(result, dict): result.setdefault("ok", True)
        return result
    except BridgeError as exc:
        return exc.response()
    except Exception as exc:
        return BridgeError("BRIDGE_EXCEPTION", "error.bridgeException", "".join(traceback.format_exception_only(type(exc), exc)).strip()).response()
