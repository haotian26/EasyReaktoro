import {t} from './i18n';
import {invoke} from '@tauri-apps/api/core';
import {Config,DatabaseSummary,readConfig} from './simulation-types';
import {EditorDraft,isCodeDocument} from './use-simulation-code';
export type HistoryDatabase={kind:'rtdb'|'official';path?:string;group?:string;name:string};
export type HistoryEntry={id:string;name:string;database:HistoryDatabase;updated_at:string;species_count:number;point_count:number;last_result?:string};
export type SimulationDocument={version:1;id:string;database:HistoryDatabase;config:Config;code_editor?:EditorDraft;updated_at:string;last_result?:string};
export type HistoryList={entries:HistoryEntry[];directory:string;unreadable:number};
export const historyDatabase=(summary:DatabaseSummary):HistoryDatabase=>({kind:summary.kind==='official'?'official':'rtdb',path:summary.path,group:summary.group,name:summary.embedded_name||summary.path?.split('/').pop()?.replace(/\.rtdb$/i,'')||t('数据库',"Database")});
export const databaseKey=(db:HistoryDatabase)=>db.kind==='rtdb'?db.path:db.group+':'+db.name;
export const historyKey=(id:string)=>'easyreaktoro.simulation.history:'+id;
export const activeHistoryKey=(db:string)=>'easyreaktoro.simulation.active:'+db;
export {encodeDraft} from './draft-json';
import {encodeDraft,restoreDraft} from './draft-json';
export function decodeDocument(value:any):SimulationDocument{
 const restored=restoreDraft(value);
 if(restored?.version!==1||typeof restored.id!=='string'||!['rtdb','official'].includes(restored.database?.kind))throw new Error(t('这份模拟历史不完整，未替换当前模拟。',"This saved simulation is incomplete. The current simulation has been kept."));
 // Blank numeric fields remain blank when switching simulations; validate their surrounding structure.
 restored.config=readConfig(restored.config,{allowDraft:true});
 if(restored.code_editor && (restored.code_editor.version!==1||!['ui','code'].includes(restored.code_editor.mode)||(restored.code_editor.document!==null&&!isCodeDocument(restored.code_editor.document))))throw new Error(t('历史记录中的代码不完整，未替换当前模拟。',"The code in this saved simulation is incomplete. The current simulation has been kept."));
 if(restored.code_editor){restored.code_editor.config=readConfig(restored.code_editor.config,{allowDraft:true});if(restored.code_editor.recovery){if(!isCodeDocument(restored.code_editor.recovery.document))throw new Error(t('历史记录中的恢复代码不完整。',"The recovery code in this saved simulation is incomplete."));restored.code_editor.recovery.config=readConfig(restored.code_editor.recovery.config,{allowDraft:true});}}
 return restored;
}
export const historyList=(trash=false)=>invoke<HistoryList>('simulation_history',{payload:{action:'list',trash}});
export const historyRead=async(id:string)=>decodeDocument(await invoke('simulation_history',{payload:{action:'read',id}}));
let writeQueue:Promise<unknown>=Promise.resolve();
export function historyWrite(document:SimulationDocument){
 const encoded=encodeDraft(document);const result=writeQueue.catch(()=>{}).then(()=>invoke<{success:boolean;path:string}>('simulation_history',{payload:{action:'write',document:encoded}}));writeQueue=result;
 return result.then(value=>{if(value.success!==true)throw new Error(t('模拟尚未保存，请重试或另存设置。',"The simulation has not been saved. Try again or save the settings as a new file."));return value;});
}

export function historyMove(id:string,action:'trash'|'restore'|'delete'){
 const result=writeQueue.catch(()=>{}).then(()=>invoke<{success:boolean}>('simulation_history',{payload:{action,id}}));writeQueue=result;
 return result.then(v=>{if(!v.success)throw new Error(t('历史记录操作未完成，请重试。',"The history operation did not finish. Try again."));});
}

export function historyEmptyTrash(ids:string[]){
 const result=writeQueue.catch(()=>{}).then(()=>invoke<{success:boolean;deleted:number}>('simulation_history',{payload:{action:'empty_trash',ids}}));writeQueue=result;
 return result.then(value=>{if(!value.success||value.deleted!==ids.length)throw new Error(t('最近删除尚未清空，请刷新后重试。',"Recently deleted items could not all be cleared. Refresh and try again."));for(const id of ids){try{localStorage.removeItem(historyKey(id)+':code');}catch{/* The history files have already been deleted. */}}return value.deleted;});
}
