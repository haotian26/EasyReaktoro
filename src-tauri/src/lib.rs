use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager, State};
#[cfg(target_os = "macos")]
mod termination;

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    replies: mpsc::Receiver<Result<String, String>>,
    diagnostics: Arc<Mutex<String>>,
    next_id: u64,
    failure: Option<String>,
}
impl Bridge {
    fn start(python: &Path, script: &Path) -> Result<Self, String> {
        let mut child = Command::new(python)
            .arg("-B")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("bridge spawn failed: {e}"))?;
        let stdin = child.stdin.take().ok_or("bridge stdin unavailable")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("bridge stdout unavailable")?);
        let (sender, replies) = mpsc::channel();
        thread::spawn(move || {
            for line in stdout.lines() {
                if sender.send(line.map_err(|e| e.to_string())).is_err() {
                    break;
                }
            }
        });
        let diagnostics = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let captured = diagnostics.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Ok(mut text) = captured.lock() {
                        text.push_str(&line);
                        text.push('\n');
                        if text.len() > 8192 {
                            let mut at = text.len() - 8192;
                            while !text.is_char_boundary(at) {
                                at += 1;
                            }
                            text.drain(..at);
                        }
                    }
                }
            });
        }
        Ok(Self {
            child,
            stdin,
            replies,
            diagnostics,
            next_id: 1,
            failure: None,
        })
    }
    fn request(&mut self, mut args: Value) -> Result<Value, String> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let id = format!("req-{}", self.next_id);
        self.next_id += 1;
        args["request_id"] = Value::String(id.clone());
        serde_json::to_writer(&mut self.stdin, &args).map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let seconds = match args["op"].as_str().unwrap_or("") {
            "runtime.probe" => 8,
            "export.interpolation" => 300,
            _ => 120,
        };
        let line = match self.replies.recv_timeout(Duration::from_secs(seconds)) {
            Ok(Ok(line)) => line,
            other => {
                let diagnostic = self
                    .diagnostics
                    .lock()
                    .map(|x| x.clone())
                    .unwrap_or_default();
                let error = json!({"code":"BRIDGE_UNRESPONSIVE", "message_key":"error.bridgeUnresponsive", "diagnostic":format!("Reaktoro 子进程未在 {seconds} 秒内返回有效响应。请重新连接环境。{other:?} {diagnostic}")}).to_string();
                let _ = self.child.kill();
                let _ = self.child.wait();
                self.failure = Some(error.clone());
                return Err(error);
            }
        };
        let value: Value =
            serde_json::from_str(&line).map_err(|e| format!("invalid bridge response: {e}"))?;
        if value.get("request_id").and_then(Value::as_str) != Some(&id) {
            let error = "BRIDGE_PROTOCOL: 响应与请求不匹配，请重新连接环境".to_string();
            self.failure = Some(error.clone());
            return Err(error);
        }
        if value.get("ok").and_then(Value::as_bool) == Some(false) {
            let err = value
                .get("error")
                .cloned()
                .unwrap_or_else(|| json!({"code":"BRIDGE_ERROR"}));
            return Err(err.to_string());
        }
        Ok(value)
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Clone)]
struct AppState {
    bridge: Arc<Mutex<Option<Bridge>>>,
    python: Arc<Mutex<Option<PathBuf>>>,
}

