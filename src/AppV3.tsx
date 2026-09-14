import {translateDatabaseMessage} from './i18n-database-errors';
import {translateModelMessage} from './i18n-models';
import {t,useLanguage,setLanguage,normalizeLanguage} from './i18n';
import {DEFAULT_TRIAL_TP,TrialConditions,readTrialTP,ReadableNumber,readingNumber,type TrialTP} from './database-reading';
import {DatabaseSwitcher} from './DatabaseSwitcher';
import {historyDatabase} from './simulation-history';
import { useEffect, useMemo, useRef, useState } from "react";
import {version as APP_VERSION} from "../package.json";
import {createPortal} from "react-dom";
import {HelpTip} from "./HelpTip";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  Activity,
  PanelLeft,
  ChartNoAxesCombined,
  Sun,
  Moon,
  Atom,
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
  Lock,
  MonitorCog,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Settings,
  History,
  Trash2,
  X,
} from "lucide-react";
import { ChemicalFormula, ELEMENTS, PeriodicTable, ElementChooser } from "./chemistry";
import {ConfirmDialog} from "./ConfirmDialog";
import {DirectorySetting} from "./WorkbenchSettings";
import {SimulationPreferences,ResultPreferences,SIMULATION_DEFAULTS,RESULT_DEFAULTS,simulationPreferences,resultPreferences} from "./workbench-preferences";
import {HistoryDatabase,HistoryEntry,historyList,activeHistoryKey,databaseKey} from "./simulation-history";
import SimulationWorkbench from "./Simulation";
import {userMessage} from './user-messages';

type Page = "home" | "databases" | "simulation" | "results" | "settings";
type Theme = "system" | "light" | "dark";
type Runtime = {
  reconnected?: boolean;
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
  startup: "home"|"databases"|"simulation"|"results";
  auto_save_simulations?:boolean;
  simulation:SimulationPreferences;
  results:ResultPreferences;
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
  simulation:SIMULATION_DEFAULTS,
  results:RESULT_DEFAULTS,
  recent_databases: [],
};
export function normalizePreferences(raw: unknown): Preferences {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string,any> : {};
  const recent = Array.isArray(input.recent_databases) ? input.recent_databases : [];
  const next:Preferences = {...DEFAULTS, theme:["light","dark","system"].includes(input.theme) ? input.theme : "system", density:input.density === "compact" ? "compact" : "comfortable", recent_databases:recent.filter(x => x && typeof x.path === "string" && /\.rtdb$/i.test(x.path)).map(x=>({...x,name:localDatabaseName(x.path),opened_at:typeof x.opened_at === "string" ? x.opened_at : ""}))};
  for(const key of ["runtime_path","save_directory","export_directory","powered_by","github_url"] as const) if(typeof input[key] === "string") next[key]=input[key];
  next.language=normalizeLanguage(input.language);
  next.startup=["home","databases","simulation","results"].includes(input.startup)?input.startup:"home";
  next.auto_save_simulations=input.auto_save_simulations!==false;
  next.simulation=simulationPreferences(input.simulation);next.results=resultPreferences(input.results);
  const d=input.default_database;
  if(d?.kind === "rtdb" && typeof d.path === "string" && /\.rtdb$/i.test(d.path)) next.default_database={kind:"rtdb",path:d.path};
  if(d?.kind === "official" && ["PHREEQC","SUPCRT","NASA"].includes(d.group) && typeof d.name === "string") next.default_database={kind:"official",group:d.group,name:d.name};
  return next;
}
const STANDARD_TP = DEFAULT_TRIAL_TP;
const dialogDefault = (directory: string | undefined, filename?: string) =>
  directory
    ? `${directory.replace(/\/+$/, "")}${filename ? `/${filename}` : ""}`
    : filename;
