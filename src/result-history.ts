import {t as tr,getLanguage,useLanguage} from './i18n';
import {useCallback,useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {JobStatus} from './simulation-types';
import {simulationError} from './simulation-api';
export type ResultHistoryEntry={path:string;name:string;kind?:'run'|'workspace';opened_at:string;status?:JobStatus['status'];completed?:number;total?:number;database?:string};
type ResultList={entries:ResultHistoryEntry[];success?:boolean};
const LEGACY='easyreaktoro.simulation.runs';
let queue:Promise<unknown>=Promise.resolve();
const request=(payload:Record<string,unknown>)=>{
 const result=queue.catch(()=>{}).then(()=>invoke<ResultList>('simulation_history',{payload}));queue=result;
 return result.then(value=>{if(!Array.isArray(value.entries)||value.success===false)throw new Error(tr('结果历史尚未更新，请重试。',"Result history could not be updated. Try again."));return value.entries;});
};
export async function loadResultHistory(){
 let legacy:unknown;try{legacy=JSON.parse(localStorage.getItem(LEGACY)||'null');}catch{/* A malformed obsolete list must not prevent opening results. */}
 if(Array.isArray(legacy)){
  const entries=legacy.filter((r):r is {path:string;name:string}=>!!r&&typeof r.path==='string'&&(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(r.path))&&typeof r.name==='string').map(r=>({path:r.path,name:r.name,opened_at:''}));
  const result=await request({action:'results_import',entries});
  // Only retire the old list once its complete contents have reached durable storage.
  try{localStorage.removeItem(LEGACY);}catch{/* Durable migration already succeeded. */}return result;
 }
 return request({action:'results_list'});
}
const entryFor=(job:JobStatus):ResultHistoryEntry=>({kind:'run',path:job.output_path,name:job.name||job.output_path.split(/[\\/]/).filter(Boolean).at(-1)||tr('计算结果',"Calculation results"),opened_at:new Date().toISOString(),status:job.status,completed:job.completed,total:job.total,database:job.source?.name});
export function useResultHistory(job:JobStatus|null){
 useLanguage();
 const [entries,setEntries]=useState<ResultHistoryEntry[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const mounted=useRef(true),revision=useRef(0),errorRevision=useRef(0);
 const accept=useCallback(async(work:()=>Promise<ResultHistoryEntry[]>,clearError=true)=>{
  const ticket=++revision.current,errorTicket=clearError?++errorRevision.current:errorRevision.current;
  try{const next=await work();if(mounted.current){if(ticket===revision.current)setEntries(next);if(clearError&&errorTicket===errorRevision.current)setError('');}return true;}
  catch(e){if(mounted.current&&errorTicket===errorRevision.current)setError(simulationError(e));return false;}
 },[]);
 const refresh=useCallback(()=>accept(loadResultHistory),[accept]);
 useEffect(()=>{mounted.current=true;const update=()=>{if(!document.hidden)void refresh().finally(()=>{if(mounted.current)setLoading(false);});};update();window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);return()=>{mounted.current=false;window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};},[refresh]);
 const remember=useCallback((next:JobStatus)=>next.output_path?accept(()=>request({action:'results_remember',entry:entryFor(next)})):Promise.resolve(false),[accept]);
 const rememberWorkspace=useCallback((path:string,name:string)=>accept(()=>request({action:'results_remember',entry:{kind:'workspace',path,name,opened_at:new Date().toISOString()}})),[accept]);
 const forget=useCallback((path:string)=>accept(()=>request({action:'results_forget',path})),[accept]);
 useEffect(()=>{if(job?.output_path)void accept(()=>request({action:'results_update',entry:entryFor(job)}),false);},[accept,job?.output_path,job?.status,job?.completed,job?.total]);
 return {entries,error:error?tr('结果文件保留，历史记录未能更新：',"Result files are retained, but history could not be updated: ")+simulationError(error):'',loading,refresh,remember,rememberWorkspace,forget};
}
export function historyDate(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString(getLanguage()):'';}
export const resultStatus=(status?:JobStatus['status'])=>status?({running:tr('计算中',"Running"),completed:tr('已完成',"Completed"),failed:tr('计算失败',"Calculation failed"),cancelled:tr('已停止',"Stopped"),interrupted:tr('已中断',"Interrupted")}[status]||tr('已保存',"Saved")):tr('已保存',"Saved");