fn push_python(out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    let choices = if path.is_dir() {
        vec![
            path.join("bin/python"),
            path.join("bin/python3"),
            path.join("python"),
            path.join("python3"),
        ]
    } else {
        vec![path]
    };
    for choice in choices {
        if choice.is_file() {
            // Resolve the directory, not the executable: venv's python symlink
            // must be invoked through its own environment to preserve sys.prefix.
            let parent = choice.parent().unwrap_or(Path::new("."));
            let directory = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
            let candidate = directory.join(choice.file_name().unwrap());
            if seen.insert(directory) {
                out.push(candidate);
            }
        }
    }
}
fn scan_env_root(out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, root: PathBuf) {
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                push_python(out, seen, entry.path());
            }
        }
    }
}
fn scan_application_roots(out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, root: &Path) {
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
            let path = entry.path();
            push_python(out, seen, path.clone());
            scan_env_root(out, seen, path.join("envs"));
        }
    }
}
fn python_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(path) = std::env::var("EASYREAKTORO_PYTHON") {
        push_python(&mut out, &mut seen, PathBuf::from(path));
    }
    if let Ok(prefix) = std::env::var("CONDA_PREFIX") {
        push_python(&mut out, &mut seen, PathBuf::from(prefix));
    }
    if let Ok(prefix) = std::env::var("VIRTUAL_ENV") {
        push_python(&mut out, &mut seen, PathBuf::from(prefix));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            push_python(&mut out, &mut seen, path);
        }
    }
    scan_application_roots(&mut out, &mut seen, Path::new("/Applications"));
    for root in [
        "/opt/homebrew/Caskroom/miniforge/base/envs",
        "/opt/homebrew/Caskroom/miniconda/base/envs",
        "/opt/homebrew/Caskroom/mambaforge/base/envs",
        "/opt/homebrew/Caskroom/anaconda/base/envs",
        "/opt/homebrew/anaconda3/envs",
        "/opt/homebrew/miniconda3/envs",
        "/opt/homebrew/miniforge3/envs",
        "/usr/local/anaconda3/envs",
        "/usr/local/miniconda3/envs",
        "/usr/local/miniforge3/envs",
    ] {
        scan_env_root(&mut out, &mut seen, PathBuf::from(root));
    }
    for path in [
        "/Applications/Reaktoro",
        "/opt/homebrew/Caskroom/miniforge/base",
        "/opt/homebrew/Caskroom/miniconda/base",
        "/opt/homebrew/Caskroom/mambaforge/base",
        "/opt/homebrew/Caskroom/anaconda/base",
        "/opt/homebrew/anaconda3",
        "/opt/homebrew/miniconda3",
        "/opt/homebrew/miniforge3",
        "/usr/local/anaconda3",
        "/usr/local/miniconda3",
        "/usr/local/miniforge3",
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ] {
        push_python(&mut out, &mut seen, PathBuf::from(path));
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        for root in [
            ".conda/envs",
            ".micromamba/envs",
            ".local/share/mamba/envs",
            ".pyenv/versions",
            "miniforge3/envs",
            "miniconda3/envs",
            "mambaforge/envs",
            "anaconda3/envs",
        ] {
            scan_env_root(&mut out, &mut seen, home.join(root));
        }
        for root in [
            "miniforge3",
            "miniconda3",
            "mambaforge",
            "anaconda3",
            ".micromamba",
        ] {
            push_python(&mut out, &mut seen, home.join(root));
        }
        if let Ok(lines) = fs::read_to_string(home.join(".conda/environments.txt")) {
            for line in lines.lines().filter(|line| !line.trim().is_empty()) {
                push_python(&mut out, &mut seen, PathBuf::from(line.trim()));
            }
        }
    }
    out
}
fn find_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let candidates = [
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("bridge/reaktoro_bridge.py")),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bridge/reaktoro_bridge.py")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .ok_or_else(|| "bridge script is not available".into())
}
fn probe_python(python: &Path, script: &Path) -> Result<(Bridge, Value), String> {
    let mut bridge = Bridge::start(python, script)?;
    let result = bridge.request(json!({"op":"runtime.probe"}))?;
    Ok((bridge, result))
}
fn ensure_bridge(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    let mut active = state.bridge.lock().map_err(|_| "bridge lock poisoned")?;
    if active.is_some() {
        return Ok(());
    }
    let script = find_script(app)?;
    let mut offline = None;
    for python in python_candidates() {
        if let Ok((bridge, probe)) = probe_python(&python, &script) {
            if probe.get("available").and_then(Value::as_bool) == Some(true) {
                *state.python.lock().map_err(|_| "python lock poisoned")? = Some(python);
                *active = Some(bridge);
                return Ok(());
            }
            if offline.is_none() {
                offline = Some((python, bridge));
            }
        }
    }
    if let Some((python, bridge)) = offline {
        *state.python.lock().map_err(|_| "python lock poisoned")? = Some(python);
        *active = Some(bridge);
        return Ok(());
    }
    Err("No usable external Python was found; choose a Reaktoro Python executable".into())
}
fn request(app: &tauri::AppHandle, state: &AppState, args: Value) -> Result<Value, String> {
    ensure_bridge(app, state)?;
    state
        .bridge
        .lock()
        .map_err(|_| "bridge lock poisoned")?
        .as_mut()
        .ok_or("bridge unavailable")?
        .request(args)
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn runtime_probe(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let shared = state.inner().clone();
    blocking(
        move || match request(&app, &shared, json!({"op":"runtime.probe"})) {
            Ok(mut value) => {
                if let Some(path) = shared.python.lock().ok().and_then(|path| path.clone()) {
                    value["python"] = Value::String(path.display().to_string());
                }
                Ok(value)
            }
            Err(error) => Ok(json!({"status":"error","available":false,"diagnostic":error})),
        },
    )
    .await
}
#[tauri::command]
async fn runtime_discover(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(move || {
        let script = find_script(&app)?;
        let mut entries = Vec::new();
        let mut environments = HashSet::new();
        for python in python_candidates() {
            let result = match probe_python(&python, &script) {
                Ok((_, probe)) => probe,
                Err(error) => json!({"status":"error","available":false,"diagnostic":error}),
            };
            let root = result
                .get("environment_root")
                .and_then(Value::as_str)
                .unwrap_or("");
            let canonical_root = fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
            let version = result.get("version").and_then(Value::as_str).unwrap_or("");
            let identity = format!("{}\0{version}", canonical_root.display());
            if !root.is_empty() && !environments.insert(identity) {
                continue;
            }
            entries.push(json!({
                "python": python.display().to_string(), "environment_root": root,
                "available": result.get("available").and_then(Value::as_bool).unwrap_or(false),
                "status": result.get("status").cloned().unwrap_or(Value::String("error".into())),
                "version": result.get("version").cloned().unwrap_or(Value::Null),
                "diagnostic": result.get("diagnostic").cloned().unwrap_or(Value::Null)
            }));
        }
        Ok(json!({"entries":entries}))
    })
    .await
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn settings_load(app: tauri::AppHandle) -> Result<Value, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(
            json!({"language":"zh-CN","theme":"system","density":"comfortable","startup":"home","recent_databases":[]}),
        );
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_save(app: tauri::AppHandle, settings: Value) -> Result<Value, String> {
    static SETTINGS_WRITE: Mutex<()> = Mutex::new(());
    let _guard = SETTINGS_WRITE
        .lock()
        .map_err(|_| "settings lock poisoned")?;
    let path = settings_path(&app)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    Ok(json!({"success":true,"path":path}))
}

#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Value {
    Value::Array(
        paths
            .into_iter()
            .map(|path| json!({"path":path,"exists":Path::new(&path).is_file()}))
            .collect(),
    )
}

#[tauri::command]
fn reveal_path(path: String) -> Result<Value, String> {
    if !Path::new(&path).exists() {
        return Err("path does not exist".into());
    }
    Command::new("/usr/bin/open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(json!({"success":true}))
}
#[tauri::command]
async fn runtime_select(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    discard: Option<bool>,
) -> Result<Value, String> {
    let shared = state.inner().clone();
    blocking(move || {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_python(&mut candidates, &mut seen, PathBuf::from(path));
        let python = candidates
            .into_iter()
            .next()
            .ok_or("The selected path does not contain a Python executable")?;
        let (bridge, mut probe) = probe_python(&python, &find_script(&app)?)?;
        if probe.get("available").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "所选 Python 无法加载 Reaktoro：{}",
                probe["diagnostic"]
            ));
        }
        let mut current = shared.bridge.lock().map_err(|_| "bridge lock poisoned")?;
        if !discard.unwrap_or(false) {
            if let Some(old) = current.as_mut() {
                old.request(json!({"op":"runtime.can_switch"}))?;
            }
        }
        *current = Some(bridge);
        *shared.python.lock().map_err(|_| "python lock poisoned")? = Some(python.clone());
        probe["python"] = Value::String(python.display().to_string());
        Ok(probe)
    })
    .await
}
#[tauri::command]
async fn catalog_list(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    dispatch(app, state, "catalog.list", json!({})).await
}

