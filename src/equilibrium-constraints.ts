import {t} from './i18n';
import type {ScheduleDiagnostic,ScheduleIssueLocation} from './schedule-diagnostics';
import type {Config,EquilibriumConstraint} from './simulation-types';
import type {IndexScope,ParameterSetting} from './simulation-schedule';

const object=(x:any)=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function validConstraintShape(row:any,allowDraft=false):row is EquilibriumConstraint{
 const number=(v:any)=>typeof v==='number'&&(allowDraft||Number.isFinite(v));
 const scope=(s:any)=>s===undefined||object(s)&&number(s.start)&&(s.end===undefined||number(s.end))&&(s.step===undefined||number(s.step));
 return object(row)&&typeof row.id==='string'&&!!row.id&&number(row.value)&&scope(row.rounds)&&scope(row.positions)&&(row.kind==='ph'&&typeof row.titrant==='string'&&['add_only','both'].includes(row.exchange)||row.kind==='fugacity'&&typeof row.species==='string');
}
function scopeIncludes(scope:IndexScope|undefined,index:number){const n=index+1;return !scope||n>=scope.start&&(scope.end===undefined||n<=scope.end)&&(n-scope.start)%(scope.step??1)===0;}
export function constraintActiveAt(row:EquilibriumConstraint,inner:number,outer:number){return scopeIncludes(row.positions,inner)&&scopeIncludes(row.rounds,outer);}
function validScope(s:IndexScope|undefined){return !s||Number.isInteger(s.start)&&s.start>=1&&s.start<=10000&&(s.end===undefined||Number.isInteger(s.end)&&s.end>=s.start&&s.end<=10000)&&(s.step===undefined||Number.isInteger(s.step)&&s.step>=1&&s.step<=10000);}
export function constraintPointCount(row:Pick<EquilibriumConstraint,'rounds'|'positions'>,lengths?:readonly number[]):number|undefined{
 if(!lengths||!validScope(row.rounds)||!validScope(row.positions))return;
 let count=0;
 for(let outer=0;outer<lengths.length;outer++){
  if(!Number.isInteger(lengths[outer])||lengths[outer]<0)return;
  if(!scopeIncludes(row.rounds,outer))continue;
  const start=row.positions?.start??1,end=Math.min(row.positions?.end??lengths[outer],lengths[outer]),step=row.positions?.step??1;
  if(end>=start)count+=Math.floor((end-start)/step)+1;
 }
 return count;
}
export function constraintStructureDiagnostic(config:Config):ScheduleDiagnostic|undefined{
 const issue=(message:string,location?:ScheduleIssueLocation):ScheduleDiagnostic=>({message,location});
 const rows=config.equilibrium_constraints||[],ids=new Set<string>();
 for(const row of rows){
  if(!validConstraintShape(row,true)||ids.has(row.id))return issue(t('平衡目标设置不完整或编号重复。','Equilibrium targets are incomplete or have duplicate identifiers.'));ids.add(row.id);
  const location=(field:'titrant'|'species'|'rounds'|'positions',bound?:'start'|'end'|'step'):ScheduleIssueLocation=>({kind:'constraint',constraintId:row.id,field,bound});
  for(const axis of ['rounds','positions'] as const){const scope=row[axis];if(scope&&!validScope(scope)){const bound=!Number.isInteger(scope.start)||scope.start<1||scope.start>10000?'start':scope.end!==undefined&&(!Number.isInteger(scope.end)||scope.end<scope.start||scope.end>10000)?'end':'step';return issue(t('请补全平衡目标适用的轮次和位置范围。','Complete the rounds and positions where the equilibrium target applies.'),location(axis,bound));}}
 }
}
/** Validate only points that will actually run, including rounds of unequal length. */
export function constraintDefinitionsDiagnostic(config:Config,lengths?:readonly number[]):ScheduleDiagnostic|undefined{
 const structural=constraintStructureDiagnostic(config);if(structural)return structural;
 const issue=(message:string,location?:ScheduleIssueLocation):ScheduleDiagnostic=>({message,location});
 const rows=config.equilibrium_constraints||[],positions=config.schedule?.positions??config.points.length,rounds=config.schedule?.rounds??config.cycles;
 const actual=lengths??(Number.isInteger(rounds)&&rounds>=0&&rounds<=10000?Array.from({length:rounds},()=>positions):[]);
 const activeIds=new Set<string>();
 for(let oi=0;oi<actual.length;oi++)for(const row of rows){
  const first=(row.positions?.start??1)-1;
  if(first<actual[oi]&&constraintActiveAt(row,first,oi))activeIds.add(row.id);
 }
 for(const row of rows){
  if(!activeIds.has(row.id))continue;
  const location=(field:'titrant'|'species'):ScheduleIssueLocation=>({kind:'constraint',constraintId:row.id,field});
  if(row.kind==='ph'&&!row.titrant.trim())return issue(t('请指定用于调整 pH 的中性物质。','Specify an electrically neutral substance to adjust pH.'),location('titrant'));
  if(row.kind==='fugacity'&&!row.species)return issue(t('请选择需要指定逸度的气体。','Choose the gas whose fugacity should be specified.'),location('species'));
 }
 if(actual.every(n=>Number.isInteger(n)&&n>=0)&&actual.reduce((a,b)=>a+b,0)<=20000)for(let oi=0;oi<actual.length;oi++)for(let ii=0;ii<actual[oi];ii++){
  const active=rows.filter(row=>constraintActiveAt(row,ii,oi));
  if(active.filter(row=>row.kind==='ph').length>1)return issue(t(`第 ${oi+1} 轮位置 ${ii+1} 有多个 pH 目标，请调整适用范围。`,`Round ${oi+1}, position ${ii+1} has multiple pH targets. Adjust their ranges.`),{kind:'constraint',constraintId:active.filter(r=>r.kind==='ph')[1].id,field:'rounds'});
  const gases=active.flatMap(row=>row.kind==='fugacity'?[row.species]:[]);if(new Set(gases).size!==gases.length)return issue(t(`第 ${oi+1} 轮位置 ${ii+1} 重复指定了同一气体的逸度。`,`Round ${oi+1}, position ${ii+1} specifies a gas fugacity more than once.`),{kind:'constraint',constraintId:active.filter(r=>r.kind==='fugacity').find((r,i,a)=>a.slice(0,i).some(p=>p.kind==='fugacity'&&r.kind==='fugacity'&&p.species===r.species))!.id,field:'rounds'});
 }
}
export function constraintDefinitionsIssue(config:Config):string|undefined{return constraintDefinitionsDiagnostic(config)?.message;}
export function removeConstraint(config:Config,id:string):Partial<Config>{
 const keep=(p:ParameterSetting)=>p.target.kind!=='equilibrium_constraint'||p.target.constraint_id!==id;
 return {equilibrium_constraints:(config.equilibrium_constraints||[]).filter(c=>c.id!==id),...(config.schedule?{schedule:{...config.schedule,parameters:config.schedule.parameters.filter(keep),overrides:config.schedule.overrides.flatMap(row=>{const parameters=row.parameters.filter(keep);return row.parameters.length&&!parameters.length?[]:[{...row,parameters}];})}}:{})};
}
