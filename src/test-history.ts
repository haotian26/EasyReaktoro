import {loopCounts} from './simulation-loops';
export const trashedHistoryDocuments=new Map<string,any>();
export const historyDocuments=new Map<string,any>();
export const resultHistoryEntries=new Map<string,any>();
export function mockHistory(payload:any){
 if(payload.action.startsWith('results_')){
  if(payload.action==='results_remember'||payload.action==='results_update'){
   const old=resultHistoryEntries.get(payload.entry.path);
   if(old||payload.action==='results_remember')resultHistoryEntries.set(payload.entry.path,{...structuredClone(payload.entry),opened_at:payload.action==='results_update'?old.opened_at:payload.entry.opened_at});
  }
  if(payload.action==='results_forget')resultHistoryEntries.delete(payload.path);
  if(payload.action==='results_import')for(const entry of payload.entries)if(!resultHistoryEntries.has(entry.path))resultHistoryEntries.set(entry.path,structuredClone(entry));
  return {success:true,entries:[...resultHistoryEntries.values()].sort((a,b)=>b.opened_at.localeCompare(a.opened_at))};
 }
 if(payload.action==='empty_trash'){
  if(payload.ids.some((id:string)=>!trashedHistoryDocuments.has(id)||historyDocuments.has(id)))throw new Error('最近删除已发生变化，请刷新后再次确认。');
  payload.ids.forEach((id:string)=>trashedHistoryDocuments.delete(id));return {success:true,deleted:payload.ids.length};
 }

 if(payload.action==='list')return {directory:'/test/Simulations',unreadable:0,entries:[...(payload.trash?trashedHistoryDocuments:historyDocuments).values()].map(d=>({id:d.id,name:d.config.name,database:d.database,updated_at:d.updated_at,species_count:d.config.species.length,point_count:loopCounts(d.config).inner,last_result:d.last_result}))};
 if(payload.action==='delete'){historyDocuments.delete(payload.id);trashedHistoryDocuments.delete(payload.id);return {success:true};}
 if(payload.action==='trash'){trashedHistoryDocuments.set(payload.id,historyDocuments.get(payload.id));historyDocuments.delete(payload.id);return {success:true};}
 if(payload.action==='restore'){historyDocuments.set(payload.id,trashedHistoryDocuments.get(payload.id));trashedHistoryDocuments.delete(payload.id);return {success:true};}
 if(payload.action==='write'){historyDocuments.set(payload.document.id,structuredClone(payload.document));return {success:true,path:'/test/Simulations/'+payload.document.id+'.json'};}
 if(payload.action==='read')return structuredClone(historyDocuments.get(payload.id));
 throw new Error('Unexpected history action');
}
export async function flushHistory(){await (window as any).__easyreaktoroFlushSimulation?.();}
export const currentHistory=()=>[...historyDocuments.values()].sort((a,b)=>b.updated_at.localeCompare(a.updated_at))[0];
