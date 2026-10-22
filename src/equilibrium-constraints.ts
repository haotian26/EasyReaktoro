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
export function constraintDefinitionsDiagnostic(config:Config):ScheduleDiagnostic|undefined{
 const issue=(message:string,location?:ScheduleIssueLocation):ScheduleDiagnostic=>({message,location});
 const rows=config.equilibrium_constraints||[],ids=new Set<string>(),positions=config.schedule?.positions??config.points.length,rounds=config.schedule?.rounds??config.cycles;
 for(const row of rows){
  if(!validConstraintShape(row,true)||ids.has(row.id))return issue(t('平衡目标设置不完整或编号重复。','Equilibrium targets are incomplete or have duplicate identifiers.'));ids.add(row.id);
  const location=(field:'titrant'|'species'|'rounds'|'positions',bound?:'start'|'end'|'step'):ScheduleIssueLocation=>({kind:'constraint',constraintId:row.id,field,bound});
  for(const axis of ['rounds','positions'] as const){const scope=row[axis];if(scope&&!validScope(scope)){const bound=!Number.isInteger(scope.start)||scope.start<1||scope.start>10000?'start':scope.end!==undefined&&(!Number.isInteger(scope.end)||scope.end<scope.start||scope.end>10000)?'end':'step';return issue(t('请补全平衡目标适用的轮次和位置范围。','Complete the rounds and positions where the equilibrium target applies.'),location(axis,bound));}}
  const active=(row.positions?.start??1)<=positions&&(row.rounds?.start??1)<=rounds;
  if(!active)continue;
  if(row.kind==='ph'&&!row.titrant.trim())return issue(t('请指定用于调整 pH 的中性物质。','Specify an electrically neutral substance to adjust pH.'),location('titrant'));
  if(row.kind==='fugacity'&&!row.species)return issue(t('请选择需要指定逸度的气体。','Choose the gas whose fugacity should be specified.'),location('species'));
 }
 if(Number.isInteger(positions)&&Number.isInteger(rounds)&&positions*rounds<=20000)for(let oi=0;oi<rounds;oi++)for(let ii=0;ii<positions;ii++){
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