const pickPath = async (kind: string, defaultDirectory?: string) => {
  let result: string | null | string[];
  if (kind === "save_rtdb")
    result = await saveDialog({
      title: t("保存 EasyReaktoro 数据库", "Save EasyReaktoro database"),
      defaultPath: dialogDefault(defaultDirectory, "database.rtdb"),
      filters: [{ name: t("EasyReaktoro 数据库", "EasyReaktoro database"), extensions: ["rtdb"] }],
    });
  else if (kind === "export_yaml")
    result = await saveDialog({
      title: t("导出 Reaktoro YAML", "Export Reaktoro YAML"),
      defaultPath: dialogDefault(defaultDirectory, "database.yaml"),
      filters: [{ name: "YAML", extensions: ["yaml", "yml"] }],
    });
  else if (kind === "runtime_folder")
    result = await openDialog({
      title: t("选择 Reaktoro 或 Conda 环境文件夹", "Choose a Reaktoro or Conda environment folder"),
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "import_folder")
    result = await openDialog({
      title: t("选择已转换的扩展 Reaktoro 数据库文件夹", "Choose a converted extended Reaktoro database folder"),
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "save_folder")
    result = await openDialog({
      title: t("选择默认保存位置", "Choose the default save location"),
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "export_folder")
    result = await openDialog({
      title: t("选择默认导出位置", "Choose the default export location"),
      directory: true,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "runtime_file")
    result = await openDialog({
      title: t("选择 Reaktoro 环境中的 Python 可执行文件", "Choose the Python executable in your Reaktoro environment"),
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
    });
  else if (kind === "import_yaml")
    result = await openDialog({
      title: t("选择 Reaktoro YAML 文件", "Choose a Reaktoro YAML file"),
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
      filters: [{ name: "YAML", extensions: ["yaml", "yml"] }],
    });
  else if (kind === "import_rtdb")
    result = await openDialog({
      title: t("从其他 EasyReaktoro 数据库添加", "Add from another EasyReaktoro database"),
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
      filters: [{ name: t("EasyReaktoro 数据库", "EasyReaktoro database"), extensions: ["rtdb"] }],
    });
  else
    result = await openDialog({
      title: t("打开 EasyReaktoro 数据库", "Open EasyReaktoro database"),
      directory: false,
      multiple: false,
      defaultPath: defaultDirectory,
      filters: [{ name: t("EasyReaktoro 数据库", "EasyReaktoro database"), extensions: ["rtdb"] }],
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
     : invoke<T>(command, args).catch(error=>{
      if(/BRIDGE_UNRESPONSIVE|BRIDGE_PROTOCOL/.test(String(error)))window.dispatchEvent(new CustomEvent('easyreaktoro:connection-lost',{detail:error}));
      throw error;
    });
const label = (summary: Summary | null) =>
  summary?.embedded_name || summary?.path?.split("/").pop() || t("数据库", "Database");
const errText = (error:unknown) => translateDatabaseMessage(userMessage(error));

export default function AppV3() {
  useLanguage();
  const [page, setPage] = useState<Page>("home");
  const [simulationOpened, setSimulationOpened] = useState(false);
  const [lastSimulation,setLastSimulation]=useState<HistoryEntry|null>(null);
  useEffect(()=>{
    if(page!=="home")return;
    let cancelled=false;
    historyList().then(result=>{if(cancelled)return;const entries=Array.isArray(result.entries)?result.entries:[],activeId=localStorage.getItem('easyreaktoro.simulation.active');setLastSimulation(entries.find(entry=>entry.id===activeId)||entries[0]||null);}).catch(()=>{if(!cancelled)setLastSimulation(null);});
    return()=>{cancelled=true;};
  },[page]);
  const [drawer,setDrawer]=useState(false);
  const [workbenchToolbar,setWorkbenchToolbar]=useState<HTMLDivElement|null>(null);
  const simulationRunning = useRef(false);
  useEffect(()=>setDrawer(false),[page]);
  useEffect(()=>{if(!drawer)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setDrawer(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[drawer]);
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  useEffect(()=>setLanguage(prefs.language),[prefs.language]);
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
  const currentSelected=useRef(selected);currentSelected.current=selected;
  const [details, setDetails] = useState<Details | null>(null);
  const [detailsError,setDetailsError]=useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({
    state: "All",
    model: "All",
    elements: [] as string[],
  });
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [settingsTab, setSettingsTab] = useState<
    "general" | "database" | "simulation" | "results" | "runtime" | "about"
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
  const [simulationActive,setSimulationActive]=useState(false),[composeForSimulation,setComposeForSimulation]=useState(false);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");
  const toastNeedsAttention = /失败|无法|不能|未确认|请输入|超出|无效|未被覆盖|暂时|未保存/.test(toast);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [tp, setTp] = useState<TrialTP>(STANDARD_TP);
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusyState] = useState(false);
  const busyRef=useRef(false);
  const setBusy=(next:boolean)=>{busyRef.current=next;setBusyState(next);};
  const [periodicDraft,setPeriodicDraft]=useState<string[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError,setRowsError]=useState("");
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
  const editorExit=useRef<null|(()=>void)>(null);
  const [exitSaveError,setExitSaveError]=useState('');
  const preferenceQueue = useRef(Promise.resolve());
  const guard = async (action: () => Promise<void> | void) => {
    try{const flush=(window as any).__easyreaktoroFlushSimulation;if(flush&&await flush()===false)return;}catch(error){setToast(t("模拟尚未保存：", "Simulation has not been saved: ")+errText(error));return;}
    if (currentSummary.current?.dirty) { pendingAction.current = action; setDialog("close"); return; }
    await action();
  };

  const savePrefs = (next: Preferences) => {
    currentPrefs.current=next;
    setPrefs(next);
    preferenceQueue.current = preferenceQueue.current.then(() => api("settings_save", { settings: next })).then(() => {}).catch((error) =>
      setToast(t(`设置保存失败：${errText(error)}`, `Could not save settings: ${errText(error)}`)),
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
      return false;
    }
    setCatalogState("loading");
    try {
      const result = await api<{ entries: Catalog[] }>("catalog_list");
      setCatalog(result.entries);
      setCatalogState("ready");
      return true;
    } catch (error) {
      setCatalog([]);
      setCatalogState("error");
      setToast(t(`系统数据库目录加载失败：${errText(error)}`, `Could not load the system database catalog: ${errText(error)}`));
      return false;
    }
  };
  const probe = async (settings = prefs) => {
    if(simulationRunning.current) {setToast(t("请先停止模拟或等待完成，再重新连接 Reaktoro 环境。", "Stop the simulation or wait for it to finish before reconnecting Reaktoro."));return;}
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
      } catch { setToast(t("设置无法读取，已使用默认设置启动；原设置文件未被覆盖。", "Settings could not be read. The app started with defaults; your settings file has not been overwritten.")); }
      try { loaded = await validRecents(loaded); }
      catch(error) { setToast(t(`最近文件暂时无法检查：${errText(error)}`, `Recent files could not be checked: ${errText(error)}`)); }
      setPrefs(loaded);
      document.documentElement.dataset.theme = loaded.theme;
      document.documentElement.dataset.density = loaded.density;
      await probe(loaded);
      if(loaded.startup!=="home"){
        const destination=loaded.startup;setSimulationOpened(destination==="simulation"||destination==="results");setPage(destination);
        if(destination==="results")return;
        let database=loaded.default_database;
        if(destination==="simulation"){try{const entries=(await historyList()).entries,activeId=localStorage.getItem('easyreaktoro.simulation.active'),latest=entries.find(e=>e.id===activeId)||entries[0];if(latest){localStorage.setItem(activeHistoryKey(databaseKey(latest.database)||""),latest.id);database=latest.database.kind==="rtdb"?{kind:"rtdb",path:latest.database.path!}:{kind:"official",group:latest.database.group!,name:latest.database.name};}}catch{}}
        if(database){try{const result=await api<{summary:Summary}>(database.kind==="rtdb"?"rtdb_open":"database_open",database.kind==="rtdb"?{path:database.path}:{group:database.group,name:database.name});acceptSummary(result.summary);setPage(destination);}catch(error){setToast(t("启动时未能打开数据库：", "Could not open the database at startup: ")+errText(error));setLibraryVisible(true);if(destination==="simulation"){setDatabaseIntent("simulation");setPage("databases");}}}
        else if(destination==="simulation"){setDatabaseIntent("simulation");setLibraryVisible(true);setPage("databases");}
      }
    })();
  }, []);
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;
    listen("easyreaktoro:request-exit", () => { getCurrentWindow().close().catch(error => setToast(errText(error))); }).then(off => { if(disposed) off(); else unlistenQuit=off; }).catch(() => {});
    getCurrentWindow().onCloseRequested(async (event) => {
      if(simulationRunning.current) { event.preventDefault();setPage("simulation");setToast(t("模拟正在运行，请先停止计算或等待完成，再退出应用。", "The simulation is running. Stop it or wait for it to finish before quitting."));return; }
      if(busyRef.current) { event.preventDefault(); setToast(t("操作正在进行，请完成后再退出。", "An operation is in progress. Wait for it to finish before quitting.")); return; }
      if (editorExit.current) {event.preventDefault();editorExit.current();return;}
      if (currentDialog.current && currentDialog.current !== "close") {setDialog(null);}
      const saves=(window as any).__easyreaktoroFlushSimulation as undefined|(()=>Promise<boolean|void>);
      if(saves){event.preventDefault();try{if(await saves()===false)return;}catch(error){setExitSaveError(errText(error));return;}
        if(!currentSummary.current?.dirty){await getCurrentWindow().destroy();return;}}

      if (currentSummary.current?.dirty) {
        event.preventDefault();
        pendingAction.current = async () => { await getCurrentWindow().destroy(); };
        setDialog("close");
      }
    }).then((off) => { if (disposed) off(); else unlisten = off; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); unlistenQuit?.(); };
  }, []);
  useEffect(() => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.theme = prefs.theme;
    document.documentElement.dataset.density = prefs.density;
  }, [prefs.theme, prefs.density]);
  useEffect(() => {
    if (!toast || toastNeedsAttention) return;
    const id = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const refresh = () => {void refreshSummary().catch(error=>setToast(t(`刷新失败：${errText(error)}`, `Could not refresh: ${errText(error)}`)));};
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

  useEffect(()=>{
    const lost=(event:Event)=>setRuntime(old=>({...old,status:'error',available:false,diagnostic:errText((event as CustomEvent).detail)}));
    window.addEventListener('easyreaktoro:connection-lost',lost);
    return ()=>window.removeEventListener('easyreaktoro:connection-lost',lost);
  },[]);
  const discover = async () => {
    if(busyRef.current||discovering)return;
    if(simulationRunning.current){setToast(t("请先停止模拟或等待完成，再检查 Reaktoro 连接。", "Stop the simulation or wait for it to finish before checking the Reaktoro connection."));return;}
    setDiscovering(true);
    try {
      const checked = await api<Runtime>('runtime_probe');
      setRuntime(checked);
      if(checked.reconnected){
        const unsaved=currentSummary.current?.dirty;
        currentSummary.current=null;currentSelected.current=null;
        request.current++;detailRequest.current++;evaluationRequest.current++;
        setSummary(null);setRows([]);setRowsLoading(false);setRowsError('');setTotal(0);setOffset(0);
        setSelected(null);setDetails(null);setDetailsError('');setEvaluation(null);setValidation(null);setDiagnostics(null);
        setLibraryVisible(true);
        setToast(unsaved?t("已重新连接。请重新打开数据库；连接中断前未保存的数据库修改已无法恢复。", "Reconnected. Reopen your database; database changes not saved before the connection was lost cannot be recovered."):t("已重新连接 Reaktoro，请重新打开数据库。", "Reconnected to Reaktoro. Reopen your database to continue."));
      }
      const catalogReady=await loadCatalog(checked);
      const r = await api<{ entries: Candidate[] }>('runtime_discover');
      const ready = (Array.isArray(r.entries)?r.entries:[]).filter(x=>x.available);
      setCandidates(ready);
      if(!checked.reconnected&&(!checked.available||catalogReady))setToast(checked.available?t(`Reaktoro ${checked.version} 连接正常。`, `Reaktoro ${checked.version} is connected.`):ready.length?t(`发现 ${ready.length} 个可用环境，请选择要连接的环境。`, `Found ${ready.length} available environments. Choose one to connect.`):t("尚未连接 Reaktoro，请选择安装位置。", "Reaktoro is not connected. Choose its installation location."));
    } catch (error) {
      setToast(t(`检测失败：${errText(error)}`, `Detection failed: ${errText(error)}`));
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
    if(simulationRunning.current) {setToast(t("请先停止模拟或等待完成，再切换 Reaktoro 环境。", "Stop the simulation or wait for it to finish before switching Reaktoro environments."));return;}
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
      setToast(t(`已连接 Reaktoro ${result.version}`, `Connected to Reaktoro ${result.version}`));
      } catch (error) { setToast(t(`连接失败，原数据库保持打开：${errText(error)}`, `Connection failed; your database remains open: ${errText(error)}`)); }
      finally { setBusy(false); }
      });
    } catch (error) {
      if (!String(error).includes("cancelled"))
        setToast(t(`连接失败：${errText(error)}`, `Connection failed: ${errText(error)}`));
    }
  };
  const loadRows = async (at = offset) => {
    if (!summary) return;
    const seq = ++request.current;
    setRowsLoading(true);setRowsError("");
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
      const current=currentSelected.current;
      const matched=current&&result.items.find(x=>current.id?x.id===current.id:x.name===current.name);
      if (!matched) {
        if(result.items.length)void selectSpecies(result.items[0]);
        else {currentSelected.current=null;setSelected(null);setDetails(null);setDetailsError("");detailRequest.current++;evaluationRequest.current++;setEvaluation(null);}
      } else if(matched.fingerprint!==current?.fingerprint || matched.name!==current?.name || matched.formula!==current?.formula || matched.model!==current?.model) {
        void selectSpecies(matched);
      }
    } catch (error) {
      if (seq === request.current) {
        setRowsError(t(`species 列表未能读取：${errText(error)}`, `Could not load the species list: ${errText(error)}`));setRows([]);setTotal(0);setOffset(0);
        currentSelected.current=null;setSelected(null);setDetails(null);setDetailsError("");detailRequest.current++;evaluationRequest.current++;setEvaluation(null);
      }
    } finally { if(seq === request.current) setRowsLoading(false); }
  };
  const loadRowsRef=useRef(loadRows);loadRowsRef.current=loadRows;
  useEffect(() => {
    if(summary)setRowsLoading(true);
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
  const [databaseIntent,setDatabaseIntent]=useState<'browse'|'simulation'>('browse');
  useEffect(()=>{if(page!=='databases')setDatabaseIntent('browse');},[page]);
  const chooseSimulationDatabase=()=>{setDatabaseIntent('simulation');setLibraryVisible(true);setPage('databases');};
  const enterSimulation=()=>{setSimulationOpened(true);if(summary)setPage('simulation');else chooseSimulationDatabase();};
  const showSimulationHistory=()=>{(window as any).__easyreaktoroShowSimulationHistory=true;setSimulationOpened(true);setPage('simulation');window.dispatchEvent(new Event('easyreaktoro:simulation-history'));};
  const continueLastSimulation=async()=>{
    if(!lastSimulation){enterSimulation();return;}
    if(busyRef.current||simulationRunning.current)return;
    await guard(async()=>{
      setBusy(true);
      try{
        const database=lastSimulation.database,current=currentSummary.current;
        if(simulationOpened && current && databaseKey(historyDatabase(current))===databaseKey(database)) {setPage('simulation');return;}
        const result=await api<{summary:Summary}>(database.kind==='rtdb'?'rtdb_open':'database_open',database.kind==='rtdb'?{path:database.path}:{group:database.group,name:database.name});
        localStorage.setItem(activeHistoryKey(databaseKey(database)||''),lastSimulation.id);
        localStorage.setItem('easyreaktoro.simulation.active',lastSimulation.id);
        acceptSummary(result.summary);setSimulationOpened(true);setPage('simulation');
      }catch(error){setToast(t("上次模拟未能打开：", "Could not open the last simulation: ")+errText(error));}
      finally{setBusy(false);}
    });
  };
  const acceptSummary = (s: Summary) => {
    pendingDefault.current=false;
    const old = currentSummary.current;
    if (old && old.handle_id !== s.handle_id) api("database_close", {handleId:old.handle_id,discard:true}).catch(error => setToast(errText(error)));
    currentSummary.current = s;
    request.current++; detailRequest.current++; evaluationRequest.current++;
    setRows([]); setRowsError("");setDetailsError("");setOffset(0); setTotal(0); setValidation(null); setLibraryVisible(false);
    setSummary(s);
    if(databaseIntent==='simulation'){setSimulationOpened(true);setPage('simulation');}else setPage("databases");
    setDatabaseIntent('browse');
    setSelected(null);
    setDetails(null);
    setEvaluation(null);
    setTp(STANDARD_TP);
    setQuery("");
    setFilters({ state: "All", model: "All", elements: [] });
    if (s.path) addRecent(s);
  };
  const switchSimulationDatabase=async(database:import('./simulation-history').HistoryDatabase)=>{if(busyRef.current||simulationRunning.current)return;await guard(async()=>{setBusy(true);try{const r=await api<{summary:Summary}>(database.kind==='rtdb'?'rtdb_open':'database_open',database.kind==='rtdb'?{path:database.path}:{group:database.group,name:database.name});acceptSummary(r.summary);setSimulationOpened(true);setPage('simulation');}catch(error){setToast(t("数据库未能打开：", "Could not open the database: ")+errText(error));}finally{setBusy(false);}});};
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
      setToast(t(`打开失败：${errText(error)}`, `Could not open: ${errText(error)}`));
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
      } catch(error) { setToast(t(`打开失败：${errText(error)}`, `Could not open: ${errText(error)}`)); await validRecents(prefs); }
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
        setToast(t(`打开失败：${errText(error)}`, `Could not open: ${errText(error)}`));
    }
  };
  const enterDatabases = async () => {
    setDatabaseIntent('browse');
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
      else setToast(t("默认系统数据库当前不可用，请先连接提供该数据库的 Reaktoro 环境。", "The default system database is unavailable. Connect to a Reaktoro environment that provides it."));
    }
  };
  const selectSpecies = async (species: Species) => {
    const seq = ++detailRequest.current;
    evaluationRequest.current++;
    setDetails(null);setDetailsError("");
    currentSelected.current=species;
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
      if(seq === detailRequest.current)setDetailsError(t(`species 详情未能读取：${errText(error)}`, `Could not load species details: ${errText(error)}`));
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
    await loadRowsRef.current();
  };
  const save = async () => {
    if(busyRef.current) throw new Error(t("操作正在进行，请稍候", "An operation is in progress. Please wait."));
    const active = currentSummary.current;
    if (!active) return;
    setBusy(true);
    try {
      const r = await api<{ summary: Summary; success: boolean }>("rtdb_save", {
        handleId: active.handle_id,
      });
      if(r.success !== true || r.summary?.handle_id !== active.handle_id || r.summary?.dirty !== false) throw new Error(t("无法确认文件是否已保存，请检查保存位置后重试。当前修改已保留。", "The save could not be confirmed. Check the destination and try again. Your changes have been retained."));
      setSummary(r.summary);
      currentSummary.current = r.summary;
      setToast(t("数据库已保存", "Database saved"));
    } catch (error) {
      setToast(t(`保存失败：${errText(error)}`, `Could not save: ${errText(error)}`));
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
      setToast(t(`关闭失败：${errText(error)}`, `Could not close: ${errText(error)}`));
    }
  };
  const evaluate = async () => {
    if(busyRef.current || !currentSummary.current || !selected || !details) return;
    const seq = ++evaluationRequest.current;
    const {temperatureK:temperature,pressurePa:pressure} = readTrialTP(tp);
    const reject = (message: string) => {
      setEvaluation(null);
      setToast(message);
    };
    if (!Number.isFinite(temperature) || temperature <= 0) {
      reject(tp.temperatureUnit==='°C'?t("请输入高于 −273.15 °C 的有效温度。", "Enter a valid temperature above −273.15 °C."):t("请输入大于 0 K 的有效温度。", "Enter a valid temperature above 0 K."));
      return;
    }
    if (!Number.isFinite(pressure) || pressure <= 0) {
      reject(t(`请输入大于 0 ${tp.pressureUnit} 的有效压力。`, `Enter a valid pressure greater than 0 ${tp.pressureUnit}.`));
      return;
    }
    const valid = details?.valid_tp || {};
    const tr = valid.temperature_K || valid.temperature;
    const pr = valid.pressure_Pa || valid.pressure;
    if (Array.isArray(tr) && (temperature < tr[0] || temperature > tr[1])) {
      reject(t(`温度超出该 species 模型的有效范围：${readingNumber(tr[0]-(tp.temperatureUnit==='°C'?273.15:0))}–${readingNumber(tr[1]-(tp.temperatureUnit==='°C'?273.15:0))} ${tp.temperatureUnit}。`, `Temperature is outside this species model's stated range: ${readingNumber(tr[0]-(tp.temperatureUnit==='°C'?273.15:0))}–${readingNumber(tr[1]-(tp.temperatureUnit==='°C'?273.15:0))} ${tp.temperatureUnit}.`));
      return;
    }
    if (Array.isArray(pr) && (pressure < pr[0] || pressure > pr[1])) {
      const scale={bar:100000,MPa:1000000,Pa:1}[tp.pressureUnit];reject(t(`压力超出该 species 模型的有效范围：${readingNumber(pr[0]/scale)}–${readingNumber(pr[1]/scale)} ${tp.pressureUnit}。`, `Pressure is outside this species model's stated range: ${readingNumber(pr[0]/scale)}–${readingNumber(pr[1]/scale)} ${tp.pressureUnit}.`));
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
      if(seq === evaluationRequest.current) reject(t(`计算失败：${errText(error)}`, `Calculation failed: ${errText(error)}`));
    } finally { setBusy(false); }
  };
  const deleteSpecies = async () => {
    if (busyRef.current || !summary || summary.read_only || !selected) return;
    const speciesId = selected.id || details?.id;
    if (!speciesId) {
      setToast(t("该 species 没有可删除的本地记录 ID", "This species has no local record ID to delete."));
      return;
    }
    if (
      !confirm(
        t(`确定从当前数据库删除“${selected.name}”吗？保存前仍可通过放弃更改撤销。`, `Delete “${selected.name}” from this database? You can discard database changes to undo this before saving.`),
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
      setToast(t("species 已删除，保存数据库后生效", "Species deleted. Save the database to keep this change."));
    } catch (error) {
      setToast(t(`删除失败：${errText(error)}`, `Could not delete: ${errText(error)}`));
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
    setToast(t("已设为默认数据库", "Set as default database"));
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
      if(event.key.toLowerCase()==='s' && page==='databases' && currentSummary.current){event.preventDefault();if(currentSummary.current.dirty && !currentSummary.current.read_only) void save().catch(()=>{});}
      if(event.key.toLowerCase()==='f' && page==='databases'){const input=document.querySelector<HTMLInputElement>(summary && !libraryVisible?'.species-panel .search-box input':'.catalog-search input');if(input){event.preventDefault();input.focus();input.select();}}
    };
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  },[page,libraryVisible,report]);

  return (
    <div className="app-shell" onClick={() => setMenu(false)}>
      <header className="app-commandbar">
        <button className="shell-icon" aria-label={drawer?t("收起导航", "Collapse navigation"):t("展开导航", "Expand navigation")} aria-expanded={drawer} aria-controls="app-navigation" onClick={()=>setDrawer(!drawer)} title={t("展开导航", "Expand navigation")}><PanelLeft size={18}/></button>
        <strong className="page-context">{{home:t("主页", "Home"),databases:t("数据库", "Database"),simulation:t("模拟", "Simulation"),results:t("结果", "Results"),settings:t("设置", "Settings")}[page]}</strong>
        <div className="commandbar-slot" ref={setWorkbenchToolbar}/>
        {summary && page==='simulation' ? <DatabaseSwitcher name={label(summary).replace(/\.rtdb$/i,'')} current={historyDatabase(summary)} currentCounts={{species_count:summary.species_count,element_count:summary.element_count}} dirty={summary.dirty} disabled={busy||simulationActive} catalog={catalog} recents={prefs.recent_databases} onChoose={database=>void switchSimulationDatabase(database)} onFile={()=>{void (async()=>{try{const path=await pickPath('open_rtdb');await switchSimulationDatabase({kind:'rtdb',path,name:localDatabaseName(path)});}catch(error){if(!String(error).includes('cancelled'))setToast(errText(error));}})();}} onCombine={()=>{void guard(()=>{setComposeForSimulation(true);setDialog('compose');});}} onInspect={()=>{setLibraryVisible(false);setPage('databases');}}/> : summary && page==='databases' && libraryVisible && <button className="context-database" title={t(`当前数据库：${label(summary)}`, `Current database: ${label(summary)}`)} onClick={()=>{setLibraryVisible(false);setPage('databases');}}><Database size={14}/><span>{label(summary).replace(/\.rtdb$/i,'')}</span>{summary.dirty && <i title={t("有未保存的数据库修改", "Unsaved database changes")}/>}</button>}
        <button className="shell-icon theme-quick" aria-label={t("切换浅色或深色", "Switch between light and dark")} title={t("切换浅色 / 深色；跟随系统可在设置中选择", "Switch between light and dark; follow system appearance in Settings")} onClick={()=>{const current=currentPrefs.current;const dark=current.theme==='dark' || (current.theme==='system' && window.matchMedia('(prefers-color-scheme: dark)').matches);savePrefs({...current,theme:dark?'light':'dark'});}}>{prefs.theme==='light'?<Moon size={16}/>:<Sun size={16}/>}</button>
      </header>
      <div className="body">
        {drawer && <button className="nav-scrim" aria-label={t("关闭导航抽屉", "Close navigation drawer")} onClick={()=>setDrawer(false)}/>}
        <aside id="app-navigation" onClick={()=>setDrawer(false)} className={`sidebar ${drawer?'expanded':'collapsed'}`}>
          <nav>
            <Nav
              active={page === "home"}
              icon={<Home />}
              label={t("主页", "Home")}
              onClick={() => setPage("home")}
            />
            <Nav
              active={page === "databases"}
              icon={<Database />}
              label={t("数据库", "Database")}
              onClick={enterDatabases}
            />
            <Nav
              active={page === "simulation"}
              icon={<FlaskConical />}
              label={t("模拟", "Simulation")}
              onClick={enterSimulation}
            />
            <Nav active={page === "results"} icon={<ChartNoAxesCombined/>} label={t("结果", "Results")} onClick={()=>{setSimulationOpened(true);setPage('results');}}/>
            <Nav
              active={page === "settings"}
              icon={<Settings />}
              label={t("设置", "Settings")}
              onClick={() => setPage("settings")}
            />
          </nav>
          <div className="sidebar-spacer" />
          <button
            className="runtime-entry"
            title={runtime.available?t(`Reaktoro ${runtime.version} 已连接`, `Reaktoro ${runtime.version} connected`):t("连接 Reaktoro 环境", "Connect to Reaktoro")}
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
                  ? t(`已连接 · ${runtime.version}`, `Connected · ${runtime.version}`)
                  : runtime.status === "probing"
                    ? t("正在检测", "Detecting")
                    : t("连接 Reaktoro", "Connect Reaktoro")}
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
                setDatabaseIntent('browse');
                setLibraryVisible(true);
                setPage("databases");
              }}
              onOpen={openLocal}
              onSimulation={enterSimulation}
              lastSimulation={lastSimulation}
              onResumeSimulation={()=>{void continueLastSimulation();}}
              onHistory={showSimulationHistory}
              onResults={()=>{setSimulationOpened(true);setPage('results');}}
            />
          )}{" "}
          {page === "databases" &&
            (summary && !libraryVisible ? (
              <Workspace toolbar={workbenchToolbar}
                onSimulation={enterSimulation}
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
                  busy, rowsLoading, rowsError,detailsError, facets, validation,
                }}
                onQuery={setQuery}
                onFilters={setFilters}
                onPage={loadRows}
                onRetryRows={()=>loadRows(0)}
                onRetryDetails={()=>selected&&selectSpecies(selected)}
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
                }catch(error){if(!String(error).includes('cancelled'))setToast(t(`复制失败：${errText(error)}`, `Could not copy: ${errText(error)}`));}finally{setBusy(false);}}}
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
                      ? t("验证通过", "Validation passed")
                      : t(`验证发现 ${r.issues.length} 个问题`, `Validation found ${r.issues.length} issues`),
                  );
                  setValidation(r); setReport({kind:"validation",...r});
                } catch(error) { setToast(t(`验证失败：${errText(error)}`, `Validation failed: ${errText(error)}`)); } finally {setBusy(false);} }}
                onDefault={setDefault}
                onReveal={() =>
                  summary.path && api("reveal_path", { path: summary.path }).catch(error => setToast(errText(error)))
                }
                onClose={() => close()}
                onTp={(value:TrialTP) => { const before=readTrialTP(tp),after=readTrialTP(value);setTp(value);if(before.temperatureK!==after.temperatureK||before.pressurePa!==after.pressurePa){evaluationRequest.current++;setEvaluation(null);} }}
                onLibrary={() => setLibraryVisible(true)}
                onSaveAs={async () => { if(busyRef.current) return; setBusy(true); try {
                  const path = await pickPath("save_rtdb", prefs.save_directory);
                  const result = await api<{summary:Summary;success:boolean}>("rtdb_save_as", {handleId:summary.handle_id,path});
                  if(result.success !== true || result.summary?.dirty !== false) throw new Error(t("无法确认文件是否已另存，请检查保存位置后重试。", "The new copy could not be confirmed. Check the destination and try again."));
                  acceptSummary(result.summary); setToast(t(`已另存为：${path}`, `Saved as: ${path}`));
                } catch(error) { if(!String(error).includes("cancelled")) setToast(t(`另存为失败：${errText(error)}`, `Could not save as: ${errText(error)}`)); } finally {setBusy(false);} }}
                onEvaluate={evaluate}
              />
            ) : (
              <DatabaseLibrary
                runtime={runtime}
                catalog={catalog}
                catalogState={catalogState}
                recents={prefs.recent_databases}
                currentSummary={summary}
                defaultDb={prefs.default_database}
                onOpenOfficial={openOfficial}
                onOpenLocal={openLocal}
                onNew={() => guard(() => setDialog("new"))}
                onCompose={() => guard(() => setDialog("compose"))}
                forSimulation={databaseIntent==='simulation'}
                onCancelIntent={()=>setDatabaseIntent('browse')}
                onRuntime={showRuntimeSettings}
                onRetry={()=>loadCatalog(runtime)}
              />
            ))}{" "}
          {simulationOpened && <div hidden={page !== "simulation" && page !== "results"} style={{height:"100%"}}><SimulationWorkbench summary={summary} runtime={runtime} onRunningChange={value=>{simulationRunning.current=value;setSimulationActive(value);}} autoSave={prefs.auto_save_simulations!==false} onDatabases={chooseSimulationDatabase} onRuntime={showRuntimeSettings} exportDirectory={prefs.export_directory} view={page==='results'?'results':'simulation'} visible={page==='simulation' || page==='results'} onViewChange={setPage} toolbar={workbenchToolbar} theme={prefs.theme} onHistoryDatabase={database=>{void guard(async()=>{try{const result=await api<{summary:Summary}>(database.kind==="rtdb"?"rtdb_open":"database_open",database.kind==="rtdb"?{path:database.path}:{group:database.group,name:database.name});acceptSummary(result.summary);setSimulationOpened(true);setPage("simulation");}catch(error){setToast(t("此模拟的数据库未能打开：", "Could not open this simulation's database: ")+errText(error));}});}}/></div>}{" "}
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
              summary={summary} catalog={catalog}
              onSetDefault={setDefault}
              onChooseDefaultFile={async()=>{try{const path=await pickPath("open_rtdb");savePrefs({...prefs,default_database:{kind:"rtdb",path}});}catch(error){if(!String(error).includes("cancelled"))setToast(errText(error));}}}
              onHistory={showSimulationHistory}
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
        <Modal title={t("按元素筛选 species", "Filter species by element")} onClose={() => setDialog(null)} wide>
          <p className="modal-copy">{t("选择一个或多个元素，结果必须同时包含全部已选元素。", "Choose one or more elements. Results must contain every selected element.")}</p>
          <PeriodicTable
            selected={periodicDraft}
            onChange={setPeriodicDraft}
          />
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={!periodicDraft.length}
              onClick={() => setPeriodicDraft([])}
            >{t("清除", "Clear")}</button>
            <button className="secondary" onClick={() => setDialog(null)}>{t("取消", "Cancel")}</button>
            <button className="primary" onClick={() => {setFilters({...filters,elements:periodicDraft});setDialog(null);}}>{t("应用筛选", "Apply filter")}</button>
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
      {exitSaveError && <ConfirmDialog title={t("模拟尚未保存，确定退出？", "Quit with unsaved simulation changes?")} onCancel={()=>setExitSaveError('')} confirmLabel={t("放弃未保存内容并退出", "Discard changes and quit")} onConfirm={()=>{setExitSaveError('');if(currentSummary.current?.dirty){pendingAction.current=async()=>{await getCurrentWindow().destroy();};setDialog('close');}else void getCurrentWindow().destroy();}}><p>{t("自动保存未完成，退出会丢失最近修改。继续编辑后可重试保存或另存模拟设置。", "Automatic saving has not finished. Quitting will lose recent changes. Continue editing to retry saving or save a copy of the simulation settings.")}</p><p>{exitSaveError}</p></ConfirmDialog>}
      {(dialog === "species-new" || dialog === "species-edit") && summary && (
        <SpeciesEditor
          handleId={summary.handle_id}
          existing={dialog === "species-edit" ? details : null}
          registerExit={request=>{editorExit.current=request;}}
          onExit={()=>{editorExit.current=null;setDialog(null);void guard(async()=>{await getCurrentWindow().destroy();});}}
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
            setToast(t(`${species.id ? "species 已更新" : "species 已创建"}，请保存数据库文件。`, `${species.id ? "Species updated" : "Species created"}. Save the database file to keep this change.`));
          }}
        />
      )}
      {dialog === "compose" && (
        <ComposeWizard
          catalog={catalog}
          initial={summary?.kind === "official" || composeForSimulation ? summary : null}
          target={!composeForSimulation && !libraryVisible && summary?.kind === "rtdb" ? summary : null}
          defaultDirectory={prefs.save_directory}
          onClose={() => {setDialog(null);setComposeForSimulation(false);}}
          onCreated={(s) => {
            setDialog(null);
            acceptSummary(s);if(composeForSimulation){setSimulationOpened(true);setPage('simulation');setComposeForSimulation(false);}
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
            setValidation(null); setToast(t("所选 species 已添加，请保存数据库文件。", "Selected species added. Save the database file to keep these changes."));
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
              t(`已导出 ${report.export_count} 条，排除 ${report.exclude_count} 条：${report.output_path}`, `Exported ${report.export_count} records, excluded ${report.exclude_count}: ${report.output_path}`),
            );
          }}
        />
      )}
      {dialog === "close" && (
        <Modal title={t("保存未完成的更改？", "Save your changes?")} busy={busy} onClose={() => { pendingAction.current = null; setDialog(null); }}>
          <p className="modal-copy">“{label(summary)}{t("”包含未保存更改。保存失败时会保留当前数据库。", "” has unsaved changes. If saving fails, the database will remain open.")}</p>
          <div className="modal-actions spread">
            <button className="danger" onClick={async () => { const action = pendingAction.current; pendingAction.current = null; setDialog(null); await action?.(); }}>{t("放弃更改", "Discard changes")}</button>
            <span />
            <button className="secondary" onClick={() => { pendingAction.current = null; setDialog(null); }}>{t("取消", "Cancel")}</button>
            <button
              className="primary"
              onClick={async () => {
                try {
                  await save();
                  const action = pendingAction.current; pendingAction.current = null; setDialog(null); await action?.();
                } catch {}
              }}
            >{t("保存并关闭", "Save and close")}</button>
          </div>
        </Modal>
      )}
      {report && <Modal title={report.kind === "export" ? t("导出结果", "Export results") : t("数据库验证", "Database validation")} onClose={() => setReport(null)}>
        {report.output_path && <p className="modal-copy selectable">{report.output_path}</p>}
        <p className="modal-copy">{report.kind === "export" ? t(`已导出 ${report.export_count} 个 species，排除 ${report.exclude_count} 个；Reaktoro 重新加载验证通过。`, `Exported ${report.export_count} species and excluded ${report.exclude_count}. Reaktoro successfully reloaded the exported data.`) : t(`${report.species_count} 个 species · ${report.status === "valid" ? "验证通过" : `发现 ${report.issues.length} 项需要检查的记录`}`, `${report.species_count} species · ${report.status === "valid" ? "Validation passed" : `${report.issues.length} records need review`}`)}</p>
        <div className="report-list">{(report.issues || report.exclusions || []).map((item:any,index:number) => <article key={index}><strong>{item.species || item.name}</strong><p>{translateDatabaseMessage(item.message || item.reason || "")}</p></article>)}</div>
        <div className="modal-actions"><button className="primary" onClick={() => setReport(null)}>{t("完成", "Done")}</button></div>
      </Modal>}
      {busy && <div className="operation-shield" role="status"><div className="panel">{t("正在处理，请稍候…", "Working, please wait…")}</div></div>}
      {toast && (
        <div className={`toast ${toastNeedsAttention ? 'attention' : ''}`} role={toastNeedsAttention ? "alert" : "status"} aria-live="polite">
          <Info size={14} />
          <span>{translateDatabaseMessage(toast)}</span><button aria-label={t("关闭提示", "Dismiss notification")} onClick={()=>setToast('')}><X size={16}/></button>
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
  useLanguage();
  return (
    <button className={`nav-item ${active ? "active" : ""}`} aria-label={label} aria-current={active?"page":undefined} title={label} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {suffix && <em>{suffix}</em>}
    </button>
  );
}

export function HomePage({runtime,candidates,prefs,summary,discovering,onDiscover,onChoose,onChooseFolder,onCandidate,onContinue,onManage,onOpen,onSimulation,onResults,lastSimulation,onResumeSimulation,onHistory}: {
  runtime:Runtime;candidates:Candidate[];prefs:Preferences;summary:Summary|null;discovering:boolean;
  onDiscover:()=>void;onChoose:()=>void;onChooseFolder:()=>void;onCandidate:(p:string)=>void;
  onContinue:()=>void;onManage:()=>void;onOpen:(path?:string)=>void;onSimulation:()=>void;onResults:()=>void;
  lastSimulation?:HistoryEntry|null;onResumeSimulation?:()=>void;onHistory?:()=>void;
}) {
  useLanguage();
  return <div className="scroll-page home-page">
    <header className="home-welcome">
      <div><span className="eyebrow">EASYREAKTORO</span><h1>{t("从热力学数据，到反应与结果", "From thermodynamic data to reactions and results")}</h1><p>{t("定义化学体系，构建平衡计算，观察物质如何变化。", "Define a chemical system, set up equilibrium calculations, and follow its evolution.")}</p></div>
      {runtime.available && <button className="home-runtime" onClick={onDiscover} title={runtime.python}><i/><span>Reaktoro {runtime.version}{t(" 已连接", " Connected")}</span><ChevronRight size={14}/></button>}
    </header>
    {!runtime.available && <section className="onboarding panel">
          <div className="onboarding-icon">
            <MonitorCog />
          </div>
          <div>
            <span className="eyebrow">{t("计算准备", "Prepare for calculation")}</span>
            <h2>{t("连接 Reaktoro", "Connect Reaktoro")}</h2>
            <p>
              {runtime.status === "probing"
                ? t("正在检查常见安装位置…", "Checking common installation locations…")
                : (runtime.diagnostic?errText(runtime.diagnostic):'') ||
                  t("自动检测，或手动指定 Reaktoro 环境中的 Python。", "Detect automatically, or choose the Python executable in your Reaktoro environment.")}
            </p>
            <div className="button-row">
              <button
                className="primary"
                disabled={discovering}
                onClick={onDiscover}
              >
                <RefreshCw />
                {discovering ? t("正在检测…", "Detecting…") : t("自动检测", "Detect automatically")}
              </button>
              <button className="secondary" onClick={onChoose}>
                <FolderOpen />{t("选择 Reaktoro Python", "Choose Reaktoro Python")}</button>
              <button className="secondary" onClick={onChooseFolder}>{t("选择 Conda / Reaktoro 环境", "Choose Conda / Reaktoro environment")}</button>
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
            {runtime.status !== "probing" && <p className="offline-access">{t("暂不连接？", "Connect later?")}<button className="text-button" onClick={onManage}>{t("离线管理 .rtdb", "Manage .rtdb files offline")}</button></p>}
          </div>
        </section>}
    {summary && <section className="home-current panel"><div className="home-current-icon"><Database size={23}/></div><div><small>{t("当前数据库", "Current database")}{summary.dirty?t(" · 有未保存的修改", " · Unsaved changes"):''}</small><h2>{label(summary)}</h2><p>{summary.species_count.toLocaleString()}{t(" 个 species · ", " species · ")}{summary.element_count}{t(" 个元素 · ", " elements · ")}{summary.read_only?t("只读数据", "Read-only data"):t("可编辑数据", "Editable data")}</p></div><div className="button-row"><button className="secondary" onClick={onContinue}>{t("查看 species", "Browse species")}</button><button className="primary" onClick={onSimulation}><FlaskConical size={16}/>{t("进入模拟", "Open simulation")}<ChevronRight size={15}/></button></div></section>}
    <div className="home-workflow" aria-label={t("计算工作流程", "Calculation workflow")}>
      <button className="workflow-card" onClick={onManage}><span className="workflow-card-top"><Database size={23}/><small>{t("01 / 数据", "01 / Data")}</small></span><h2>{t("数据库与 species 管理", "Database and species management")}</h2><p>{t("按名称、化学式或元素寻找 species，检查热力学参数与来源。", "Find species by name, formula, or element, and inspect thermodynamic parameters and sources.")}</p><span className="workflow-card-link">{t("查看我的数据库和系统数据库", "Browse my databases and system databases")}<ChevronRight size={16}/></span></button>
      <article className="workflow-card home-simulation-card"><button className="home-simulation-primary" onClick={lastSimulation?(onResumeSimulation||onSimulation):onSimulation}><span className="workflow-card-top"><FlaskConical size={23}/><small>{t("02 / 模拟", "02 / Simulation")}</small></span><h2>{lastSimulation?t("继续上次模拟", "Continue last simulation"):t("构建平衡计算", "Set up equilibrium calculations")}</h2>{lastSimulation?<p className="home-simulation-summary"><strong>{lastSimulation.name}</strong><span>{lastSimulation.database.name} · {lastSimulation.species_count}{t(" 个 species · ", " species · ")}{lastSimulation.point_count}{t(" 个路径位置", " path positions")}</span></p>:<p>{t("选择可能生成的 species，设置温压路径、投料变化与物料传递；随时切换图形设置和 Python 代码。", "Choose the species allowed at equilibrium, set temperature and pressure paths, vary inputs, and transfer material between reactions. Switch between graphical settings and Python code at any time.")}</p>}<span className="workflow-card-link">{lastSimulation?t("恢复 species、参数与代码", "Restore species, parameters, and code"):summary?t("继续当前体系", "Continue with this system"):t("选择数据库后开始", "Choose a database to begin")}<ChevronRight size={16}/></span></button>{onHistory&&<div className="home-simulation-secondary"><button className="text-button" onClick={onHistory}><History size={14}/>{t("模拟历史", "Simulation history")}</button></div>}</article>
      <button className="workflow-card" onClick={onResults}><span className="workflow-card-top"><ChartNoAxesCombined size={23}/><small>{t("03 / 结果", "03 / Results")}</small></span><h2>{t("查看与比较结果", "View and compare results")}</h2><p>{t("打开计算结果或导入表格，比较不同条件，保存图表与工作区。", "Open calculation results or import tables, compare conditions, and save charts and workspaces.")}</p><span className="workflow-card-link">{t("打开结果", "Open results")}<ChevronRight size={16}/></span></button>
    </div>
    <div className="home-recent-heading"><h2>{t("最近数据库", "Recent databases")}</h2><button className="text-button" onClick={()=>onOpen()}><FolderOpen size={15}/>{t("打开 .rtdb", "Open .rtdb")}</button></div>
    <RecentHome recents={prefs.recent_databases} onOpen={onOpen}/>
    <div className="home-footnote"><span>{t("运行前选择保存位置 · 计算结果自动保存 · 支持独立查看与分享", "Choose a location before running · Results save automatically · View and share independently")}</span><HelpTip label={t("计算从哪里开始", "Where calculations begin")}>{t("数据库提供热力学数据。系统 species 决定平衡时允许出现什么；初始物质决定实际投入多少。运行前选择结果保存位置，计算和查看结果可在不同页面进行。", "The database provides thermodynamic data. System species define what can exist at equilibrium; initial materials define how much is introduced. Choose a results folder before running. Calculations and results have their own workspaces.")}</HelpTip></div>
  </div>;
}
function RecentHome({
  recents,
  onOpen,
}: {
  recents: Recent[];
  onOpen: (p?: string) => void;
}) {
  useLanguage();
  if (!recents.length)
    return (
      <p className="home-recent-empty">{t("尚未打开本地数据库。可以直接使用已连接环境中的系统数据库，或打开自己的 .rtdb 文件。", "No local database is open. Use a system database from your connected Reaktoro environment, or open your own .rtdb file.")}</p>
    );
  return (
    <section className="quiet-section">
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

type LocalDatabaseInfo = {path:string;status:'ready'|'error';species_count?:number;element_count?:number;message?:string};
export function DatabaseLibrary({runtime,catalog,catalogState,recents,defaultDb,currentSummary,onOpenOfficial,onOpenLocal,onNew,onCompose,forSimulation=false,onCancelIntent,onRuntime,onRetry}: {
  runtime:Runtime;catalog:Catalog[];catalogState:string;recents:Recent[];defaultDb?:DefaultDb;currentSummary?:Summary|null;
  onOpenOfficial:(x:Catalog)=>void;onOpenLocal:(p?:string)=>void;onNew:()=>void;onCompose:()=>void;
  forSimulation?:boolean;onCancelIntent:()=>void;onRuntime:()=>void;onRetry:()=>void;
}) {
  useLanguage();
  const local=useMemo(()=>{
    const values=[...recents];
    if(defaultDb?.kind==='rtdb' && !values.some(x=>x.path===defaultDb.path))values.unshift({path:defaultDb.path,name:localDatabaseName(defaultDb.path),opened_at:''});
    return values.filter((x,i)=>values.findIndex(r=>r.path===x.path)===i);
  },[recents,defaultDb]);
  const [section,setSection]=useState<'mine'|'system'>(()=>local.length?'mine':'system');
  const [query,setQuery]=useState(''),[group,setGroup]=useState('all');
  const [counts,setCounts]=useState<Record<string,LocalDatabaseInfo>>({}),[reading,setReading]=useState(false),[refresh,setRefresh]=useState(0);
  const pathKey=JSON.stringify(local.map(x=>x.path));
  useEffect(()=>{
    let disposed=false; const paths:string[]=JSON.parse(pathKey);
    setCounts({});setReading(paths.length>0);
    if(paths.length)api<{items:LocalDatabaseInfo[]}>('rtdb_list_info',{paths}).then(result=>{
      if(!disposed)setCounts(Object.fromEntries(result.items.map(x=>[x.path,x])));
    }).catch(()=>{if(!disposed)setCounts(Object.fromEntries(paths.map(path=>[path,{path,status:'error',message:t("数量暂时无法读取，可点击刷新重试。", "Counts could not be read. Refresh to try again.")}])));})
      .finally(()=>{if(!disposed)setReading(false);});
    return()=>{disposed=true;};
  },[pathKey,refresh,runtime.python]);
  const needle=query.trim().toLocaleLowerCase(),matches=(text:string)=>needle.split(/\s+/).every(word=>text.toLocaleLowerCase().includes(word));
  const locals=local.filter(x=>matches(localDatabaseName(x.path)+' '+x.path));
  const officials=catalog.filter(x=>(group==='all' || x.group===group) && matches(x.group+' '+x.embedded_name));
  const filters=[['all',t("全部", "All"),catalog.length],...['PHREEQC','SUPCRT','NASA'].map(g=>[g,g,catalog.filter(x=>x.group===g).length])];
  const isMine=section==='mine',visibleCount=isMine?locals.length:officials.length;
  return <div className="library-page">
    <h1 className="library-accessible-title">{t("数据库", "Database")}</h1>
    {forSimulation && <div className="library-intent"><FlaskConical size={16}/><span>{t("为模拟选择数据库 · 打开后继续设置化学体系", "Choose a database for this simulation, then define the chemical system")}</span><button className="text-button" onClick={onCancelIntent}>{t("改为浏览数据库", "Browse databases instead")}</button></div>}
    <div className="library-navigation"><div className="library-tabs" role="tablist" aria-label={t("数据库分类", "Database category")}>
      <button role="tab" id="library-mine-tab" aria-controls="library-mine" aria-selected={isMine} onClick={()=>setSection('mine')}><FolderOpen size={16}/>{t("我的数据库", "My databases")}<span>{local.length}</span></button>
      <button role="tab" id="library-system-tab" aria-controls="library-system" aria-selected={!isMine} onClick={()=>setSection('system')}><Database size={16}/>{t("系统数据库", "System databases")}<span>{catalog.length}</span><small><Lock size={11}/>{t("只读", "Read-only")}</small></button>
    </div><div className="button-row"><button className="secondary" onClick={onNew}><FilePlus2 size={15}/>{t("新建数据库", "New database")}</button><button className="primary" onClick={()=>onOpenLocal()}><FolderOpen size={15}/>{t("打开数据库", "Open database")}</button></div></div>
    <div className="library-section-toolbar">
      <label className="search-box catalog-search"><Search size={16}/><input aria-label={t("搜索数据库", "Search databases")} placeholder={isMine?t("搜索我的数据库 · ⌘F", "Search my databases · ⌘F"):t("搜索系统数据库 · ⌘F", "Search system databases · ⌘F")} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setQuery('');}}/>{query && <button aria-label={t("清除数据库搜索", "Clear database search")} onClick={()=>setQuery('')}><X size={14}/></button>}</label>
      {!isMine && <div className="catalog-filters" role="group" aria-label={t("系统数据库类型", "System database type")}>{filters.map(([id,name,count])=><button key={id} aria-pressed={group===id} onClick={()=>setGroup(String(id))}>{name}<span>{count}</span></button>)}</div>}
      <span className="library-section-actions">{!isMine && <><HelpTip label={t("系统数据库", "System databases")}>{t("由 Reaktoro 提供，可以查看和用于模拟。需要编辑时，可选取其中的 species 创建自己的数据库。", "Provided by Reaktoro for inspection and simulation. To edit data, select species and create your own database.")}</HelpTip><button className="secondary" onClick={onCompose} disabled={!runtime.available} title={!runtime.available?t("连接 Reaktoro 后可用", "Available after connecting Reaktoro"):t("选取需要的 species，创建可编辑的数据库", "Select species to create an editable database")}><Plus size={14}/>{t("选取 species 建库", "Create from selected species")}</button></>}{isMine && <button className="text-button" disabled={reading || !local.length} onClick={()=>setRefresh(v=>v+1)} aria-label={t("刷新数据库数量", "Refresh database counts")} title={t("重新读取 species 数和元素数", "Reload species and element counts")}><RefreshCw size={14}/>{reading?t("读取中…", "Loading…"):t("刷新", "Refresh")}</button>}</span>
    </div>
    <div className="catalog-scroll" role="tabpanel" id={isMine?'library-mine':'library-system'} aria-labelledby={isMine?'library-mine-tab':'library-system-tab'}>
      {!isMine && !runtime.available && <div className="catalog-status"><MonitorCog size={18}/><span>{t("连接 Reaktoro 后可查看系统数据库。", "Connect Reaktoro to browse system databases.")}</span><button className="secondary" onClick={onRuntime}>{t("连接 Reaktoro", "Connect Reaktoro")}</button></div>}
      {!isMine && runtime.available && catalogState==='loading' && <div className="catalog-status" role="status"><RefreshCw size={16}/><span>{t("正在读取系统数据库…", "Loading system databases…")}</span></div>}
      {!isMine && runtime.available && catalogState==='error' && <div className="catalog-status" role="alert"><Info size={16}/><span>{t("系统数据库读取失败，请重新加载或检查连接。", "Could not load system databases. Reload or check the connection.")}</span><button className="secondary" onClick={onRetry}>{t("重新加载", "Reload")}</button><button className="text-button" onClick={onRuntime}>{t("检查连接", "Check connection")}</button></div>}
      {visibleCount>0 && <div className="database-list">
        <div className="database-list-heading" aria-hidden="true"><span>{t("名称", "Name")}{isMine?t("与位置", " and location"):''}</span><span>{t("species 数", "Species count")}</span><span>{t("元素数", "Element count")}</span><span/></div>
        {isMine?locals.map(x=>{
          const active=currentSummary?.kind==='rtdb' && currentSummary.path===x.path?currentSummary:undefined;
          const info=active?{status:'ready',species_count:active.species_count,element_count:active.element_count}:counts[x.path];
          const count=(value:number|undefined)=>Number.isInteger(value) && Number(value)>=0?value!.toLocaleString():'—';
          const error=translateDatabaseMessage(counts[x.path]?.message || "");
          return <div className="database-list-entry" key={x.path}><button className="database-list-row" onClick={()=>onOpenLocal(x.path)} title={x.path} aria-label={localDatabaseName(x.path)+' · '+(info?.status==='ready'?count(info.species_count)+t(" 个 species · ", " species · ")+count(info.element_count)+t(" 个元素", " elements"):info?.status==='error'?t("数量暂不可用", "Counts unavailable"):t("正在读取数量", "Loading counts"))+t(" · 打开数据库", " · Open database")}>
            <span className="database-row-name"><span className="database-row-icon"><Database size={20}/></span><span><strong>{localDatabaseName(x.path)}{defaultDb?.kind==='rtdb' && defaultDb.path===x.path && <em>{t("默认", "Default")}</em>}{active?.dirty && <em>{t("未保存", "Unsaved")}</em>}</strong><small title={error || x.path}>{info?.status==='error'?error:x.path.substring(0,x.path.lastIndexOf('/')) || x.path}</small></span></span>
            <span className="database-row-count">{info?.status==='ready'?count(info.species_count):reading?'…':'—'}</span><span className="database-row-count">{info?.status==='ready'?count(info.element_count):reading?'…':'—'}</span><ChevronRight size={16}/>
          </button></div>;
        }):officials.map(x=><OfficialDbRow key={x.id} entry={x} onOpen={()=>onOpenOfficial(x)}/>)}
      </div>}
      {!visibleCount && (isMine || catalogState==='ready') && <div className="catalog-empty"><Database size={27}/><h2>{query?t("没有匹配的数据库", "No matching databases"):isMine?t("还没有自己的数据库", "No personal databases yet"):t("暂无此类系统数据库", "No system databases of this type")}</h2><p>{query?t("尝试其他名称，或清除搜索。", "Try a different name, or clear the search."):isMine?t("打开已有数据库，或从系统数据库中选取 species 开始。", "Open an existing database, or begin by selecting species from a system database."):t("可选择其他类型，或检查 Reaktoro 连接。", "Choose another type, or check the Reaktoro connection.")}</p>{query?<button className="secondary" onClick={()=>setQuery('')}>{t("清除搜索", "Clear search")}</button>:isMine?<div className="button-row"><button className="primary" onClick={()=>onOpenLocal()}>{t("打开数据库", "Open database")}</button><button className="secondary" onClick={()=>setSection('system')}>{t("查看系统数据库", "Browse system databases")}</button></div>:group!=='all'?<button className="secondary" onClick={()=>setGroup('all')}>{t("查看全部系统数据库", "View all system databases")}</button>:null}</div>}
    </div>
    <footer className="catalog-footer"><span>{visibleCount}{t(" 个数据库", " databases")}{needle?t("符合搜索", " matching the search"):''}</span><span>{isMine?t("数量包含数据库中的全部 species；未保存的修改会单独标出。", "Counts include all species in each database. Unsaved changes are marked separately."):t("数据来自 Reaktoro ", "Data provided by Reaktoro ")+(runtime.version || '')}</span></footer>
  </div>;
}
function OfficialDbRow({entry,onOpen}:{entry:Catalog;onOpen:()=>void}) {
  useLanguage();
  const [expanded,setExpanded]=useState(false),[details,setDetails]=useState<any>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const load=async()=>{
    setLoading(true);setError('');
    try{setDetails(await api('catalog_entry_details',{group:entry.group,name:entry.embedded_name}));}
    catch(error){setError(t("详情读取失败：", "Could not load details: ")+errText(error));}finally{setLoading(false);}
  };
  const toggle=()=>{setExpanded(!expanded);if(!expanded && !details)void load();};
  return <div className="database-list-entry">
    <div className="system-database-row"><button className="database-list-row" onClick={onOpen} title={entry.embedded_name} aria-label={entry.embedded_name+' · '+entry.species_count.toLocaleString()+t(" 个 species · ", " species · ")+entry.element_count+t(" 个元素 · 打开数据库", " elements · Open database")}>
      <span className="database-row-name"><span className="database-row-icon"><Database size={20}/></span><span><strong>{entry.embedded_name}</strong><small>{entry.group}</small></span></span>
      <span className="database-row-count">{entry.species_count.toLocaleString()}</span><span className="database-row-count">{entry.element_count.toLocaleString()}</span><ChevronRight size={16}/>
    </button><button className="database-details-toggle" aria-label={entry.embedded_name+t(" 详情", " details")} aria-expanded={expanded} onClick={toggle} title={expanded?t("收起详情", "Hide details"):t("查看详情", "View details")}><Info size={15}/></button></div>
    {expanded && <div className="database-list-details">{error && <p className="inline-error" role="alert">{translateDatabaseMessage(error)}<button className="text-button" onClick={load}>{t("重试", "Retry")}</button></p>}{loading?<span>{t("正在读取详情…", "Loading details…")}</span>:details?<><div><b>{t("相态分布", "Phase distribution")}</b><span>{Object.entries(details.phase_counts || {}).map(([k,v])=>stateLabel(k)+' '+v).join(' · ') || t("尚无信息", "No information yet")}</span></div><div><b>{t("热力学模型", "Thermodynamic models")}</b><span>{Object.entries(details.model_family_counts || {}).map(([k,v])=>modelLabel(k)+' '+v).join(' · ') || t("尚无信息", "No information yet")}</span></div><div><b>{t("参考文献", "References")}</b><span>{details.references?.length?details.references.length+t(" 条", " entries"):t("尚无参考文献", "No references yet")}</span></div></>:null}</div>}
  </div>;
}

function Workspace(props: any) {
  useLanguage();
  const [split, setSplit] = useState(48);
  const [showFilters,setShowFilters]=useState(false);
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
  const activeFilters=(filters.state!=='All'?1:0)+(filters.model!=='All'?1:0)+filters.elements.length;
  const tools=<div className="database-commandbar">
    <button className="breadcrumb" onClick={props.onLibrary} title={t("返回数据库列表", "Return to database list")}><FolderOpen size={15}/><span>{t("数据库列表", "Database list")}</span></button>
    <h1 title={label(summary)}>{label(summary)}</h1>
    <span className="db-save-state">{summary.read_only?t("只读", "Read-only"):summary.dirty?t("未保存", "Unsaved"):t("已保存", "Saved")}</span>
    <HelpTip label={t("数据库信息", "Database information")}>{summary.path || `${summary.provider} · ${summary.embedded_name}`}<br/>{summary.species_count} species · {summary.element_count}{t(" 元素", " Elements")}<br/>{summary.kind==='official'?`Reaktoro ${summary.runtime_version || ''}`:t("文件格式 .rtdb", "File format .rtdb")}</HelpTip>
        <div className="workspace-actions">
          <button className="secondary" onClick={props.onSimulation} title={t("以当前数据库中的 species 与参数设置模拟", "Set up a simulation with this database's species and parameters")}><FlaskConical/>{t("用于模拟", "Use for simulation")}</button>
          {!summary.read_only && (
            <button className="primary" onClick={props.onNewSpecies}>
              <Plus />{t("新建 species", "New species")}</button>
          )}
          {!summary.read_only && (
            <button
              className="secondary"
              disabled={!summary.dirty}
              onClick={props.onSave}
            >
              <Save />{t("保存", "Save")}</button>
          )}
          <div className="menu-anchor">
            <button
              className="secondary"
              onClick={(e) => {
                e.stopPropagation();
                props.onMenu();
              }}
            >{t("操作", "Actions")}<Ellipsis />
            </button>
            {menu && <ActionMenu {...props} />}
          </div>
        </div>
    </div>;
  const rowIndex=rows.findIndex((x:Species)=>selected?.id && x.id?selected.id===x.id:selected?.name===x.name);
  const navigate=(event:React.KeyboardEvent)=>{
    if(props.rowsLoading || !rows.length)return;
    const fromSearch=(event.target as HTMLElement).tagName==='INPUT';
    const key=event.key;
    if(!['ArrowDown','ArrowUp','Home','End','Enter'].includes(key) || (fromSearch && ['Home','End'].includes(key)))return;
    event.preventDefault();
    const index=key==='Home'?0:key==='End'?rows.length-1:key==='ArrowDown'?Math.min(rows.length-1,rowIndex+1):key==='ArrowUp'?Math.max(0,rowIndex-1):Math.max(0,rowIndex);
    props.onSelect(rows[index]);
    const node=grid.current?.querySelectorAll<HTMLButtonElement>('.species-row')[index];
    node?.scrollIntoView?.({block:'nearest'});
    if(!fromSearch || key==='Enter')node?.focus();
  };
  return (
    <div className="workspace-page">
      {props.toolbar?createPortal(tools,props.toolbar):tools}
      <div className="workspace-grid" ref={grid} style={{gridTemplateColumns:`minmax(0, ${split}fr) 10px minmax(0, ${100-split}fr)`}}>
        <section className="species-panel panel">
          <div className="table-toolbar">
            <label className="search-box">
              <Search />
              <input
                aria-label={t("搜索 species", "Search species")}
                value={query}
                onChange={(e) => props.onQuery(e.target.value)}
                placeholder={t("名称 / 化学式 / 模型 · ⌘F", "Name / formula / model · ⌘F")}
                onKeyDown={e=>{if(e.key==='Escape' && query){e.preventDefault();props.onQuery('');}else navigate(e);}}
              />
              {query && (
                <button aria-label={t("清除搜索", "Clear search")} onClick={() => props.onQuery("")}>
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
                : t("元素周期表", "Periodic table")}
            </button>
            <button className={'element-filter'+(activeFilters?' active':'')} aria-label={t("筛选 species", "Filter species")} aria-expanded={showFilters} onClick={()=>setShowFilters(!showFilters)} title={t("相态与模型筛选", "Filter by phase and model")}><SlidersHorizontal size={15}/>{activeFilters>0 && <b>{activeFilters}</b>}</button>
            <HelpTip label={t("查找 species", "Find species")}>{t("⌘F 定位搜索；支持名称、化学式、原始名称及模型。精确名称和化学式优先，随后是前缀和包含匹配；化学式的元素大小写参与排序。", "⌘F focuses search. Search names, formulas, original names, and models. Exact names and formulas rank first, followed by prefix and partial matches. Element capitalization is considered when ranking formulas.")}<br/>{t("↑↓ 浏览当前页，Enter 查看；Esc 清除搜索。元素周期表筛选包含全部所选元素的 species，可与相态、模型组合。", "Use ↑↓ to browse this page, Enter to view, and Esc to clear search. Periodic-table filters match every selected element and can be combined with phase and model filters.")}</HelpTip>
          </div>
          {showFilters && <div className="filter-row">
            <select aria-label={t("筛选相态", "Filter by phase")}
              value={filters.state}
              onChange={(e) =>
                props.onFilters({ ...filters, state: e.target.value })
              }
            >
              <option value="All">{t("全部相态", "All phases")}</option>
              {(props.facets.states || []).map((state:string) => <option key={state} value={state}>{stateLabel(state)}</option>)}
            </select>
            <select aria-label={t("筛选模型", "Filter by model")}
              value={filters.model}
              onChange={(e) =>
                props.onFilters({ ...filters, model: e.target.value })
              }
            >
              <option value="All">{t("全部模型", "All models")}</option>
              {(props.facets.models || []).map((model:string) => <option key={model} value={model}>{modelLabel(model)}</option>)}
            </select>
            {activeFilters>0 && <button className="clear-filter" onClick={()=>props.onFilters({state:'All',model:'All',elements:[]})}>{t("清空筛选", "Clear filters")}</button>}
          </div>}
          <div className="table-header">
            <span>{t("名称", "Name")}</span>
            <span>{t("化学式", "Formula")}</span>
            <span>{t("相态", "Phase")}</span>
            <span>{t("模型", "Model")}</span>
          </div>
          <div className="species-scroll" aria-label={t("species 列表", "Species list")} aria-busy={props.rowsLoading} onKeyDown={navigate}>
            {rows.map((x: Species) => (
              <button
                key={`${x.id || x.name}-${x.fingerprint}`}
                disabled={props.rowsLoading}
                aria-pressed={selected?.id && x.id?selected.id===x.id:selected?.name===x.name}
                className={`species-row ${(selected?.id && x.id ? selected.id === x.id : selected?.name === x.name) ? "selected" : ""}`}
                onClick={() => props.onSelect(x)}
              >
                <strong title={x.name}>{x.name}{x.disabled ? t(" · 草稿", " · Draft") : ""}</strong>
                <ChemicalFormula value={x.formula} />
                <span title={x.state}>{stateLabel(x.state)}</span>
                <span title={modelLabel(x.model)}>{modelLabel(x.model,true)}</span>
              </button>
            ))}
            {!rows.length && (props.rowsError ? <div className="database-read-state" role="alert"><Info size={22}/><strong>{t("species 列表未能更新", "Could not update the species list")}</strong><p>{props.rowsError}</p><button className="secondary" onClick={props.onRetryRows}>{t("重新读取 species", "Reload species")}</button></div> :
              <div className="empty-list" role={props.rowsLoading?'status':undefined}>{props.rowsLoading ? t("正在读取 species…", "Loading species…") : summary.species_count ? t("没有符合条件的 species，请调整搜索或筛选。", "No species match. Adjust the search or filters.") : t("数据库还没有 species，点击“新建 species”开始。", "This database has no species yet. Choose “New species” to begin.")}</div>
            )}
          </div>
          <div className="table-footer">
            <span>
              {props.rowsLoading?t("读取中…", "Loading…"):`${total ? offset + 1 : 0}–${Math.min(offset + rows.length,total)} / ${total}`}
            </span>
            <span>
              <label className="db-page-jump">{t("页 ", "Page ")}<select aria-label={t("species 页码", "Species page number")} value={Math.floor(offset/100)} disabled={props.rowsLoading || !total} onChange={e=>props.onPage(Number(e.target.value)*100)}>{Array.from({length:Math.max(1,Math.ceil(total/100))},(_,i)=><option key={i} value={i}>{i+1} / {Math.max(1,Math.ceil(total/100))}</option>)}</select></label>
              <button
                disabled={!offset || props.rowsLoading}
                onClick={() => props.onPage(Math.max(0, offset - 100))}
              >{t("上一页", "Previous page")}</button>
              <button
                disabled={offset + rows.length >= total || props.rowsLoading}
                onClick={() => props.onPage(offset + 100)}
              >{t("下一页", "Next page")}</button>
            </span>
          </div>
        </section>
        <div className="splitter" role="separator" tabIndex={0} aria-label={t("调整 species 列表宽度", "Resize species list")} aria-orientation="vertical" aria-valuemin={32} aria-valuemax={65} aria-valuenow={split}
          onKeyDown={e => { if(e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setSplit(Math.min(65,Math.max(32,split+(e.key === "ArrowRight" ? 2 : -2)))); } }}
          onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if(e.currentTarget.hasPointerCapture(e.pointerId) && grid.current) {const rect=grid.current.getBoundingClientRect(); setSplit(Math.max(32,Math.min(65,100*(e.clientX-rect.left)/rect.width)));} }}
          onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); }} />
        <Inspector
          {...{ summary, selected, details, tp, evaluation, runtime }}
          busy={props.busy}
          detailsError={props.detailsError}
          onRetryDetails={props.onRetryDetails}
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
  useLanguage();
  return (
    <div className="popover action-menu" onClick={(e) => e.stopPropagation()}>
      {p.summary.read_only ? (
        <>
          <button onClick={p.onCompose}>{t("从系统数据库选择 species 并创建", "Create from system database species")}</button>
          <button onClick={p.onCopyAll}>{t("复制整个数据库…", "Copy entire database…")}</button>
        </>
      ) : (
        <>
          <button onClick={p.onCompose}>{t("从 Reaktoro 系统数据库添加", "Add from a Reaktoro system database")}</button>
          <button onClick={p.onImport}>{t("从 YAML / .rtdb / 文件夹添加", "Add from YAML / .rtdb / folder")}</button>
          <button onClick={p.onSaveAs}>{t("另存为 .rtdb…", "Save as .rtdb…")}</button>
          {p.selected && (
            <button className="danger" onClick={p.onDeleteSpecies}>
              <Trash2 />{t("删除所选 species", "Delete selected species")}</button>
          )}
        </>
      )}
      <hr />
      <button onClick={p.onValidate}>{t("验证数据库", "Validate database")}</button>
      <button onClick={p.onExport} disabled={!p.runtime.available} title={!p.runtime.available ? t("导出需要连接 Reaktoro 进行重新加载验证", "Connect Reaktoro to verify the export by reloading it") : ""}>{t("导出…", "Export…")}</button>
      {p.summary.path && <button onClick={p.onReveal}>{t("在 Finder 中显示", "Show in Finder")}</button>}
      <button onClick={p.onDefault}>{t("设为默认数据库", "Set as default database")}</button>
      <hr />
      <button onClick={p.onClose}>{t("关闭数据库", "Close database")}</button>
    </div>
  );
}

