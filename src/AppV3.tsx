import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  Activity,
  Atom,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Ellipsis,
  FilePlus2,
  FlaskConical,
  FolderOpen,
  Home,
  Info,
  MonitorCog,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { ChemicalFormula, ELEMENTS, PeriodicTable } from "./chemistry";

type Page = "home" | "databases" | "simulation" | "settings";
type Theme = "system" | "light" | "dark";
type Runtime = {
  status: "unconfigured" | "probing" | "ready" | "error";
  available: boolean;
  version?: string;
  python?: string;
  environment_root?: string;
  diagnostic?: string;
};
type Candidate = Runtime & { python: string };
type Catalog = {
  id: string;
  group: "PHREEQC" | "SUPCRT" | "NASA";
  provider: string;
  embedded_name: string;
  status: string;
  species_count: number;
  element_count: number;
  read_only: boolean;
};
type Summary = {
  handle_id: string;
  kind: "official" | "rtdb";
  group?: string;
  provider?: string;
  embedded_name?: string;
  path?: string;
  read_only: boolean;
  dirty: boolean;
  species_count: number;
  element_count: number;
  runtime_version?: string;
  modified_time?: string;
  schema_version?: string;
  native_exportable_count?: number;
};
type Species = {
  id?: string;
  name: string;
  original_name?: string;
  formula: string;
  state: string;
  charge: number;
  model: string;
  elements: string[];
  provider?: string;
  read_only: boolean;
  disabled?: boolean;
  fingerprint?: string;
};
type Details = Record<string, any>;
type Recent = {
  path: string;
  name: string;
  opened_at: string;
  pinned?: boolean;
};
type DefaultDb =
  | { kind: "rtdb"; path: string }
  | { kind: "official"; group: string; name: string };
type Preferences = {
  language: string;
  theme: Theme;
  density: "compact" | "comfortable";
  startup: "home";
  runtime_path?: string;
  default_database?: DefaultDb;
  recent_databases: Recent[];
  save_directory?: string;
  export_directory?: string;
  powered_by?: string;
  github_url?: string;
};
type ModelParameter = {
  name: string;
  label: string;
  unit: string;
  help: string;
  required: boolean;
};
type ModelDefinition = {
  id: string;
  label: string;
  description: string;
  native: boolean;
  creatable: boolean;
  calculable: boolean;
  reaction_based: boolean;
  states: string[];
  parameters: ModelParameter[];
};
type MrbFitRow = {
  temperature_C: string;
  pressure_bar: string;
  value: string;
};

function localDatabaseName(path: string) {
  const file = path.split("/").filter(Boolean).pop() || path;
  return file.replace(/\.rtdb$/i, "");
}

const DEFAULTS: Preferences = {
  language: "zh-CN",
  theme: "system",
  density: "comfortable",
  startup: "home",
  recent_databases: [],
};
export function normalizePreferences(raw: unknown): Preferences {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string,any> : {};
  const recent = Array.isArray(input.recent_databases) ? input.recent_databases : [];
  const next:Preferences = {...DEFAULTS, theme:["light","dark","system"].includes(input.theme) ? input.theme : "system", density:input.density === "compact" ? "compact" : "comfortable", recent_databases:recent.filter(x => x && typeof x.path === "string" && /\.rtdb$/i.test(x.path)).map(x=>({...x,name:localDatabaseName(x.path),opened_at:typeof x.opened_at === "string" ? x.opened_at : ""}))};
  for(const key of ["runtime_path","save_directory","export_directory","powered_by","github_url"] as const) if(typeof input[key] === "string") next[key]=input[key];
  const d=input.default_database;
  if(d?.kind === "rtdb" && typeof d.path === "string" && /\.rtdb$/i.test(d.path)) next.default_database={kind:"rtdb",path:d.path};
  if(d?.kind === "official" && ["PHREEQC","SUPCRT","NASA"].includes(d.group) && typeof d.name === "string") next.default_database={kind:"official",group:d.group,name:d.name};
  return next;
}
const STANDARD_TP = { temperature: "298.15", pressure: "100000" };
const dialogDefault = (directory: string | undefined, filename?: string) =>
  directory
    ? `${directory.replace(/\/+$/, "")}${filename ? `/${filename}` : ""}`
    : filename;