fn command(
    app: &tauri::AppHandle,
    state: &AppState,
    op: &str,
    mut args: Value,
) -> Result<Value, String> {
    args["op"] = Value::String(op.into());
    request(app, state, args)
}
async fn dispatch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    op: &'static str,
    args: Value,
) -> Result<Value, String> {
    let shared = state.inner().clone();
    blocking(move || command(&app, &shared, op, args)).await
}
#[tauri::command]
async fn database_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    group: String,
    name: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "database.open",
        json!({"group":group,"name":name}),
    )
    .await
}
#[tauri::command]
async fn database_close(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    discard: Option<bool>,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "database.close",
        json!({"handle_id":handle_id,"discard":discard.unwrap_or(false)}),
    )
    .await
}
#[tauri::command]
async fn database_summary(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "database.summary",
        json!({"handle_id":handle_id}),
    )
    .await
}
#[tauri::command]
async fn catalog_entry_details(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    group: String,
    name: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "catalog.entry_details",
        json!({"group":group,"name":name}),
    )
    .await
}
#[tauri::command]
async fn species_page(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    offset: usize,
    limit: usize,
    query: String,
    state_filter: String,
    charge: Option<f64>,
    model_filter: String,
    elements: Vec<String>,
) -> Result<Value, String> {
    dispatch(app, state, "database.species_page", json!({"handle_id":handle_id,"offset":offset,"limit":limit,"query":query,"state":state_filter,"charge":charge,"model":model_filter,"elements":elements})).await
}
#[tauri::command]
async fn species_options(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "database.species_options",
        json!({"handle_id":handle_id}),
    )
    .await
}
#[tauri::command]
async fn model_definitions(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    dispatch(app, state, "model.definitions", json!({})).await
}
#[tauri::command]
async fn model_fit_mrb(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rows: Value,
    value_kind: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "model.fit_mrb",
        json!({"rows":rows,"value_kind":value_kind}),
    )
    .await
}
#[tauri::command]
async fn species_details(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    name: String,
    species_id: Option<String>,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "species.details",
        json!({"handle_id":handle_id,"name":name,"species_id":species_id}),
    )
    .await
}
#[tauri::command]
async fn species_evaluate(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    name: String,
    species_id: Option<String>,
    temperature_k: f64,
    pressure_pa: f64,
) -> Result<Value, String> {
    dispatch(app, state, "species.evaluate", json!({"handle_id":handle_id,"name":name,"species_id":species_id,"temperature_K":temperature_k,"pressure_Pa":pressure_pa})).await
}
#[tauri::command]
async fn species_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    species: Value,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "species.create",
        json!({"handle_id":handle_id,"species":species}),
    )
    .await
}
#[tauri::command]
async fn species_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    species_id: String,
    species: Value,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "species.update",
        json!({"handle_id":handle_id,"species_id":species_id,"species":species}),
    )
    .await
}
#[tauri::command]
async fn species_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    species_id: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "species.delete",
        json!({"handle_id":handle_id,"species_id":species_id}),
    )
    .await
}
#[tauri::command]
async fn rtdb_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
) -> Result<Value, String> {
    dispatch(app, state, "rtdb.create", json!({"path":path,"name":name})).await
}
#[tauri::command]
async fn rtdb_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Value, String> {
    dispatch(app, state, "rtdb.open", json!({"path":path})).await
}
#[tauri::command]
async fn rtdb_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
) -> Result<Value, String> {
    dispatch(app, state, "rtdb.save", json!({"handle_id":handle_id})).await
}
#[tauri::command]
async fn rtdb_save_as(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    path: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "rtdb.save_as",
        json!({"handle_id":handle_id,"path":path}),
    )
    .await
}
#[tauri::command]
async fn compose_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    selections: Value,
    target_handle_id: Option<String>,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "compose.preview",
        json!({"selections":selections,"target_handle_id":target_handle_id}),
    )
    .await
}
#[tauri::command]
async fn compose_commit(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    selections: Value,
    path: String,
    name: Option<String>,
    target_handle_id: Option<String>,
) -> Result<Value, String> {
    dispatch(app, state, "compose.commit", json!({"selections":selections,"path":path,"name":name,"target_handle_id":target_handle_id})).await
}
#[tauri::command]
async fn import_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    path: String,
    fingerprints: Option<Vec<String>>,
) -> Result<Value, String> {
    let mut args = json!({"handle_id":handle_id,"path":path});
    if let Some(ids) = fingerprints {
        args["fingerprints"] = json!(ids);
    }
    dispatch(app, state, "import.preview", args).await
}
#[tauri::command]
async fn import_commit(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    path: String,
    fingerprints: Vec<String>,
    source_revision: Option<String>,
) -> Result<Value, String> {
    dispatch(app, state, "import.commit", json!({"handle_id":handle_id,"path":path,"fingerprints":fingerprints,"source_revision":source_revision})).await
}
#[tauri::command]
async fn validate_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "validate.database",
        json!({"handle_id":handle_id}),
    )
    .await
}
#[tauri::command]
async fn export_native_yaml(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    path: String,
) -> Result<Value, String> {
    dispatch(
        app,
        state,
        "export.native_yaml",
        json!({"handle_id":handle_id,"path":path}),
    )
    .await
}
#[tauri::command]
async fn export_interpolation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle_id: String,
    path: String,
    temperatures_k: Vec<f64>,
    pressures_pa: Vec<f64>,
    tolerance: f64,
) -> Result<Value, String> {
    dispatch(app, state, "export.interpolation", json!({"handle_id":handle_id,"path":path,"temperatures_K":temperatures_k,"pressures_Pa":pressures_pa,"tolerance":tolerance})).await
}
#[tauri::command]
async fn runtime_diagnostics(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    dispatch(app, state, "runtime.diagnostics", json!({})).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            termination::install(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .menu(|app| {
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as Item, Submenu};
            // The Cocoa predefined Quit item invokes terminate: directly. Route
            // Cmd-Q through the same frontend save/discard/cancel guard as closing.
            Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "EasyReaktoro",
                        true,
                        &[
                            &Item::about(app, Some("关于 EasyReaktoro"), None)?,
                            &Item::separator(app)?,
                            &Item::hide(app, Some("隐藏 EasyReaktoro"))?,
                            &Item::hide_others(app, Some("隐藏其他应用"))?,
                            &Item::show_all(app, Some("全部显示"))?,
                            &Item::separator(app)?,
                            &MenuItem::with_id(
                                app,
                                "guarded-quit",
                                "退出 EasyReaktoro",
                                true,
                                Some("CmdOrCtrl+Q"),
                            )?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "编辑",
                        true,
                        &[
                            &Item::undo(app, Some("撤销"))?,
                            &Item::redo(app, Some("重做"))?,
                            &Item::separator(app)?,
                            &Item::cut(app, Some("剪切"))?,
                            &Item::copy(app, Some("复制"))?,
                            &Item::paste(app, Some("粘贴"))?,
                            &Item::select_all(app, Some("全选"))?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "窗口",
                        true,
                        &[
                            &Item::minimize(app, Some("最小化"))?,
                            &MenuItem::with_id(
                                app,
                                "guarded-close",
                                "关闭窗口",
                                true,
                                Some("CmdOrCtrl+W"),
                            )?,
                        ],
                    )?,
                ],
            )
        })
        .on_menu_event(|app, event| {
            if matches!(event.id().as_ref(), "guarded-quit" | "guarded-close") {
                let _ = app.emit("easyreaktoro:request-exit", ());
            }
        })
        .manage(AppState {
            bridge: Arc::new(Mutex::new(None)),
            python: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            settings_load,
            settings_save,
            paths_exist,
            reveal_path,
            runtime_probe,
            runtime_discover,
            runtime_select,
            runtime_diagnostics,
            catalog_list,
            catalog_entry_details,
            database_open,
            database_close,
            database_summary,
            species_page,
            species_options,
            model_definitions,
            model_fit_mrb,
            species_details,
            species_evaluate,
            species_create,
            species_update,
            species_delete,
            rtdb_create,
            rtdb_open,
            rtdb_save,
            rtdb_save_as,
            compose_preview,
            compose_commit,
            import_preview,
            import_commit,
            validate_database,
            export_native_yaml,
            export_interpolation
        ])
        .build(tauri::generate_context!())
        .expect("error while building EasyReaktoro")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app.get_webview_window("main").is_some() {
                    api.prevent_exit();
                    let _ = app.emit("easyreaktoro:request-exit", ());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn venv_symlinks_keep_environment_identity() {
        let root =
            std::env::temp_dir().join(format!("easyreaktoro-venv-test-{}", std::process::id()));
        for name in ["alpha", "beta"] {
            let bin = root.join(name).join("bin");
            fs::create_dir_all(&bin).unwrap();
            std::os::unix::fs::symlink("/usr/bin/python3", bin.join("python")).unwrap();
            std::os::unix::fs::symlink("/usr/bin/python3", bin.join("python3")).unwrap();
        }
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_python(&mut candidates, &mut seen, root.join("alpha"));
        push_python(&mut candidates, &mut seen, root.join("beta"));
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0].ends_with("alpha/bin/python"));
        assert!(candidates[1].ends_with("beta/bin/python"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bridge_protocol_and_stderr_are_drained() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/bridge_fixture.py");
        let mut bridge = Bridge::start(Path::new("/usr/bin/python3"), &script).unwrap();
        assert_eq!(bridge.request(json!({"op":"noisy"})).unwrap()["result"], 42);
        assert!(bridge.request(json!({"op":"wrong_id"})).is_err());
        assert!(bridge.request(json!({"op":"noisy"})).is_err());
    }
    #[test]
    fn dead_bridge_returns_without_hanging() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/bridge_fixture.py");
        let mut bridge = Bridge::start(Path::new("/usr/bin/python3"), &script).unwrap();
        let start = std::time::Instant::now();
        assert!(bridge.request(json!({"op":"exit"})).is_err());
        assert!(start.elapsed().as_secs() < 8);
    }
}