const fieldNames = (): Record<string, string> => ({
  name: t("名称", "Name"),
  original_name: t("原始名称", "Original name"),
  formula: t("化学式", "Formula"),
  composition: t("元素组成", "Elemental composition"),
  charge: t("电荷", "Charge"),
  state: t("相态", "Phase"),
  molar_mass_kg_mol: t("摩尔质量 (kg/mol)", "Molar mass (kg/mol)"),
  model: t("模型", "Model"),
  valid_tp: t("有效温压范围", "Valid temperature and pressure range"),
  reaction: t("形成反应", "Formation reaction"),
  dependencies: t("所需 species", "Required species"),
  activity_parameters: t("活度参数", "Activity parameters"),
  provenance: t("来源", "Provenance"),
  references: t("参考文献", "References"),
  tags: t("标签", "Tags"),
  notes: t("备注", "Notes"),
  fingerprint: t("资料校验码", "Data checksum"),
  external_reactants:t("参考 species 数据", "Reference species data"), coefficient:t("计量系数", "Stoichiometric coefficient"), source:t("来源", "Provenance"), reference:t("参数参考文献", "Parameter references"), resolution:t("赋值方式", "Assignment method"), is_default:t("是否采用源库默认规则", "Uses the source database's default rule"), reason:t("说明", "Description"), usage:t("适用说明", "Scope of use"), original_assignment:t("修改前的原始赋值", "Original assignment before editing"), source_entry:t("源参数条目", "Source parameter entry"), source_file:t("来源文件", "Source file"), source_index:t("原始记录位置", "Original record location"), source_code:t("源记录编号", "Source record ID"), source_sha256:t("源文件校验值", "Source file checksum"), record_fingerprint:t("源记录校验值", "Source record checksum"), mapping_fingerprint:t("映射校验值", "Mapping checksum"), aliases:t("原始别名", "Original aliases"), raw_name:t("原始名称", "Original name"), conversion:t("数据版本", "Data version"),
  type:t("模型类型", "Model type"), native_type:t("热力学模型", "Thermodynamic models"), parameters:t("模型参数", "Model parameters"), parameters_yaml:t("原始模型参数", "Original model parameters"), runtime_version:t("Reaktoro 版本", "Reaktoro version"), provider:t("提供者", "Provider"), group:t("数据库类型", "Database type"), database:t("数据库", "Database"), source_path:t("来源路径", "Source path"), reactants:t("反应物及系数", "Reactants and coefficients"), equation:t("反应式", "Reaction equation"), model_parameters_yaml:t("反应模型参数", "Reaction model parameters"), temperature_K:t("温度范围 (K)", "Temperature range (K)"), pressure_Pa:t("压力范围 (Pa)", "Pressure range (Pa)"), ion_size_angstrom:t("离子尺寸 aᵢ (Å)", "Ion size aᵢ (Å)"), calibration:t("平衡常数拟合", "Equilibrium constant fit"), version:t("版本", "Version"), unit:t("单位", "Units"),
});
const stateLabel = (value:string) => ({Aqueous:t("水溶液", "Aqueous"),Gas:t("气相", "Gas"),Liquid:t("液相", "Liquid"),Solid:t("固相", "Solid"),CrystallineSolid:t("晶体固相", "Crystalline solid"),IonExchange:t("离子交换", "Ion exchange"),Adsorbed:t("吸附态", "Adsorbed"),Unknown:t("未指定", "Unspecified")}[value] || value || "—");
const modelLabel=(value:string,short=false)=>({"extended-maier-kelley":short?'EMK':'Extended Maier–Kelley',"modified-ryzhenko-bryzgalin":short?'MRB':'Modified Ryzhenko–Bryzgalin',"akinfiev-diamond":short?'AD':'Akinfiev–Diamond',"reaktoro-native":t("Reaktoro 数据", "Reaktoro data"),"converted-standard-state":t("数据库热力学模型", "Database thermodynamic model"),"HollandPowell":'Holland–Powell',"WaterHKF":t("HKF（水）", "HKF (water)"),"PhreeqcLgK":'PHREEQC log K',"StandardThermoModel":t("数据库标准态", "Database standard state"),"VantHoff":'van’t Hoff',"ReactionStandardThermoModel":t("反应标准态模型", "Reaction standard-state model")}[value] || (value ? translateModelMessage(value) : "") || t("未提供", "Not provided"));
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
  validation,detailsError,onRetryDetails,
}: any) {
  useLanguage();
  const [tab, setTab] = useState("overview");
  useEffect(() => setTab("overview"), [selected?.id, selected?.name]);
  if (!selected)
    return (
      <section className="inspector panel empty-inspector">
        <Atom />
        <p>{t("选择 species，查看热力学性质与数据来源。", "Select a species to inspect its thermodynamic properties and data sources.")}</p>
      </section>
    );
  const reaction = details?.reaction && Object.keys(details.reaction).length;
  const tabs = [
    ["overview", t("概览", "Overview")],
    ["model", t("模型与参数", "Model and parameters")],
    ...(reaction ? [["reaction", t("形成反应", "Formation reaction")]] : []),
    ["source", t("来源与参考文献", "Sources and references")],
    ...(!summary.read_only ? [["validation", t("验证", "Validation")]] : []),
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
            <Pencil />{t("编辑", "Edit")}</button>
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
        {!details ? <div className="database-read-state" role={detailsError?'alert':'status'}>{detailsError?<><Info size={22}/><strong>{t("详情暂时无法显示", "Details are unavailable")}</strong><p>{translateDatabaseMessage(detailsError)}</p><button className="secondary" onClick={onRetryDetails}>{t("重新读取详情", "Reload details")}</button></>:<><RefreshCw size={20}/><p>{t("正在读取 ", "Loading ")}{selected.name}{t(" 的参数与来源…", " parameters and sources…")}</p></>}</div> : <>
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
            <h3 className="section-caption">{t("指定温压计算", "Evaluate at temperature and pressure")}</h3>
            <TrialConditions value={tp} onChange={onTp}/>
            <button
              className="primary full-button"
              disabled={!details || selected.disabled || busy || (!runtime.available && selected.model !== "extended-maier-kelley")}
              title={selected.disabled ? t("草稿不参与计算", "Draft species are excluded from calculations") : !runtime.available ? t("除 Extended Maier–Kelley 外，计算需要连接 Reaktoro", "Connect Reaktoro to calculate models other than Extended Maier–Kelley") : ""}
              onClick={onEvaluate}
            >
              <Activity />{t("计算标准热力学性质", "Calculate standard thermodynamic properties")}</button>
            {evaluation && <ThermoResults report={evaluation} />}
          </>
        )}
        {tab === "model" && (
          <>
            <CardRows
              data={{ model: modelLabel(details?.model_definition?.label || details?.model?.native_type || details?.model?.type), ...(details?.model?.runtime_version ? {runtime_version:details.model.runtime_version} : {}), valid_tp: details?.valid_tp }}
            />
            <ModelParameterTable value={details?.model_parameters || details?.model?.parameters} definition={details?.model_definition} />
            {!details?.model_parameters && !details?.model?.parameters && details?.model?.parameters_yaml && <details className="raw-model-parameters"><summary>{t("查看源模型参数", "View source model parameters")}</summary><pre>{details.model.parameters_yaml}</pre></details>}
            {details?.activity_parameters &&
              Object.keys(details.activity_parameters).length > 0 && (
                <div className="notice">
                  <strong>{t("活度模型参数", "Activity model parameters")}</strong>
                  <p>{t("仅在记录声明的适用活度模型中使用；其中 aᵢ 是经验模型参数，并非物理半径。", "Use only with the activity model stated in the record. The ion size aᵢ is an empirical parameter, not a physical radius.")}</p>
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
              }}
            />
            <ReferenceList references={details?.references} />
          </>
        )}
        {tab === "validation" && (
          <p className="empty-note">
            {validation ? t(`最近验证：${validation.status === "valid" ? "通过" : `${validation.issues.length} 项待检查`}。使用“操作 → 验证数据库”查看完整报告。`, `Last validation: ${validation.status === "valid" ? "passed" : `${validation.issues.length} items need review`}. See the full report under Actions → Validate database.`) : t("尚未执行验证。使用“操作 → 验证数据库”检查模型参数、形成反应和引用 species。草稿不参与计算或正式导出。", "Not yet validated. Use Actions → Validate database to check model parameters, formation reactions, and referenced species. Drafts are excluded from calculations and final exports.")}
          </p>
        )}
        </>}
      </div>
    </section>
  );
}
export function ModelParameterTable({value,definition}:{value:unknown;definition?:ModelDefinition}) {
  useLanguage();
  const rows:{name:string,value:unknown}[]=[];
  const visit=(item:unknown,path:string[])=>{
    if(item === null || item === undefined) return;
    if(Array.isArray(item)) { item.forEach((child,index)=>visit(child,item.length === 1 && path.length === 0 ? path : [...path,String(index+1)])); return; }
    if(typeof item === "object") { Object.entries(item).forEach(([key,child])=>visit(child,[...path,key])); return; }
    rows.push({name:path.join(" / "),value:item});
  };
  visit(value,[]);
  if(!rows.length) return <p className="empty-note">{t("尚无可显示的模型参数。", "No model parameters to display.")}</p>;
  const hasUnits=Boolean(definition?.parameters?.length);
  return <section className="model-parameters"><h3>{t("模型参数", "Model parameters")}</h3><table><thead><tr><th>{t("参数", "Parameter")}</th><th>{t("数值", "Value")}</th>{hasUnits && <th>{t("单位", "Units")}</th>}</tr></thead><tbody>{rows.map((row,index)=>{const parameter=definition?.parameters?.find(item=>item.name===row.name);return <tr key={index}><td title={row.name}>{parameter?.label ? translateModelMessage(parameter.label) : row.name}</td><td>{typeof row.value === "number" ? <ReadableNumber value={row.value}/> : String(row.value)}</td>{hasUnits && <td>{parameter?.unit || t("未声明", "Not specified")}</td>}</tr>;})}</tbody></table>{!hasUnits && <p className="empty-note">{t("参数名称和单位请参照该模型的原始文献。", "Refer to the model's original publication for parameter definitions and units.")}</p>}</section>;
}
function CardRows({ data }: { data: Record<string, unknown> }) {
  useLanguage();
  return (
    <div className="detail-card">
      {Object.entries(data).map(([key, value]) => (
        <div className="detail-row" key={key}>
          <span>{fieldNames()[key] || extraFieldNames()[key] || key}</span>
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
const hiddenSourceFields=new Set(['read_only','request_id','ok','id','fingerprint','source_fingerprint','record_fingerprint','mapping_fingerprint','source_sha256','source_index','conversion','schema','return_code']);
const extraFieldNames = (): Record<string,string> => ({source_parameters:t("原始参数", "Original parameters"),Code:t("记录编号", "Record ID"),code:t("编号", "ID"),Cp:t("热容", "Heat capacity"),nCp:t("热容项数", "Number of heat-capacity terms"),Form:t("化学式", "Formula"),Param:t("参数", "Parameter"),comment:t("说明", "Description"),quality:t("数据质量", "Data quality"),active:t("启用", "Enabled"),species:'species',a_angstrom:t("离子尺寸 aᵢ (Å)", "Ion size aᵢ (Å)"),merged_sources:t("补充来源", "Additional sources"),valid_tp_alternatives:t("其他来源的适用范围", "Validity ranges from other sources")});
function Value({ value }: { value: unknown }) {
  useLanguage();
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "string" && /^<.+ object at 0x[0-9a-f]+>$/i.test(value)) ||
    (typeof value === "object" && !Object.keys(value as object).length)
  )
    return <strong className="not-provided">{t("未提供", "Not provided")}</strong>;
  if (typeof value === "object")
    return (
      <div className="structured-value">
        {Array.isArray(value)
          ? value.map((x, i) => (
              <div key={i}>
                <Value value={x} />
              </div>
            ))
          : Object.entries(value as Record<string, unknown>).filter(([k]) => !hiddenSourceFields.has(k) && !(k === "parameters_yaml" && !!(value as any).parameters)).map(([k, v]) => (
              <div key={k}>
                <b>{fieldNames()[k] || extraFieldNames()[k] || k}</b>
                <Value value={v} />
              </div>
            ))}
      </div>
    );
  if(typeof value==='number')return <ReadableNumber value={value}/>;
  return <strong>{typeof value==='boolean'?(value?t("是", "Yes"):t("否", "No")):String(value)}</strong>;
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
  useLanguage();
  return (
    <div className="thermo-results">
      {Object.entries(report.properties || {}).map(([key, value]) => (
        <div key={key}>
          <span title={key}>{thermoNames[key] || key}</span>
          {typeof value==='number'&&Number.isFinite(value)?<ReadableNumber value={value}/>:<strong>{t("Reaktoro 未提供", "Not provided by Reaktoro")}</strong>}
          <small>{report.units?.[key] || ""}</small>
        </div>
      ))}
    </div>
  );
}
function ReferenceList({ references }: { references: any[] }) {
  useLanguage();
  if (!references?.length)
    return (
      <p className="empty-note">{t("尚无参考文献。可查阅该数据库的说明文件或原始文献。", "No references yet. Consult the database documentation or original publications.")}</p>
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
  summary,catalog,onSetDefault,onChooseDefaultFile,onHistory,
}: any) {
  useLanguage();
  const tabs = [
    ["general", t("常规", "General")],
    ["database", t("数据库与文件", "Databases and files")],

    ["runtime", t("Reaktoro 环境", "Reaktoro environment")],
    ["about", t("关于", "About")],
  ];
  return (
    <div className="scroll-page settings-page">
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
                title={t("界面语言", "Interface language")}
                copy={t("切换菜单、表单与帮助的语言，当前输入保持不变。", "Choose the language for menus, forms, and help. Your current entries are preserved.")}
              >
                <select aria-label={t("界面语言", "Interface language")} value={prefs.language} onChange={e=>onPrefs({...prefs,language:e.target.value})}><option value="zh-CN">简体中文</option><option value="en">English</option></select>
              </Setting>
              <Setting title={t("自动保存模拟", "Save simulations automatically")} copy={t("关闭后手动保存；切换数据库、模拟或退出时询问如何处理未保存内容。", "When disabled, save manually. When switching databases or simulations, or quitting, you will be asked how to handle unsaved changes.")}><input type="checkbox" aria-label={t("自动保存模拟", "Save simulations automatically")} checked={prefs.auto_save_simulations!==false} onChange={e=>onPrefs({...prefs,auto_save_simulations:e.target.checked})}/></Setting>
              <Setting title={t("编辑与快捷键", "Editing and keyboard shortcuts")} copy={t("模拟支持撤销、重做和恢复到上次保存；具体参数与图表偏好在对应页面设置。", "Simulations support undo, redo, and restoring the last saved state. Parameter and chart options are available in their workspaces.")}><span className="setting-value">{t("⌘ / Ctrl + S 保存", "⌘ / Ctrl + S Save")}<br/>{t("⌘ / Ctrl + Z 撤销", "⌘ / Ctrl + Z Undo")}<br/>{t("⇧ + ⌘ / Ctrl + Z 重做", "⇧ + ⌘ / Ctrl + Z Redo")}</span></Setting>
              <Setting title={t("主题", "Appearance")} copy={t("立即生效并在重启后保持。", "Applies immediately and is remembered after restarting.")}>
                <select aria-label={t("主题", "Appearance")}
                  value={prefs.theme}
                  onChange={(e) => onPrefs({ ...prefs, theme: e.target.value })}
                >
                  <option value="system">{t("跟随系统", "Follow system")}</option>
                  <option value="light">{t("浅色", "Light")}</option>
                  <option value="dark">{t("深色", "Dark")}</option>
                </select>
              </Setting>
              <Setting title={t("界面密度", "Interface density")} copy={t("控制列表与表单间距。", "Adjust spacing in lists and forms.")}>
                <select aria-label={t("界面密度", "Interface density")}
                  value={prefs.density}
                  onChange={(e) =>
                    onPrefs({ ...prefs, density: e.target.value })
                  }
                >
                  <option value="comfortable">{t("舒适", "Comfortable")}</option>
                  <option value="compact">{t("紧凑", "Compact")}</option>
                </select>
              </Setting>
              <Setting title={t("启动时打开", "Open at startup")} copy={t("下次启动生效；继续上次模拟会恢复其数据库、参数和代码。", "Applies next time the app starts. Continuing the last simulation restores its database, parameters, and code.")}><select aria-label={t("启动时打开", "Open at startup")} value={prefs.startup} onChange={e=>onPrefs({...prefs,startup:e.target.value})}><option value="home">{t("主页", "Home")}</option><option value="databases">{t("数据库", "Database")}</option><option value="simulation">{t("上次模拟", "Last simulation")}</option><option value="results">{t("结果", "Results")}</option></select></Setting>
            </>
          )}
          {settingsTab === "database" && (
            <>
              <Setting
                title={t("默认数据库", "Default database")}
                copy={
                  prefs.default_database
                    ? prefs.default_database.kind === "rtdb" ? prefs.default_database.path : `${prefs.default_database.group} / ${prefs.default_database.name}`
                    : t("尚未设置", "Not set")
                }
              >
                <div className="settings-default-db"><select aria-label={t("默认数据库", "Default database")} value={prefs.default_database?JSON.stringify(prefs.default_database):""} onChange={e=>onPrefs({...prefs,default_database:e.target.value?JSON.parse(e.target.value):undefined})}><option value="">{t("未设置", "Not set")}</option>{prefs.default_database&&<option value={JSON.stringify(prefs.default_database)}>{prefs.default_database.kind==="rtdb"?localDatabaseName(prefs.default_database.path):prefs.default_database.name}{t("（当前默认）", " (current default)")}</option>}<optgroup label={t("我的数据库", "My databases")}>{prefs.recent_databases.map((r:Recent)=><option key={r.path} value={JSON.stringify({kind:"rtdb",path:r.path})}>{r.name}</option>)}</optgroup><optgroup label={t("系统数据库", "System databases")}>{catalog.map((r:Catalog)=><option key={r.id} value={JSON.stringify({kind:"official",group:r.group,name:r.embedded_name})}>{r.embedded_name}</option>)}</optgroup></select><div className="button-row"><button className="secondary" disabled={!summary} onClick={onSetDefault}>{t("使用当前数据库", "Use current database")}</button><button className="secondary" onClick={onChooseDefaultFile}>{t("选择文件…", "Choose file…")}</button></div></div>
                <button
                  className="text-button"
                  disabled={!prefs.default_database}
                  onClick={() => {
                    const n = { ...prefs };
                    delete n.default_database;
                    onPrefs(n);
                  }}
                >{t("清除", "Clear")}</button>
              </Setting>
              <Setting
                title={t("最近数据库", "Recent databases")}
                copy={t(`${prefs.recent_databases.length} 个有效记录`, `${prefs.recent_databases.length} available entries`)}
              >
                <button
                  className="secondary"
                  disabled={!prefs.recent_databases.length}
                  onClick={() => onPrefs({ ...prefs, recent_databases: [] })}
                >{t("清除列表", "Clear list")}</button>
              </Setting>
<DirectorySetting title={t("默认保存位置", "Default save location")} value={prefs.save_directory} onChange={save_directory=>onPrefs({...prefs,save_directory})}/><DirectorySetting title={t("默认导出位置", "Default export location")} value={prefs.export_directory} onChange={export_directory=>onPrefs({...prefs,export_directory})}/>            </>
          )}

          {settingsTab === "runtime" && (
            <>
              <div className="runtime-settings-head">
                <div>
                  <span className={`status-chip ${runtime.status}`}>
                    {runtime.available ? t("已连接", "Connected") : t("未连接", "Not connected")}
                  </span>
                  <h3>
                    {runtime.available
                      ? `Reaktoro ${runtime.version}`
                      : t("尚未连接 Reaktoro", "Reaktoro is not connected")}
                  </h3>
                  <p>{runtime.python || (runtime.diagnostic?errText(runtime.diagnostic):'')}</p>
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
                  {discovering ? t("正在检查…", "Checking…") : t("检查并重新连接", "Check and reconnect")}
                </button>
                <button className="primary" onClick={onChoose}>{t("选择 Python", "Choose Python")}</button>
                <button className="secondary" onClick={onChooseFolder}>{t("选择环境文件夹", "Choose environment folder")}</button>
                <button
                  className="secondary"
                  disabled={!runtime.available}
                  onClick={onDiagnose}
                >{t("检查连接", "Check connection")}</button>
              </div>
              <p className="setting-copy">{t("检查当前连接，并在连接中断时重新连接。正常连接会保留已打开的数据库；其他已安装环境列在下方。", "Check the current connection and reconnect if needed. A working connection keeps the open database. Other installed environments are listed below.")}</p>
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
              <p>{t("版本 ", "Version ")}{APP_VERSION}</p>
              <dl>
                <div>
                  <dt>{t("许可证", "License")}</dt>
                  <dd>MIT</dd>
                </div>
                <div>
                  <dt>{t("计算工具", "Calculation engine")}</dt>
                  <dd>Reaktoro{runtime.version?' '+runtime.version:''}</dd>
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
  useLanguage();
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
  useLanguage();
  const tests = [
    [t("计算服务连接", "Calculation service connection"), data.bridge?.pid ? t("通过", "Passed") : t("失败", "Failed")],
    [t("Reaktoro 可用性", "Reaktoro availability"), data.probe?.available ? t("通过", "Passed") : t("失败", "Failed")],
    [t("Reaktoro 版本", "Reaktoro version"), data.probe?.version || t("不可用", "Unavailable")],
    [t("已打开数据库", "Open databases"), String(data.bridge?.handles ?? 0)],
    [t("模型类型", "Model type"), t(`${data.model_registry?.length || 0} 个模型`, `${data.model_registry?.length || 0} models`)],
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
  useLanguage();
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
          <button disabled={busy} aria-label={t("关闭对话框", "Close dialog")} onClick={onClose}>
            <X />
          </button>
        </header>
        {error && <p className="inline-error" role="alert" tabIndex={-1}>{translateDatabaseMessage(error)}</p>}
        <fieldset className="modal-fields" disabled={busy}>{children}</fieldset>
        {busy && <p className="modal-copy" role="status">{t("正在处理，请稍候…", "Working, please wait…")}</p>}
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
  useLanguage();
  const [path, setPath] = useState("");
  const operation = useOperation();
  return (
    <Modal title={t("新建空白数据库", "New blank database")} onClose={onClose} {...operation}>
      <p className="modal-copy">{t("数据库名称使用你保存的 .rtdb 文件名，例如“热液实验.rtdb”在界面中显示为“热液实验”。", "The database name comes from its saved .rtdb filename. For example, “Hydrothermal experiment.rtdb” appears as “Hydrothermal experiment”.")}</p>
      <div className="field-label">
        <label htmlFor="new-db-path">{t("保存位置", "Save location")}</label>
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
          >{t("选择…", "Choose…")}</button>
        </div>
      </div>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t("取消", "Cancel")}</button>
        <button
          className="primary"
          disabled={!path}
          onClick={() => operation.run(async () => {
            const r = await api<{ summary: Summary }>("rtdb_create", {
              path,
            });
            onCreated(r.summary);
          })}
        >{t("创建", "Create")}</button>
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
  if(typeof reference==="string")return reference;
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
  registerExit,
  onExit,
}: {
  registerExit?:(request:(()=>void)|null)=>void;
  onExit?:()=>void;
  handleId: string;
  existing: any;
  onClose: () => void;
  onSaved: (x: any) => Promise<void> | void;
}) {
  useLanguage();
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
    (existing?.references || []).map((reference: any) => typeof reference==="string"?reference:({ ...reference })),
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
  const [choosingElements,setChoosingElements]=useState(false);
  const [confirmCancel,setConfirmCancel] = useState<"close"|"exit"|null>(null);
  const cancel = () => changed ? setConfirmCancel("close") : onClose();
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
  const thermoLocked = modelType === "reaktoro-native" || modelType === "converted-standard-state";
  const selectedElements = Object.keys(composition);
  const automaticFormula = generatedFormula(
    composition,
    Number(value.charge || 0),
  );
  const formula = formulaCustomized ? formulaText : automaticFormula;
  const editSnapshot=JSON.stringify({value,composition,formula,parameters,reactionRows:reactionRows.map(({name,coefficient})=>({name,coefficient})),references,activityEnabled,ionSize,mrbMode,mrbValueKind,mrbRows,mrbFitReport});
  const initialSnapshot=useRef(editSnapshot);
  const changed=editSnapshot !== initialSnapshot.current;
  useEffect(()=>{registerExit?.(()=>{if(saving||fitting){setEditorError(t("正在保存或拟合，请稍候再退出。", "Saving or fitting is in progress. Wait before closing."));return;}if(changed)setConfirmCancel("exit");else onExit?.();});return()=>registerExit?.(null);},[changed,saving,fitting,registerExit,onExit]);
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
      .catch((error) => setEditorError(t(`编辑器初始化失败：${errText(error)}`, `Could not initialize the editor: ${errText(error)}`)));
  }, [handleId]);

  const modelDrafts=useRef(new Map<string,{model:any;parameters:Record<string,number|string>;reactionRows:typeof reactionRows;fit:any}>());
  const changeModel = (type: string) => {
    if(type===modelType)return;
    modelDrafts.current.set(modelType,{model:structuredClone(value.model),parameters:structuredClone(parameters),reactionRows:structuredClone(reactionRows),fit:structuredClone(mrbFitReport)});
    const previous=modelDrafts.current.get(type);
    setValue({ ...value, model: previous?.model || { type, parameters: {} }, disabled: false });
    setParameters(previous?.parameters || {});
    setReactionRows(previous?.reactionRows || []);
    setMrbFitReport(previous?.fit || null);
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
        row === index ? { ...(typeof reference==="string"?{raw:reference}:reference), [key]: next } : reference,
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
        throw new Error(t(`第 ${index + 1} 行尚未填写完整。`, `Complete all fields in row ${index + 1}.`));
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
        throw new Error(t(`第 ${index + 1} 行的温度、压力或平衡常数无效。`, `Row ${index + 1} has an invalid temperature, pressure, or equilibrium constant.`));
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
      if (!value.name.trim()) throw new Error(t("请输入 species 名称。", "Enter a species name."));
      if (!selectedElements.length) throw new Error(t("请先从周期表选择元素。", "Select elements from the periodic table first."));
      if (Object.values(composition).some((amount) => !Number.isFinite(amount) || amount <= 0))
        throw new Error(t("每个元素的化学计量数必须大于 0。", "Every elemental stoichiometric coefficient must be greater than 0."));
      if (!model) throw new Error(t("请选择一个已加载的热力学模型。", "Choose an available thermodynamic model."));
      if (
        modelType === "modified-ryzhenko-bryzgalin" &&
        mrbMode === "fit" &&
        !mrbFitReport
      )
        throw new Error(t("平衡常数数据已修改，请先完成 MRB 拟合。", "Equilibrium constant data have changed. Fit the MRB parameters again before saving."));
      const numericParameters = Object.fromEntries(
        model.parameters.map((parameter) => {
          const raw = parameters[parameter.name];
          if (parameter.required && (raw === "" || raw === undefined))
            throw new Error(t(`请填写模型参数“${translateModelMessage(parameter.label)}”。`, `Enter the model parameter “${translateModelMessage(parameter.label)}”.`));
          const number = Number(raw);
          if (!Number.isFinite(number))
            throw new Error(t(`模型参数“${translateModelMessage(parameter.label)}”必须是数值。`, `Model parameter “${translateModelMessage(parameter.label)}” must be a number.`));
          return [parameter.name, number];
        }),
      );
      if (model.states.length && !model.states.includes(value.state))
        throw new Error(
          t(`${translateModelMessage(model.label)} 仅适用于 ${model.states.join("、")} 相态。`, `${translateModelMessage(model.label)} applies only to these phases: ${model.states.map(stateLabel).join(", ")}.`),
        );
      if (model.reaction_based && !reactionRows.length)
        throw new Error(t("该模型必须指定形成反应所依赖的 species。", "This model requires reference species for its formation reaction."));
      if (
        reactionRows.some(
          (row) => !row.name || !Number.isFinite(row.coefficient) || row.coefficient === 0,
        )
      )
        throw new Error(t("依赖 species 和计量系数必须完整填写。", "Enter both the reference species and its stoichiometric coefficient."));
      if(new Set(reactionRows.map(row => row.name)).size !== reactionRows.length) throw new Error(t("同一个已有 species 只能填写一行，请合并计量系数。", "Each existing species can appear only once. Combine its stoichiometric coefficients."));
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
            t("有效范围必须填写有效的最小值和最大值，且最小值小于最大值。", "Enter valid minimum and maximum values for the range, with the minimum below the maximum."),
          );
        return values;
      };
      const temperatureRange = range(validTemperature);
      const pressureRange = range(validPressure);
      if (
        activityEnabled && value.state === "Aqueous" && Number(value.charge) !== 0 &&
        (!Number.isFinite(Number(ionSize)) || Number(ionSize) <= 0)
      )
        throw new Error(t("扩展 Debye–Hückel 离子尺寸 aᵢ 必须大于 0 Å。", "The extended Debye–Hückel ion size aᵢ must be greater than 0 Å."));
      setSaving(true);
      await onSaved({
        ...value,
        name: value.name.trim(),
        formula,
        composition,
        model: {
          ...value.model,
          type: modelType,
          parameters: thermoLocked ? value.model?.parameters : numericParameters,
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
          : thermoLocked ? value.reaction : {},
        dependencies: model.reaction_based
          ? reactionRows.map((row) => row.name)
          : thermoLocked ? value.dependencies : [],
        activity_parameters: !activityTouched || foreignActivity ? (value.activity_parameters || {}) :
          activityEnabled
            ? {
                ...value.activity_parameters,
                model: "extended-debye-huckel",
                ion_size_angstrom: Number(ionSize),
              }
            : {},
        references: references.filter(reference=>typeof reference==="string"?reference.trim():Object.values(reference).some(Boolean)),
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
    <Modal title={existing ? t("编辑 species", "Edit species") : t("新建 species", "New species")} onClose={cancel} wide busy={saving || fitting} error={translateDatabaseMessage(editorError)}>
      {confirmCancel && <ConfirmDialog title={confirmCancel==="exit"?t("有未保存的 species 修改，确定退出？", "Quit with unsaved species changes?"):t("放弃当前 species 的修改？", "Discard changes to this species?")} onCancel={()=>setConfirmCancel(null)} onConfirm={()=>confirmCancel==="exit"?onExit?.():onClose()} confirmLabel={confirmCancel==="exit"?t("放弃修改并退出", "Discard changes and quit"):t("放弃表单修改", "Discard form changes")}><p>{t("当前填写的内容尚未保存。继续编辑可保留这些内容；放弃后无法恢复。", "Your entries have not been saved. Continue editing to keep them; discarded changes cannot be recovered.")}</p></ConfirmDialog>}
      <nav className="editor-jumpnav" aria-label={t("species 表单章节", "Species form sections")}><button type="button" onClick={()=>jumpTo('editor-composition')}>{t("组成与身份", "Composition and identity")}</button><button type="button" onClick={()=>jumpTo('editor-model')}>{t("热力学模型", "Thermodynamic models")}</button>{model?.reaction_based && <button type="button" onClick={()=>jumpTo('editor-reaction')}>{t("形成反应", "Formation reaction")}</button>}{value.state === 'Aqueous' && Number(value.charge)!==0 && <button type="button" onClick={()=>jumpTo('editor-activity')}>{t("活度参数", "Activity parameters")}</button>}<button type="button" onClick={()=>jumpTo('editor-references')}>{t("文献与备注", "References and notes")}</button></nav>
      <div className="species-editor">
        <section className="editor-section" id="editor-composition">
          <header>
            <b>1</b>
            <div>
              <h3>{t("定义组成", "Define composition")}</h3>
              <p>{t("先选择元素并填写化学计量数。系统生成初始化学式，你可以按数据库命名习惯继续修改。", "Select elements and enter their stoichiometric coefficients. An initial formula is generated automatically; you can edit it to follow your database's naming conventions.")}</p>
            </div>
          </header>
          <label className="field-label">{t("species 名称", "Species name")}<input
              value={value.name}
              onChange={(e) => setValue({ ...value, name: e.target.value })}
              placeholder={t("用于数据库中的唯一名称", "Unique name in this database")}
            />
          </label>
          {!thermoLocked && <div className="element-picker-summary"><button type="button" className="secondary" onClick={()=>setChoosingElements(true)}>{t("选择组成元素", "Choose constituent elements")}</button><span>{selectedElements.length?selectedElements.join(" · "):t("尚未选择元素", "No elements selected")}</span>{selectedElements.length>0&&<button type="button" className="text-button" onClick={()=>changeElements([])}>{t("清除已选元素", "Clear selected elements")}</button>}</div>}
          {choosingElements&&<ElementChooser selected={selectedElements} onApply={changeElements} onClose={()=>setChoosingElements(false)}/>}
          {selectedElements.length > 0 && (
            <div className="composition-editor">
              {selectedElements.map((symbol) => {
                const element = ELEMENTS.find((item) => item.symbol === symbol);
                return (
                  <label key={symbol}>
                    <span>
                      <strong>{symbol}</strong>
                      <small>
                        {element && t(element.zh+" · "+element.en,element.en)}
                      </small>
                    </span>
                    <input
                      type="number"
                      disabled={thermoLocked}
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
              <span>{t("最终电荷", "Net charge")}</span>
              <input
                type="number"
                disabled={thermoLocked}
                step="1"
                value={value.charge}
                onChange={(e) =>
                  setValue({ ...value, charge: Number(e.target.value) })
                }
              />
            </label>
            <label className="identity-field state-field">
              <span>{t("相态", "Phase")}</span>
              <select
                disabled={thermoLocked}
                value={value.state}
                onChange={(e) => setValue({ ...value, state: e.target.value })}
              >
                {[...new Set(["Aqueous","Gas","Liquid","Solid",value.state])].map(state => <option key={state} value={state}>{stateLabel(state)}</option>)}
              </select>
            </label>
            <div className="identity-field formula-field">
              <label htmlFor="species-formula">{t("化学式", "Formula")}<small>{formulaCustomized ? t("已修改", "Edited") : t("自动生成", "Generated automatically")}</small>
              </label>
              <div className="formula-control">
                <input
                  id="species-formula"
                  disabled={thermoLocked}
                  value={formula}
                  placeholder={t("请先选择元素", "Select elements first")}
                  onChange={(event) => {
                    setFormulaText(event.target.value);
                    setFormulaCustomized(true);
                  }}
                />
                <button
                  className="formula-reset"
                  disabled={!formulaCustomized || thermoLocked}
                  title={t("恢复自动生成", "Restore automatic formula")}
                  onClick={() => {
                    setFormulaCustomized(false);
                    setFormulaText(automaticFormula);
                  }}
                >
                  <RefreshCw />
                  <span>{t("恢复自动生成", "Restore automatic formula")}</span>
                </button>
              </div>
              {formula ? (
                <div className="formula-preview-inline">
                  <small>{t("排版预览", "Formula preview")}</small>
                  <strong>
                    <ChemicalFormula value={formula} />
                  </strong>
                  <em>{t("可加入括号或相态标记", "Parentheses and phase labels are supported")}</em>
                </div>
              ) : (
                <em className="formula-hint">{t("选择元素后自动生成，也可以直接编辑", "Generated from the selected elements; you can also edit it directly")}</em>
              )}
            </div>
          </div>
        </section>

        <section className="editor-section" id="editor-model">
          <header>
            <b>2</b>
            <div>
              <h3>{t("选择标准态热力学模型", "Choose a standard-state thermodynamic model")}</h3>
              <p>{t("选择与数据来源一致的模型，按标明的单位填写参数。", "Choose the model used by your data source and enter parameters in the stated units.")}</p>
            </div>
          </header>
          <label className="field-label">{t("模型", "Model")}<select
              disabled={thermoLocked}
              value={modelType}
              onChange={(e) => changeModel(e.target.value)}
            >
              {definitions
                .filter((item) => item.creatable || item.id === modelType)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {translateModelMessage(item.label)}
                  </option>
                ))}
            </select>
          </label>
          {model && (
            <div className="model-description">
              <strong>{translateModelMessage(model.label)}</strong>
              <p>{translateModelMessage(model.description)}</p>
              {!model.creatable && (
                <span>{t("这是已有来源记录，不能作为从零创建的新模型。", "This is an existing source record and cannot be used to create a model from scratch.")}</span>
              )}
            </div>
          )}
          {modelType === "modified-ryzhenko-bryzgalin" && (
            <div className="mrb-mode">
              <button
                className={mrbMode === "parameters" ? "active" : ""}
                onClick={() => setMrbMode("parameters")}
              >{t("直接输入三个参数", "Enter three parameters directly")}</button>
              <button
                className={mrbMode === "fit" ? "active" : ""}
                onClick={() => setMrbMode("fit")}
              >{t("用多温压平衡常数拟合", "Fit equilibrium constants at multiple temperatures and pressures")}</button>
            </div>
          )}
          {modelType === "modified-ryzhenko-bryzgalin" && mrbMode === "fit" && (
            <div className="mrb-fit-editor">
              <div className="mrb-fit-heading">
                <div>
                  <strong>{t("实验或文献平衡常数", "Experimental or published equilibrium constants")}</strong>
                  <p>{t("输入至少 3 组温度、压力和观测值。选择 log K 时按热力学约定转换为 pK = −log K，再拟合 MRB 三参数。", "Enter at least 3 sets of temperature, pressure, and observed values. log K values are converted using pK = −log K before fitting the three MRB parameters.")}</p>
                </div>
                <label>{t("输入值", "Input quantity")}<select
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
                  <span>{t("温度 (°C)", "Temperature (°C)")}</span>
                  <span>{t("压力 (bar)", "Pressure (bar)")}</span>
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
                    >{t("删除", "Delete")}</button>
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
                  <Plus />{t("添加数据点", "Add data point")}</button>
                <button
                  className="primary"
                  onClick={async () => {
                    try {
                      await fitMrb();
                    } catch (error) {
                      alert(t(`MRB 拟合失败：${errText(error)}`, `MRB fit failed: ${errText(error)}`));
                    }
                  }}
                >{t("拟合 MRB 参数", "Fit MRB parameters")}</button>
              </div>
              {mrbFitReport && (
                <div className="mrb-fit-result">
                  <div className="mrb-fit-status">
                    <Check />
                    <div>
                      <strong>{t("拟合成功，参数已写入当前表单", "Fit complete; parameters are in this form")}</strong>
                      <p>{t("尚未保存到数据库。请完成其余字段后点击“保存 species”，再保存数据库文件。", "These parameters have not been saved to the database. Complete the remaining fields, choose “Save species”, then save the database file.")}</p>
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
                    {translateModelMessage(parameter.label)}
                    <small>{translateModelMessage(parameter.help)}</small>
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
          ) : thermoLocked ? (
            <p className="empty-note">
              {modelType === "converted-standard-state"
                ? t("当前模型的热力学参数不可在这里修改。可以编辑名称、适用温压范围、参考文献、活度参数和备注。", "Thermodynamic parameters for this model cannot be edited here. You can edit the name, valid temperature and pressure ranges, references, activity parameters, and notes.")
                : t("当前模型参数来自所选数据库，不可在这里修改。可以补充适用温压范围、参考文献、活度参数和备注。", "These model parameters come from the selected database and cannot be edited here. You can add valid temperature and pressure ranges, references, activity parameters, and notes.")}
            </p>
          ) : null}
          {model?.calculable && (
            <div className="valid-range">
              <h4>{t("有效温压范围（可选）", "Valid temperature and pressure range (optional)")}</h4>
              <label>{t("最低温度", "Minimum temperature")}<input
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
              <label>{t("最高温度", "Maximum temperature")}<input
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
              <label>{t("最低压力", "Minimum pressure")}<input
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
              <label>{t("最高压力", "Maximum pressure")}<input
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
                <h3>{t("形成反应", "Formation reaction")}</h3>
                <p>{t("选择组成目标 species 的已有 species 并填写计量系数。MRB 给出该反应的平衡常数，已有 species 的标准态性质则用于求目标 species 的标准态性质。", "Choose existing species that form the target species and enter their stoichiometric coefficients. MRB gives the equilibrium constant for this reaction; the existing species' standard-state properties determine those of the target species.")}</p>
              </div>
            </header>
            <div className="reaction-equation">
              <span>{t("反应式预览", "Reaction preview")}</span>
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
                          <em>{t("待选择", "Not selected")}</em>
                        )}
                      </span>
                    );
                  })
                ) : (
                  <em>{t("请添加形成反应中的已有 species", "Add existing species for the formation reaction")}</em>
                )}
                <strong> ⇌ </strong>
                <span className="reaction-target">
                  {formula ? <ChemicalFormula value={formula} /> : t("目标 species", "Target species")}
                </span>
                {reactionRows.filter(row=>row.coefficient < 0).map((row,index)=><span key={index}><i> + </i><b>{Math.abs(row.coefficient) === 1 ? '' : Math.abs(row.coefficient)}</b><ChemicalFormula value={available.find(item=>item.name===row.name)?.formula || row.name || t("待选择", "Not selected")}/></span>)}
              </div>
              <small>{t("目标 species 的系数固定为 1。正系数放在左侧，负系数放在右侧；保存前会检查元素和电荷是否守恒。", "The target species has a coefficient of 1. Positive coefficients appear on the left and negative coefficients on the right. Element and charge balance are checked before saving.")}</small>
            </div>
            <div className="reaction-editor">
              {reactionRows.map((row, index) => (
                <div className="reaction-row" key={index}>
                  <div className="reaction-species-search">
                    <label>{t("已有 species", "Existing species")}</label>
                    <div className="search-box">
                      <Search />
                      <input
                        value={row.query}
                        placeholder={t("搜索 species 名称或化学式", "Search species name or formula")}
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
                        }) && <p>{t("没有匹配的已有 species。", "No matching existing species.")}</p>}
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
                  <label className="reaction-coefficient">{t("计量系数", "Stoichiometric coefficient")}<input
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
                  >{t("删除", "Delete")}</button>
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
                <Plus />{t("添加已有 species", "Add existing species")}</button>
            </div>
          </section>
        )}

        {value.state === "Aqueous" && Number(value.charge) !== 0 && (
          <section className="editor-section" id="editor-activity">
            <header>
              <b>{model?.reaction_based ? 4 : 3}</b>
              <div>
                <h3>{t("水溶液活度参数", "Aqueous activity parameters")}</h3>
                <p>{t("这是活度系数模型参数，不是标准态热力学模型参数；aᵢ 为经验离子尺寸，并非物理半径。", "These are parameters for the activity coefficient model, separate from the standard-state thermodynamic model. The ion size aᵢ is empirical, not a physical radius.")}</p>
              </div>
            </header>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={activityEnabled}
                disabled={Boolean(foreignActivity)}
                title={foreignActivity ? t("已有其他活度模型的数据，此编辑器不会覆盖", "Data for another activity model are present and will be preserved") : ""}
                onChange={(e) => {setActivityTouched(true);setActivityEnabled(e.target.checked);}}
              />
              <span>{t("记录扩展 Debye–Hückel 参数", "Record extended Debye–Hückel parameters")}</span>
            </label>
            {foreignActivity && <p className="notice">{t("已记录 ", "Recorded ")}{foreignActivity}{t(" 活度参数，本次编辑会原样保留。", " activity parameters will be preserved.")}</p>}
            {activityEnabled && (
              <div className="activity-grid">
                <label>{t("适用活度模型", "Applicable activity model")}<select value="extended-debye-huckel" disabled>
                    <option>Extended Debye–Hückel</option>
                  </select>
                </label>
                <label>{t("离子尺寸 aᵢ", "Ion size aᵢ")}<div>
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
            <b>{3+(model?.reaction_based?1:0)+(value.state==='Aqueous'&&Number(value.charge)!==0?1:0)}</b>
            <div>
              <h3>{t("来源、参考文献与说明", "Sources, references, and notes")}</h3>
              <p>{t("粘贴完整参考文献即可，也可以分别填写作者、年份等信息。备注可用于记录数据说明。", "Paste a full citation, or enter authors, year, and other details separately. Use notes to describe the data.")}</p>
            </div>
          </header>
          <div className="reference-editor">
            {references.map((reference, index) => (
              <article key={index}>
                <div className="reference-main">
                  <label>{t("完整引用", "Full citation")}<textarea
                      value={referenceText(reference)}
                      placeholder={t("例如：Helgeson, H. C. et al. (1981). Thermodynamic properties... Journal..., 45, 123–145. https://doi.org/...", "For example: Helgeson, H. C. et al. (1981). Thermodynamic properties... Journal..., 45, 123–145. https://doi.org/...")}
                      onChange={(event) =>
                        setReferences(
                          references.map((item, row) =>
                            row === index
                              ? { ...(typeof item==="string"?{}:item), raw: event.target.value }
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
                  >{t("删除", "Delete")}</button>
                </div>
                <details>
                  <summary>{t("补充作者、年份等信息", "Add authors, year, and other details")}</summary>
                  <div className="reference-details">
                    <input
                      placeholder={t("作者", "Authors")}
                      value={reference.authors || ""}
                      onChange={(event) =>
                        updateReference(index, "authors", event.target.value)
                      }
                    />
                    <input
                      placeholder={t("年份", "Year")}
                      value={reference.year || ""}
                      onChange={(event) =>
                        updateReference(index, "year", event.target.value)
                      }
                    />
                    <input
                      className="wide"
                      placeholder={t("题目", "Title")}
                      value={reference.title || ""}
                      onChange={(event) =>
                        updateReference(index, "title", event.target.value)
                      }
                    />
                    <input
                      placeholder={t("期刊 / 出版物", "Journal / publication")}
                      value={reference.journal || ""}
                      onChange={(event) =>
                        updateReference(index, "journal", event.target.value)
                      }
                    />
                    <input
                      placeholder={t("卷(期)", "Volume (issue)")}
                      value={reference.volume || ""}
                      onChange={(event) =>
                        updateReference(index, "volume", event.target.value)
                      }
                    />
                    <input
                      placeholder={t("页码", "Pages")}
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
              <Plus />{t("添加参考文献", "Add reference")}</button>
          </div>
          <label className="field-label">{t("备注（可选）", "Notes (optional)")}<textarea
              value={value.notes || ""}
              onChange={(e) => setValue({ ...value, notes: e.target.value })}
              placeholder={t("记录数据处理、适用条件或待核查事项；不参与计算。", "Record data processing, applicable conditions, or items to check. Notes do not affect calculations.")}
            />
          </label>
          {existing?.disabled && (
            <div className="notice">
              <strong>{t("这是尚未启用的草稿", "This is an inactive draft")}</strong>
              <p>{t("原记录因模型未知或参数不完整而被禁用。选择一个可创建模型并补齐参数后，保存时才会恢复为可计算记录。", "The original record was disabled because its model was unknown or its parameters were incomplete. Choose a supported model and complete its parameters to enable calculations when saving.")}</p>
            </div>
          )}
        </section>
      </div>
      <div className="modal-actions editor-actions">
        <span>{changed ? t("保存 species 后，还需保存数据库文件", "After saving the species, save the database file too") : ''}</span>
        <button className="secondary" onClick={cancel}>{t("取消", "Cancel")}</button>
        <button
          className="primary"
          disabled={
            saving || !definitions.length || !value.name || !formula || !model
          }
          onClick={submit}
        >
          {saving ? t("正在校验并保存…", "Checking and saving…") : t("保存 species", "Save species")}
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
  useLanguage();
  const [step, setStep] = useState(1);
  const initialLocal = initial?.kind==='rtdb'&&initial.path ? {id:initial.path,group:initial.group||'SUPCRT',provider:'RTDB',embedded_name:localDatabaseName(initial.path),status:'ready',species_count:initial.species_count,element_count:initial.element_count,read_only:true,local_path:initial.path} as Catalog&{local_path:string}:null;
  const [localSources,setLocalSources]=useState<(Catalog&{local_path:string})[]>(initialLocal?[initialLocal]:[]);
  const [sources, setSources] = useState<(Catalog&{local_path?:string})[]>(initialLocal?[initialLocal]:initial?catalog.filter(x=>x.group===initial.group&&x.embedded_name===initial.embedded_name):[]);
  const [handles, setHandles] = useState<Record<string, Summary>>(initial?{[initialLocal?.local_path||`${initial.group}:${initial.embedded_name}`]:initial}:{});
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
  const key = (x: Catalog&{local_path?:string}) => x.local_path||`${x.group}:${x.embedded_name}`;
  const openSources = async () => {
    const next = { ...handles };
    for (const source of sources) {
      if (!next[key(source)]) {
        next[key(source)] = (
          await api<{ summary: Summary }>(source.local_path?"rtdb_open":"database_open", source.local_path?{path:source.local_path}:{group:source.group,name:source.embedded_name})
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
    <Modal title={target ? t(`向“${label(target)}”添加其他数据库的 species`, `Add species from other databases to “${label(target)}”`) : t("跨库选择 species，创建组合数据库", "Combine species from multiple databases")} onClose={onClose} wide {...operation}>
      <div className="wizard-steps">
        <span className={step === 1 ? "active" : ""}>{t("1 选择数据库", "1 Choose databases")}</span>
        <span className={step === 2 ? "active" : ""}>{t("2 选择 species", "2 Choose species")}</span>
        <span className={step === 3 ? "active" : ""}>{t("3 预览并创建", "3 Preview and create")}</span>
      </div>
      {step === 1 && (
        <><div className="compose-intro"><p>{t("选择需要的数据库，再挑选 species。软件会检查标准态依赖和同名记录；创建后仍需判断不同来源的模型和参数是否适合一起使用。", "Choose databases, then select species. Standard-state dependencies and duplicate names will be checked. Assess whether models and parameters from different sources are suitable for use together.")}</p><button className="secondary" onClick={()=>operation.run(async()=>{const path=await pickPath('open_rtdb');if(localSources.some(x=>x.local_path===path))return;const {summary:s}=await api<{summary:Summary}>('rtdb_open',{path});const row={id:path,group:s.group||'SUPCRT',provider:'RTDB',embedded_name:localDatabaseName(path),status:'ready',species_count:s.species_count,element_count:s.element_count,read_only:true,local_path:path} as Catalog&{local_path:string};ownedHandles.current.push(s.handle_id);setHandles(old=>({...old,[path]:s}));setLocalSources(old=>[...old,row]);setSources(old=>[...old,row]);})}><FolderOpen size={14}/>{t("添加我的数据库…", "Add my database…")}</button></div><div className="source-grid">
          {[...localSources,...catalog].map((x) => (
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
                  {x.group} · {x.species_count} species
                </small>
              </span>
            </label>
          ))}
        </div></>
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
                placeholder={t("搜索名称、化学式或模型", "Search name, formula, or model")}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
              />
            </label>
          </div>
          <div className="filter-row">
            <select aria-label={t("选择 species 相态", "Choose species phase")} value={stateFilter} onChange={e => setStateFilter(e.target.value)}><option value="All">{t("全部相态", "All phases")}</option>{facets.states.map(s => <option key={s} value={s}>{stateLabel(s)}</option>)}</select>
            <select aria-label={t("选择 species 模型", "Choose species model")} value={modelFilter} onChange={e => setModelFilter(e.target.value)}><option value="All">{t("全部模型", "All models")}</option>{facets.models.map(s => <option key={s} value={s}>{modelLabel(s)}</option>)}</select>
            <button className="secondary" onClick={() => setShowElements(!showElements)}>{t("元素筛选", "Filter by element")}{elements.length ? ` (${elements.length})` : ""}</button>
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
                  {stateLabel(x.state)} · {modelLabel(x.model)}
                </small>
              </label>
            ))}
          </div>
          <div className="table-footer"><span>{total ? offset+1 : 0}–{Math.min(offset+rows.length,total)} / {total}{t(" · 已选 ", " · Selected ")}{Object.values(chosen).reduce((n,x) => n+x.length,0)}{t(" 个", " items")}</span><span><button disabled={!offset} onClick={() => operation.run(() => load(handles[active],query,offset-100))}>{t("上一页", "Previous page")}</button><button disabled={offset+rows.length>=total} onClick={() => operation.run(() => load(handles[active],query,offset+100))}>{t("下一页", "Next page")}</button></span></div>
        </>
      )}
      {step === 3 && preview && (
        <>
          <div
            className={`preview-status ${preview.can_commit ? "valid" : "invalid"}`}
          >
            <strong>{preview.can_commit ? t("可以创建", "Ready to create") : t("不能创建", "Cannot create")}</strong>
            <span>
              {preview.records.length}{t(" 个 species（含 ", " species (including ")}{preview.dependency_count}{" "}{t("个必需 species）· ", " required species) · ")}{preview.rename_decisions.length}{t(" 个来源重命名", " source-qualified names")}</span>
          </div>
          {preview.missing_dependencies.length > 0 && (
            <DependencyReport issues={preview.missing_dependencies} />
          )}
          {preview.cycles.length > 0 && <div className="inline-error">{preview.cycles.map((chain:string[],i:number) => <p key={i}>{t("反应循环：", "Formation-reaction cycle: ")}{chain.join(" → ")}</p>)}</div>}
          {preview.rename_decisions.length > 0 && <details className="report-list"><summary>{t("查看重命名 (", "View renamed species (")}{preview.rename_decisions.length})</summary>{preview.rename_decisions.map((x:any,i:number) => <p key={i}>{x.original_name} → {x.resolved_name}</p>)}</details>}
          {!target && <>
          <p className="modal-copy">{t("数据库名称将使用最终保存的 .rtdb 文件名。", "The database name will come from the final .rtdb filename.")}</p>
          <div className="field-label">
            <label htmlFor="compose-db-path">{t("保存位置", "Save location")}</label>
            <div className="path-picker">
              <input id="compose-db-path" readOnly value={path} />
              <button
                className="secondary"
                onClick={() => operation.run(async () => {
                    setPath(await api("pick_path", { kind: "save_rtdb", defaultDirectory }));
                })}
              >{t("选择…", "Choose…")}</button>
            </div>
          </div>
          </>}
        </>
      )}
      <div className="modal-actions">
        {step > 1 && (
          <button className="secondary" onClick={() => setStep(step - 1)}>{t("上一步", "Back")}</button>
        )}
        <span className="grow" />
        <button className="secondary" onClick={onClose}>{t("取消", "Cancel")}</button>
        {step === 1 && (
          <button
            className="primary"
            disabled={!sources.length}
            onClick={() => operation.run(openSources)}
          >{t("下一步", "Next")}</button>
        )}
        {step === 2 && (
          <button
            className="primary"
            disabled={!Object.values(chosen).some((x) => x.length)}
            onClick={() => operation.run(makePreview)}
          >{t("检查所需 species 并预览", "Check required species and preview")}</button>
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
            {target ? t("添加到当前数据库", "Add to current database") : t("创建 .rtdb", "Create .rtdb")}
          </button>
        )}
      </div>
    </Modal>
  );
}

export function DependencyReport({issues}:{issues:any[]}) {
  useLanguage();
  return <div className="report-list dependency-report">{issues.map((issue,index)=><article key={index}>
    <strong>{Array.isArray(issue) ? t("形成反应存在循环", "Formation reactions contain a cycle") : issue.code === 'AMBIGUOUS_DEPENDENCY' ? t("同名 species 来源不明确", "Ambiguous source for a species with the same name") : (issue.message ? translateDatabaseMessage(issue.message) : "") || t(`缺少必需 species：${issue.dependency || issue.species || ''}`, `Missing required species: ${issue.dependency || issue.species || ''}`)}</strong>
    {(Array.isArray(issue) || issue.chain) && <p>{(Array.isArray(issue) ? issue : issue.chain).join(' → ')}</p>}
    {issue.candidates?.length > 0 && <p>{t("候选来源：", "Candidate sources: ")}{issue.candidates.join('；')}{t("。请在源数据库中明确引用或区分名称后重试。", ". Specify the reference or distinguish names in the source database, then try again.")}</p>}
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
  useLanguage();
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
    <Modal title={t("添加已有 species", "Add existing species")} onClose={onClose} {...operation} wide>
      <p className="modal-copy">{t("选择 Reaktoro YAML、其他 .rtdb，或已转换且包含 YAML / records.json 的扩展数据库文件夹。源文件不会被修改，也不会执行其中的 Python。", "Choose a Reaktoro YAML file, another .rtdb, or a converted extended database folder containing YAML / records.json. Source files are not modified, and Python files in the folder are not executed.")}</p>
      <div className="button-row">
        <button className="secondary" onClick={() => choose("import_yaml")}>
          <FolderOpen />
          Reaktoro YAML
        </button>
        <button className="secondary" onClick={() => choose("import_rtdb")}>
          <Database />{t("其他 .rtdb", "Another .rtdb")}</button>
        <button className="secondary" onClick={() => choose("import_folder")}>
          <FolderOpen />{t("扩展数据库文件夹", "Extended database folder")}</button>
      </div>
      {preview && (
        <>
          <div
            className={`preview-status ${preview.can_commit ? "valid" : "invalid"}`}
          >
            <strong>{preview.can_commit ? t("可以导入", "Ready to import") : t("导入被阻止", "Import blocked")}</strong>
            <span>
              {preview.new_count ?? preview.items.length}{t(" 个新 species · 补充 ", " new species · Add information to ")}{preview.update_count || 0}{t(" 个已有 species · 复用 ", " existing species · Reuse ")}{preview.reused_count}{t(" 个 ·", " entries ·")}{" "}
              {preview.rename_decisions.length}{t(" 个重命名", " renamed")}</span>
          </div>
          <div className="button-row"><button className="secondary" onClick={() => setSelected(preview.items.map((x:any) => x.fingerprint))}>{t("全选", "Select all")}</button><button className="secondary" onClick={() => setSelected([])}>{t("清除选择", "Clear selection")}</button><span>{t("已选 ", "Selected ")}{selected.length}{t(" 个 species", " species")}</span></div>
          <div className="compose-species">{preview.items.map((item:any) => <label key={item.fingerprint}><input type="checkbox" checked={selected.includes(item.fingerprint)} onChange={e => setSelected(e.target.checked ? [...selected,item.fingerprint] : selected.filter(x => x !== item.fingerprint))} /><span><strong>{item.name}</strong><ChemicalFormula value={item.formula} />{item.merge_kind==='metadata' && <small>{t("补充信息 · ", "Additional information · ")}{item.merge_fields.map((key:string)=>fieldNames()[key] || extraFieldNames()[key] || key).join(t('、', ', '))}{item.range_conflict?t("；范围有差异，保留原范围及来源", "; validity ranges differ, so the original range and provenance will be preserved"):''}</small>}</span></label>)}</div>
          {checked !== JSON.stringify(selected) && <p className="modal-copy">{t("选择已改变，请先检查所选 species；形成反应所需的其他 species 会自动加入。", "The selection has changed. Check the selected species again; species required for their formation reactions will be added automatically.")}</p>}
          {preview.dependency_count > 0 && <p className="modal-copy">{t("将自动加入 ", "Automatically includes ")}{preview.dependency_count}{t(" 个必需 species。", " required species.")}</p>}
          {!preview.can_commit && (
            <DependencyReport issues={[...preview.missing_dependencies, ...preview.cycles, ...(preview.issues || [])]} />
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="secondary" disabled={!preview || !selected.length} onClick={() => operation.run(async () => { const report = await api<any>("import_preview",{handleId:summary.handle_id,path,fingerprints:selected}); setPreview(report); setChecked(JSON.stringify(selected)); })}>{t("检查所选 species", "Check selected species")}</button>
        <button className="secondary" onClick={onClose}>{t("取消", "Cancel")}</button>
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
            if(result.success !== true || !result.summary) throw new Error(t("导入未完成，请重试。当前数据库仍保留原有内容。", "Import did not finish. Try again. The database retains its original contents."));
            await onDone(result.summary);
          })}
        >{t("导入所选记录", "Import selected records")}</button>
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
  useLanguage();
  const [kind, setKind] = useState<"native" | "interpolation">(summary.native_exportable_count === 0 ? "interpolation" : "native");
  const operation = useOperation();
  const {busy} = operation;
  const [grid,setGrid] = useState({tMin:"25",tMax:"300",tCount:"12",pMin:"1",pMax:"100",pCount:"5",tolerance:"5"});
  const run = async () => {
    await operation.run(async () => {
      const axis = (min:string,max:string,count:string,scale:number,shift=0) => {
        const lo=Number(min), hi=Number(max), n=Number(count);
        if(!min.trim() || !max.trim() || !Number.isFinite(lo) || !Number.isFinite(hi) || lo>=hi || !Number.isInteger(n) || n<2 || n>100 || (lo+shift)*scale<=0) throw new Error(t("温压下限必须小于上限，温度高于绝对零度、压力大于 0；每轴点数应为 2–100 的整数。", "Minimum values must be below maximum values, temperature must be above absolute zero, and pressure must be greater than 0. Each axis requires an integer from 2 to 100 points."));
        return Array.from({length:n},(_,i) => (lo+(hi-lo)*i/(n-1)+shift)*scale);
      };
      const temperaturesK = kind === "interpolation" ? axis(grid.tMin,grid.tMax,grid.tCount,1,273.15) : [];
      const pressuresPa = kind === "interpolation" ? axis(grid.pMin,grid.pMax,grid.pCount,100000) : [];
      const tolerance = Number(grid.tolerance)/100;
      if(kind === "interpolation" && (!Number.isFinite(tolerance) || tolerance<=0 || tolerance>1)) throw new Error(t("误差容限必须大于 0% 且不超过 100%。", "The error tolerance must be greater than 0% and no more than 100%."));
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
    <Modal title={t("导出数据库", "Export database")} onClose={onClose} {...operation}>
      <label className="choice">
        <input
          type="radio"
          checked={kind === "native"}
          disabled={summary.native_exportable_count === 0}
          onChange={() => setKind("native")}
        />
        <span>
          <strong>{t("保留模型参数（YAML）", "Preserve model parameters (YAML)")}</strong>
          <small>{summary.native_exportable_count === 0 ? t("当前 species 无法以这种格式导出，请选择温压插值数据。", "These species cannot be exported in this format. Choose temperature–pressure interpolation data.") : t(`导出支持此格式的 species${summary.native_exportable_count !== undefined ? `（${summary.native_exportable_count} 个）` : ""}；保存前检查文件是否可用。`, `Export species supported by this format${summary.native_exportable_count !== undefined ? ` (${summary.native_exportable_count} species)` : ""}. The file is verified before saving.`)}</small>
        </span>
      </label>
      <label className="choice">
        <input
          type="radio"
          checked={kind === "interpolation"}
          onChange={() => setKind("interpolation")}
        />
        <span>
          <strong>{t("温压插值数据（YAML）", "Temperature–pressure interpolation data (YAML)")}</strong>
          <small>{t("在指定温压范围内计算热力学性质，并检查插值误差。误差超过容限时不会生成文件。", "Calculate thermodynamic properties over a temperature and pressure range and check interpolation errors. No file is created if errors exceed the tolerance.")}</small>
        </span>
      </label>
      {kind === "interpolation" && <div className="parameter-grid">{([['tMin',t("温度下限 (°C)", "Minimum temperature (°C)")],['tMax',t("温度上限 (°C)", "Maximum temperature (°C)")],['tCount',t("温度点数", "Temperature points")],['pMin',t("压力下限 (bar)", "Minimum pressure (bar)")],['pMax',t("压力上限 (bar)", "Maximum pressure (bar)")],['pCount',t("压力点数", "Pressure points")],['tolerance',t("归一化误差容限 (%)", "Normalized error tolerance (%)")]] as const).map(([key,label]) => <label key={key}>{label}<input type="number" value={grid[key]} onChange={e => setGrid({...grid,[key]:e.target.value})}/></label>)}</div>}
      {kind === "interpolation" && <p className="modal-copy">{t("误差按 |插值值 − 模型值| / max(1, |模型值|) 逐项检查（SI 单位）；中点检验不保证网格内每一点均满足容限。只有完整提供所需标准性质的 species 才参与导出。", "Each error is checked as |interpolated value − model value| / max(1, |model value|), in SI units. Midpoint checks do not guarantee the tolerance at every point in the grid. Only species with all required standard properties are exported.")}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t("取消", "Cancel")}</button>
        <button className="primary" disabled={busy} onClick={run}>
          {busy ? t("正在采样与验证…", "Sampling and validating…") : t("选择位置并导出", "Choose location and export")}
        </button>
      </div>
    </Modal>
  );
}