const pickPath = async (kind: string, defaultDirectory?: string) => {
  let result: string | null | string[];
  if (kind === "save_rtdb")
    result = await saveDialog({
      title: "保存 EasyReaktoro 数据库",
      defaultPath: dialogDefault(defaultDirectory, "database.rtdb"),
      filters: [{ name: "EasyReaktoro 数据库", extensions: ["rtdb"] }],
    });
  else if (kind === "export_yaml")
    result = await saveDialog({
      title: "导出 Reaktoro YAML",
      defaultPath: dialogDefault(defaultDirectory, "database.yaml"),
      filters: [{ name: "YAML", extensions: ["yaml", "yml"] }],
    });
  else if (kind === "runtime_folder")
    result = await openDialog({
      title: "选择 Reaktoro 或 Conda 环境文件夹",
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "import_folder")
    result = await openDialog({
      title: "选择已转换的扩展 Reaktoro 数据库文件夹",
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "save_folder")
    result = await openDialog({
      title: "选择默认保存目录",
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "export_folder")
    result = await openDialog({
      title: "选择默认导出目录",
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "runtime_file")
    result = await openDialog({
      title: "选择 Reaktoro 环境中的 Python 可执行文件",
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "import_yaml")
    result = await openDialog({
      title: "选择 Reaktoro YAML 文件",
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
      filters: [{ name: "YAML", extensions: ["yaml", "yml"] }],
    });
  else if (kind === "import_rtdb")
    result = await openDialog({
      title: "从其他 EasyReaktoro 数据库添加",
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
      filters: [{ name: "EasyReaktoro 数据库", extensions: ["rtdb"] }],
    });
  else
    result = await openDialog({
      title: "打开 EasyReaktoro 数据库",
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
      filters: [{ name: "EasyReaktoro 数据库", extensions: ["rtdb"] }],
    });
  const path = Array.isArray(result) ? result[0] : result;
  if (!path) throw new Error("cancelled");
  return path;
};
const api = <T,>(command: string, args: Record<string, unknown> = {}) =>
  command === "pick_path"
    ? (pickPath(
        String(args.kind || ""),
        typeof args.defaultDirectory === "string"
          ? args.defaultDirectory
          : undefined,
      ) as Promise<T>)
    : invoke<T>(command, args);
const label = (summary: Summary | null) =>
  summary?.embedded_name || summary?.path?.split("/").pop() || "数据库";
const errText = (error: unknown) => {
  try {
    const parsed = JSON.parse(String(error));
    return parsed.diagnostic || parsed.code || String(error);
  } catch {
    return String(error);
  }
};

export default function AppV3() {
  const [page, setPage] = useState<Page>("home");
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [runtime, setRuntime] = useState<Runtime>({
    status: "probing",
    available: false,
  });
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [catalogState, setCatalogState] = useState<
    "blocked" | "loading" | "ready" | "error"
  >("blocked");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Species[]>([]);
  const [selected, setSelected] = useState<Species | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({
    state: "All",
    model: "All",
    elements: [] as string[],
  });
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [settingsTab, setSettingsTab] = useState<
    "general" | "database" | "runtime" | "about"
  >("general");
  const [dialog, setDialog] = useState<
    | "new"
    | "close"
    | "periodic"
    | "species-new"
    | "species-edit"
    | "compose"
    | "import"
    | "export"
    | null
  >(null);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");
  const toastNeedsAttention = /失败|无法|不能|未确认|请输入|超出|无效|未被覆盖|暂时|未保存/.test(toast);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [tp, setTp] = useState({ temperature: "298.15", pressure: "100000" });
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusyState] = useState(false);
  const busyRef=useRef(false);
  const setBusy=(next:boolean)=>{busyRef.current=next;setBusyState(next);};
  const [periodicDraft,setPeriodicDraft]=useState<string[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [libraryVisible, setLibraryVisible] = useState(false);
  const [facets, setFacets] = useState<{models:string[];states:string[]}>({models:[],states:[]});
  const [validation, setValidation] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const request = useRef(0);
  const detailRequest = useRef(0);
  const evaluationRequest = useRef(0);
  const currentSummary = useRef(summary); currentSummary.current = summary;
  const currentDialog = useRef(dialog); currentDialog.current = dialog;
  const currentPrefs=useRef(prefs); currentPrefs.current=prefs;
  const pendingAction = useRef<null | (() => Promise<void> | void)>(null);
  const pendingDefault=useRef(false);
  const preferenceQueue = useRef(Promise.resolve());
  const guard = async (action: () => Promise<void> | void) => {
    if (currentSummary.current?.dirty) { pendingAction.current = action; setDialog("close"); return; }
    await action();
  };

  const savePrefs = (next: Preferences) => {
    currentPrefs.current=next;
    setPrefs(next);
    preferenceQueue.current = preferenceQueue.current.then(() => api("settings_save", { settings: next })).then(() => {}).catch((error) =>
      setToast(`设置保存失败：${errText(error)}`),
    );
  };
  const validRecents = async (settings: Preferences) => {
    const paths = [...settings.recent_databases.map((x) => x.path), ...(settings.default_database?.kind === "rtdb" ? [settings.default_database.path] : [])];
    if (!paths.length) return settings;
    const result = await api<{ path: string; exists: boolean }[]>(
      "paths_exist",
      { paths },
    );
    const good = new Set(result.filter((x) => x.exists).map((x) => x.path));
    const next = {
      ...settings,
      recent_databases: settings.recent_databases
        .filter((x) => good.has(x.path))
        .map((x) => ({ ...x, name: localDatabaseName(x.path) })),
    };
    if (
      settings.default_database?.kind === "rtdb" &&
      !good.has(settings.default_database.path)
    )
      delete next.default_database;
    if (
      next.recent_databases.length !== settings.recent_databases.length ||
      next.default_database !== settings.default_database
    )
      savePrefs(next);
    return next;
  };
  const loadCatalog = async (current: Runtime) => {
    if (!current.available) {
      setCatalog([]);
      setCatalogState("blocked");
      return;
    }
    setCatalogState("loading");
    try {
      const result = await api<{ entries: Catalog[] }>("catalog_list");
      setCatalog(result.entries);
      setCatalogState("ready");
    } catch (error) {
      setCatalog([]);
      setCatalogState("error");
      setToast(`内置数据库目录加载失败：${errText(error)}`);
    }
  };
  const probe = async (settings = prefs) => {
    setRuntime((x) => ({ ...x, status: "probing" }));
    try {
      let result: Runtime;
      if (settings.runtime_path) {
        try {
          result = await api("runtime_select", { path: settings.runtime_path });
        } catch {
          result = await api("runtime_probe");
        }
      } else result = await api("runtime_probe");
      setRuntime(result);
      await loadCatalog(result);
    } catch (error) {
      setRuntime({
        status: "error",
        available: false,
        diagnostic: errText(error),
      });
      setCatalog([]);
      setCatalogState("blocked");
    }
  };
  useEffect(() => {
    (async () => {
      let loaded = DEFAULTS;
      try {
        loaded = normalizePreferences(await api("settings_load"));
      } catch { setToast("设置无法读取，已使用默认设置启动；原设置文件未被覆盖。"); }
      try { loaded = await validRecents(loaded); }
      catch(error) { setToast(`最近文件暂时无法检查：${errText(error)}`); }
      setPrefs(loaded);
      document.documentElement.dataset.theme = loaded.theme;
      document.documentElement.dataset.density = loaded.density;
      await probe(loaded);
    })();
  }, []);
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;
    listen("easyreaktoro:request-exit", () => { getCurrentWindow().close().catch(error => setToast(errText(error))); }).then(off => { if(disposed) off(); else unlistenQuit=off; }).catch(() => {});
    getCurrentWindow().onCloseRequested(async (event) => {
      if(busyRef.current) { event.preventDefault(); setToast("操作正在进行，请完成后再退出。"); return; }
      if (currentDialog.current && currentDialog.current !== "close") {
        event.preventDefault(); setToast("请先完成或取消当前对话框，再退出应用。"); return;
      }
      if (currentSummary.current?.dirty) {
        event.preventDefault();
        pendingAction.current = async () => { await getCurrentWindow().destroy(); };
        setDialog("close");
      }
    }).then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); unlistenQuit?.(); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    document.documentElement.dataset.density = prefs.density;
  }, [prefs.theme, prefs.density]);
  useEffect(() => {
    if (!toast || toastNeedsAttention) return;
    const id = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const refresh = () => {void refreshSummary().catch(error=>setToast(`刷新失败：${errText(error)}`));};
    window.addEventListener("easyreaktoro:species-mutated", refresh);
    return () =>
      window.removeEventListener("easyreaktoro:species-mutated", refresh);
  }, [summary?.handle_id]);
  useEffect(() => {
    const open = (event: Event) =>
      acceptSummary((event as CustomEvent<Summary>).detail);
    window.addEventListener("easyreaktoro:open-summary", open);
    return () => window.removeEventListener("easyreaktoro:open-summary", open);
  }, [prefs]);

  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await api<{ entries: Candidate[] }>("runtime_discover");
      const ready = r.entries.filter((x) => x.available);
      setCandidates(ready);
      setToast(
        ready.length
          ? `发现 ${ready.length} 个可用的 Reaktoro 环境`
          : "没有自动发现可用的 Reaktoro 环境。",
      );
    } catch (error) {
      setToast(`检测失败：${errText(error)}`);
    } finally {
      setDiscovering(false);
    }
  };
  const showRuntimeSettings = async () => {
    setSettingsTab("runtime");
    setPage("settings");
    await discover();
  };
  const chooseRuntime = async (path?: string, folder = false) => {
    if(busyRef.current) return;
    try {
      const chosen =
        path ||
        (await api<string>("pick_path", {
          kind: folder ? "runtime_folder" : "runtime_file",
        }));
      await guard(async () => {
      if(busyRef.current) return;
      setBusy(true);
      try {
      const result = await api<Runtime>("runtime_select", { path: chosen, discard: true });
      request.current++; detailRequest.current++; evaluationRequest.current++;
      setSummary(null);
      currentSummary.current = null;
      setRows([]);
      setSelected(null);
      setDetails(null);
      setEvaluation(null);
      setTp(STANDARD_TP);
      setRuntime(result);
      setCatalog([]); setDiagnostics(null); setValidation(null);
      savePrefs({ ...currentPrefs.current, runtime_path: result.python || chosen });
      await loadCatalog(result);
      setToast(`已连接 Reaktoro ${result.version}`);
      } catch (error) { setToast(`连接失败，原数据库保持打开：${errText(error)}`); }
      finally { setBusy(false); }
      });
    } catch (error) {
      if (!String(error).includes("cancelled"))
        setToast(`连接失败：${errText(error)}`);
    }
  };
  const loadRows = async (at = offset) => {
    if (!summary) return;
    const seq = ++request.current;
    setRowsLoading(true);
    try {
      const result = await api<{ items: Species[]; total: number; models:string[]; states:string[] }>(
        "species_page",
        {
          handleId: summary.handle_id,
          offset: at,
          limit: 100,
          query,
          stateFilter: filters.state,
          charge: null,
          modelFilter: filters.model,
          elements: filters.elements,
        },
      );
      if (seq !== request.current) return;
      setRows(result.items);
      setFacets({models:result.models,states:result.states});
      setTotal(result.total);
      setOffset(at);
      if (selected && !result.items.some((x) => selected.id ? x.id === selected.id : x.name === selected.name)) {
        setSelected(null);
        setDetails(null);
        detailRequest.current++; evaluationRequest.current++; setEvaluation(null);
      }
    } catch (error) {
      if (seq === request.current) setToast(`物种加载失败：${errText(error)}`);
    } finally { if(seq === request.current) setRowsLoading(false); }
  };
  useEffect(() => {
    const id = setTimeout(() => loadRows(0), 180);
    return () => { clearTimeout(id); request.current++; };
  }, [
    summary?.handle_id,
    query,
    filters.state,
    filters.model,
    filters.elements.join("|"),
  ]);
  const addRecent = (s: Summary) => {
    if (!s.path) return;
    const recent = {
      path: s.path,
      name: localDatabaseName(s.path),
      opened_at: new Date().toISOString(),
    };
    savePrefs({
      ...currentPrefs.current,
      recent_databases: [
        recent,
        ...currentPrefs.current.recent_databases.filter((x) => x.path !== s.path),
      ].slice(0, 12),
    });
  };
  const acceptSummary = (s: Summary) => {
    pendingDefault.current=false;
    const old = currentSummary.current;
    if (old && old.handle_id !== s.handle_id) api("database_close", {handleId:old.handle_id,discard:true}).catch(error => setToast(errText(error)));
    currentSummary.current = s;
    request.current++; detailRequest.current++; evaluationRequest.current++;
    setRows([]); setOffset(0); setTotal(0); setValidation(null); setLibraryVisible(false);
    setSummary(s);
    setPage("databases");
    setSelected(null);
    setDetails(null);
    setEvaluation(null);
    setTp(STANDARD_TP);
    setQuery("");
    setFilters({ state: "All", model: "All", elements: [] });
    if (s.path) addRecent(s);
  };
  const openOfficial = async (entry: Catalog) => {
    if(busyRef.current) return;
    await guard(async () => {
    if(busyRef.current) return;
    setBusy(true);
    try {
      const r = await api<{ summary: Summary }>("database_open", {
        group: entry.group,
        name: entry.embedded_name,
      });
      acceptSummary(r.summary);
    } catch (error) {
      setToast(`打开失败：${errText(error)}`);
    } finally { setBusy(false); }
    });
  };
  const openLocal = async (path?: string) => {
    if(busyRef.current) return;
    try {
      const p = path || (await api<string>("pick_path", { kind: "open_rtdb" }));
      await guard(async () => {
      if(busyRef.current) return;
      setBusy(true);
      try {
      const r = await api<{ summary: Summary }>("rtdb_open", { path: p });
      acceptSummary(r.summary);
      } catch(error) { setToast(`打开失败：${errText(error)}`); await validRecents(prefs); }
      finally { setBusy(false); }
      });
    } catch (error) {
      if (path) {
        const next = {
          ...prefs,
          recent_databases: prefs.recent_databases.filter(
            (x) => x.path !== path,
          ),
        };
        if (
          next.default_database?.kind === "rtdb" &&
          next.default_database.path === path
        )
          delete next.default_database;
        savePrefs(next);
      }
      if (!String(error).includes("cancelled"))
        setToast(`打开失败：${errText(error)}`);
    }
  };
  const enterDatabases = async () => {
    setPage("databases");
    setLibraryVisible(false);
    const d = prefs.default_database;
    if (summary || !d) return;
    if (d.kind === "rtdb") await openLocal(d.path);
    else {
      const entry = catalog.find(
        (x) => x.group === d.group && x.embedded_name === d.name,
      );
      if (entry) await openOfficial(entry);
      else if(catalogState === 'loading' || runtime.status === 'probing') pendingDefault.current=true;
      else setToast('默认内置数据库当前不可用，请先连接提供该数据库的 Reaktoro 环境。');
    }
  };
  const selectSpecies = async (species: Species) => {
    const seq = ++detailRequest.current;
    evaluationRequest.current++;
    setDetails(null);
    setSelected(species);
    setEvaluation(null);
    setTp(STANDARD_TP);
    try {
      const result = await api<Details>("species_details", {
        handleId: summary!.handle_id,
        speciesId: species.id || null,
        name: species.name,
      });
      if (seq === detailRequest.current) setDetails({ ...result, _handle_id: summary!.handle_id });
    } catch (error) {
      if(seq === detailRequest.current) setToast(`属性加载失败：${errText(error)}`);
    }
  };
  const refreshSummary = async () => {
    const active=currentSummary.current;
    if (!active) return;
    const r = await api<{ summary: Summary }>("database_summary", {
      handleId: active.handle_id,
    });
    if(currentSummary.current?.handle_id !== active.handle_id) return;
    currentSummary.current=r.summary;
    setSummary(r.summary);
    await loadRows();
  };
  const save = async () => {
    if(busyRef.current) throw new Error("操作正在进行，请稍候");
    const active = currentSummary.current;
    if (!active) return;
    setBusy(true);
    try {
      const r = await api<{ summary: Summary; success: boolean }>("rtdb_save", {
        handleId: active.handle_id,
      });
      if(r.success !== true || r.summary?.handle_id !== active.handle_id || r.summary?.dirty !== false) throw new Error("后端未确认保存完成，数据库仍保持打开。");
      setSummary(r.summary);
      currentSummary.current = r.summary;
      setToast("数据库已保存");
    } catch (error) {
      setToast(`保存失败：${errText(error)}`);
      throw error;
    } finally { setBusy(false); }
  };
  const close = async (discard = false) => {
    if(busyRef.current) return;
    const active = currentSummary.current;
    if (!active) return;
    if (active.dirty && !discard) { await guard(() => close(true)); return; }
    try {
      await api("database_close", { handleId: active.handle_id, discard });
      currentSummary.current = null;
      request.current++; detailRequest.current++; evaluationRequest.current++;
      setSummary(null);
      setRows([]);
      setSelected(null);
      setDetails(null);
      setDialog(null);
    } catch (error) {
      setToast(`关闭失败：${errText(error)}`);
    }
  };
  const evaluate = async () => {
    if(busyRef.current || !currentSummary.current || !selected || !details) return;
    const seq = ++evaluationRequest.current;
    const temperature = Number(tp.temperature),
      pressure = Number(tp.pressure);
    const reject = (message: string) => {
      setEvaluation(null);
      setToast(message);
    };
    if (!Number.isFinite(temperature) || temperature <= 0) {
      reject("请输入大于 0 K 的有效温度。");
      return;
    }
    if (!Number.isFinite(pressure) || pressure <= 0) {
      reject("请输入大于 0 Pa 的有效压力。");
      return;
    }
    const valid = details?.valid_tp || {};
    const tr = valid.temperature_K || valid.temperature;
    const pr = valid.pressure_Pa || valid.pressure;
    if (Array.isArray(tr) && (temperature < tr[0] || temperature > tr[1])) {
      reject(`温度超出该物种模型的有效范围：${tr[0]}–${tr[1]} K。`);
      return;
    }
    if (Array.isArray(pr) && (pressure < pr[0] || pressure > pr[1])) {
      reject(`压力超出该物种模型的有效范围：${pr[0]}–${pr[1]} Pa。`);
      return;
    }
    try {
      setBusy(true);
      const result = await api("species_evaluate", {
          handleId: summary!.handle_id,
          name: selected!.name,
          speciesId: selected!.id,
          temperatureK: temperature,
          pressurePa: pressure,
        });
      if(seq === evaluationRequest.current) setEvaluation(result);
    } catch (error) {
      if(seq === evaluationRequest.current) reject(`计算失败：${errText(error)}`);
    } finally { setBusy(false); }
  };
  const deleteSpecies = async () => {
    if (busyRef.current || !summary || summary.read_only || !selected) return;
    const speciesId = selected.id || details?.id;
    if (!speciesId) {
      setToast("该物种没有可删除的本地记录 ID");
      return;
    }
    if (
      !confirm(
        `确定从当前数据库删除“${selected.name}”吗？保存前仍可通过放弃更改撤销。`,
      )
    )
      return;
    try {
      setBusy(true);
      const result = await api<any>("species_delete", {
        handleId: summary.handle_id,
        speciesId,
      });
      setSummary(result.summary);
      currentSummary.current=result.summary;
      detailRequest.current++; evaluationRequest.current++;
      setSelected(null);
      setDetails(null);
      setEvaluation(null);
      await loadRows(0);
      setToast("物种已删除，保存数据库后生效");
    } catch (error) {
      setToast(`删除失败：${errText(error)}`);
    } finally {setBusy(false);}
  };
  const setDefault = () => {
    if (!summary) return;
    const d: DefaultDb =
      summary.kind === "rtdb"
        ? { kind: "rtdb", path: summary.path! }
        : {
            kind: "official",
            group: summary.group!,
            name: summary.embedded_name!,
          };
    savePrefs({ ...prefs, default_database: d });
    setToast("已设为默认数据库");
  };
  useEffect(()=>{
    if(!pendingDefault.current || page !== 'databases' || libraryVisible || summary || catalogState !== 'ready') return;
    pendingDefault.current=false;
    void enterDatabases();
  },[catalogState,page,libraryVisible,summary?.handle_id]);
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      if(currentDialog.current || report || busyRef.current) return;
      if(event.key==='Escape'){setMenu(false);return;}
      if(!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if(event.key.toLowerCase()==='s' && currentSummary.current){event.preventDefault();if(currentSummary.current.dirty && !currentSummary.current.read_only) void save().catch(()=>{});}
      if(event.key.toLowerCase()==='f' && page==='databases' && !libraryVisible){const input=document.querySelector<HTMLInputElement>('.species-panel .search-box input');if(input){event.preventDefault();input.focus();input.select();}}
    };
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  },[page,libraryVisible,report]);

  return (
    <div className="app-shell" onClick={() => setMenu(false)}>
      <header className="topbar">
        <button className="brand" onClick={() => setPage("home")}>
          <img src="/easyreaktoro-icon.png" />
          <strong>EasyReaktoro</strong>
        </button>
        {summary && (
          <button
            className="database-pill"
            onClick={() => { setLibraryVisible(false); setPage("databases"); }}
          >
            <Database size={14} />
            {label(summary)}
            <ChevronRight size={13} />
          </button>
        )}
      </header>
      <div className="body">
        <aside className="sidebar">
          <nav>
            <Nav
              active={page === "home"}
              icon={<Home />}
              label="主页"
              onClick={() => setPage("home")}
            />
            <Nav
              active={page === "databases"}
              icon={<Database />}
              label="数据库"
              onClick={enterDatabases}
            />
            <Nav
              active={page === "simulation"}
              icon={<FlaskConical />}
              label="模拟"
              suffix="计划中"
              onClick={() => setPage("simulation")}
            />
            <Nav
              active={page === "settings"}
              icon={<Settings />}
              label="设置"
              onClick={() => setPage("settings")}
            />
          </nav>
          <div className="sidebar-spacer" />
          <button
            className="runtime-entry"
            onClick={() => {
              setSettingsTab("runtime");
              setPage("settings");
            }}
          >
            <i className={runtime.available ? "ready" : runtime.status} />
            <span>
              <strong>
                Reaktoro
              </strong>
              <small>
                {runtime.available
                  ? `已连接 · ${runtime.version}`
                  : runtime.status === "probing"
                    ? "正在检测"
                    : "点击配置环境"}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
        </aside>
        <main className="main-content">
          {page === "home" && (
            <HomePage
              {...{ runtime, candidates, prefs, summary, discovering }}
              onDiscover={showRuntimeSettings}
              onChoose={() => chooseRuntime()}
              onChooseFolder={() => chooseRuntime(undefined, true)}
              onCandidate={(p) => chooseRuntime(p)}
              onContinue={() =>
                summary ? (setLibraryVisible(false), setPage("databases")) : enterDatabases()
              }
              onManage={() => {
                setLibraryVisible(true);
                setPage("databases");
              }}
              onOpen={openLocal}
            />
          )}{" "}
          {page === "databases" &&
            (summary && !libraryVisible ? (
              <Workspace
                {...{
                  summary,
                  rows,
                  total,
                  offset,
                  query,
                  filters,
                  selected,
                  details,
                  tp,
                  evaluation,
                  runtime,
                  menu,
                  busy, rowsLoading, facets, validation,
                }}
                onQuery={setQuery}
                onFilters={setFilters}
                onPage={loadRows}
                onSelect={selectSpecies}
                onPeriodic={() => {setPeriodicDraft([...filters.elements]);setDialog("periodic");}}
                onSave={() => {void save().catch(()=>{});}}
                onMenu={() => setMenu(!menu)}
                onNewSpecies={() => {
                  setMenu(false);
                  setDialog("species-new");
                }}
                onEditSpecies={() => {
                  setMenu(false);
                  setDialog("species-edit");
                }}
                onDeleteSpecies={deleteSpecies}
                onCompose={() => {
                  setMenu(false);
                  setDialog("compose");
                }}
                onCopyAll={async()=>{if(busyRef.current) return;setBusy(true);setMenu(false);try {
                  const path=await pickPath('save_rtdb',prefs.save_directory);
                  const result=await api<{summary:Summary}>('compose_commit',{selections:[{handle_id:summary.handle_id,all:true}],path});
                  acceptSummary(result.summary);
                }catch(error){if(!String(error).includes('cancelled'))setToast(`复制失败：${errText(error)}`);}finally{setBusy(false);}}}
                onImport={() => {
                  setMenu(false);
                  setDialog("import");
                }}
                onExport={() => {
                  setMenu(false);
                  setDialog("export");
                }}
                onValidate={async () => { if(busyRef.current) return;setBusy(true);try {
                  const r = await api<any>("validate_database", {
                    handleId: summary.handle_id,
                  });
                  setToast(
                    r.status === "valid"
                      ? "验证通过"
                      : `验证发现 ${r.issues.length} 个问题`,
                  );
                  setValidation(r); setReport({kind:"validation",...r});
                } catch(error) { setToast(`验证失败：${errText(error)}`); } finally {setBusy(false);} }}
                onDefault={setDefault}
                onReveal={() =>
                  summary.path && api("reveal_path", { path: summary.path }).catch(error => setToast(errText(error)))
                }
                onClose={() => close()}
                onTp={(value) => { setTp(value); evaluationRequest.current++; setEvaluation(null); }}
                onLibrary={() => setLibraryVisible(true)}
                onSaveAs={async () => { if(busyRef.current) return; setBusy(true); try {
                  const path = await pickPath("save_rtdb", prefs.save_directory);
                  const result = await api<{summary:Summary;success:boolean}>("rtdb_save_as", {handleId:summary.handle_id,path});
                  if(result.success !== true || result.summary?.dirty !== false) throw new Error("后端未确认另存为完成。");
                  acceptSummary(result.summary); setToast(`已另存为：${path}`);
                } catch(error) { if(!String(error).includes("cancelled")) setToast(`另存为失败：${errText(error)}`); } finally {setBusy(false);} }}
                onEvaluate={evaluate}
              />
            ) : (
              <DatabaseLibrary
                runtime={runtime}
                catalog={catalog}
                catalogState={catalogState}
                recents={prefs.recent_databases}
                defaultDb={prefs.default_database}
                onOpenOfficial={openOfficial}
                onOpenLocal={openLocal}
                onNew={() => guard(() => setDialog("new"))}
                onCompose={() => guard(() => setDialog("compose"))}
              />
            ))}{" "}
          {page === "simulation" && <Simulation />}{" "}
          {page === "settings" && (
            <SettingsPage
              {...{
                prefs,
                runtime,
                candidates,
                settingsTab,
                diagnostics,
                discovering,
              }}
              onTab={setSettingsTab}
              onPrefs={savePrefs}
              onDiscover={discover}
              onChoose={() => chooseRuntime()}
              onChooseFolder={() => chooseRuntime(undefined, true)}
              onCandidate={(p) => chooseRuntime(p)}
              onPickDirectory={async (kind: string) => {
                try {
                  const path = await api<string>("pick_path", { kind });
                  savePrefs({
                    ...prefs,
                    [kind === "save_folder"
                      ? "save_directory"
                      : "export_directory"]: path,
                  });
                } catch {}
              }}
              onDiagnose={async () => { try { setDiagnostics(await api("runtime_diagnostics")); } catch(error) { setToast(errText(error)); } }}
            />
          )}
        </main>
      </div>
      {dialog === "periodic" && (
        <Modal title="按元素筛选物种" onClose={() => setDialog(null)} wide>
          <p className="modal-copy">
            选择一个或多个元素，结果必须同时包含全部已选元素。
          </p>
          <PeriodicTable
            selected={periodicDraft}
            onChange={setPeriodicDraft}
          />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={!periodicDraft.length}
              onClick={() => setPeriodicDraft([])}
            >
              清除
            </button>
            <button className="secondary" onClick={() => setDialog(null)}>取消</button>
            <button className="primary" onClick={() => {setFilters({...filters,elements:periodicDraft});setDialog(null);}}>
              应用筛选
            </button>
          </div>
        </Modal>
      )}
      {dialog === "new" && (
        <NewDatabase
          defaultDirectory={prefs.save_directory}
          onClose={() => setDialog(null)}
          onCreated={(s) => {
            setDialog(null);
            acceptSummary(s);
          }}
        />
      )}
      {(dialog === "species-new" || dialog === "species-edit") && summary && (
        <SpeciesEditor
          handleId={summary.handle_id}
          existing={dialog === "species-edit" ? details : null}
          onClose={() => setDialog(null)}
          onSaved={async (species) => {
            const command = species.id ? "species_update" : "species_create";
            const args: any = { handleId: summary.handle_id, species };
            if (species.id) args.speciesId = species.id;
            const r = await api<any>(command, args);
            currentSummary.current=r.summary;
            setSummary(r.summary);
            setDialog(null);
            setQuery(r.species.name);setFilters({state:'All',model:'All',elements:[]});
            setEvaluation(null); setValidation(null);
            await selectSpecies({...r.species,model:r.species.model.type});
            setToast(`${species.id ? "物种已更新" : "物种已创建"}，请保存数据库文件。`);
          }}
        />
      )}
      {dialog === "compose" && (
        <ComposeWizard
          catalog={catalog}
          initial={summary?.kind === "official" ? summary : null}
          target={!libraryVisible && summary?.kind === "rtdb" ? summary : null}
          defaultDirectory={prefs.save_directory}
          onClose={() => setDialog(null)}
          onCreated={(s) => {
            setDialog(null);
            acceptSummary(s);
          }}
        />
      )}
      {dialog === "import" && summary && (
        <ImportDialog
          summary={summary}
          onClose={() => setDialog(null)}
          onDone={async (updated) => {
            currentSummary.current=updated;
            setSummary(updated);
            setDialog(null);
            setValidation(null); setToast("所选物种已添加，请保存数据库文件。");
            await loadRows(0);
          }}
        />
      )}
      {dialog === "export" && summary && (
        <ExportDialog
          summary={summary}
          defaultDirectory={prefs.export_directory}
          onClose={() => setDialog(null)}
          onDone={(report) => {
            setDialog(null);
            setReport({kind:"export",...report});
            setToast(
              `已导出 ${report.export_count} 条，排除 ${report.exclude_count} 条：${report.output_path}`,
            );
          }}
        />
      )}
      {dialog === "close" && (
        <Modal title="保存未完成的更改？" busy={busy} onClose={() => { pendingAction.current = null; setDialog(null); }}>
          <p className="modal-copy">“{label(summary)}”包含未保存更改。保存失败时会保留当前数据库。</p>
          <div className="modal-actions spread">
            <button className="danger" onClick={async () => { const action = pendingAction.current; pendingAction.current = null; setDialog(null); await action?.(); }}>
              放弃更改
            </button>
            <span />
            <button className="secondary" onClick={() => { pendingAction.current = null; setDialog(null); }}>
              取消
            </button>
            <button
              className="primary"
              onClick={async () => {
                try {
                  await save();
                  const action = pendingAction.current; pendingAction.current = null; setDialog(null); await action?.();
                } catch {}
              }}
            >
              保存并关闭
            </button>
          </div>
        </Modal>
      )}
      {report && <Modal title={report.kind === "export" ? "导出结果" : "数据库验证"} onClose={() => setReport(null)}>
        {report.output_path && <p className="modal-copy selectable">{report.output_path}</p>}
        <p className="modal-copy">{report.kind === "export" ? `已导出 ${report.export_count} 个物种，排除 ${report.exclude_count} 个；Reaktoro 重新加载验证通过。` : `${report.species_count} 个物种 · ${report.status === "valid" ? "验证通过" : `发现 ${report.issues.length} 项需要检查的记录`}`}</p>
        <div className="report-list">{(report.issues || report.exclusions || []).map((item:any,index:number) => <article key={index}><strong>{item.species || item.name}</strong><p>{item.message || item.reason}</p></article>)}</div>
        <div className="modal-actions"><button className="primary" onClick={() => setReport(null)}>完成</button></div>
      </Modal>}
      {busy && <div className="operation-shield" role="status"><div className="panel">正在处理，请稍候…</div></div>}
      {toast && (
        <div className={`toast ${toastNeedsAttention ? 'attention' : ''}`} role={toastNeedsAttention ? "alert" : "status"} aria-live="polite">
          <Info size={14} />
          <span>{toast}</span><button aria-label="关闭提示" onClick={()=>setToast('')}><X size={16}/></button>
        </div>
      )}
    </div>
  );
}

