import {t} from './i18n';
import {stageAt} from './reaction-stages';
import {stageConditionScope} from './reaction-stage-conditions';
import {newId} from './simulation-types';
import {targetKey,targetsOverlap,routeTargetBindings,type LoopTarget} from './simulation-loops';
import type {IndexScope,ParameterProfile,ParameterSetting,Schedule,ScheduleOverride} from './simulation-schedule';

const includes=(s:IndexScope,n:number)=>n>=s.start&&(s.end===undefined||n<=s.end)&&(n-s.start)%(s.step??1)===0;
export const atPoint=(scope:ScheduleOverride,inner:number,outer:number)=>includes(scope.positions,inner+1)&&includes(scope.rounds,outer+1);
export function pointSetting(schedule:Schedule,target:LoopTarget,inner:number,outer:number){
 const matching=schedule.overrides.filter(o=>atPoint(o,inner,outer));
 const scope=matching.find(o=>o.point&&o.parameters.some(p=>targetsOverlap(p.target,target)))??matching.find(o=>o.parameters.some(p=>targetsOverlap(p.target,target)));
 return {scope,setting:scope?.parameters.find(p=>targetsOverlap(p.target,target))??schedule.parameters.find(p=>targetsOverlap(p.target,target))};
}
/** Older single-point ranges have no recoverable parent. Their explicit reset uses the general rule. */
export function isLegacyPoint(scope?:ScheduleOverride){
 return !!scope&&!scope.point&&scope.positions.start===scope.positions.end&&scope.rounds.start===scope.rounds.end
  &&!(scope.positions.start===1&&scope.rounds.start===1);
}
export function setPointSetting(schedule:Schedule,target:LoopTarget,inner:number,outer:number,value:ParameterProfile):Schedule{
 const candidates=schedule.overrides.filter(o=>o.point&&atPoint(o,inner,outer));
 const existing=candidates.find(o=>o.parameters.some(p=>targetsOverlap(p.target,target)))??candidates[0];
 const scope=existing??{id:newId(),point:true as const,rounds:{start:outer+1,end:outer+1},positions:{start:inner+1,end:inner+1},parameters:[]};
 const previous=scope.parameters.find(p=>targetKey(p.target)===targetKey(target));
 const setting:ParameterSetting={id:previous?.id??newId(),target,value};
 const updated={...scope,parameters:previous?scope.parameters.map(p=>p.id===previous.id?setting:p):[...withoutTarget(scope.parameters,target),setting]};
 return {...schedule,overrides:existing?schedule.overrides.flatMap(o=>{
  if(o.id===existing.id)return [updated];
  if(!candidates.includes(o)||!o.parameters.some(p=>targetsOverlap(p.target,target)))return [o];
  const parameters=withoutTarget(o.parameters,target);
  return parameters.length?[{...o,parameters}]:[];
 }):[...schedule.overrides,updated]};
}
/** Split a shared material rule so changing one input preserves the others. */
function withoutTarget(parameters:ParameterSetting[],target:LoopTarget):ParameterSetting[]{
 return parameters.flatMap(p=>{
  if(!targetsOverlap(p.target,target))return [p];
  if(p.target.kind==='route_fraction'&&target.kind==='route_fraction'){
   const removed=routeTargetBindings(target);
   const bindings=routeTargetBindings(p.target).filter(b=>!removed.some(r=>r.route_id===b.route_id&&r.field===b.field));
   if(bindings.length)return [{...p,target:{kind:'route_fraction' as const,...bindings[0],...(bindings.length>1?{bindings}:{})}}];
  }
  return [];
 });
}
export function resetPointSetting(schedule:Schedule,scopeId:string,target:LoopTarget):Schedule{
 return {...schedule,overrides:schedule.overrides.flatMap(o=>{
  if(o.id!==scopeId)return [o];
  const parameters=withoutTarget(o.parameters,target);
  return parameters.length?[{...o,parameters}]:[];
 })};
}

/** Explain and locate the rule restored when this point's override is removed. */
export function inheritedPointRule(schedule:Schedule,target:LoopTarget,inner:number,outer:number){
 const current=pointSetting(schedule,target,inner,outer).scope;
 const resetLegacy=current&&!current.point&&isLegacyPoint(current)?current.id:undefined;
 const inherited={...schedule,overrides:schedule.overrides.filter(o=>!o.point&&o.id!==resetLegacy)};
 const {scope,setting}=pointSetting(inherited,target,inner,outer),stage=stageAt(inner,outer),area=stageConditionScope(stage);
 const same=(a:IndexScope,b:IndexScope)=>a.start===b.start&&a.end===b.end&&(a.step??1)===(b.step??1);
 const stageLabels={first_start:t('首轮 · 第一步','First round · initial step'),first_following:t('首轮 · 后续每一步','First round · following steps'),later_start:t('后续轮次 · 第一步','Subsequent rounds · initial step'),later_following:t('后续轮次 · 后续每一步','Subsequent rounds · following steps')};
 const range=(s:IndexScope)=>`${s.start}–${s.end??t('末','end')}${(s.step??1)>1?t(`，每隔 ${s.step}`,`, every ${s.step}`):''}`;
 const label=scope?(scope.name||(same(scope.rounds,area.rounds)&&same(scope.positions,area.positions)?stageLabels[stage]:t(`轮次 ${range(scope.rounds)} · 位置 ${range(scope.positions)}`,`Rounds ${range(scope.rounds)} · positions ${range(scope.positions)}`))):t('通常规则','General rule');
 return {label,setting,scope,location:setting?{kind:'parameter' as const,target,settingId:setting.id,overrideId:scope?.id,inner,outer}:undefined};
}
