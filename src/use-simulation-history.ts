import {t as tr} from './i18n';
import {loopCounts} from './simulation-loops';
import {useEffect,useRef,useState} from 'react';
import {Config,DatabaseSummary,newId,readConfig} from './simulation-types';
import {EditorDraft} from './use-simulation-code';
import {activeHistoryKey,databaseKey,encodeDraft,HistoryDatabase,HistoryEntry,historyDatabase,historyKey,historyList,historyRead,historyWrite,historyMove,SimulationDocument,decodeDocument} from './simulation-history';
import {CodeContextChanged} from './use-simulation-code';
import {simulationError} from './simulation-api';

export function useSimulationHistory(summary:DatabaseSummary|null,ready:boolean,setConfig:(c:Config)=>void,defaults:()=>Config,onError:(s:string)=>void,onDatabase?:(db:HistoryDatabase)=>void){
 const [document,setDocument]=useState<SimulationDocument|null>(null),[entries,setEntries]=useState<HistoryEntry[]>([]),[directory,setDirectory]=useState(''),[loading,setLoading]=useState(false);
 const current=useRef(document),previous=useRef(''),request=useRef(0),fingerprints=useRef(new Map<string,string>());
 const context=useRef('');
 const db=summary?historyDatabase(summary):null,dbKey=db?databaseKey(db)||'':'';
 context.current=dbKey;
 const refresh=async()=>{const result=await historyList();if(!Array.isArray(result.entries))throw new Error(tr("模拟历史暂时无法读取，请重试。", "Simulation history is temporarily unavailable. Try again."));setEntries(result.entries);setDirectory(result.directory);if(result.unreadable)onError(result.unreadable+tr(" 份历史记录无法读取，原文件已保留。", " history entries could not be read. Their original files were kept."));return result.entries;};
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 useEffect(()=>{const update=()=>{if(!window.document.hidden)void refreshRef.current().catch(e=>onError(simulationError(e)));};update();window.addEventListener('focus',update);window.document.addEventListener('visibilitychange',update);return()=>{window.removeEventListener('focus',update);window.document.removeEventListener('visibilitychange',update);};},[]);
 const activate=(next:SimulationDocument)=>{
  const key=historyKey(next.id);if(next.code_editor)localStorage.setItem(key+':code',JSON.stringify(encodeDraft(next.code_editor)));else localStorage.removeItem(key+':code');
  localStorage.setItem(activeHistoryKey(databaseKey(next.database)||''),next.id);localStorage.setItem('easyreaktoro.simulation.active',next.id);
  current.current=next;setDocument(next);setConfig(next.config);previous.current=databaseKey(next.database)||'';
  fingerprints.current.set(next.id,JSON.stringify(encodeDraft([next.config,next.code_editor,next.last_result])));
 };
 const entry=(doc:SimulationDocument):HistoryEntry=>({id:doc.id,name:doc.config.name,database:doc.database,updated_at:doc.updated_at,species_count:doc.config.species.length,point_count:loopCounts(doc.config).inner,last_result:doc.last_result});
 const create=async(config:Config,editor?:EditorDraft)=>{
  if(!db)throw new Error(tr("请先选择数据库。", "Choose a database first."));
  const next:SimulationDocument={version:1,id:newId(),database:db,config,code_editor:editor,updated_at:new Date().toISOString()};
  decodeDocument(encodeDraft(next));await historyWrite(next);setEntries(old=>[entry(next),...old]);if(context.current!==dbKey)throw new CodeContextChanged();activate(next);return next;
 };
 useEffect(()=>{
  if(!ready||!dbKey||previous.current===dbKey)return;
  let cancelled=false;const token=++request.current;setLoading(true);
  (async()=>{
   const all=await refresh(),savedId=localStorage.getItem(activeHistoryKey(dbKey)),matches=all.filter(e=>databaseKey(e.database)===dbKey);
   const found=matches.find(e=>e.id===savedId)||matches[0];let next:SimulationDocument;
   if(found)next=await historyRead(found.id);
   else{
    const legacy='easyreaktoro.simulation.v2:'+dbKey,raw=localStorage.getItem(legacy)||localStorage.getItem('easyreaktoro.simulation.v1:'+dbKey);
    const config=raw?readConfig(JSON.parse(raw),{allowDraft:true}):defaults();let editor:EditorDraft|undefined;
    const code=localStorage.getItem(legacy+':code');if(code)editor=JSON.parse(code);
    next={version:1,id:newId(),database:db!,config,code_editor:editor,updated_at:new Date().toISOString()};
    decodeDocument(encodeDraft(next));if(cancelled||token!==request.current)return;await historyWrite(next);setEntries(old=>[entry(next),...old]);
   }
   if(!cancelled&&token===request.current)activate(next);
  })().catch(e=>{if(!cancelled)onError(tr("模拟未载入：", "Simulation not loaded: ")+simulationError(e));}).finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;};
 },[dbKey,ready]);
 const persist=async(config:Config,editor?:EditorDraft,resultPath?:string)=>{
  const old=current.current;if(!old||databaseKey(old.database)!==dbKey)return;
  const last_result=resultPath||old.last_result,signature=JSON.stringify(encodeDraft([config,editor,last_result]));
  if(fingerprints.current.get(old.id)===signature)return;
  const next={...old,config,code_editor:editor,last_result,updated_at:new Date().toISOString()};await historyWrite(next);
  fingerprints.current.set(old.id,signature);if(current.current?.id===next.id){current.current=next;setDocument(next);}
  setEntries(rows=>[entry(next),...rows.filter(r=>r.id!==next.id)]);
 };
 const open=async(item:HistoryEntry)=>{
  if(databaseKey(item.database)!==dbKey){if(!onDatabase)throw new Error(tr("请先打开此模拟对应的数据库。", "Open this simulation's database first."));localStorage.setItem(activeHistoryKey(databaseKey(item.database)||''),item.id);onDatabase(item.database);return;}
  const next=await historyRead(item.id);if(context.current!==dbKey)throw new CodeContextChanged();activate(next);
 };
 const move=async(id:string,action:'trash'|'restore'|'delete')=>{await historyMove(id,action);fingerprints.current.delete(id);if(action==='trash'||action==='delete'){localStorage.removeItem(historyKey(id)+':code');}await refresh();};
 const isSaved=(config:Config,editor?:EditorDraft)=>!!current.current&&fingerprints.current.get(current.current.id)===JSON.stringify(encodeDraft([config,editor,current.current.last_result]));
 const checkpoint=()=>current.current?structuredClone(current.current):null;
 return {missing:!!document&&!loading&&databaseKey(document.database)===dbKey&&!entries.some(entry=>entry.id===document.id),isSaved,checkpoint,move,document,entries,directory,loading,ready:!!document&&databaseKey(document.database)===dbKey&&ready&&!loading,key:document?historyKey(document.id):'',create,open,persist,refresh};
}