function Nav({
  active,
  icon,
  label,
  suffix,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  suffix?: string;
  onClick: () => void;
}) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {suffix && <em>{suffix}</em>}
    </button>
  );
}

export function HomePage({
  runtime,
  candidates,
  prefs,
  summary,
  discovering,
  onDiscover,
  onChoose,
  onChooseFolder,
  onCandidate,
  onContinue,
  onManage,
  onOpen,
}: {
  runtime: Runtime;
  candidates: Candidate[];
  prefs: Preferences;
  summary: Summary | null;
  discovering: boolean;
  onDiscover: () => void;
  onChoose: () => void;
  onChooseFolder: () => void;
  onCandidate: (p: string) => void;
  onContinue: () => void;
  onManage: () => void;
  onOpen: (path?: string) => void;
}) {
  return (
    <div className="scroll-page home-page">
      <section className="home-welcome">
        <span className="eyebrow">EASYREAKTORO</span>
        <h1>把 Reaktoro 数据库变成清晰、可编辑的工作空间</h1>
        <p>
          EasyReaktoro 使用你电脑上的 Reaktoro；应用本身不包含 Python、Reaktoro
          或官方数据库。
        </p>
      </section>
      {runtime.available ? (
        <>
          <section className="connected-line panel">
            <i />
            <div>
              <strong>Reaktoro {runtime.version} 已连接</strong>
              <small>{runtime.python}</small>
            </div>
            <button
              className="text-button"
              disabled={discovering}
              onClick={onDiscover}
            >
              {discovering ? "正在检测…" : "切换环境"}
            </button>
          </section>
          <div className="home-actions-grid">
            {(summary || prefs.default_database) && <button className="home-action primary-card" onClick={onContinue}>
              <Database />
              <span>
                <strong>
                  {summary
                    ? "继续当前数据库"
                    : prefs.default_database
                      ? "继续默认数据库"
                      : "进入数据库"}
                </strong>
                <small>
                  {summary ? label(summary) : "浏览、创建和管理数据库"}
                </small>
              </span>
              <ChevronRight />
            </button>}
            <button className={`home-action ${!summary && !prefs.default_database ? "primary-card" : ""}`} onClick={onManage}>
              <BookOpen />
              <span>
                <strong>管理数据库</strong>
                <small>我的数据库与 Reaktoro 内置数据库</small>
              </span>
              <ChevronRight />
            </button>
            <button className="home-action" onClick={() => onOpen()}>
              <FolderOpen />
              <span>
                <strong>打开 .rtdb</strong>
                <small>离线打开 EasyReaktoro 数据库</small>
              </span>
              <ChevronRight />
            </button>
          </div>
          <RecentHome recents={prefs.recent_databases} onOpen={onOpen} />
        </>
      ) : (
        <section className="onboarding panel">
          <div className="onboarding-icon">
            <MonitorCog />
          </div>
          <div>
            <span className="eyebrow">首次连接</span>
            <h2>连接本机 Reaktoro 环境</h2>
            <p>
              {runtime.status === "probing"
                ? "正在检查常见安装位置…"
                : runtime.diagnostic ||
                  "自动检测，或手动指定 Reaktoro 环境中的 Python。"}
            </p>
            <div className="button-row">
              <button
                className="primary"
                disabled={discovering}
                onClick={onDiscover}
              >
                <RefreshCw />
                {discovering ? "正在检测…" : "自动检测"}
              </button>
              <button className="secondary" onClick={onChoose}>
                <FolderOpen />
                选择 Reaktoro Python
              </button>
              <button className="secondary" onClick={onChooseFolder}>
                选择 Conda / Reaktoro 环境
              </button>
            </div>
            {candidates.length > 0 && (
              <div className="candidate-list">
                {candidates.map((x) => (
                  <button key={x.python} onClick={() => onCandidate(x.python)}>
                    <span>
                      <strong>Reaktoro {x.version}</strong>
                      <small>{x.environment_root || x.python}</small>
                    </span>
                    <ChevronRight />
                  </button>
                ))}
              </div>
            )}
            {runtime.status !== "probing" && <p className="offline-access">暂不连接？<button className="text-button" onClick={onManage}>离线管理 .rtdb</button></p>}
          </div>
        </section>
      )}
    </div>
  );
}
function RecentHome({
  recents,
  onOpen,
}: {
  recents: Recent[];
  onOpen: (p?: string) => void;
}) {
  if (!recents.length)
    return (
      <section className="quiet-section">
        <h2>最近数据库</h2>
        <p>打开过的本地数据库会显示在这里。</p>
      </section>
    );
  return (
    <section className="quiet-section">
      <h2>最近数据库</h2>
      <div className="recent-row">
        {recents.slice(0, 4).map((x) => (
          <button key={x.path} onClick={() => onOpen(x.path)}>
            <Database />
            <span>
              <strong>{x.name}</strong>
              <small>{x.path}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function DatabaseLibrary({
  runtime,
  catalog,
  catalogState,
  recents,
  defaultDb,
  onOpenOfficial,
  onOpenLocal,
  onNew,
  onCompose,
}: {
  runtime: Runtime;
  catalog: Catalog[];
  catalogState: string;
  recents: Recent[];
  defaultDb?: DefaultDb;
  onOpenOfficial: (x: Catalog) => void;
  onOpenLocal: (p?: string) => void;
  onNew: () => void;
  onCompose: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    mine: true,
    official: true,
    PHREEQC: true,
    SUPCRT: false,
    NASA: false,
  });
  const toggle = (key: string) => setOpen({ ...open, [key]: !open[key] });
  return (
    <div className="scroll-page library-page">
      <div className="page-heading">
        <span className="eyebrow">数据库</span>
        <h1>数据库</h1>
        <p>
          管理自己的可编辑数据库，或浏览所选 Reaktoro 环境提供的只读数据库。
        </p>
        <div className="button-row">
          <button className="primary" onClick={onNew}>
            <FilePlus2 />
            新建空白数据库
          </button>
          <button
            className="secondary"
            onClick={onCompose}
            disabled={!runtime.available}
            title={!runtime.available ? "需要先连接 Reaktoro" : ""}
          >
            <Atom />
            从内置数据库创建
          </button>
          <button className="secondary" onClick={() => onOpenLocal()}>
            <FolderOpen />
            打开 .rtdb
          </button>
        </div>
      </div>
      <Tree title="我的数据库" open={open.mine} onToggle={() => toggle("mine")}>
        <div className="tree-list">
          {defaultDb && <div className="tree-label">默认数据库</div>}
          {defaultDb?.kind === "rtdb" && (
            <DbRow
              name={localDatabaseName(defaultDb.path)}
              meta={defaultDb.path}
              badge="默认"
              onClick={() => onOpenLocal(defaultDb.path)}
            />
          )}
          <div className="tree-label">最近使用</div>
          {recents.length ? (
            recents.map((x) => (
              <DbRow
                key={x.path}
                name={localDatabaseName(x.path)}
                meta={x.path}
                onClick={() => onOpenLocal(x.path)}
              />
            ))
          ) : (
            <p className="tree-empty">暂无有效的本地数据库。</p>
          )}
        </div>
      </Tree>
      <Tree
        title="Reaktoro 内置数据库"
        subtitle="由外部 Reaktoro 提供，EasyReaktoro 不打包这些数据"
        open={open.official}
        onToggle={() => toggle("official")}
      >
        {!runtime.available ? (
          <div className="blocked-inline">
            <MonitorCog />
            连接 Reaktoro 后才会加载目录；本地 .rtdb 仍可离线管理。
          </div>
        ) : catalogState === "loading" ? (
          <p className="tree-empty">正在并发读取真实目录…</p>
        ) : (
          (["PHREEQC", "SUPCRT", "NASA"] as const).map((group) => (
            <Tree
              key={group}
              nested
              title={group}
              subtitle={`${catalog.filter((x) => x.group === group).length} 个数据库`}
              open={open[group]}
              onToggle={() => toggle(group)}
            >
              <div className="tree-list">
                {catalog
                  .filter((x) => x.group === group)
                  .map((x) => (
                    <OfficialDbRow
                      key={x.id}
                      entry={x}
                      onOpen={() => onOpenOfficial(x)}
                    />
                  ))}
              </div>
            </Tree>
          ))
        )}
      </Tree>
    </div>
  );
}
function Tree({
  title,
  subtitle,
  open,
  onToggle,
  nested = false,
  children,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  nested?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`db-tree panel ${nested ? "nested" : ""}`}>
      <button className="tree-head" onClick={onToggle}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <span>
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </span>
      </button>
      {open && <div className="tree-body">{children}</div>}
    </section>
  );
}
function DbRow({
  name,
  meta,
  badge,
  onClick,
}: {
  name: string;
  meta: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button className="db-row" onClick={onClick}>
      <Database />
      <span>
        <strong>{name}</strong>
        <small>{meta}</small>
      </span>
      {badge && <b>{badge}</b>}
      <ChevronRight />
    </button>
  );
}
function OfficialDbRow({
  entry,
  onOpen,
}: {
  entry: Catalog;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error,setError]=useState('');
  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !details) {
      setLoading(true);
      setError('');
      try {
        setDetails(
          await api("catalog_entry_details", {
            group: entry.group,
            name: entry.embedded_name,
          }),
        );
      } catch(error) {setError(`详情读取失败：${errText(error)}`);} finally {
        setLoading(false);
      }
    }
  };
  return (
    <div className="official-db-entry">
      <div className="official-db-row">
        <button className="db-row" onClick={onOpen}>
          <Database />
          <span>
            <strong>{entry.embedded_name}</strong>
            <small>
              {entry.species_count} 个物种 · {entry.element_count} 个元素
            </small>
          </span>
          <b>只读</b>
          <ChevronRight />
        </button>
        <button className="details-toggle" onClick={toggle}>
          {expanded ? "收起详情" : "查看详情"}
        </button>
      </div>
      {expanded && (
        <div className="catalog-details">
          {error && <p className="inline-error" role="alert">{error}，可收起后重新打开。</p>}
          {loading ? (
            <span>正在读取真实统计…</span>
          ) : details ? (
            <>
              <div>
                <b>相态统计</b>
                <span>
                  {Object.entries(details.phase_counts || {})
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ") || "Reaktoro 未提供"}
                </span>
              </div>
              <div>
                <b>模型家族</b>
                <span>
                  {Object.entries(details.model_family_counts || {})
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ") || "Reaktoro 未提供"}
                </span>
              </div>
              <div>
                <b>运行时</b>
                <span>
                  Reaktoro {details.runtime_version} · 只读 · 已 live-open
                </span>
              </div>
              <div>
                <b>参考信息</b>
                <span>
                  {details.references?.length
                    ? `${details.references.length} 条可用`
                    : "当前 API 未提供"}
                </span>
              </div>
            </>
          ) : (
            <span>详情读取失败</span>
          )}
        </div>
      )}
    </div>
  );
}

function Workspace(props: any) {
  const [split, setSplit] = useState(42);
  const grid = useRef<HTMLDivElement>(null);
  const {
    summary,
    rows,
    total,
    offset,
    query,
    filters,
    selected,
    details,
    tp,
    evaluation,
    runtime,
    menu,
  } = props;
  return (
    <div className="workspace-page">
      <header className="workspace-header">
        <div>
          <button className="breadcrumb" onClick={props.onLibrary}>
            数据库 /
          </button>
          <h1>{label(summary)}</h1>
          <p>
            {summary.read_only
              ? "Reaktoro 内置数据库 · 只读"
              : "EasyReaktoro 本地数据库 · 可编辑"}
          </p>
        </div>
        <div className="workspace-actions">
          {!summary.read_only && (
            <button className="primary" onClick={props.onNewSpecies}>
              <Plus />
              新建物种
            </button>
          )}
          {!summary.read_only && (
            <button
              className="secondary"
              disabled={!summary.dirty}
              onClick={props.onSave}
            >
              <Save />
              保存
            </button>
          )}
          <div className="menu-anchor">
            <button
              className="secondary"
              onClick={(e) => {
                e.stopPropagation();
                props.onMenu();
              }}
            >
              操作
              <Ellipsis />
            </button>
            {menu && <ActionMenu {...props} />}
          </div>
        </div>
      </header>
      <div className="db-info-strip">
        <div>
          <span>来源 / 路径</span>
          <strong>
            {summary.path || `${summary.provider} · ${summary.embedded_name}`}
          </strong>
        </div>
        <div>
          <span>规模</span>
          <strong>
            {summary.species_count} 物种 · {summary.element_count} 元素
          </strong>
        </div>
        <div>
          <span>{summary.kind === 'official' ? 'Reaktoro 版本' : '文件格式'}</span>
          <strong>
            {summary.kind === 'official' ? summary.runtime_version || '未提供' : summary.schema_version || '.rtdb'}
          </strong>
        </div>
        <b>
          {summary.read_only ? "只读" : summary.dirty ? "未保存" : "已保存"}
        </b>
      </div>
      <div className="workspace-grid" ref={grid} style={{gridTemplateColumns:`minmax(0, ${split}fr) 10px minmax(0, ${100-split}fr)`}}>
        <section className="species-panel panel">
          <div className="table-toolbar">
            <label className="search-box">
              <Search />
              <input
                aria-label="搜索物种"
                value={query}
                onChange={(e) => props.onQuery(e.target.value)}
                placeholder="搜索名称、化学式或模型"
              />
              {query && (
                <button aria-label="清除搜索" onClick={() => props.onQuery("")}>
                  <X />
                </button>
              )}
            </label>
            <button
              className={
                filters.elements.length
                  ? "element-filter active"
                  : "element-filter"
              }
              onClick={props.onPeriodic}
            >
              <Atom />
              {filters.elements.length
                ? filters.elements.join(" · ")
                : "元素周期表"}
            </button>
          </div>
          <div className="filter-row">
            <select aria-label="筛选相态"
              value={filters.state}
              onChange={(e) =>
                props.onFilters({ ...filters, state: e.target.value })
              }
            >
              <option value="All">全部相态</option>
              {(props.facets.states || []).map((state:string) => <option key={state} value={state}>{stateLabel(state)}</option>)}
            </select>
            <select aria-label="筛选模型"
              value={filters.model}
              onChange={(e) =>
                props.onFilters({ ...filters, model: e.target.value })
              }
            >
              <option value="All">全部模型</option>
              {(props.facets.models || []).map((model:string) => <option key={model} value={model}>{modelLabel(model)}</option>)}
            </select>
          </div>
          <div className="table-header">
            <span>名称</span>
            <span>化学式</span>
            <span>相态</span>
            <span>模型</span>
          </div>
          <div className="species-scroll" aria-busy={props.rowsLoading}>
            {rows.map((x: Species) => (
              <button
                key={`${x.name}-${x.fingerprint}`}
                className={`species-row ${(selected?.id && x.id ? selected.id === x.id : selected?.name === x.name) ? "selected" : ""}`}
                onClick={() => props.onSelect(x)}
              >
                <strong title={x.name}>{x.name}{x.disabled ? " · 草稿" : ""}</strong>
                <ChemicalFormula value={x.formula} />
                <span title={x.state}>{stateLabel(x.state)}</span>
                <span title={modelLabel(x.model)}>{modelLabel(x.model,true)}</span>
              </button>
            ))}
            {!rows.length && (
              <div className="empty-list">{props.rowsLoading ? "正在读取物种…" : summary.species_count ? "没有符合条件的物种，请调整搜索或筛选。" : "数据库还没有物种，点击“新建物种”开始。"}</div>
            )}
          </div>
          <div className="table-footer">
            <span>
              {total ? offset + 1 : 0}–{Math.min(offset + rows.length, total)} /{" "}
              {total}
            </span>
            <span>
              <button
                disabled={!offset || props.rowsLoading}
                onClick={() => props.onPage(Math.max(0, offset - 100))}
              >
                上一页
              </button>
              <button
                disabled={offset + rows.length >= total || props.rowsLoading}
                onClick={() => props.onPage(offset + 100)}
              >
                下一页
              </button>
            </span>
          </div>
        </section>
        <div className="splitter" role="separator" tabIndex={0} aria-label="调整物种列表宽度" aria-orientation="vertical" aria-valuemin={32} aria-valuemax={65} aria-valuenow={split}
          onKeyDown={e => { if(e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setSplit(Math.min(65,Math.max(32,split+(e.key === "ArrowRight" ? 2 : -2)))); } }}
          onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if(e.currentTarget.hasPointerCapture(e.pointerId) && grid.current) {const rect=grid.current.getBoundingClientRect(); setSplit(Math.max(32,Math.min(65,100*(e.clientX-rect.left)/rect.width)));} }}
          onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); }} />
        <Inspector
          {...{ summary, selected, details, tp, evaluation, runtime }}
          busy={props.busy}
          validation={props.validation}
          onTp={props.onTp}
          onEvaluate={props.onEvaluate}
          onEdit={() => props.onEditSpecies()}
        />
      </div>
    </div>
  );
}
function ActionMenu(p: any) {
  return (
    <div className="popover action-menu" onClick={(e) => e.stopPropagation()}>
      {p.summary.read_only ? (
        <>
          <button onClick={p.onCompose}>从内置数据库选择物种并创建</button>
          <button onClick={p.onCopyAll}>复制整个数据库…</button>
        </>
      ) : (
        <>
          <button onClick={p.onCompose}>从 Reaktoro 内置数据库添加</button>
          <button onClick={p.onImport}>从 YAML / .rtdb / 文件夹添加</button>
          <button onClick={p.onSaveAs}>另存为 .rtdb…</button>
          {p.selected && (
            <button className="danger" onClick={p.onDeleteSpecies}>
              <Trash2 />
              删除所选物种
            </button>
          )}
        </>
      )}
      <hr />
      <button onClick={p.onValidate}>验证数据库</button>
      <button onClick={p.onExport} disabled={!p.runtime.available} title={!p.runtime.available ? "导出需要连接 Reaktoro 进行重新加载验证" : ""}>导出…</button>
      {p.summary.path && <button onClick={p.onReveal}>在 Finder 中显示</button>}
      <button onClick={p.onDefault}>设为默认数据库</button>
      <hr />
      <button onClick={p.onClose}>关闭数据库</button>
    </div>
  );
}

