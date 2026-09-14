use serde_json::{json, Value};
use std::{fs,io::Write,path::{Path,PathBuf},sync::{Mutex,OnceLock},collections::HashSet};
use tauri::Manager;
static WRITES:Mutex<()> = Mutex::new(());
// A queued autosave must not recreate a file deleted in this application session.
static KNOWN:OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
fn known()->&'static Mutex<HashSet<PathBuf>>{KNOWN.get_or_init(||Mutex::new(HashSet::new()))}
static DELETED:OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
fn deleted()->&'static Mutex<HashSet<PathBuf>>{DELETED.get_or_init(||Mutex::new(HashSet::new()))}
fn file(root:&Path,id:&str)->Result<PathBuf,String>{
 if id.is_empty()||id.len()>90||!id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'){return Err("模拟编号无效，请重新选择历史记录。".into());}
 Ok(root.join(format!("{id}.json")))
}
fn validate(value:&Value)->Result<(),String>{
 if value["version"]!=1||!value["id"].is_string()||!value["database"].is_object()||!value["config"].is_object()||!value["updated_at"].is_string(){return Err("模拟记录不完整，原记录已保留。".into());}Ok(())
}
// Only location metadata is stored here; result files are never moved or removed.
fn result_request(root:&Path,payload:&Value)->Result<Value,String>{
 let _lock=WRITES.lock().map_err(|_|"结果历史正在保存，请稍后重试。")?;
 let directory=root.join("Results");
 if fs::symlink_metadata(&directory).is_ok_and(|m|m.file_type().is_symlink()){return Err("结果历史目录不可使用符号链接。".into());}
 fs::create_dir_all(&directory).map_err(|e|e.to_string())?;let path=directory.join("index.json");
 let validate_entry=|entry:&Value|->Result<(),String>{
  let location=entry["path"].as_str().unwrap_or("");
  if !Path::new(location).is_absolute()||location.contains('\0')||!entry["name"].is_string()||!entry["opened_at"].is_string(){return Err("结果历史信息不完整，原记录已保留。".into());}
  if !entry["status"].is_null()&&!matches!(entry["status"].as_str(),Some("running"|"completed"|"failed"|"cancelled"|"interrupted")){return Err("结果历史的运行状态无法识别。".into());}Ok(())
 };
 let mut legacy_imported=false;
 let mut entries=if path.exists(){
  let value:Value=serde_json::from_slice(&fs::read(&path).map_err(|e|e.to_string())?).map_err(|_|"结果历史暂时无法读取，原文件已保留。")?;
  legacy_imported=value["legacy_imported"]==true;
  let entries=value["entries"].as_array().filter(|_|value["version"]==1).ok_or("结果历史格式无法识别，原文件已保留。")?;
  for entry in entries{validate_entry(entry)?;}entries.clone()
 }else{Vec::new()};
 let action=payload["action"].as_str().unwrap_or("");
 match action{
  "results_list"=>(),
  "results_import"=>{
   let incoming=payload["entries"].as_array().ok_or("结果历史信息不完整。")?;for entry in incoming{validate_entry(entry)?;}
   if !legacy_imported{for entry in incoming{if !entries.iter().any(|old|old["path"]==entry["path"]){entries.push(entry.clone());}}}legacy_imported=true;
  },
  "results_remember"|"results_update"=>{
   let mut entry=payload["entry"].clone();validate_entry(&entry)?;
   if let Some(index)=entries.iter().position(|old|old["path"]==entry["path"]){
    if action=="results_update"{entry["opened_at"]=entries[index]["opened_at"].clone();}entries[index]=entry;
   }else if action=="results_remember"{entries.push(entry);}
  },
  "results_forget"=>{let target=payload["path"].as_str().ok_or("请选择一条结果历史。")?;entries.retain(|entry|entry["path"]!=target);},
  _=>return Err("无法识别此结果历史操作。".into())
 }
 let before_pruning=entries.len();
 // Only a confirmed missing path is removed. Permission/offline errors retain the entry.
 entries.retain(|entry| !matches!(fs::metadata(entry["path"].as_str().unwrap_or("")),Err(error) if error.kind()==std::io::ErrorKind::NotFound));
 let pruned=before_pruning!=entries.len();
 entries.sort_by(|a,b|b["opened_at"].as_str().cmp(&a["opened_at"].as_str()));
 if action!="results_list"||pruned{
  let bytes=serde_json::to_vec_pretty(&json!({"version":1,"legacy_imported":legacy_imported,"entries":entries})).map_err(|e|e.to_string())?;
  let temporary=path.with_extension("json.tmp");let mut output=fs::File::create(&temporary).map_err(|e|e.to_string())?;
  output.write_all(&bytes).and_then(|_|output.sync_all()).map_err(|e|e.to_string())?;fs::rename(temporary,&path).map_err(|e|e.to_string())?;
 }
 Ok(json!({"success":true,"entries":entries}))
}
fn inner_count(config:&Value)->usize{
 if !config["schedule"].is_null(){return config["schedule"]["positions"].as_u64().filter(|n|*n>=1&&*n<=10000).unwrap_or(0) as usize;}
 let inner=&config["loops"]["inner"];
 if config["loops"].is_null(){return config["points"].as_array().map_or(0,|v|v.len());}
 match inner["mode"].as_str().unwrap_or(""){
  "repeat"=>inner["count"].as_u64().filter(|v|*v>=1&&*v<=10000).unwrap_or(0) as usize,
  "list"=>inner["values"].as_array().filter(|v|!v.is_empty()&&v.len()<=10000&&v.iter().all(|n|n.as_f64().is_some_and(|n|n.is_finite()))).map_or(0,|v|v.len()),
  "range"=>{let (Some(start),Some(end),Some(step))=(inner["start"].as_f64(),inner["end"].as_f64(),inner["step"].as_f64())else{return 0;};
   if !start.is_finite()||!end.is_finite()||!step.is_finite()||step==0.0{return 0;}
   let ratio=(end-start)/step;let count=(ratio+1e-10).floor()+1.0;
   if !ratio.is_finite()||ratio<0.0||count<1.0||count>10000.0{0}else{count as usize}
  },
  _=>0
 }
}
// A missing result does not invalidate the simulation. Only alter the returned copy.
fn clear_missing_result(value:&mut Value){
 if value["last_result"].as_str().is_some_and(|path|matches!(fs::metadata(path),Err(error) if error.kind()==std::io::ErrorKind::NotFound)){
  if let Some(document)=value.as_object_mut(){document.remove("last_result");}
 }
}
fn request(root:&Path,payload:Value)->Result<Value,String>{
 fs::create_dir_all(root).map_err(|e|e.to_string())?;
 let canonical_root=fs::canonicalize(root).map_err(|e|e.to_string())?;let root=canonical_root.as_path();
 if payload["action"].as_str().unwrap_or("").starts_with("results_"){return result_request(root,&payload);}
 match payload["action"].as_str().unwrap_or(""){
  "list"=>{let mut entries=Vec::new();let mut unreadable=0;
   let directory=if payload["trash"]==true{root.join("Trash")}else{root.to_path_buf()};fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
   for item in fs::read_dir(&directory).map_err(|e|e.to_string())?{let path=item.map_err(|e|e.to_string())?.path();if path.extension().and_then(|s|s.to_str())!=Some("json"){continue;}
    let value=fs::read(&path).ok().and_then(|s|serde_json::from_slice::<Value>(&s).ok());
    if let Some(mut v)=value.filter(|v|validate(v).is_ok()) {clear_missing_result(&mut v);known().lock().map_err(|_|"历史记录暂时无法更新。")?.insert(path.clone());entries.push(json!({"id":v["id"],"name":v["config"]["name"],"database":v["database"],"updated_at":v["updated_at"],"species_count":v["config"]["species"].as_array().map_or(0,|v|v.len()),"point_count":inner_count(&v["config"]),"last_result":v["last_result"]}));}else{unreadable+=1;}
   }entries.sort_by(|a,b|b["updated_at"].as_str().cmp(&a["updated_at"].as_str()));Ok(json!({"entries":entries,"directory":root,"unreadable":unreadable}))},
  "read"=>{let path=file(root,payload["id"].as_str().unwrap_or(""))?;let mut value:Value=serde_json::from_slice(&fs::read(&path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;validate(&value)?;clear_missing_result(&mut value);known().lock().map_err(|_|"历史记录暂时无法更新。")?.insert(path);Ok(value)},
  "write"=>{let _lock=WRITES.lock().map_err(|_|"模拟暂时无法保存，请重试。")?;let value=&payload["document"];validate(value)?;let path=file(root,value["id"].as_str().unwrap_or(""))?;
   if known().lock().map_err(|_|"历史记录暂时无法更新。")?.contains(&path)&&!path.try_exists().map_err(|e|e.to_string())?{return Err("这份模拟文件已从本机删除。当前编辑仍保留，可在历史中复制当前模拟，或另存模拟设置。".into());}
   if deleted().lock().map_err(|_|"模拟暂时无法保存，请重试。")?.contains(&path){return Err("这份模拟已删除，请新建模拟或另存为新记录。".into());}
   if file(&root.join("Trash"),value["id"].as_str().unwrap_or(""))?.exists(){return Err("这份模拟已移入最近删除，请先恢复后再保存。".into());}
   let bytes=serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?;if bytes.len()>16*1024*1024{return Err("这份模拟超过 16 MB，请减少代码或参数数量后另存。".into());}
   let temporary=path.with_extension("json.tmp");let mut output=fs::File::create(&temporary).map_err(|e|e.to_string())?;output.write_all(&bytes).and_then(|_|output.sync_all()).map_err(|e|e.to_string())?;fs::rename(temporary,&path).map_err(|e|e.to_string())?;known().lock().map_err(|_|"历史记录暂时无法更新。")?.insert(path.clone());Ok(json!({"success":true,"path":path}))},
  "empty_trash"=>{
   let _lock=WRITES.lock().map_err(|_|"历史记录正在保存，请稍后重试。")?;let trash=root.join("Trash");
   if fs::symlink_metadata(&trash).is_ok_and(|m|m.file_type().is_symlink()){return Err("最近删除目录不可使用符号链接，未删除任何文件。".into());}
   let ids=payload["ids"].as_array().ok_or("请重新确认要清空的模拟记录。")?;let mut seen=HashSet::new();let mut paths=Vec::new();
   // A snapshot avoids sweeping in a simulation deleted after the user confirmed.
   for id in ids{let id=id.as_str().ok_or("模拟编号无效。")?;if !seen.insert(id){return Err("模拟编号重复，请刷新最近删除。".into());}
    let path=file(&trash,id)?;
    if file(root,id)?.exists()||fs::symlink_metadata(&path).map_or(true,|m|m.is_dir()){return Err("最近删除已发生变化，请刷新后再次确认。".into());}
    paths.push((file(root,id)?,path));
   }
   for (normal,path) in &paths{fs::remove_file(path).map_err(|e|e.to_string())?;deleted().lock().map_err(|_|"删除状态暂时无法更新，请重试。")?.insert(normal.clone());}
   Ok(json!({"success":true,"deleted":paths.len()}))
  },
  "delete"=>{
   let _lock=WRITES.lock().map_err(|_|"历史记录正在保存，请稍后重试。")?;
   let id=payload["id"].as_str().unwrap_or("");let normal=file(root,id)?;let trashed=file(&root.join("Trash"),id)?;
   // A linked Trash directory must never redirect a deletion outside this store.
   if fs::symlink_metadata(root.join("Trash")).is_ok_and(|m|m.file_type().is_symlink()){return Err("最近删除目录不可使用符号链接，未删除任何文件。".into());}
   for path in [&normal,&trashed]{if fs::symlink_metadata(path).is_ok_and(|m|m.is_dir()){return Err("模拟文件位置被文件夹占用，未删除任何文件。".into());}}
   deleted().lock().map_err(|_|"删除状态暂时无法更新，请重试。")?.insert(normal.clone());
   // Remove only this record, never its database or result directory.
   for path in [&normal,&trashed]{match fs::remove_file(path){Ok(())=>(),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>(),Err(e)=>return Err(e.to_string())}}
   Ok(json!({"success":true}))
  },
  "trash"|"restore"=>{
   let _lock=WRITES.lock().map_err(|_|"历史记录正在保存，请稍后重试。")?;
   let id=payload["id"].as_str().unwrap_or("");let trash=root.join("Trash");fs::create_dir_all(&trash).map_err(|e|e.to_string())?;
   let (source,destination)=if payload["action"]=="trash"{(file(root,id)?,file(&trash,id)?)}else{(file(&trash,id)?,file(root,id)?)};
   if !source.exists()&&destination.exists(){return Ok(json!({"success":true}));}
   if destination.exists(){return Err("相同编号的记录已存在，原文件已保留。".into());}
   fs::rename(source,destination).map_err(|e|e.to_string())?;Ok(json!({"success":true}))
  },
  _=>Err("无法识别此历史记录操作。".into())
 }
}
#[tauri::command]
pub fn simulation_history(app:tauri::AppHandle,payload:Value)->Result<Value,String>{
 let root=app.path().app_data_dir().map_err(|e|e.to_string())?.join("Simulations");request(&root,payload)
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn trash_is_recoverable_and_rejects_late_autosaves(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-trash-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let doc=json!({"version":1,"id":"case-a","database":{"kind":"rtdb"},"config":{"name":"Before delete","species":[],"points":[]},"updated_at":"2026-09-08"});
  request(&root,json!({"action":"write","document":doc})).unwrap();request(&root,json!({"action":"trash","id":"case-a"})).unwrap();
  assert_eq!(request(&root,json!({"action":"list"})).unwrap()["entries"].as_array().unwrap().len(),0);
  assert_eq!(request(&root,json!({"action":"list","trash":true})).unwrap()["entries"].as_array().unwrap().len(),1);
  assert!(request(&root,json!({"action":"write","document":doc})).is_err());
  request(&root,json!({"action":"restore","id":"case-a"})).unwrap();assert_eq!(request(&root,json!({"action":"read","id":"case-a"})).unwrap(),doc);
  assert!(request(&root,json!({"action":"trash","id":"../case-a"})).is_err());fs::remove_dir_all(root).unwrap();
 }
 #[test]fn saves_reopens_and_isolates_invalid_records(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-history-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let v=json!({"version":1,"id":"test-1","database":{"kind":"rtdb","path":"/sample.rtdb"},"config":{"name":"A","species":["H2O"],"points":[]},"code_editor":{"source":"# keep comments"},"updated_at":"2026-09-08"});
  request(&root,json!({"action":"write","document":v})).unwrap();assert_eq!(request(&root,json!({"action":"read","id":"test-1"})).unwrap(),v);
  fs::write(root.join("bad.json"),"broken").unwrap();let listed=request(&root,json!({"action":"list"})).unwrap();assert_eq!(listed["entries"].as_array().unwrap().len(),1);assert_eq!(listed["unreadable"],1);
  assert!(request(&root,json!({"action":"read","id":"../settings"})).is_err());let mut invalid=v.clone();invalid["config"]=Value::Null;assert!(request(&root,json!({"action":"write","document":invalid})).is_err());assert_eq!(request(&root,json!({"action":"read","id":"test-1"})).unwrap(),v);fs::remove_dir_all(root).unwrap();
 }
 #[test]fn permanent_delete_removes_normal_and_trashed_files_but_preserves_results(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-delete-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let result=root.join("result");fs::create_dir_all(&result).unwrap();fs::write(result.join("summary.csv"),"preserved").unwrap();
  for id in ["normal","trashed"]{
   let doc=json!({"version":1,"id":id,"database":{"kind":"rtdb"},"config":{"name":"Delete case","species":[],"points":[]},"last_result":result,"updated_at":"2026-09-08"});
   request(&root,json!({"action":"write","document":doc})).unwrap();
   if id=="trashed"{request(&root,json!({"action":"trash","id":id})).unwrap();}
   request(&root,json!({"action":"delete","id":id})).unwrap();
   assert!(!file(&root,id).unwrap().exists());assert!(!file(&root.join("Trash"),id).unwrap().exists());
   assert!(request(&root,json!({"action":"write","document":doc})).is_err());
   request(&root,json!({"action":"delete","id":id})).unwrap();
  }
  assert_eq!(fs::read_to_string(result.join("summary.csv")).unwrap(),"preserved");
  assert!(request(&root,json!({"action":"delete","id":"../result/summary"})).is_err());
  fs::remove_dir_all(root).unwrap();
 }
 #[test]fn concurrent_delete_and_autosave_cannot_resurrect_the_record(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-delete-race-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let doc=json!({"version":1,"id":"case-race","database":{},"config":{},"updated_at":"2026-09-08"});
  request(&root,json!({"action":"write","document":doc})).unwrap();
  std::thread::scope(|scope|{
   for _ in 0..20{let root=&root;let doc=&doc;scope.spawn(move||{let _=request(root,json!({"action":"write","document":doc}));});}
   let root=&root;scope.spawn(move||request(root,json!({"action":"delete","id":"case-race"})).unwrap());
  });
  assert!(!root.join("case-race.json").exists());assert!(!root.join("case-race.json.tmp").exists());
  assert!(request(&root,json!({"action":"write","document":doc})).is_err());fs::remove_dir_all(root).unwrap();
 }
 #[cfg(unix)]
 #[test]fn delete_does_not_follow_a_linked_trash_directory(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-delete-link-{}",std::process::id()));let external=root.with_extension("external");
  fs::create_dir_all(&root).unwrap();fs::create_dir_all(&external).unwrap();fs::write(external.join("case-a.json"),"external record").unwrap();
  std::os::unix::fs::symlink(&external,root.join("Trash")).unwrap();
  assert!(request(&root,json!({"action":"delete","id":"case-a"})).is_err());
  assert_eq!(fs::read_to_string(external.join("case-a.json")).unwrap(),"external record");
  fs::remove_dir_all(root).unwrap();fs::remove_dir_all(external).unwrap();
 }

 #[test]fn result_locations_survive_reopen_and_forgetting_never_deletes_files(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-result-history-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let result=root.join("user-result");fs::create_dir_all(&result).unwrap();fs::write(result.join("summary.csv"),"preserved").unwrap();
  let entry=json!({"kind":"run","path":result,"name":"实验","opened_at":"2026-09-08T00:00:00Z","status":"running","completed":1,"total":12});
  request(&root,json!({"action":"results_remember","entry":entry})).unwrap();
  let mut updated=entry.clone();updated["opened_at"]=json!("2026-09-08T01:00:00Z");updated["completed"]=json!(12);updated["status"]=json!("completed");
  let list=request(&root,json!({"action":"results_update","entry":updated})).unwrap();assert_eq!(list["entries"][0]["opened_at"],entry["opened_at"]);assert_eq!(list["entries"][0]["completed"],12);
  assert_eq!(request(&root,json!({"action":"list"})).unwrap()["unreadable"],0);
  request(&root,json!({"action":"results_forget","path":result})).unwrap();request(&root,json!({"action":"results_update","entry":updated})).unwrap();
  assert_eq!(request(&root,json!({"action":"results_list"})).unwrap()["entries"],json!([]));assert_eq!(fs::read_to_string(result.join("summary.csv")).unwrap(),"preserved");
  fs::remove_dir_all(root).unwrap();
 }
 #[test]fn result_migration_is_once_only_and_invalid_index_is_preserved(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-result-migration-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let entries:Vec<_>=(0..20).map(|i|json!({"path":root.join(format!("workspace-{i}.html")),"kind":"workspace","name":"同名","opened_at":""})).collect();
  for entry in &entries{fs::write(entry["path"].as_str().unwrap(),"saved workspace").unwrap();}
  assert_eq!(request(&root,json!({"action":"results_import","entries":entries})).unwrap()["entries"].as_array().unwrap().len(),20);
  request(&root,json!({"action":"results_forget","path":entries[0]["path"]})).unwrap();
  assert_eq!(request(&root,json!({"action":"results_import","entries":entries})).unwrap()["entries"].as_array().unwrap().len(),19);
  let index=root.join("Results/index.json");fs::write(&index,"unreadable original").unwrap();
  assert!(request(&root,json!({"action":"results_remember","entry":entries[0]})).is_err());assert_eq!(fs::read_to_string(index).unwrap(),"unreadable original");fs::remove_dir_all(root).unwrap();
 }
 #[test]fn empty_trash_only_deletes_confirmed_files_and_rejects_late_autosaves(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-empty-trash-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let doc=|id:&str|json!({"version":1,"id":id,"database":{},"config":{},"updated_at":"2026-09-08"});
  for id in ["active","a","b","newly-deleted"]{request(&root,json!({"action":"write","document":doc(id)})).unwrap();if id!="active"{request(&root,json!({"action":"trash","id":id})).unwrap();}}
  fs::write(root.join("Trash/unrecognized.txt"),"preserved").unwrap();
  assert_eq!(request(&root,json!({"action":"empty_trash","ids":["a","b"]})).unwrap()["deleted"],2);
  assert!(root.join("active.json").exists());assert!(root.join("Trash/newly-deleted.json").exists());assert!(root.join("Trash/unrecognized.txt").exists());
  assert!(request(&root,json!({"action":"write","document":doc("a")})).is_err());assert!(request(&root,json!({"action":"write","document":doc("b")})).is_err());fs::remove_dir_all(root).unwrap();
 }
 #[test]fn empty_trash_preflights_every_confirmed_id_before_deleting_anything(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-empty-trash-changed-{}",std::process::id()));fs::create_dir_all(root.join("Trash")).unwrap();
  fs::write(root.join("Trash/a.json"),"original").unwrap();fs::write(root.join("b.json"),"restored").unwrap();
  assert!(request(&root,json!({"action":"empty_trash","ids":["a","b"]})).is_err());assert!(root.join("Trash/a.json").exists());
  assert!(request(&root,json!({"action":"empty_trash","ids":["../b"]})).is_err());assert!(root.join("b.json").exists());fs::remove_dir_all(root).unwrap();
 }
 #[cfg(unix)]
 #[test]fn empty_trash_refuses_a_linked_directory(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-empty-trash-link-{}",std::process::id()));let external=root.with_extension("outside");fs::create_dir_all(&root).unwrap();fs::create_dir_all(&external).unwrap();fs::write(external.join("a.json"),"outside").unwrap();
  std::os::unix::fs::symlink(&external,root.join("Trash")).unwrap();assert!(request(&root,json!({"action":"empty_trash","ids":["a"]})).is_err());assert_eq!(fs::read_to_string(external.join("a.json")).unwrap(),"outside");fs::remove_dir_all(root).unwrap();fs::remove_dir_all(external).unwrap();
 }
 #[test]fn history_counts_inner_loops_without_panicking_on_unfinished_input(){
  assert_eq!(inner_count(&json!({"schedule":{"positions":111},"points":[{}]})),111);
  for positions in [json!(null),json!({"easyreaktoro_empty_number":true}),json!(-1),json!(2.5),json!(10001)]{assert_eq!(inner_count(&json!({"schedule":{"positions":positions},"points":[{}]})),0);}
  assert_eq!(inner_count(&json!({"points":[{},{}],"cycles":4})),2);
  for (inner,count) in [(json!({"mode":"repeat","count":100}),100),(json!({"mode":"list","values":[7,5,7]}),3),(json!({"mode":"range","start":0.0,"end":0.3,"step":0.1}),4),(json!({"mode":"range","start":100,"end":50,"step":-10}),6),(json!({"mode":"range","start":100,"end":50,"step":0}),0),(json!({"mode":"repeat","count":-4}),0),(json!({"mode":"list","values":[{}]}),0)]{assert_eq!(inner_count(&json!({"loops":{"inner":inner}})),count);}
 }

 #[test]fn externally_deleted_files_leave_history_and_late_save_cannot_restore_them(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-external-delete-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let doc=json!({"version":1,"id":"external-delete","database":{},"config":{},"updated_at":"2026-09-09"});
  request(&root,json!({"action":"write","document":doc})).unwrap();fs::remove_file(root.join("external-delete.json")).unwrap();
  assert_eq!(request(&root,json!({"action":"list"})).unwrap()["entries"],json!([]));
  assert!(request(&root,json!({"action":"write","document":doc})).is_err());assert!(!root.join("external-delete.json").exists());
  let result=root.join("saved-result");fs::create_dir_all(&result).unwrap();
  let entry=json!({"path":result,"name":"saved","opened_at":"2026-09-09"});
  request(&root,json!({"action":"results_remember","entry":entry})).unwrap();fs::remove_dir_all(&result).unwrap();
  assert_eq!(request(&root,json!({"action":"results_list"})).unwrap()["entries"],json!([]));
  assert_eq!(serde_json::from_slice::<Value>(&fs::read(root.join("Results/index.json")).unwrap()).unwrap()["entries"],json!([]));
  request(&root,json!({"action":"results_update","entry":entry})).unwrap();assert_eq!(request(&root,json!({"action":"results_list"})).unwrap()["entries"],json!([]));fs::remove_dir_all(root).unwrap();
 }

 #[test]fn missing_results_hide_only_the_returned_link_and_preserve_the_simulation(){
  let root=std::env::temp_dir().join(format!("easyreaktoro-missing-result-link-{}",std::process::id()));fs::create_dir_all(&root).unwrap();
  let result=root.join("calculated-result");fs::create_dir_all(&result).unwrap();
  let doc=json!({"version":1,"id":"result-link","database":{"kind":"rtdb"},"config":{"name":"Keep simulation","species":["H2O"],"points":[]},"code_editor":{"source":"# preserve current code"},"last_result":result,"updated_at":"2026-09-09"});
  request(&root,json!({"action":"write","document":doc})).unwrap();
  let file=root.join("result-link.json");let original=fs::read(&file).unwrap();
  assert_eq!(request(&root,json!({"action":"list"})).unwrap()["entries"][0]["last_result"],doc["last_result"]);
  assert_eq!(request(&root,json!({"action":"read","id":"result-link"})).unwrap(),doc);
  fs::remove_dir_all(&result).unwrap();
  let listed=request(&root,json!({"action":"list"})).unwrap();assert_eq!(listed["entries"].as_array().unwrap().len(),1);assert!(listed["entries"][0]["last_result"].is_null());
  let reopened=request(&root,json!({"action":"read","id":"result-link"})).unwrap();let mut expected=doc.clone();expected.as_object_mut().unwrap().remove("last_result");
  assert_eq!(reopened,expected);assert_eq!(reopened["config"],doc["config"]);assert_eq!(fs::read(&file).unwrap(),original);
  // An unavailable path is not necessarily deleted: retain links on non-NotFound errors.
  #[cfg(unix)]{
   let looping=root.join("looping-result");std::os::unix::fs::symlink(&looping,&looping).unwrap();
   assert_ne!(fs::metadata(&looping).unwrap_err().kind(),std::io::ErrorKind::NotFound);
   let mut inaccessible=doc.clone();inaccessible["last_result"]=json!(looping);
   request(&root,json!({"action":"write","document":inaccessible})).unwrap();let original=fs::read(&file).unwrap();
   assert_eq!(request(&root,json!({"action":"list"})).unwrap()["entries"][0]["last_result"],inaccessible["last_result"]);
   assert_eq!(request(&root,json!({"action":"read","id":"result-link"})).unwrap(),inaccessible);assert_eq!(fs::read(&file).unwrap(),original);
  }
  fs::remove_dir_all(root).unwrap();
 }

}
