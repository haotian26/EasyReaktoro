import {newId,type Config,type ReactionStageKey} from './simulation-types';
import type {LoopTarget} from './simulation-loops';
import {targetKey,targetsOverlap} from './simulation-loops';
import type {ParameterProfile,ParameterSetting,Schedule,ScheduleOverride} from './simulation-schedule';

export function profileFormula(profile:ParameterProfile,stage?:ReactionStageKey,scope?:Pick<ScheduleOverride,'rounds'|'positions'>):string{
 if(profile.mode==='expression')return profile.expression;
 if(profile.mode==='fixed')return Number.isFinite(profile.value)?String(profile.value):'';
 if(profile.mode==='water_saturation')return 'Psat(T)';
 const ordinal=(axis:'path'|'round')=>{const s=scope?.[axis==='path'?'positions':'rounds'],v=axis==='path'?'i':'N',offset=(s?.start??1)-1,stride=s?.step??1;return stride===1?(offset?`(${v}-${offset})`:v):`(${v}-${offset})/${stride}`;};
 const add=(start:string,step:number,term?:string)=>step?`${start} ${step<0?'-':'+'} ${Math.abs(step)}${term?`*${term}`:''}`:start;
 if(profile.mode==='linear')return add(add(String(profile.start),profile.path_step,ordinal('path')),profile.round_step,ordinal('round'));
 if(profile.mode==='list')return `list(${ordinal(profile.along)}, ${profile.values.join(', ')})`;
 const initializes=profile.along==='path'?stage?.endsWith('start'):stage?.startsWith('first');
 if(initializes)return add(String(profile.start),profile.other_step,profile.along==='path'?'N':'i');
 return add(profile.along==='round'?'R':'V',profile.step);
}
export function conditionFormula(profile:ParameterProfile,kind:'temperature'|'pressure',stage:ReactionStageKey,scope?:Pick<ScheduleOverride,'rounds'|'positions'>){
 const symbol=kind==='temperature'?'T':'P';return profileFormula(profile,stage,scope).replace(/\bV\b/g,symbol).replace(/\bR\b/g,symbol+'r');
}
export function parameterSettings(config:Config,target:LoopTarget){
 const same=(s:ParameterSetting)=>targetsOverlap(s.target,target);
 return [...(config.schedule?.parameters.filter(same)||[]).map(setting=>({setting,scope:undefined as ScheduleOverride|undefined})),...(config.schedule?.overrides||[]).flatMap(scope=>scope.parameters.filter(same).map(setting=>({setting,scope})))];
}
export function replaceParameterFormula(schedule:Schedule,settingId:string,expression:string):Schedule{
 const change=(s:ParameterSetting)=>s.id===settingId?{...s,value:{mode:'expression' as const,expression}}:s;
 return {...schedule,parameters:schedule.parameters.map(change),overrides:schedule.overrides.map(o=>({...o,parameters:o.parameters.map(change)}))};
}

/** A single visible term edits only that term, even after legacy shared bindings. */
export function replaceTargetFormula(schedule:Schedule,target:LoopTarget,settingId:string,expression:string):Schedule{
 const replace=(rows:ParameterSetting[])=>rows.flatMap(s=>{
  if(s.id!==settingId)return [s];
  if(s.target.kind==='route_fraction'&&target.kind==='route_fraction'&&s.target.bindings?.length){
   const keep=s.target.bindings.filter(b=>b.route_id!==target.route_id||b.field!==target.field);
   if(keep.length)return [{...s,target:{kind:'route_fraction' as const,...keep[0],...(keep.length>1?{bindings:keep}:{})}},{...s,id:newId(),target,value:{mode:'expression' as const,expression}}];
  }
  return [{...s,value:{mode:'expression' as const,expression}}];
 });
 return {...schedule,parameters:replace(schedule.parameters),overrides:schedule.overrides.map(o=>({...o,parameters:replace(o.parameters)}))};
}