const fieldNames: Record<string, string> = {
  name: "名称",
  original_name: "原始名称",
  formula: "化学式",
  composition: "元素组成",
  charge: "电荷",
  state: "相态",
  molar_mass_kg_mol: "摩尔质量 (kg/mol)",
  model: "模型",
  valid_tp: "有效温压范围",
  reaction: "形成反应",
  dependencies: "依赖",
  activity_parameters: "活度参数",
  provenance: "来源",
  references: "参考文献",
  notes: "备注",
  fingerprint: "Fingerprint",
  type:"模型类型", native_type:"原生模型", parameters:"模型参数", parameters_yaml:"原始模型参数", runtime_version:"Reaktoro 版本", provider:"提供者", group:"数据库类型", database:"数据库", source_path:"来源路径", reactants:"反应物及系数", equation:"反应式", model_parameters_yaml:"反应模型参数", temperature_K:"温度范围 (K)", pressure_Pa:"压力范围 (Pa)", ion_size_angstrom:"离子尺寸 aᵢ (Å)", calibration:"平衡常数拟合", version:"版本", unit:"单位",
};
const stateLabel = (value:string) => ({Aqueous:"水溶液",Gas:"气相",Liquid:"液相",Solid:"固相",CrystallineSolid:"晶体固相",IonExchange:"离子交换",Adsorbed:"吸附态",Unknown:"未指定"}[value] || value || "—");
const modelLabel=(value:string,short=false)=>({"extended-maier-kelley":short?'EMK':'Extended Maier–Kelley',"modified-ryzhenko-bryzgalin":short?'MRB':'Modified Ryzhenko–Bryzgalin',"akinfiev-diamond":short?'AD':'Akinfiev–Diamond',"reaktoro-native":'Reaktoro native'}[value] || value || 'Reaktoro 未提供');
function Inspector({
  summary,
  selected,
  details,
  tp,
  evaluation,
  runtime,
  onTp,
  onEvaluate,
  onEdit,
  busy,
  validation,
}: any) {
  const [tab, setTab] = useState("overview");
  useEffect(() => setTab("overview"), [selected?.id, selected?.name]);
  if (!selected)
    return (
      <section className="inspector panel empty-inspector">
        <Atom />
        <p>选择物种查看真实属性。</p>
      </section>
    );
  const reaction = details?.reaction && Object.keys(details.reaction).length;
  const tabs = [
    ["overview", "概览"],
    ["model", "模型与参数"],
    ...(reaction ? [["reaction", "反应与依赖"]] : []),
    ["source", "来源与参考文献"],
    ...(!summary.read_only ? [["validation", "验证"]] : []),
  ];
  return (
    <section className="inspector panel">
      <div className="inspector-title">
        <div>
          <h2>{selected.name}</h2>
          <ChemicalFormula value={selected.formula} />
          <div className="tag-row">
            <span>{stateLabel(selected.state)}</span>
            <span>{modelLabel(selected.model)}</span>
          </div>
        </div>
        {!summary.read_only && (
          <button className="secondary" disabled={!details} onClick={onEdit}>
            <Pencil />
            编辑
          </button>
        )}
      </div>
      <div className="inspector-tabs">
        {tabs.map(([id, name]) => (
          <button
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => setTab(id)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="inspector-scroll">
        {tab === "overview" && (
          <>
            <CardRows
              data={{
                name: details?.name,
                formula: details?.formula,
                composition: details?.composition,
                state: stateLabel(details?.state),
                charge: details?.charge,
                molar_mass_kg_mol: details?.molar_mass_kg_mol,
              }}
            />
            <h3 className="section-caption">指定温压计算</h3>
            <div className="tp-grid">
              <label>
                温度 (K)
                <input
                  value={tp.temperature}
                  onChange={(e) => onTp({ ...tp, temperature: e.target.value })}
                />
              </label>
              <label>
                压力 (Pa)
                <input
                  value={tp.pressure}
                  onChange={(e) => onTp({ ...tp, pressure: e.target.value })}
                />
              </label>
            </div>
            <button
              className="primary full-button"
              disabled={!details || selected.disabled || busy || (!runtime.available && selected.model !== "extended-maier-kelley")}
              title={selected.disabled ? "草稿不参与计算" : !runtime.available ? "除 Extended Maier–Kelley 外，计算需要连接 Reaktoro" : ""}
              onClick={onEvaluate}
            >
              <Activity />
              计算标准热力学性质
            </button>
            {evaluation && <ThermoResults report={evaluation} />}
          </>
        )}
        {tab === "model" && (
          <>
            <CardRows
              data={{ model: details?.model_definition?.label || details?.model?.native_type || details?.model?.type, ...(details?.model?.runtime_version ? {runtime_version:details.model.runtime_version} : {}), valid_tp: details?.valid_tp }}
            />
            <ModelParameterTable value={details?.model_parameters || details?.model?.parameters} definition={details?.model_definition} />
            {!details?.model_parameters && !details?.model?.parameters && details?.model?.parameters_yaml && <details className="raw-model-parameters"><summary>查看源模型参数</summary><pre>{details.model.parameters_yaml}</pre></details>}
            {details?.activity_parameters &&
              Object.keys(details.activity_parameters).length > 0 && (
                <div className="notice">
                  <strong>活度模型参数</strong>
                  <p>
                    仅在记录声明的适用活度模型中使用；其中 aᵢ
                    是经验模型参数，并非物理半径。
                  </p>
                  <Value value={details.activity_parameters} />
                </div>
              )}
          </>
        )}
        {tab === "reaction" && (
          <CardRows
            data={{
              reaction: details?.reaction,
              dependencies: details?.dependencies,
            }}
          />
        )}
        {tab === "source" && (
          <>
            <CardRows
              data={{
                provenance: details?.provenance,
                fingerprint: details?.fingerprint,
              }}
            />
            <ReferenceList references={details?.references} />
          </>
        )}
        {tab === "validation" && (
          <p className="empty-note">
            {validation ? `最近验证：${validation.status === "valid" ? "通过" : `${validation.issues.length} 项待检查`}。使用“操作 → 验证数据库”查看完整报告。` : "尚未执行验证。使用“操作 → 验证数据库”检查模型参数、形成反应和引用物种。草稿不参与计算或正式导出。"}
          </p>
        )}
      </div>
    </section>
  );
}
export function ModelParameterTable({value,definition}:{value:unknown;definition?:ModelDefinition}) {
  const rows:{name:string,value:unknown}[]=[];
  const visit=(item:unknown,path:string[])=>{
    if(item === null || item === undefined) return;
    if(Array.isArray(item)) { item.forEach((child,index)=>visit(child,item.length === 1 ? path : [...path,String(index+1)])); return; }
    if(typeof item === "object") { Object.entries(item).forEach(([key,child])=>visit(child,[...path,key])); return; }
    rows.push({name:path.join(" / "),value:item});
  };
  visit(value,[]);
  if(!rows.length) return <p className="empty-note">Reaktoro 未提供结构化模型参数。</p>;
  const hasUnits=Boolean(definition?.parameters?.length);
  return <section className="model-parameters"><h3>模型参数</h3><table><thead><tr><th>参数</th><th>数值</th>{hasUnits && <th>单位</th>}</tr></thead><tbody>{rows.map((row,index)=>{const parameter=definition?.parameters?.find(item=>item.name===row.name);return <tr key={index}><td title={row.name}>{parameter?.label || row.name}</td><td>{typeof row.value === "number" ? Number(row.value.toPrecision(10)).toString() : String(row.value)}</td>{hasUnits && <td>{parameter?.unit || '未声明'}</td>}</tr>;})}</tbody></table>{!hasUnits && <p className="empty-note">参数名与单位约定沿用源模型；未声明的单位不作推测。</p>}</section>;
}
function CardRows({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="detail-card">
      {Object.entries(data).map(([key, value]) => (
        <div className="detail-row" key={key}>
          <span>{fieldNames[key] || key}</span>
          {key === "formula" && typeof value === "string" ? (
            <strong>
              <ChemicalFormula value={value} />
            </strong>
          ) : (
            <Value value={value} />
          )}
        </div>
      ))}
    </div>
  );
}
function Value({ value }: { value: unknown }) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "string" && /^<.+ object at 0x[0-9a-f]+>$/i.test(value)) ||
    (typeof value === "object" && !Object.keys(value as object).length)
  )
    return <strong className="not-provided">Reaktoro 未提供</strong>;
  if (typeof value === "object")
    return (
      <div className="structured-value">
        {Array.isArray(value)
          ? value.map((x, i) => (
              <div key={i}>
                <Value value={x} />
              </div>
            ))
          : Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "read_only" && k !== "request_id" && k !== "ok" && k !== "id" && !(k === "parameters_yaml" && !!(value as any).parameters)).map(([k, v]) => (
              <div key={k}>
                <b>{fieldNames[k] || k}</b>
                <Value value={v} />
              </div>
            ))}
      </div>
    );
  return <strong>{String(value)}</strong>;
}
const thermoNames: Record<string, string> = {
  G0: "G°",
  H0: "H°",
  S0: "S°",
  Cp0: "Cₚ°",
  V0: "V°",
  VP0: "(∂V°/∂P)ₜ",
  VT0: "(∂V°/∂T)ₚ",
  logK: "log K",
  reaction_G0: "ΔᵣG°",
};
function ThermoResults({ report }: { report: any }) {
  return (
    <div className="thermo-results">
      {Object.entries(report.properties || {}).map(([key, value]) => (
        <div key={key}>
          <span title={key}>{thermoNames[key] || key}</span>
          <strong>
            {value === null || !Number.isFinite(Number(value))
              ? "Reaktoro 未提供"
              : Number(value).toPrecision(8)}
          </strong>
          <small>{report.units?.[key] || ""}</small>
        </div>
      ))}
    </div>
  );
}
function ReferenceList({ references }: { references: any[] }) {
  if (!references?.length)
    return (
      <p className="empty-note">
        该数据库未通过当前 Reaktoro API 暴露参考文献；EasyReaktoro
        不联网猜测或补写。
      </p>
    );
  return (
    <div className="reference-list">
      {references.map((x, i) => (
        <article key={i}>{referenceText(x)}</article>
      ))}
    </div>
  );
}

