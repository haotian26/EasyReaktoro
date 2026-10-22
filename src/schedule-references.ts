import {t} from './i18n';
import type {Config} from './simulation-types';
import type {LoopTarget,RouteBinding} from './simulation-loops';
import {loopValues} from './simulation-loops';
import {compileSchedule,migrateSchedule,scheduleScopeIndices,scheduleSettingSummary,type Schedule,type ParameterSetting,type ScheduleOverride,type IndexScope} from './simulation-schedule';

/** One reference per physical input, including legacy shared route bindings. */
export function atomicTargets(target:LoopTarget):LoopTarget[]{
 if(target.kind!=='route_fraction')return [target];
 return (target.bindings||[{route_id:target.route_id,field:target.field}]).map(binding=>({kind:'route_fraction',...binding}));
}
export function referenceKey(target:LoopTarget):string{
 if(target.kind==='equilibrium_constraint')return JSON.stringify([target.kind,target.constraint_id]);
 if(target.kind==='material_amount')return JSON.stringify([target.kind,target.material_id,target.species]);
 if(target.kind==='route_fraction')return JSON.stringify([target.kind,target.route_id,target.field]);
 return target.kind;
}
export function referenceMatches(a:LoopTarget,b:LoopTarget){const keys=new Set(atomicTargets(a).map(referenceKey));return atomicTargets(b).some(target=>keys.has(referenceKey(target)));}
function joinedTargets(targets:LoopTarget[]):LoopTarget|null{
 if(!targets.length)return null;
 if(targets[0].kind!=='route_fraction')return targets[0];
 const bindings=targets.map(target=>({route_id:(target as Extract<LoopTarget,{kind:'route_fraction'}>).route_id,field:(target as Extract<LoopTarget,{kind:'route_fraction'}>).field})).filter((binding,index,all)=>all.findIndex(other=>other.route_id===binding.route_id&&other.field===binding.field)===index);
 return {kind:'route_fraction',...bindings[0],...(bindings.length>1?{bindings}:{})};
}
/** Keep IDs, profiles and scope metadata when only a target identity changes. */
export function mapScheduleTargets(schedule:Schedule,map:(target:LoopTarget)=>LoopTarget|null):Schedule{
 const parameters=(rows:ParameterSetting[])=>rows.flatMap(setting=>{const target=map(setting.target);return target?[{...setting,target}]:[];});
 return {...schedule,parameters:parameters(schedule.parameters),overrides:schedule.overrides.flatMap(group=>{const next=parameters(group.parameters);return group.parameters.length&&!next.length?[]:[{...group,parameters:next}];})};
}
export function removeParameterReferences(config:Config,remove:(target:LoopTarget)=>boolean):Partial<Config>{
 const filter=(target:LoopTarget)=>joinedTargets(atomicTargets(target).filter(item=>!remove(item)));
 const result:Partial<Config>={};
 if(config.schedule)result.schedule=mapScheduleTargets(config.schedule,filter);
 if(config.loops){const loops={...config.loops};for(const axis of ['inner','outer'] as const){const loop=loops[axis];if(loop.mode==='repeat')continue;const target=filter(loop.target);if(target)loops[axis]={...loop,target};else{let count=1;try{count=loopValues(loop).length;}catch{}loops[axis]={mode:'repeat',count};}}result.loops=loops;}
 return result;
}
export function hasParameterReference(config:Config,target:LoopTarget):boolean{
 if(config.schedule)return [...config.schedule.parameters,...config.schedule.overrides.flatMap(group=>group.parameters)].some(setting=>referenceMatches(setting.target,target));
 return !!config.loops&&(['inner','outer'] as const).some(axis=>{const loop=config.loops![axis];return loop.mode!=='repeat'&&referenceMatches(loop.target,target);});
}
/** Copy ordinary material quantities. Local exceptions keep their original scope. */
export function copyRouteParameterReferences(config:Config,mapping:Map<string,string>,replaced:Set<string>):Partial<Config>{
 const remove=(target:LoopTarget)=>target.kind==='route_fraction'&&replaced.has(target.route_id);
 const next=removeParameterReferences(config,remove);
 const copyTarget=(target:LoopTarget)=>joinedTargets(atomicTargets(target).flatMap(item=>item.kind==='route_fraction'&&mapping.has(item.route_id)?[{...item,route_id:mapping.get(item.route_id)!}]:[]));
 if(config.schedule){
  const schedule=next.schedule!,used=new Set([...schedule.parameters,...schedule.overrides.flatMap(group=>group.parameters)].map(setting=>setting.id));
  const copies=config.schedule.parameters.flatMap(setting=>{const target=copyTarget(setting.target);if(!target)return [];const base=`${setting.id}-copy`;let id=base,n=1;while(used.has(id))id=`${base}-${n++}`;used.add(id);return [{...structuredClone(setting),id,target}];});
  next.schedule={...schedule,parameters:[...schedule.parameters,...copies]};
 }
 // Legacy axes share one profile; preserve that profile and its unrelated bindings.
 if(config.loops){const loops=next.loops!;for(const axis of ['inner','outer'] as const){const old=config.loops[axis];if(old.mode==='repeat')continue;const copied=copyTarget(old.target);if(!copied)continue;const current=loops[axis];const target=joinedTargets([...(current.mode==='repeat'?[]:atomicTargets(current.target)),...atomicTargets(copied)])!;loops[axis]={...old,target};}}
 return next;
}
function sameScope(a:IndexScope,b:IndexScope,count:number){
 const start=Math.max(a.start,b.start),end=Math.min(a.end??count,b.end??count,count);
 for(let index=start;index<=end;index++)if((index-a.start)%(a.step??1)===0&&(index-b.start)%(b.step??1)===0)return true;
 return false;
}
function groupsOverlap(a:ScheduleOverride,b:ScheduleOverride,schedule:Schedule){return sameScope(a.rounds,b.rounds,schedule.rounds)&&sameScope(a.positions,b.positions,schedule.positions);}
/** Restore just the references removed by an action, never a whole stale schedule. */
export function restoreRemovedScheduleReferences(current:Schedule,before:Schedule,after:Schedule):Schedule{
 let result:Schedule={...current,parameters:[...current.parameters],overrides:current.overrides.map(group=>({...group,parameters:[...group.parameters]}))};
 const restore=(rows:ParameterSetting[],original:ParameterSetting[],cleaned:ParameterSetting[],group?:ScheduleOverride)=>{
  const restored=[...rows];
  for(const old of original){
   const remaining=cleaned.find(setting=>setting.id===old.id),remainingKeys=new Set(remaining?atomicTargets(remaining.target).map(referenceKey):[]);
   const lost=atomicTargets(old.target).filter(target=>!remainingKeys.has(referenceKey(target)));
   if(!lost.length)continue;
   const index=restored.findIndex(setting=>setting.id===old.id),existing=restored[index];
   // Reused IDs now identify deliberate edits, not the removed parameter.
   if(existing&&(!remaining||existing.target.kind!==remaining.target.kind||!referenceMatches(existing.target,remaining.target)))continue;
   const conflicts=(target:LoopTarget)=>restored.some(setting=>setting.id!==old.id&&referenceMatches(setting.target,target))||!!group&&result.overrides.some(other=>other.id!==group.id&&groupsOverlap(group,other,result)&&other.parameters.some(setting=>referenceMatches(setting.target,target)));
   const recoverable=lost.filter(target=>!conflicts(target));
   if(!recoverable.length)continue;
   const target=joinedTargets([...(existing?atomicTargets(existing.target):[]),...recoverable])!;
   const setting=existing?{...existing,target}:{...structuredClone(old),target};
   if(index>=0)restored[index]=setting;else restored.push(setting);
  }
  return restored;
 };
 result.parameters=restore(result.parameters,before.parameters,after.parameters);
 for(const old of before.overrides){
  const cleaned=after.overrides.find(group=>group.id===old.id),index=result.overrides.findIndex(group=>group.id===old.id),existing=result.overrides[index];
  const group=existing||{...structuredClone(old),parameters:[]};
  const parameters=restore(group.parameters,old.parameters,cleaned?.parameters||[],group);
  if(!parameters.length)continue;
  if(existing)result.overrides[index]={...existing,parameters};else result.overrides.push({...group,parameters});
 }
 return result;
}
/** Remap legacy source identities during lossless conversion to the four material groups. */
export function remapRouteTarget(target:LoopTarget,mapping:Map<string,RouteBinding[]>):LoopTarget{
 if(target.kind!=='route_fraction')return target;
 const mapped=atomicTargets(target).flatMap(item=>{const route=item as Extract<LoopTarget,{kind:'route_fraction'}>;const bindings=mapping.get(JSON.stringify([route.route_id,route.field]));return bindings?bindings.map(binding=>({kind:'route_fraction' as const,...binding})):[item];});
 return joinedTargets(mapped)||target;
}

