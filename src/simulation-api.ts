import {invoke} from '@tauri-apps/api/core';
import {encodeDraft} from './draft-json';
import {userMessage} from './user-messages';
export const simulationCall=<T=any,>(action:string,payload:Record<string,unknown>={})=>invoke<T>('simulation_call',{payload:encodeDraft({action,...payload})});
export const simulationError=userMessage;


/** Retain structured input references through the native bridge's JSON errors. */
export function simulationDiagnostic(error:unknown):import('./schedule-diagnostics').ScheduleDiagnostic{
 let value:any=error instanceof Error?error.message:error;
 if(typeof value==='string')try{value=JSON.parse(value);}catch{}
 if(value?.error)value=value.error;
 const loc=value?.location,coordinate=(n:unknown)=>Number.isInteger(n)&&Number(n)>=0&&Number(n)<10000;
 let location:import('./schedule-diagnostics').ScheduleIssueLocation|undefined;
 if(loc?.kind==='constraint'&&typeof loc.constraintId==='string'&&['titrant','species','rounds','positions','exchange'].includes(loc.field)&&(loc.bound===undefined||['start','end','step'].includes(loc.bound)))location=loc;
 if(loc?.kind==='parameter'&&loc.target?.kind==='equilibrium_constraint'&&typeof loc.target.constraint_id==='string'&&coordinate(loc.inner)&&coordinate(loc.outer))location=loc;
 return {message:location&&typeof value?.diagnostic==='string'?value.diagnostic:simulationError(error),...(location?{location}:{})};
}