function SettingsPage({
  prefs,
  runtime,
  candidates,
  settingsTab,
  diagnostics,
  discovering,
  onTab,
  onPrefs,
  onDiscover,
  onChoose,
  onChooseFolder,
  onCandidate,
  onPickDirectory,
  onDiagnose,
}: any) {
  const tabs = [
    ["general", "常规"],
    ["database", "数据库与文件"],
    ["runtime", "Reaktoro 环境"],
    ["about", "关于"],
  ];
  return (
    <div className="scroll-page settings-page">
      <div className="page-heading">
        <span className="eyebrow">设置</span>
        <h1>设置</h1>
      </div>
      <div className="settings-layout">
        <nav>
          {tabs.map(([id, name]) => (
            <button
              className={settingsTab === id ? "active" : ""}
              onClick={() => onTab(id)}
              key={id}
            >
              {name}
            </button>
          ))}
        </nav>
        <section className="settings-card panel">
          <h2>{tabs.find((x) => x[0] === settingsTab)?.[1]}</h2>
          {settingsTab === "general" && (
            <>
              <Setting
                title="界面语言"
                copy="当前提供简体中文界面。"
              >
                <button disabled className="secondary">
                  简体中文
                </button>
              </Setting>
              <Setting title="主题" copy="立即生效并在重启后保持。">
                <select
                  value={prefs.theme}
                  onChange={(e) => onPrefs({ ...prefs, theme: e.target.value })}
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </Setting>
              <Setting title="界面密度" copy="控制列表与表单间距。">
                <select
                  value={prefs.density}
                  onChange={(e) =>
                    onPrefs({ ...prefs, density: e.target.value })
                  }
                >
                  <option value="comfortable">舒适</option>
                  <option value="compact">紧凑</option>
                </select>
              </Setting>
              <Setting title="启动行为" copy="应用始终从主页开始。">
                <button disabled className="secondary">
                  打开主页
                </button>
              </Setting>
            </>
          )}
          {settingsTab === "database" && (
            <>
              <Setting
                title="默认数据库"
                copy={
                  prefs.default_database
                    ? prefs.default_database.kind === "rtdb" ? prefs.default_database.path : `${prefs.default_database.group} / ${prefs.default_database.name}`
                    : "尚未设置"
                }
              >
                <button
                  className="secondary"
                  disabled={!prefs.default_database}
                  onClick={() => {
                    const n = { ...prefs };
                    delete n.default_database;
                    onPrefs(n);
                  }}
                >
                  清除
                </button>
              </Setting>
              <Setting
                title="最近数据库"
                copy={`${prefs.recent_databases.length} 个有效记录`}
              >
                <button
                  className="secondary"
                  disabled={!prefs.recent_databases.length}
                  onClick={() => onPrefs({ ...prefs, recent_databases: [] })}
                >
                  清除列表
                </button>
              </Setting>
              <Setting
                title="默认保存目录"
                copy={prefs.save_directory || "未设置；保存时由系统面板选择。"}
              >
                <button
                  className="secondary"
                  onClick={() => onPickDirectory("save_folder")}
                >
                  选择文件夹…
                </button>
              </Setting>
              <Setting
                title="默认导出目录"
                copy={
                  prefs.export_directory || "未设置；导出时由系统面板选择。"
                }
              >
                <button
                  className="secondary"
                  onClick={() => onPickDirectory("export_folder")}
                >
                  选择文件夹…
                </button>
              </Setting>
            </>
          )}
          {settingsTab === "runtime" && (
            <>
              <div className="runtime-settings-head">
                <div>
                  <span className={`status-chip ${runtime.status}`}>
                    {runtime.available ? "已连接" : "未连接"}
                  </span>
                  <h3>
                    {runtime.available
                      ? `Reaktoro ${runtime.version}`
                      : "未配置 Reaktoro"}
                  </h3>
                  <p>{runtime.python || runtime.diagnostic}</p>
                </div>
                <MonitorCog />
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={discovering}
                  onClick={onDiscover}
                >
                  <RefreshCw />
                  {discovering ? "正在检测…" : "重新检测"}
                </button>
                <button className="primary" onClick={onChoose}>
                  选择 Python
                </button>
                <button className="secondary" onClick={onChooseFolder}>
                  选择环境文件夹
                </button>
                <button
                  className="secondary"
                  disabled={!runtime.available}
                  onClick={onDiagnose}
                >
                  连接测试与诊断
                </button>
              </div>
              <p className="setting-copy">
                自动检测会扫描环境变量、Conda 环境记录、Applications
                中的环境目录以及
                Homebrew、Miniforge、Miniconda、Mambaforge、Anaconda、Micromamba
                和 pyenv 的常见位置。列表只显示经测试能正常加载 Reaktoro 的 Python 环境，不要求环境名称为 Reaktoro。自定义位置未被发现时，请手动选择其中的 Python 或环境文件夹。
              </p>
              <div className="candidate-list">
                {candidates.map((x: Candidate) => (
                  <button
                    key={x.python}
                    className={runtime.python === x.python ? "selected" : ""}
                    onClick={() => onCandidate(x.python)}
                  >
                    <span>
                      <strong>Reaktoro {x.version}</strong>
                      <small>{x.environment_root || x.python}</small>
                    </span>
                    {runtime.python === x.python ? <Check /> : <ChevronRight />}
                  </button>
                ))}
              </div>
              {diagnostics && <Diagnostics data={diagnostics} />}
            </>
          )}
          {settingsTab === "about" && (
            <div className="about-card">
              <img src="/easyreaktoro-icon.png" />
              <h3>EasyReaktoro</h3>
              <p>版本 0.2.0</p>
              <dl>
                <div>
                  <dt>许可证</dt>
                  <dd></dd>
                </div>
                <div>
                  <dt>Powered by</dt>
                  <dd>{prefs.powered_by || ""}</dd>
                </div>
                <div>
                  <dt>GitHub / 更新</dt>
                  <dd>{prefs.github_url || ""}</dd>
                </div>
              </dl>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
function Setting({
  title,
  copy,
  children,
}: {
  title: string;
  copy: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <span>{copy}</span>
      </div>
      {children}
    </div>
  );
}
function Diagnostics({ data }: { data: any }) {
  const tests = [
    ["Bridge 进程", data.bridge?.pid ? "通过" : "失败"],
    ["Reaktoro 模块加载", data.probe?.available ? "通过" : "失败"],
    ["运行时版本", data.probe?.version || "不可用"],
    ["已打开数据库", String(data.bridge?.handles ?? 0)],
    ["模型 Registry", `${data.model_registry?.length || 0} 个模型`],
  ];
  return (
    <div className="diagnostic-grid">
      {tests.map(([a, b]) => (
        <div key={a}>
          <span>{a}</span>
          <strong>{b}</strong>
        </div>
      ))}
    </div>
  );
}
function Simulation() {
  return (
    <div className="centered-page">
      <FlaskConical />
      <span className="eyebrow">SIMULATION</span>
      <h1>模拟功能计划中</h1>
      <p>
        当前版本不提供模拟计算或占位控件。数据库模型、验证与导出链路稳定后再接入。
      </p>
    </div>
  );
}

function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if(lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); } catch(error) { if(!String(error).includes("cancelled")) setError(errText(error)); }
    finally { lock.current = false; setBusy(false); }
  };
  return {busy,error,run};
}

function Modal({
  title,
  onClose,
  wide = false,
  children,
  busy = false,
  error = "",
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
  busy?: boolean;
  error?: string;
}) {
  const modal = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose); latestClose.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(()=>{if(error){const target=modal.current?.querySelector<HTMLElement>('[role="alert"]');target?.scrollIntoView?.({block:'nearest'});target?.focus();}},[error]);
  return (
    <div className="modal-backdrop">
      <div ref={modal} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal panel ${wide ? "wide" : ""}`} onKeyDown={e => {
        if(e.key === "Escape" && !busy) { e.stopPropagation(); latestClose.current(); }
        if(e.key === "Tab") {
          const focusable = [...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])];
          const first = focusable[0], last = focusable[focusable.length-1];
          if(e.shiftKey && (document.activeElement === first || document.activeElement === modal.current)) { e.preventDefault(); last?.focus(); }
          else if(!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <header>
          <h2>{title}</h2>
          <button disabled={busy} aria-label="关闭对话框" onClick={onClose}>
            <X />
          </button>
        </header>
        {error && <p className="inline-error" role="alert" tabIndex={-1}>{error}</p>}
        <fieldset className="modal-fields" disabled={busy}>{children}</fieldset>
        {busy && <p className="modal-copy" role="status">正在处理，请稍候…</p>}
      </div>
    </div>
  );
}
export function NewDatabase({
  defaultDirectory,
  onClose,
  onCreated,
}: {
  defaultDirectory?: string;
  onClose: () => void;
  onCreated: (s: Summary) => void;
}) {
  const [path, setPath] = useState("");
  const operation = useOperation();
  return (
    <Modal title="新建空白数据库" onClose={onClose} {...operation}>
      <p className="modal-copy">
        数据库名称使用你保存的 .rtdb
        文件名，例如“热液实验.rtdb”在界面中显示为“热液实验”。
      </p>
      <div className="field-label">
        <label htmlFor="new-db-path">保存位置</label>
        <div className="path-picker">
          <input id="new-db-path" readOnly value={path} />
          <button
            className="secondary"
            onClick={() => operation.run(async () => {
                setPath(
                  await api("pick_path", {
                    kind: "save_rtdb",
                    defaultDirectory,
                  }),
                );
            })}
          >
            选择…
          </button>
        </div>
      </div>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={!path}
          onClick={() => operation.run(async () => {
            const r = await api<{ summary: Summary }>("rtdb_create", {
              path,
            });
            onCreated(r.summary);
          })}
        >
          创建
        </button>
      </div>
    </Modal>
  );
}

const emptySpecies = {
  name: "",
  formula: "",
  composition: {},
  charge: 0,
  state: "Aqueous",
  model: {
    type: "extended-maier-kelley",
    parameters: {},
    units: {},
    valid_tp: {},
  },
  valid_tp: {},
  reaction: {},
  dependencies: [],
  activity_parameters: {},
  provenance: { provider: "EasyReaktoro" },
  references: [],
  notes: "",
  disabled: false,
};

function generatedFormula(composition: Record<string, number>, charge: number) {
  const base = Object.entries(composition)
    .map(([symbol, amount]) => {
      const coefficient = Number(amount);
      return `${symbol}${coefficient === 1 ? "" : Number.isInteger(coefficient) ? coefficient : coefficient.toString()}`;
    })
    .join("");
  if (!charge) return base;
  const magnitude = Math.abs(charge) === 1 ? "" : Math.abs(charge).toString();
  return `${base}${charge > 0 ? "+" : "-"}${magnitude}`;
}

function referenceText(reference: any) {
  if (reference?.raw) return String(reference.raw);
  return [
    reference?.authors,
    reference?.year,
    reference?.title,
    reference?.journal,
    reference?.volume,
    reference?.pages,
    reference?.doi,
  ]
    .filter(Boolean)
    .join(". ");
}

export function SpeciesEditor({
  handleId,
  existing,
  onClose,
  onSaved,
}: {
  handleId: string;
  existing: any;
  onClose: () => void;
  onSaved: (x: any) => Promise<void> | void;
}) {
  const initial = existing
    ? structuredClone(existing)
    : structuredClone(emptySpecies);
  const [value, setValue] = useState<any>(initial);
  const [composition, setComposition] = useState<Record<string, number>>(
    Object.fromEntries(
      Object.entries(existing?.composition || {}).map(([key, amount]) => [
        key,
        Number(amount),
      ]),
    ),
  );
  const initialGeneratedFormula = generatedFormula(
    Object.fromEntries(
      Object.entries(existing?.composition || {}).map(([key, amount]) => [
        key,
        Number(amount),
      ]),
    ),
    Number(initial.charge || 0),
  );
  const [formulaText, setFormulaText] = useState(
    existing?.formula || initialGeneratedFormula,
  );
  const [formulaCustomized, setFormulaCustomized] = useState(
    Boolean(existing?.formula && existing.formula !== initialGeneratedFormula),
  );
  const [definitions, setDefinitions] = useState<ModelDefinition[]>([]);
  const [available, setAvailable] = useState<
    { id?: string; name: string; formula: string; state: string }[]
  >([]);
  const [parameters, setParameters] = useState<Record<string, number | string>>(
    existing?.model?.parameters || {},
  );
  const [reactionRows, setReactionRows] = useState<
    { name: string; coefficient: number; query: string }[]
  >(
    Object.entries(existing?.reaction?.reactants || {}).map(
      ([name, coefficient]) => ({
        name,
        coefficient: Number(coefficient),
        query: name,
      }),
    ),
  );
  const [activeReaction, setActiveReaction] = useState<number | null>(null);
  const [references, setReferences] = useState<any[]>(
    (existing?.references || []).map((reference: any) => ({ ...reference })),
  );
  const [activityEnabled, setActivityEnabled] = useState(
    Boolean(existing?.activity_parameters?.ion_size_angstrom !== undefined && (!existing?.activity_parameters?.model || existing.activity_parameters.model === "extended-debye-huckel")),
  );
  const [activityTouched,setActivityTouched]=useState(false);
  const foreignActivity=existing?.activity_parameters?.model && existing.activity_parameters.model !== "extended-debye-huckel";
  const submitLock=useRef(false);
  const [ionSize, setIonSize] = useState<string>(
    existing?.activity_parameters?.ion_size_angstrom?.toString() || "",
  );
  const [saving, setSaving] = useState(false);
  const [fitting,setFitting] = useState(false);
  const [editorError,setEditorError] = useState("");
  const [confirmCancel,setConfirmCancel] = useState(false);
  const cancel = () => changed ? setConfirmCancel(true) : onClose();
  const existingCalibration = existing?.model?.calibration;
  const [mrbMode, setMrbMode] = useState<"parameters" | "fit">(
    existingCalibration?.mode === "fit" ? "fit" : "parameters",
  );
  const [mrbValueKind, setMrbValueKind] = useState<"pK" | "logK">(
    existingCalibration?.value_kind === "logK" ? "logK" : "pK",
  );
  const [mrbRows, setMrbRows] = useState<MrbFitRow[]>(
    existingCalibration?.input_rows?.length
      ? existingCalibration.input_rows
      : [
          { temperature_C: "25", pressure_bar: "1", value: "" },
          { temperature_C: "100", pressure_bar: "500", value: "" },
          { temperature_C: "200", pressure_bar: "1000", value: "" },
        ],
  );
  const [mrbFitReport, setMrbFitReport] = useState<any>(
    existingCalibration?.report || null,
  );
  const modelType = value.model?.type || "extended-maier-kelley";
  const model = definitions.find((item) => item.id === modelType);
  const selectedElements = Object.keys(composition);
  const automaticFormula = generatedFormula(
    composition,
    Number(value.charge || 0),
  );
  const formula = formulaCustomized ? formulaText : automaticFormula;
  const editSnapshot=JSON.stringify({value,composition,formula,parameters,reactionRows:reactionRows.map(({name,coefficient})=>({name,coefficient})),references,activityEnabled,ionSize,mrbMode,mrbValueKind,mrbRows,mrbFitReport});
  const initialSnapshot=useRef(editSnapshot);
  const changed=editSnapshot !== initialSnapshot.current;
  const jumpTo=(id:string)=>document.getElementById(id)?.scrollIntoView?.({block:'start',behavior:'smooth'});

  useEffect(() => {
    Promise.all([
      api<{ items: ModelDefinition[] }>("model_definitions"),
      api<{
        items: { id?: string; name: string; formula: string; state: string }[];
      }>("species_options", { handleId }),
    ])
      .then(([modelResult, speciesResult]) => {
        setDefinitions(modelResult.items);
        setAvailable(
          speciesResult.items.filter((item) => item.name !== existing?.name),
        );
      })
      .catch((error) => setEditorError(`编辑器初始化失败：${errText(error)}`));
  }, [handleId]);

  const changeModel = (type: string) => {
    setValue({ ...value, model: { type, parameters: {} }, disabled: false });
    setParameters({});
    setReactionRows([]);
    setMrbFitReport(null);
  };

  const changeElements = (next: string[]) => {
    setComposition(
      Object.fromEntries(
        next.map((symbol) => [symbol, composition[symbol] || 1]),
      ),
    );
  };

  const updateReference = (index: number, key: string, next: string) =>
    setReferences(
      references.map((reference, row) =>
        row === index ? { ...reference, [key]: next } : reference,
      ),
    );

  const updateMrbRow = (index: number, key: keyof MrbFitRow, next: string) => {
    setMrbRows(
      mrbRows.map((row, current) =>
        current === index ? { ...row, [key]: next } : row,
      ),
    );
    setMrbFitReport(null);
  };

  const fitMrb = async () => {
    setFitting(true); setEditorError("");
    try {
    const rows = mrbRows.map((row, index) => {
      if (
        !row.temperature_C.trim() ||
        !row.pressure_bar.trim() ||
        !row.value.trim()
      )
        throw new Error(`第 ${index + 1} 行尚未填写完整。`);
      const temperature_C = Number(row.temperature_C);
      const pressure_bar = Number(row.pressure_bar);
      const measured = Number(row.value);
      if (
        !Number.isFinite(temperature_C) ||
        temperature_C <= -273.15 ||
        !Number.isFinite(pressure_bar) ||
        pressure_bar <= 0 ||
        !Number.isFinite(measured)
      )
        throw new Error(`第 ${index + 1} 行的温度、压力或平衡常数无效。`);
      return {
        temperature_K: temperature_C + 273.15,
        pressure_Pa: pressure_bar * 100000,
        value: measured,
      };
    });
    const report = await api<any>("model_fit_mrb", {
      rows,
      valueKind: mrbValueKind,
    });
    setParameters(report.parameters);
    setMrbFitReport(report);
    } catch(error) { setEditorError(errText(error)); }
    finally { setFitting(false); }
  };

  const submit = async () => {
    if(submitLock.current || fitting) return;
    submitLock.current=true;
    try {
      setEditorError("");
      if (!value.name.trim()) throw new Error("请输入物种名称。");
      if (!selectedElements.length) throw new Error("请先从周期表选择元素。");
      if (Object.values(composition).some((amount) => !Number.isFinite(amount) || amount <= 0))
        throw new Error("每个元素的化学计量数必须大于 0。");
      if (!model) throw new Error("请选择一个已加载的热力学模型。");
      if (
        modelType === "modified-ryzhenko-bryzgalin" &&
        mrbMode === "fit" &&
        !mrbFitReport
      )
        throw new Error("平衡常数数据已修改，请先完成 MRB 拟合。");
      const numericParameters = Object.fromEntries(
        model.parameters.map((parameter) => {
          const raw = parameters[parameter.name];
          if (parameter.required && (raw === "" || raw === undefined))
            throw new Error(`请填写模型参数“${parameter.label}”。`);
          const number = Number(raw);
          if (!Number.isFinite(number))
            throw new Error(`模型参数“${parameter.label}”必须是数值。`);
          return [parameter.name, number];
        }),
      );
      if (model.states.length && !model.states.includes(value.state))
        throw new Error(
          `${model.label} 仅适用于 ${model.states.join("、")} 相态。`,
        );
      if (model.reaction_based && !reactionRows.length)
        throw new Error("该模型必须指定形成反应所依赖的物种。");
      if (
        reactionRows.some(
          (row) => !row.name || !Number.isFinite(row.coefficient) || row.coefficient === 0,
        )
      )
        throw new Error("依赖物种和计量系数必须完整填写。");
      if(new Set(reactionRows.map(row => row.name)).size !== reactionRows.length) throw new Error("同一个已有物种只能填写一行，请合并计量系数。");
      const validTemperature = [
        value.valid_tp?.temperature_K?.[0],
        value.valid_tp?.temperature_K?.[1],
      ];
      const validPressure = [
        value.valid_tp?.pressure_Pa?.[0],
        value.valid_tp?.pressure_Pa?.[1],
      ];
      const range = (input: unknown[]) => {
        if (input.every((item) => item === "" || item === undefined))
          return undefined;
        const values = input.map(Number);
        if (input.some(item => item === "" || item === undefined) || !values.every(x => Number.isFinite(x) && x>0) || values[0] >= values[1])
          throw new Error(
            "有效范围必须填写有效的最小值和最大值，且最小值小于最大值。",
          );
        return values;
      };
      const temperatureRange = range(validTemperature);
      const pressureRange = range(validPressure);
      if (
        activityEnabled && value.state === "Aqueous" && Number(value.charge) !== 0 &&
        (!Number.isFinite(Number(ionSize)) || Number(ionSize) <= 0)
      )
        throw new Error("扩展 Debye–Hückel 离子尺寸 aᵢ 必须大于 0 Å。");
      setSaving(true);
      await onSaved({
        ...value,
        name: value.name.trim(),
        formula,
        composition,
        model: {
          ...value.model,
          type: modelType,
          parameters: modelType === "reaktoro-native" ? value.model?.parameters : numericParameters,
          calibration:
            modelType === "modified-ryzhenko-bryzgalin" && mrbMode === "fit"
              ? {
                  mode: "fit",
                  value_kind: mrbValueKind,
                  input_rows: mrbRows,
                  report: mrbFitReport,
                }
              : modelType === "modified-ryzhenko-bryzgalin" ? undefined : value.model?.calibration,
        },
        valid_tp: {
          ...(temperatureRange ? { temperature_K: temperatureRange } : {}),
          ...(pressureRange ? { pressure_Pa: pressureRange } : {}),
        },
        reaction: model.reaction_based
          ? {
              reactants: Object.fromEntries(
                reactionRows.map((row) => [row.name, row.coefficient]),
              ),
            }
          : modelType === "reaktoro-native" ? value.reaction : {},
        dependencies: model.reaction_based
          ? reactionRows.map((row) => row.name)
          : modelType === "reaktoro-native" ? value.dependencies : [],
        activity_parameters: !activityTouched || foreignActivity ? (value.activity_parameters || {}) :
          activityEnabled
            ? {
                ...value.activity_parameters,
                model: "extended-debye-huckel",
                ion_size_angstrom: Number(ionSize),
              }
            : {},
        references: references.filter((reference) =>
          Object.values(reference).some(Boolean),
        ),
        disabled: existing?.disabled && !model.creatable ? true : false,
      });
    } catch (error) {
      setEditorError(errText(error));
    } finally {
      submitLock.current=false;
      setSaving(false);
    }
  };

  return (
    <Modal title={existing ? "编辑物种" : "新建物种"} onClose={cancel} wide busy={saving || fitting} error={editorError}>
      {confirmCancel && <div className="inline-error"><p>表单中的修改尚未写入物种。确定放弃吗？</p><div className="button-row"><button className="secondary" onClick={() => setConfirmCancel(false)}>继续编辑</button><button className="danger" onClick={onClose}>放弃表单修改</button></div></div>}
      <nav className="editor-jumpnav" aria-label="物种表单章节"><button type="button" onClick={()=>jumpTo('editor-composition')}>组成与身份</button><button type="button" onClick={()=>jumpTo('editor-model')}>热力学模型</button>{model?.reaction_based && <button type="button" onClick={()=>jumpTo('editor-reaction')}>形成反应</button>}{value.state === 'Aqueous' && Number(value.charge)!==0 && <button type="button" onClick={()=>jumpTo('editor-activity')}>活度参数</button>}<button type="button" onClick={()=>jumpTo('editor-references')}>文献与备注</button></nav>
      <div className="species-editor">
        <section className="editor-section" id="editor-composition">
          <header>
            <b>1</b>
            <div>
              <h3>定义组成</h3>
              <p>
                先选择元素并填写化学计量数。系统生成初始化学式，你可以按数据库命名习惯继续修改。
              </p>
            </div>
          </header>
          <label className="field-label">
            物种名称
            <input
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
              placeholder="用于数据库中的唯一名称"
            />
          </label>
          {modelType !== "reaktoro-native" && <details className="element-disclosure" open={!existing}>
            <summary>选择元素 <span>{selectedElements.length ? selectedElements.join(' · ') : '尚未选择'}</span></summary>
            <div className="mini-periodic">
            <PeriodicTable
              selected={selectedElements}
              onChange={changeElements}
            />
          </div></details>}
          {selectedElements.length > 0 && (
            <div className="composition-editor">
              {selectedElements.map((symbol) => {
                const element = ELEMENTS.find((item) => item.symbol === symbol);
                return (
                  <label key={symbol}>
                    <span>
                      <strong>{symbol}</strong>
                      <small>
                        {element?.zh} · {element?.en}
                      </small>
                    </span>
                    <input
                      type="number"
                      disabled={modelType === "reaktoro-native"}
                      min="0.000001"
                      step="any"
                      value={composition[symbol]}
                      onChange={(e) =>
                        setComposition({
                          ...composition,
                          [symbol]: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                );
              })}
            </div>
          )}
          <div className="identity-fields">
            <label className="identity-field charge-field">
              <span>最终电荷</span>
              <input
                type="number"
                disabled={modelType === "reaktoro-native"}
                step="1"
                value={value.charge}
                onChange={(e) =>
                  setValue({ ...value, charge: Number(e.target.value) })
                }
              />
            </label>
            <label className="identity-field state-field">
              <span>相态</span>
              <select
                disabled={modelType === "reaktoro-native"}
                value={value.state}
                onChange={(e) => setValue({ ...value, state: e.target.value })}
              >
                {[...new Set(["Aqueous","Gas","Liquid","Solid",value.state])].map(state => <option key={state} value={state}>{stateLabel(state)}</option>)}
              </select>
            </label>
            <div className="identity-field formula-field">
              <label htmlFor="species-formula">
                化学式
                <small>{formulaCustomized ? "已修改" : "自动生成"}</small>
              </label>
              <div className="formula-control">
                <input
                  id="species-formula"
                  disabled={modelType === "reaktoro-native"}
                  value={formula}
                  placeholder="请先选择元素"
                  onChange={(event) => {
                    setFormulaText(event.target.value);
                    setFormulaCustomized(true);
                  }}
                />
                <button
                  className="formula-reset"
                  disabled={!formulaCustomized || modelType === "reaktoro-native"}
                  title="恢复自动生成"
                  onClick={() => {
                    setFormulaCustomized(false);
                    setFormulaText(automaticFormula);
                  }}
                >
                  <RefreshCw />
                  <span>恢复自动生成</span>
                </button>
              </div>
              {formula ? (
                <div className="formula-preview-inline">
                  <small>排版预览</small>
                  <strong>
                    <ChemicalFormula value={formula} />
                  </strong>
                  <em>可加入括号或相态标记</em>
                </div>
              ) : (
                <em className="formula-hint">
                  选择元素后自动生成，也可以直接编辑
                </em>
              )}
            </div>
          </div>
        </section>

        <section className="editor-section" id="editor-model">
          <header>
            <b>2</b>
            <div>
              <h3>选择标准态热力学模型</h3>
              <p>
                选择与数据来源一致的模型，按标明的单位填写参数。修改原生模型时，请新建一个自定义物种。
              </p>
            </div>
          </header>
          <label className="field-label">
            模型
            <select
              disabled={modelType === "reaktoro-native"}
              value={modelType}
              onChange={(e) => changeModel(e.target.value)}
            >
              {definitions
                .filter((item) => item.creatable || item.id === modelType)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          </label>
          {model && (
            <div className="model-description">
              <strong>{model.label}</strong>
              <p>{model.description}</p>
              {!model.creatable && (
                <span>这是已有来源记录，不能作为从零创建的新模型。</span>
              )}
            </div>
          )}
          {modelType === "modified-ryzhenko-bryzgalin" && (
            <div className="mrb-mode">
              <button
                className={mrbMode === "parameters" ? "active" : ""}
                onClick={() => setMrbMode("parameters")}
              >
                直接输入三个参数
              </button>
              <button
                className={mrbMode === "fit" ? "active" : ""}
                onClick={() => setMrbMode("fit")}
              >
                用多温压平衡常数拟合
              </button>
            </div>
          )}
          {modelType === "modified-ryzhenko-bryzgalin" && mrbMode === "fit" && (
            <div className="mrb-fit-editor">
              <div className="mrb-fit-heading">
                <div>
                  <strong>实验或文献平衡常数</strong>
                  <p>
                    输入至少 3 组温度、压力和观测值。选择 log K
                    时按热力学约定转换为 pK = −log K，再拟合 MRB 三参数。
                  </p>
                </div>
                <label>
                  输入值
                  <select
                    value={mrbValueKind}
                    onChange={(event) => {
                      setMrbValueKind(event.target.value as "pK" | "logK");
                      setMrbFitReport(null);
                    }}
                  >
                    <option value="pK">pK</option>
                    <option value="logK">log K</option>
                  </select>
                </label>
              </div>
              <div className="mrb-data-table">
                <div className="mrb-data-header">
                  <span>温度 (°C)</span>
                  <span>压力 (bar)</span>
                  <span>{mrbValueKind}</span>
                  <span />
                </div>
                {mrbRows.map((row, index) => (
                  <div key={index} className="mrb-data-row">
                    <input
                      type="number"
                      step="any"
                      value={row.temperature_C}
                      onChange={(event) =>
                        updateMrbRow(index, "temperature_C", event.target.value)
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={row.pressure_bar}
                      onChange={(event) =>
                        updateMrbRow(index, "pressure_bar", event.target.value)
                      }
                    />
                    <input
                      type="number"
                      step="any"
                      value={row.value}
                      onChange={(event) =>
                        updateMrbRow(index, "value", event.target.value)
                      }
                    />
                    <button
                      className="danger"
                      disabled={mrbRows.length <= 3}
                      onClick={() => {
                        setMrbRows(
                          mrbRows.filter((_, rowIndex) => rowIndex !== index),
                        );
                        setMrbFitReport(null);
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
              <div className="button-row">
                <button
                  className="secondary"
                  onClick={() => {
                    setMrbRows([
                      ...mrbRows,
                      { temperature_C: "", pressure_bar: "", value: "" },
                    ]);
                    setMrbFitReport(null);
                  }}
                >
                  <Plus />
                  添加数据点
                </button>
                <button
                  className="primary"
                  onClick={async () => {
                    try {
                      await fitMrb();
                    } catch (error) {
                      alert(`MRB 拟合失败：${errText(error)}`);
                    }
                  }}
                >
                  拟合 MRB 参数
                </button>
              </div>
              {mrbFitReport && (
                <div className="mrb-fit-result">
                  <div className="mrb-fit-status">
                    <Check />
                    <div>
                      <strong>拟合成功，参数已写入当前表单</strong>
                      <p>
                        尚未保存到数据库。请完成其余字段后点击“保存物种”，再保存数据库文件。
                      </p>
                    </div>
                  </div>
                  <div className="mrb-fit-values">
                    <span>
                      <small>pK₀</small>
                      {Number(parameters.pK0).toPrecision(7)}
                    </span>
                    <span>
                      <small>Azz</small>
                      {Number(parameters.Azz).toPrecision(7)}
                    </span>
                    <span>
                      <small>Bzz</small>
                      {Number(parameters.Bzz).toPrecision(7)} K
                    </span>
                    <span>
                      <small>RMSE</small>
                      {Number(mrbFitReport.rmse).toPrecision(5)}
                    </span>
                    <span>
                      <small>R²</small>
                      {Number(mrbFitReport.r_squared).toPrecision(6)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          {model?.parameters.length &&
          !(
            modelType === "modified-ryzhenko-bryzgalin" && mrbMode === "fit"
          ) ? (
            <div className="parameter-grid">
              {model.parameters.map((parameter) => (
                <label key={parameter.name}>
                  <span>
                    {parameter.label}
                    <small>{parameter.help}</small>
                  </span>
                  <div>
                    <input
                      type="number"
                      step="any"
                      value={parameters[parameter.name] ?? ""}
                      onChange={(e) =>
                        setParameters({
                          ...parameters,
                          [parameter.name]: e.target.value,
                        })
                      }
                    />
                    <em>{parameter.unit}</em>
                  </div>
                </label>
              ))}
            </div>
          ) : model?.native ? (
            <p className="empty-note">
              该记录的原生模型参数和来源映射会原样保留；计算时使用已连接
              Reaktoro 的原始数据库记录。
            </p>
          ) : null}
          {model?.calculable && (
            <div className="valid-range">
              <h4>有效温压范围（可选）</h4>
              <label>
                最低温度
                <input
                  type="number"
                  placeholder="K"
                  value={value.valid_tp?.temperature_K?.[0] ?? ""}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      valid_tp: {
                        ...value.valid_tp,
                        temperature_K: [
                          e.target.value,
                          value.valid_tp?.temperature_K?.[1] ?? "",
                        ],
                      },
                    })
                  }
                />
              </label>
              <label>
                最高温度
                <input
                  type="number"
                  placeholder="K"
                  value={value.valid_tp?.temperature_K?.[1] ?? ""}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      valid_tp: {
                        ...value.valid_tp,
                        temperature_K: [
                          value.valid_tp?.temperature_K?.[0] ?? "",
                          e.target.value,
                        ],
                      },
                    })
                  }
                />
              </label>
              <label>
                最低压力
                <input
                  type="number"
                  placeholder="Pa"
                  value={value.valid_tp?.pressure_Pa?.[0] ?? ""}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      valid_tp: {
                        ...value.valid_tp,
                        pressure_Pa: [
                          e.target.value,
                          value.valid_tp?.pressure_Pa?.[1] ?? "",
                        ],
                      },
                    })
                  }
                />
              </label>
              <label>
                最高压力
                <input
                  type="number"
                  placeholder="Pa"
                  value={value.valid_tp?.pressure_Pa?.[1] ?? ""}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      valid_tp: {
                        ...value.valid_tp,
                        pressure_Pa: [
                          value.valid_tp?.pressure_Pa?.[0] ?? "",
                          e.target.value,
                        ],
                      },
                    })
                  }
                />
              </label>
            </div>
          )}
        </section>

        {model?.reaction_based && (
          <section className="editor-section" id="editor-reaction">
            <header>
              <b>3</b>
              <div>
                <h3>形成反应</h3>
                <p>
                  选择组成目标物种的已有物种并填写计量系数。MRB
                  给出该反应的平衡常数，已有物种的标准态性质则用于求目标物种的标准态性质。
                </p>
              </div>
            </header>
            <div className="reaction-equation">
              <span>反应式预览</span>
              <div>
                {reactionRows.length ? (
                  reactionRows.filter(row=>row.coefficient >= 0).map((row, index) => {
                    const species = available.find(
                      (item) => item.name === row.name,
                    );
                    return (
                      <span key={`${row.name}-${index}`}>
                        {index > 0 && <i> + </i>}
                        <b>{row.coefficient || "ν"}</b>
                        {species ? (
                          <ChemicalFormula value={species.formula} />
                        ) : (
                          <em>待选择</em>
                        )}
                      </span>
                    );
                  })
                ) : (
                  <em>请添加形成反应中的已有物种</em>
                )}
                <strong> ⇌ </strong>
                <span className="reaction-target">
                  {formula ? <ChemicalFormula value={formula} /> : "目标物种"}
                </span>
                {reactionRows.filter(row=>row.coefficient < 0).map((row,index)=><span key={index}><i> + </i><b>{Math.abs(row.coefficient) === 1 ? '' : Math.abs(row.coefficient)}</b><ChemicalFormula value={available.find(item=>item.name===row.name)?.formula || row.name || '待选择'}/></span>)}
              </div>
              <small>
                目标物种的系数固定为 1。正系数放在左侧，负系数放在右侧；保存前会检查元素和电荷是否守恒。
              </small>
            </div>
            <div className="reaction-editor">
              {reactionRows.map((row, index) => (
                <div className="reaction-row" key={index}>
                  <div className="reaction-species-search">
                    <label>已有物种</label>
                    <div className="search-box">
                      <Search />
                      <input
                        value={row.query}
                        placeholder="搜索物种名称或化学式"
                        onFocus={() => setActiveReaction(index)}
                        onKeyDown={event=>{if(event.key==='Escape' && activeReaction===index){event.stopPropagation();setActiveReaction(null);}}}
                        onChange={(event) => {
                          const query = event.target.value;
                          setActiveReaction(index);
                          setReactionRows(
                            reactionRows.map((item, current) =>
                              current === index
                                ? { ...item, query, name: "" }
                                : item,
                            ),
                          );
                        }}
                      />
                    </div>
                    {activeReaction === index && (
                      <div className="reaction-species-menu">
                        {available
                          .filter((item) => {
                            const query = row.query.trim().toLowerCase();
                            return (
                              !query ||
                              item.name.toLowerCase().includes(query) ||
                              item.formula.toLowerCase().includes(query)
                            );
                          })
                          .slice(0, 12)
                          .map((item) => (
                            <button
                              type="button"
                              key={item.id || item.name}
                              onClick={() => {
                                setReactionRows(
                                  reactionRows.map((currentRow, current) =>
                                    current === index
                                      ? {
                                          ...currentRow,
                                          name: item.name,
                                          query: item.name,
                                        }
                                      : currentRow,
                                  ),
                                );
                                setActiveReaction(null);
                              }}
                            >
                              <strong>{item.name}</strong>
                              <ChemicalFormula value={item.formula} />
                              <small>{item.state}</small>
                            </button>
                          ))}
                        {!available.some((item) => {
                          const query = row.query.trim().toLowerCase();
                          return (
                            !query ||
                            item.name.toLowerCase().includes(query) ||
                            item.formula.toLowerCase().includes(query)
                          );
                        }) && <p>没有匹配的已有物种。</p>}
                      </div>
                    )}
                    {row.name && (
                      <div className="reaction-selection">
                        <Check />
                        <strong>{row.name}</strong>
                        <ChemicalFormula
                          value={
                            available.find((item) => item.name === row.name)
                              ?.formula || ""
                          }
                        />
                      </div>
                    )}
                  </div>
                  <label className="reaction-coefficient">
                    计量系数
                    <input
                      type="number"
                      step="any"
                      value={row.coefficient}
                      onChange={(e) =>
                        setReactionRows(
                          reactionRows.map((item, i) =>
                            i === index
                              ? { ...item, coefficient: Number(e.target.value) }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    className="danger"
                    onClick={() =>
                      setReactionRows(
                        reactionRows.filter((_, i) => i !== index),
                      )
                    }
                  >
                    删除
                  </button>
                </div>
              ))}
              <button
                className="secondary"
                disabled={!available.length}
                onClick={() =>
                  setReactionRows([
                    ...reactionRows,
                    { name: "", coefficient: 1, query: "" },
                  ])
                }
              >
                <Plus />
                添加已有物种
              </button>
            </div>
          </section>
        )}

        {value.state === "Aqueous" && Number(value.charge) !== 0 && (
          <section className="editor-section" id="editor-activity">
            <header>
              <b>{model?.reaction_based ? 4 : 3}</b>
              <div>
                <h3>水溶液活度参数</h3>
                <p>
                  这是活度系数模型参数，不是标准态热力学模型参数；aᵢ
                  为经验离子尺寸，并非物理半径。
                </p>
              </div>
            </header>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={activityEnabled}
                disabled={Boolean(foreignActivity)}
                title={foreignActivity ? "已有其他活度模型的数据，此编辑器不会覆盖" : ""}
                onChange={(e) => {setActivityTouched(true);setActivityEnabled(e.target.checked);}}
              />
              <span>记录扩展 Debye–Hückel 参数</span>
            </label>
            {foreignActivity && <p className="notice">已记录 {foreignActivity} 活度参数，本次编辑会原样保留。</p>}
            {activityEnabled && (
              <div className="activity-grid">
                <label>
                  适用活度模型
                  <select value="extended-debye-huckel" disabled>
                    <option>Extended Debye–Hückel</option>
                  </select>
                </label>
                <label>
                  离子尺寸 aᵢ
                  <div>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={ionSize}
                      onChange={(e) => {setActivityTouched(true);setIonSize(e.target.value);}}
                    />
                    <em>Å</em>
                  </div>
                </label>
              </div>
            )}
          </section>
        )}

        <section className="editor-section" id="editor-references">
          <header>
            <b>{model?.reaction_based ? 5 : 4}</b>
            <div>
              <h3>来源、参考文献与说明</h3>
              <p>
                直接粘贴完整引用即可。作者、年份等拆分字段只在需要结构化检索时填写；备注只保存内部说明，不参与计算。
              </p>
            </div>
          </header>
          <div className="reference-editor">
            {references.map((reference, index) => (
              <article key={index}>
                <div className="reference-main">
                  <label>
                    完整引用
                    <textarea
                      value={referenceText(reference)}
                      placeholder="例如：Helgeson, H. C. et al. (1981). Thermodynamic properties... Journal..., 45, 123–145. https://doi.org/..."
                      onChange={(event) =>
                        setReferences(
                          references.map((item, row) =>
                            row === index
                              ? { ...item, raw: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    className="danger"
                    onClick={() =>
                      setReferences(references.filter((_, i) => i !== index))
                    }
                  >
                    删除
                  </button>
                </div>
                <details>
                  <summary>可选：拆分为结构化字段</summary>
                  <div className="reference-details">
                    <input
                      placeholder="作者"
                      value={reference.authors || ""}
                      onChange={(event) =>
                        updateReference(index, "authors", event.target.value)
                      }
                    />
                    <input
                      placeholder="年份"
                      value={reference.year || ""}
                      onChange={(event) =>
                        updateReference(index, "year", event.target.value)
                      }
                    />
                    <input
                      className="wide"
                      placeholder="题目"
                      value={reference.title || ""}
                      onChange={(event) =>
                        updateReference(index, "title", event.target.value)
                      }
                    />
                    <input
                      placeholder="期刊 / 出版物"
                      value={reference.journal || ""}
                      onChange={(event) =>
                        updateReference(index, "journal", event.target.value)
                      }
                    />
                    <input
                      placeholder="卷(期)"
                      value={reference.volume || ""}
                      onChange={(event) =>
                        updateReference(index, "volume", event.target.value)
                      }
                    />
                    <input
                      placeholder="页码"
                      value={reference.pages || ""}
                      onChange={(event) =>
                        updateReference(index, "pages", event.target.value)
                      }
                    />
                    <input
                      className="wide"
                      placeholder="DOI"
                      value={reference.doi || ""}
                      onChange={(event) =>
                        updateReference(index, "doi", event.target.value)
                      }
                    />
                  </div>
                </details>
              </article>
            ))}
            <button
              className="secondary"
              onClick={() => setReferences([...references, { raw: "" }])}
            >
              <Plus />
              添加参考文献
            </button>
          </div>
          <label className="field-label">
            备注（可选）
            <textarea
              value={value.notes || ""}
              onChange={(e) => setValue({ ...value, notes: e.target.value })}
              placeholder="记录数据处理、适用条件或待核查事项；不参与计算。"
            />
          </label>
          {existing?.disabled && (
            <div className="notice">
              <strong>这是尚未启用的草稿</strong>
              <p>
                原记录因模型未知或参数不完整而被禁用。选择一个可创建模型并补齐参数后，保存时才会恢复为可计算记录。
              </p>
            </div>
          )}
        </section>
      </div>
      <div className="modal-actions editor-actions">
        <span>{changed ? '保存物种后，还需保存数据库文件' : '物种编辑表单'}</span>
        <button className="secondary" onClick={cancel}>
          取消
        </button>
        <button
          className="primary"
          disabled={
            saving || !definitions.length || !value.name || !formula || !model
          }
          onClick={submit}
        >
          {saving ? "正在校验并保存…" : "保存物种"}
        </button>
      </div>
    </Modal>
  );
}

function ComposeWizard({
  catalog,
  initial,
  target,
  defaultDirectory,
  onClose,
  onCreated,
}: {
  catalog: Catalog[];
  initial: Summary | null;
  target?: Summary | null;
  defaultDirectory?: string;
  onClose: () => void;
  onCreated: (s: Summary) => void;
}) {
  const [step, setStep] = useState(1);
  const [sources, setSources] = useState<Catalog[]>(
    initial
      ? catalog.filter(
          (x) =>
            x.group === initial.group &&
            x.embedded_name === initial.embedded_name,
        )
      : [],
  );
  const [handles, setHandles] = useState<Record<string, Summary>>(
    initial ? { [`${initial.group}:${initial.embedded_name}`]: initial } : {},
  );
  const [active, setActive] = useState("");
  const [rows, setRows] = useState<Species[]>([]);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [path, setPath] = useState("");
  const operation = useOperation();
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [elements, setElements] = useState<string[]>([]);
  const [showElements, setShowElements] = useState(false);
  const [stateFilter, setStateFilter] = useState("All");
  const [modelFilter, setModelFilter] = useState("All");
  const [facets,setFacets] = useState<{states:string[];models:string[]}>({states:[],models:[]});
  const loadSequence = useRef(0);
  const ownedHandles = useRef<string[]>([]);
  useEffect(() => () => { loadSequence.current++; for(const handleId of ownedHandles.current) api("database_close",{handleId,discard:true}).catch(() => {}); }, []);
  const key = (x: Catalog) => `${x.group}:${x.embedded_name}`;
  const openSources = async () => {
    const next = { ...handles };
    for (const source of sources) {
      if (!next[key(source)]) {
        next[key(source)] = (
          await api<{ summary: Summary }>("database_open", {
            group: source.group,
            name: source.embedded_name,
          })
        ).summary;
        ownedHandles.current.push(next[key(source)].handle_id);
      }
    }
    setHandles(next);
    const first = key(sources[0]);
    setActive(first);
    setStep(2);
    await load(next[first], query, 0);
  };
  const load = async (h: Summary, q: string, at = 0) => {
    if(!h) return;
    const seq = ++loadSequence.current;
    const r = await api<{ items: Species[];total:number;states:string[];models:string[] }>("species_page", {
      handleId: h.handle_id,
      offset: at,
      limit: 100,
      query: q,
      stateFilter,
      charge: null,
      modelFilter,
      elements,
    });
    if(seq !== loadSequence.current) return;
    setRows(r.items);
    setOffset(at); setTotal(r.total); setFacets({states:r.states,models:r.models});
  };
  useEffect(() => { if(step !== 2 || !handles[active]) return; const timer=setTimeout(() => { load(handles[active],query,0).catch(error => alert(errText(error))); },180); return () => {clearTimeout(timer); loadSequence.current++;}; }, [query,active,stateFilter,modelFilter,elements.join("|")]);
  const selections = () =>
    sources.map((x) => ({
      handle_id: handles[key(x)].handle_id,
      names: chosen[key(x)] || [],
    }));
  const makePreview = async () => {
    const p = await api<any>("compose_preview", { selections: selections(), targetHandleId: target?.handle_id });
    setPreview(p);
    setStep(3);
  };
  return (
    <Modal title={target ? `向“${label(target)}”添加内置物种` : "从 Reaktoro 内置数据库创建"} onClose={onClose} wide {...operation}>
      <div className="wizard-steps">
        <span className={step === 1 ? "active" : ""}>1 选择数据库</span>
        <span className={step === 2 ? "active" : ""}>2 选择物种</span>
        <span className={step === 3 ? "active" : ""}>3 预览并创建</span>
      </div>
      {step === 1 && (
        <div className="source-grid">
          {catalog.map((x) => (
            <label key={x.id}>
              <input
                type="checkbox"
                checked={sources.some((s) => s.id === x.id)}
                onChange={(e) =>
                  setSources(
                    e.target.checked
                      ? [...sources, x]
                      : sources.filter((s) => s.id !== x.id),
                  )
                }
              />
              <span>
                <strong>{x.embedded_name}</strong>
                <small>
                  {x.group} · {x.species_count} 物种
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      {step === 2 && (
        <>
          <div className="compose-toolbar">
            <select
              value={active}
              onChange={(e) => {
                setActive(e.target.value);
              }}
            >
              {sources.map((x) => (
                <option key={key(x)} value={key(x)}>{x.embedded_name}</option>
              ))}
            </select>
            <label className="search-box">
              <Search />
              <input
                value={query}
                placeholder="搜索名称、化学式或模型"
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
              />
            </label>
          </div>
          <div className="filter-row">
            <select aria-label="选择物种相态" value={stateFilter} onChange={e => setStateFilter(e.target.value)}><option value="All">全部相态</option>{facets.states.map(s => <option key={s} value={s}>{stateLabel(s)}</option>)}</select>
            <select aria-label="选择物种模型" value={modelFilter} onChange={e => setModelFilter(e.target.value)}><option value="All">全部模型</option>{facets.models.map(s => <option key={s}>{s}</option>)}</select>
            <button className="secondary" onClick={() => setShowElements(!showElements)}>元素筛选{elements.length ? ` (${elements.length})` : ""}</button>
          </div>
          {showElements && <PeriodicTable selected={elements} onChange={setElements} />}
          <div className="compose-species">
            {rows.map((x) => (
              <label key={`${x.name}-${x.fingerprint}`}>
                <input
                  type="checkbox"
                  checked={(chosen[active] || []).includes(x.name)}
                  onChange={(e) =>
                    setChosen({
                      ...chosen,
                      [active]: e.target.checked
                        ? [...(chosen[active] || []), x.name]
                        : (chosen[active] || []).filter((n) => n !== x.name),
                    })
                  }
                />
                <span>
                  <strong>{x.name}</strong>
                  <ChemicalFormula value={x.formula} />
                </span>
                <small>
                  {x.state} · {x.model}
                </small>
              </label>
            ))}
          </div>
          <div className="table-footer"><span>{total ? offset+1 : 0}–{Math.min(offset+rows.length,total)} / {total} · 已选 {Object.values(chosen).reduce((n,x) => n+x.length,0)} 个</span><span><button disabled={!offset} onClick={() => operation.run(() => load(handles[active],query,offset-100))}>上一页</button><button disabled={offset+rows.length>=total} onClick={() => operation.run(() => load(handles[active],query,offset+100))}>下一页</button></span></div>
        </>
      )}
      {step === 3 && preview && (
        <>
          <div
            className={`preview-status ${preview.can_commit ? "valid" : "invalid"}`}
          >
            <strong>{preview.can_commit ? "可以创建" : "不能创建"}</strong>
            <span>
              {preview.records.length} 个物种（含 {preview.dependency_count}{" "}
              个必需物种）· {preview.rename_decisions.length} 个来源重命名
            </span>
          </div>
          {preview.missing_dependencies.length > 0 && (
            <DependencyReport issues={preview.missing_dependencies} />
          )}
          {preview.cycles.length > 0 && <div className="inline-error">{preview.cycles.map((chain:string[],i:number) => <p key={i}>反应循环：{chain.join(" → ")}</p>)}</div>}
          {preview.rename_decisions.length > 0 && <details className="report-list"><summary>查看重命名 ({preview.rename_decisions.length})</summary>{preview.rename_decisions.map((x:any,i:number) => <p key={i}>{x.original_name} → {x.resolved_name}</p>)}</details>}
          {!target && <>
          <p className="modal-copy">
            数据库名称将使用最终保存的 .rtdb
            文件名。
          </p>
          <div className="field-label">
            <label htmlFor="compose-db-path">保存位置</label>
            <div className="path-picker">
              <input id="compose-db-path" readOnly value={path} />
              <button
                className="secondary"
                onClick={() => operation.run(async () => {
                    setPath(await api("pick_path", { kind: "save_rtdb", defaultDirectory }));
                })}
              >
                选择…
              </button>
            </div>
          </div>
          </>}
        </>
      )}
      <div className="modal-actions">
        {step > 1 && (
          <button className="secondary" onClick={() => setStep(step - 1)}>
            上一步
          </button>
        )}
        <span className="grow" />
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        {step === 1 && (
          <button
            className="primary"
            disabled={!sources.length}
            onClick={() => operation.run(openSources)}
          >
            下一步
          </button>
        )}
        {step === 2 && (
          <button
            className="primary"
            disabled={!Object.values(chosen).some((x) => x.length)}
            onClick={() => operation.run(makePreview)}
          >
            计算依赖并预览
          </button>
        )}
        {step === 3 && (
          <button
            className="primary"
            disabled={!preview.can_commit || (!target && !path)}
            onClick={() => operation.run(async () => {
              const r = await api<{ summary: Summary }>("compose_commit", {
                selections: selections(),
                path,
                targetHandleId:target?.handle_id,
              });
              onCreated(r.summary);
            })}
          >
            {target ? "添加到当前数据库" : "创建 .rtdb"}
          </button>
        )}
      </div>
    </Modal>
  );
}

export function DependencyReport({issues}:{issues:any[]}) {
  return <div className="report-list dependency-report">{issues.map((issue,index)=><article key={index}>
    <strong>{Array.isArray(issue) ? '形成反应存在循环' : issue.code === 'AMBIGUOUS_DEPENDENCY' ? '同名物种来源不明确' : issue.message || `缺少必需物种：${issue.dependency || issue.species || ''}`}</strong>
    {(Array.isArray(issue) || issue.chain) && <p>{(Array.isArray(issue) ? issue : issue.chain).join(' → ')}</p>}
    {issue.candidates?.length > 0 && <p>候选来源：{issue.candidates.join('；')}。请在源数据库中明确引用或区分名称后重试。</p>}
  </article>)}</div>;
}
export function ImportDialog({
  summary,
  onClose,
  onDone,
}: {
  summary: Summary;
  onClose: () => void;
  onDone: (updated:Summary) => void | Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [checked, setChecked] = useState("");
  const operation = useOperation();
  const choose = async (
    kind: "import_yaml" | "import_rtdb" | "import_folder",
  ) => {
    await operation.run(async () => {
      const selectedPath = await api<string>("pick_path", { kind });
      setPath(selectedPath);
      setPreview(null); setChecked("");
      const report = await api<any>("import_preview", {
          handleId: summary.handle_id,
          path: selectedPath,
        });
      setPreview(report);
      const fingerprints = report.items.map((x:any) => x.fingerprint);
      setSelected(fingerprints); setChecked(JSON.stringify(fingerprints));
    });
  };
  return (
    <Modal title="添加已有物种" onClose={onClose} {...operation} wide>
      <p className="modal-copy">
        选择 Reaktoro YAML、其他 .rtdb，或已转换且包含 YAML / records.json
        的扩展数据库文件夹。源文件不会被修改，也不会执行其中的 Python。
      </p>
      <div className="button-row">
        <button className="secondary" onClick={() => choose("import_yaml")}>
          <FolderOpen />
          Reaktoro YAML
        </button>
        <button className="secondary" onClick={() => choose("import_rtdb")}>
          <Database />
          其他 .rtdb
        </button>
        <button className="secondary" onClick={() => choose("import_folder")}>
          <FolderOpen />
          扩展数据库文件夹
        </button>
      </div>
      {preview && (
        <>
          <div
            className={`preview-status ${preview.can_commit ? "valid" : "invalid"}`}
          >
            <strong>{preview.can_commit ? "可以导入" : "导入被阻止"}</strong>
            <span>
              {preview.items.length} 个新物种 · 复用 {preview.reused_count} 个 ·{" "}
              {preview.rename_decisions.length} 个重命名
            </span>
          </div>
          <div className="button-row"><button className="secondary" onClick={() => setSelected(preview.items.map((x:any) => x.fingerprint))}>全选</button><button className="secondary" onClick={() => setSelected([])}>清除选择</button><span>已选 {selected.length} 个物种</span></div>
          <div className="compose-species">{preview.items.map((item:any) => <label key={item.fingerprint}><input type="checkbox" checked={selected.includes(item.fingerprint)} onChange={e => setSelected(e.target.checked ? [...selected,item.fingerprint] : selected.filter(x => x !== item.fingerprint))} /><span><strong>{item.name}</strong><ChemicalFormula value={item.formula} /></span></label>)}</div>
          {checked !== JSON.stringify(selected) && <p className="modal-copy">选择已改变，请先检查所选物种；必需的已有物种会自动加入。</p>}
          {preview.dependency_count > 0 && <p className="modal-copy">将自动加入 {preview.dependency_count} 个必需物种。</p>}
          {!preview.can_commit && (
            <DependencyReport issues={[...preview.missing_dependencies, ...preview.cycles, ...(preview.issues || [])]} />
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="secondary" disabled={!preview || !selected.length} onClick={() => operation.run(async () => { const report = await api<any>("import_preview",{handleId:summary.handle_id,path,fingerprints:selected}); setPreview(report); setChecked(JSON.stringify(selected)); })}>检查所选物种</button>
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={!preview?.can_commit || !selected.length || checked !== JSON.stringify(selected)}
          onClick={() => operation.run(async () => {
            const result=await api<{summary:Summary;success:boolean}>("import_commit", {
              handleId: summary.handle_id,
              path,
              fingerprints: selected,
              sourceRevision: preview.source_revision,
            });
            if(result.success !== true || !result.summary) throw new Error("后端未确认导入完成。");
            await onDone(result.summary);
          })}
        >
          添加所选物种
        </button>
      </div>
    </Modal>
  );
}
export function ExportDialog({
  summary,
  defaultDirectory,
  onClose,
  onDone,
}: {
  summary: Summary;
  defaultDirectory?: string;
  onClose: () => void;
  onDone: (x: any) => void;
}) {
  const [kind, setKind] = useState<"native" | "interpolation">(summary.native_exportable_count === 0 ? "interpolation" : "native");
  const operation = useOperation();
  const {busy} = operation;
  const [grid,setGrid] = useState({tMin:"25",tMax:"300",tCount:"12",pMin:"1",pMax:"100",pCount:"5",tolerance:"5"});
  const run = async () => {
    await operation.run(async () => {
      const axis = (min:string,max:string,count:string,scale:number,shift=0) => {
        const lo=Number(min), hi=Number(max), n=Number(count);
        if(!min.trim() || !max.trim() || !Number.isFinite(lo) || !Number.isFinite(hi) || lo>=hi || !Number.isInteger(n) || n<2 || n>100 || (lo+shift)*scale<=0) throw new Error("温压下限必须小于上限，温度高于绝对零度、压力大于 0；每轴点数应为 2–100 的整数。");
        return Array.from({length:n},(_,i) => (lo+(hi-lo)*i/(n-1)+shift)*scale);
      };
      const temperaturesK = kind === "interpolation" ? axis(grid.tMin,grid.tMax,grid.tCount,1,273.15) : [];
      const pressuresPa = kind === "interpolation" ? axis(grid.pMin,grid.pMax,grid.pCount,100000) : [];
      const tolerance = Number(grid.tolerance)/100;
      if(kind === "interpolation" && (!Number.isFinite(tolerance) || tolerance<=0 || tolerance>1)) throw new Error("误差容限必须大于 0% 且不超过 100%。");
      const path = await api<string>("pick_path", {
        kind: "export_yaml",
        defaultDirectory,
      });
      const report =
        kind === "native"
          ? await api("export_native_yaml", {
              handleId: summary.handle_id,
              path,
            })
          : await api("export_interpolation", {
              handleId: summary.handle_id,
              path,
              temperaturesK,
              pressuresPa,
              tolerance,
            });
      onDone(report);
    });
  };
  return (
    <Modal title="导出数据库" onClose={onClose} {...operation}>
      <label className="choice">
        <input
          type="radio"
          checked={kind === "native"}
          disabled={summary.native_exportable_count === 0}
          onChange={() => setKind("native")}
        />
        <span>
          <strong>Native Reaktoro YAML</strong>
          <small>{summary.native_exportable_count === 0 ? "当前记录缺少可序列化的完整原生模型或形成反应，无法原生导出；不会用零值补造参数。" : `仅导出原生可表达记录${summary.native_exportable_count !== undefined ? `（${summary.native_exportable_count} 个）` : ""}，并由 Reaktoro 重新加载验证。`}</small>
        </span>
      </label>
      <label className="choice">
        <input
          type="radio"
          checked={kind === "interpolation"}
          onChange={() => setKind("interpolation")}
        />
        <span>
          <strong>Interpolation YAML</strong>
          <small>
            按指定温压网格真实采样，并用 Reaktoro 在网格中点重新加载核对。超出容限不会生成文件。
          </small>
        </span>
      </label>
      {kind === "interpolation" && <div className="parameter-grid">{([['tMin','温度下限 (°C)'],['tMax','温度上限 (°C)'],['tCount','温度点数'],['pMin','压力下限 (bar)'],['pMax','压力上限 (bar)'],['pCount','压力点数'],['tolerance','归一化误差容限 (%)']] as const).map(([key,label]) => <label key={key}>{label}<input type="number" value={grid[key]} onChange={e => setGrid({...grid,[key]:e.target.value})}/></label>)}</div>}
      {kind === "interpolation" && <p className="modal-copy">误差按 |插值值 − 模型值| / max(1, |模型值|) 逐项检查（SI 单位）；中点检验不保证网格内每一点均满足容限。只有完整提供所需标准性质的物种才参与导出。</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={busy} onClick={run}>
          {busy ? "正在采样与验证…" : "选择位置并导出"}
        </button>
      </div>
    </Modal>
  );
}