export type ParameterEditLocation={settingId:string;overrideId?:string};
export type ParameterControlEntry=ParameterEditLocation&{scope:string;summary:string;active:boolean;atCoordinate:boolean};
export type ParameterControl={entries:ParameterControlEntry[];covered:number;total:number;allCovered:boolean;firstValue?:number};
/** Explain the settings that actually replace a base value; never evaluate a separate numeric model. */
export function parameterControl(config:Config,target:LoopTarget,coordinate?:[number,number]):ParameterControl{
 const schedule=migrateSchedule(config),empty:ParameterControl={entries:[],covered:0,total:0,allCovered:false};if(!schedule)return empty;
 const validSize=[schedule.positions,schedule.rounds].every(n=>Number.isInteger(n)&&n>0&&n<=10000)&&schedule.positions*schedule.rounds<=20000;
 const total=validSize?schedule.positions*schedule.rounds:0,covered=new Set<number>(),entries:ParameterControlEntry[]=[];
 const range=(scope:IndexScope,last:number,unit:string)=>scope.start===1&&scope.end===undefined&&(scope.step??1)===1?t(`全部${unit}`,`All ${unit}`):t(`第 ${scope.start}${(scope.end??last)===scope.start?'':`–${scope.end??last}`} ${unit}${(scope.step??1)>1?`（每 ${scope.step} ${unit}）`:''}`,`${unit} ${scope.start}${(scope.end??last)===scope.start?'':`–${scope.end??last}`}${(scope.step??1)>1?` (every ${scope.step})`:''}`);
 const general=schedule.parameters.filter(setting=>referenceMatches(setting.target,target));
 for(const setting of general)entries.push({settingId:setting.id,scope:t('通常设置',"General settings"),summary:scheduleSettingSummary(setting,config,{positions:schedule.positions,rounds:schedule.rounds}),active:true,atCoordinate:true});
 for(const group of schedule.overrides){
  const matching=group.parameters.filter(setting=>referenceMatches(setting.target,target));if(!matching.length)continue;
  let positions:number[]=[],rounds:number[]=[],scope=group.name?group.name+' · ':'';
  try{positions=scheduleScopeIndices(group.positions,schedule.positions);rounds=scheduleScopeIndices(group.rounds,schedule.rounds);scope+=`${range(group.rounds,schedule.rounds,t('轮',"rounds"))} · ${range(group.positions,schedule.positions,t('步',"positions"))}`;}catch{scope+=t('范围尚未填完整',"Range is incomplete");}
  const active=positions.length>0&&rounds.length>0,atCoordinate=coordinate?positions.includes(coordinate[0]+1)&&rounds.includes(coordinate[1]+1):false;
  if(validSize)for(const oi of rounds)for(const ii of positions)covered.add((oi-1)*schedule.positions+ii-1);
  for(const setting of matching)entries.push({settingId:setting.id,overrideId:group.id,scope,summary:scheduleSettingSummary(setting,config,{positions:positions.length,rounds:rounds.length}),active,atCoordinate});
 }
 if(coordinate&&entries.some(entry=>entry.overrideId&&entry.atCoordinate))entries.forEach(entry=>{if(!entry.overrideId)entry.atCoordinate=false;});
 const count=general.length?total:covered.size,allCovered=general.length>0||total>0&&count===total;
 let firstValue:number|undefined;try{if(entries.length)firstValue=compileSchedule(config,schedule).valueAt(target,...(coordinate||[0,0]) as [number,number]);}catch{}
 return {entries,covered:count,total,allCovered,firstValue};
}
