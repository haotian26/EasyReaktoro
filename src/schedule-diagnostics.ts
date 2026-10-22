import type {LoopTarget} from './simulation-loops';

export type ScheduleIssueLocation =
 | {kind:'parameter';target:LoopTarget;settingId?:string;overrideId?:string;inner:number;outer:number}
 | {kind:'stop';rule:'first'|'later'|'rounds'}
 | {kind:'scope';overrideId:string;axis:'positions'|'rounds';field:'start'|'end'|'step'}
 | {kind:'source';routeId:string;inner:number;outer:number};
export type ScheduleDiagnostic={message:string;location?:ScheduleIssueLocation};
export class ScheduleInputError extends Error {
 constructor(message:string,readonly location:ScheduleIssueLocation){super(message);this.name='ScheduleInputError';}
}
/** Keep the deepest failing input, including dependencies evaluated by another field. */
export function atScheduleInput<T>(location:ScheduleIssueLocation,read:()=>T):T{
 try{return read();}catch(error){
  if(error instanceof ScheduleInputError)throw error;
  throw new ScheduleInputError(error instanceof Error?error.message:String(error),location);
 }
}
