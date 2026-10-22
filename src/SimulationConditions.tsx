import {t as tr,useLanguage,englishCount} from './i18n';
import {useMemo,useState,useEffect,useRef} from 'react';
import {FormulaDiagnosticContext,ReactionFormulaInput,formulaField,revealInput} from './ReactionFormulaInput';
import {stageAt} from './reaction-stages';
import type {ScheduleIssueLocation} from './schedule-diagnostics';
import type {ParameterEditLocation} from './schedule-references';
import {Config,SimSpecies,ReactionStageKey,newId} from './simulation-types';
import {LegacySimulationConditions} from './LegacySimulationConditions';
import {ArrowRight,ArrowDown,Trash2} from 'lucide-react';
import {ReactionConditionFields} from './ReactionConditionFields';
import {WaveComposition} from './WaveComposition';
import {toStageConfig} from './reaction-stages';
import {SchedulePreview,type ScheduleSelection} from './SchedulePreview';
import {compileSchedule,migrateSchedule,scheduleDiagnostic,schedulePoints,scheduleTargets,type Schedule,type StopRules} from './simulation-schedule';
import {profileFormula,replaceParameterFormula} from './reaction-formula';
import {targetDescription,targetKey} from './simulation-loops';
import {EquilibriumConstraintFields} from './EquilibriumConstraintFields';
import {removeConstraint} from './equilibrium-constraints';
import {atPoint,pointSetting,isLegacyPoint,setPointSetting,resetPointSetting} from './local-point-settings';
import './wave-editor.css';
export {NumberField,RouteEditor} from './LegacySimulationConditions';
type Props={config:Config;patch:(value:Partial<Config>)=>void;items:SimSpecies[];disabled:boolean;onError:(e:string)=>void;onMaterials?:()=>void;editParameter?:ParameterEditLocation & {serial:number}};

export function SimulationConditions(props:Props){
 useLanguage();const {config,patch,items,disabled,onMaterials}=props;
 const workspace=useRef<HTMLFieldSetElement>(null),[pendingFocus,setPendingFocus]=useState<ScheduleIssueLocation>();
 useEffect(()=>{if(!pendingFocus)return;const field=formulaField(workspace.current,pendingFocus);if(field)revealInput(field);setPendingFocus(undefined);},[pendingFocus]);
 const [selected,setSelected]=useState<ScheduleSelection>({inner:0,outer:0}),[localId,setLocalId]=useState('');
 useEffect(()=>{if(props.editParameter){setLocalId(props.editParameter.overrideId||'');const scope=config.schedule?.overrides.find(o=>o.id===props.editParameter!.overrideId);if(scope)setSelected({inner:scope.positions.start-1,outer:scope.rounds.start-1});Array.from(document.querySelectorAll('[data-setting-id]')).find(el=>el.getAttribute('data-setting-id')===props.editParameter!.settingId)?.scrollIntoView?.({block:'center'});}},[props.editParameter]);
 const effective=useMemo(()=>{const schedule=migrateSchedule(config);if(!schedule)return null;const normalized=toStageConfig({...config,schedule,loops:undefined}),points=schedulePoints(normalized);return {...normalized,points:points.length?points:config.points};},[config]);
 if(!effective?.schedule)return <LegacySimulationConditions {...props}/>;
 const schedule=effective.schedule;let plan;try{plan=compileSchedule(effective);}catch{}
 const counts=plan?.counts??{inner:schedule.positions,outer:schedule.rounds,total:NaN};
 const outer=Math.max(0,Math.min(selected.outer,(counts.outer||1)-1)),inner=Math.max(0,Math.min(selected.inner,(plan?.lengths[outer]??counts.inner??1)-1));
 const apply=(value:Partial<Config>)=>{
  let next={...effective,...value};if(next.schedule)try{const p=compileSchedule(next);next={...next,schedule:{...next.schedule,positions:p.counts.inner,rounds:p.counts.outer}};}catch{}
  patch({schedule:next.schedule,loops:undefined,reaction_stages:next.reaction_stages,...value,...(value.schedule?{schedule:next.schedule}:{})});
 };
 const update=(next:Schedule)=>apply({schedule:next});
 const stopText=(kind:keyof StopRules)=>schedule.stop?.[kind]??`${kind==='rounds'?'N':'i'} = ${(kind==='rounds'?schedule.rounds:schedule.positions)-1}`;
 const stop=(kind:keyof StopRules,expression:string)=>update({...schedule,stop:{first:stopText('first'),later:stopText('later'),rounds:stopText('rounds'),[kind]:expression}});
 const adjust=(ii:number,oi:number)=>{setLocalId('point');setSelected({inner:ii,outer:oi});};
 const issue=scheduleDiagnostic(effective),extra=[...schedule.parameters.filter(s=>!['temperature','pressure','route_fraction'].includes(s.target.kind)),...(effective.equilibrium_constraints||[]).filter(c=>!schedule.parameters.some(s=>s.target.kind==='equilibrium_constraint'&&s.target.constraint_id===c.id)).map(c=>({id:`base-${c.id}`,target:{kind:'equilibrium_constraint' as const,constraint_id:c.id},value:{mode:'fixed' as const,value:c.value}}))];
 const available=scheduleTargets(effective).filter(s=>s.target.kind==='material_amount'&&!extra.some(e=>targetKey(e.target)===targetKey(s.target)));
 const add=(key:string)=>{if(key==='ph'||key==='fugacity'){const id=newId(),row=key==='ph'?{id,kind:'ph' as const,value:7,titrant:'',exchange:'add_only' as const}:{id,kind:'fugacity' as const,value:1,species:''};apply({equilibrium_constraints:[...(effective.equilibrium_constraints||[]),row],schedule:{...schedule,parameters:[...schedule.parameters,{id:newId(),target:{kind:'equilibrium_constraint',constraint_id:id},value:{mode:'fixed',value:row.value}}]}});}else{const row=available.find(r=>targetKey(r.target)===key);if(row)update({...schedule,parameters:[...schedule.parameters,{id:newId(),target:row.target,value:{mode:'fixed',value:row.value}}]});}};
 const local=!!localId;
 const localTargets=[...(['temperature','pressure'] as const).map(kind=>({kind})),...schedule.overrides.filter(o=>atPoint(o,inner,outer)&&(o.point||isLegacyPoint(o)||o.id===localId)).flatMap(o=>o.parameters.map(p=>p.target))].filter((target,index,all)=>all.findIndex(t=>targetKey(t)===targetKey(target))===index);
 const localFields=localTargets.map(target=>{
  const {setting,scope}=pointSetting(schedule,target,inner,outer),base=targetDescription(target,effective);
  return {target,scope,setting:setting??{id:`inherited-${targetKey(target)}`,target,value:{mode:'fixed' as const,value:base.value}},changed:!!scope&&(scope.point||isLegacyPoint(scope))};
 });
 const editLocal=(target:typeof localTargets[number],expression:string)=>update(setPointSetting(schedule,target,inner,outer,{mode:'expression',expression}));
 const stepCount=(wave:'first'|'later')=>{
  if(!plan)return '—';
  const lengths=wave==='first'?plan.lengths.slice(0,1):plan.lengths.slice(1);if(!lengths.length)return '—';
  const min=Math.min(...lengths),max=Math.max(...lengths),range=min===max?String(min):`${min}–${max}`;
  return wave==='first'?tr(`${range} 步`,englishCount(min,'step')):tr(`${range} 步 / 轮`,`${min===max?englishCount(min,'step'):`${range} steps`} / round`);
 };
 const locateIssue=()=>{
  const location=issue?.location;if(!location)return;
  if(!formulaField(workspace.current,location)&&location.kind==='parameter'&&location.overrideId){setLocalId(location.overrideId);setSelected({inner:location.inner,outer:location.outer});}
  setPendingFocus(location);
 };
 return <FormulaDiagnosticContext.Provider value={issue}><fieldset ref={workspace} className="sim-process-page wave-workspace" disabled={disabled}>
  <header className="wave-workspace-header"><div><h2>{tr('反应步骤','Reaction steps')}</h2><p>{tr('先定义如何沿路径反应，再定义下一轮如何开始。','Define how reactions move along the path, then how the next round starts.')}</p></div>{onMaterials&&<button type="button" className="secondary" onClick={onMaterials}>{tr('编辑 Composition','Edit compositions')}</button>}</header>
  <div className="wave-layout"><div className="wave-definition">
   {(['first','later'] as const).map(wave=><section className="wave-block" key={wave} aria-label={wave==='first'?tr('首轮反应','First round'):tr('后续轮次','Subsequent rounds')}>
    <header className="wave-heading"><div>{wave==='later'&&<ArrowDown size={18}/>}<h3>{wave==='first'?tr('首轮反应','First round'):tr('后续轮次','Subsequent rounds')}</h3><code>{wave==='first'?'N = 0':'N ≥ 1'}</code></div>{wave==='later'&&counts.outer===1&&<small>{tr('当前只计算首轮','Only the first round is currently calculated')}</small>}</header>
    <div className="wave-step-pair">{(['start','following'] as const).map(step=>{const stage=`${wave}_${step}` as ReactionStageKey;return <section className="wave-step" key={step} aria-label={stage}>
     <header><h4>{step==='start'?tr('第一步','Initial step'):<><ArrowRight size={16}/>{tr('后续每一步','Each following step')}</>}</h4><code>{step==='start'?'i = 0':'i ≥ 1'}</code></header>
     <ReactionConditionFields config={effective} stage={stage} onChange={update}/>
     <WaveComposition config={effective} stage={stage} items={items} onChange={apply}/>
    </section>;})}</div>
    <label className="wave-stop"><span>{tr('本轮何时结束','End this round when')}</span><ReactionFormulaInput reference={{stop:wave}} help={{kind:'stop',stage:wave==='first'?'first_following':'later_following'}} aria-label={`${wave} ${tr('结束条件','end condition')}`} value={stopText(wave)} spellCheck={false} onChange={e=>stop(wave,e.target.value)}/><small>{stepCount(wave)}</small></label>
   </section>)}
   <label className="wave-stop wave-finish"><span>{tr('整个模拟何时结束','Finish the simulation when')}</span><ReactionFormulaInput reference={{stop:'rounds'}} help={{kind:'completion'}} aria-label={tr('模拟结束条件','Simulation completion condition')} value={stopText('rounds')} spellCheck={false} onChange={e=>stop('rounds',e.target.value)}/><small>{plan?tr(`共 ${counts.outer} 轮 · ${counts.total} 次平衡`,`${englishCount(counts.outer,'round')} · ${englishCount(counts.total,'equilibrium','equilibria')}`):'—'}</small></label>
   <p className="wave-guide">{tr('选中输入框可查看当前可用变量及其含义。','Focus an input to see the available variables and what they mean.')}</p>
   {(extra.length>0||effective.equilibrium_constraints?.length)&&<section className="wave-extra"><h3>{tr('其他指定条件','Additional specified conditions')}</h3>{extra.map(setting=>{const description=targetDescription(setting.target,effective),constraint=setting.target.kind==='equilibrium_constraint'?effective.equilibrium_constraints?.find(c=>c.id===(setting.target as {constraint_id:string}).constraint_id):undefined;return <div className="wave-extra-item" id={`schedule-setting-${setting.id}`} data-setting-id={setting.id} key={setting.id}><label><span>{description.label}{description.unit?` / ${description.unit}`:''}</span><ReactionFormulaInput reference={{target:setting.target,settingIds:[setting.id]}} help={{kind:'value'}} aria-label={`${description.label} ${tr('数值或公式','value or expression')}`} value={profileFormula(setting.value).replace(/\bV\b/g,'X').replace(/\bR\b/g,'Xr')} onChange={e=>update(setting.id.startsWith('base-')?{...schedule,parameters:[...schedule.parameters,{...setting,id:newId(),value:{mode:'expression',expression:e.target.value}}]}:replaceParameterFormula(schedule,setting.id,e.target.value))}/></label><button type="button" className="sim-icon-btn" aria-label={tr('移除此条件','Remove this condition')} onClick={()=>constraint?apply(removeConstraint(effective,constraint.id)):update({...schedule,parameters:schedule.parameters.filter(s=>s.id!==setting.id)})}><Trash2 size={14}/></button>{constraint&&<EquilibriumConstraintFields row={constraint} items={items} positions={counts.inner} rounds={counts.outer} onChange={row=>apply({equilibrium_constraints:effective.equilibrium_constraints?.map(c=>c.id===row.id?row:c)})}/>}</div>;})}</section>}
   <label className="wave-add-condition"><select aria-label={tr('添加指定条件','Add a specified condition')} value="" onChange={e=>add(e.target.value)}><option value="">{tr('＋ 添加指定条件','＋ Add a specified condition')}</option><option value="ph">{tr('指定 pH','Specify pH')}</option><option value="fugacity">{tr('指定气体逸度','Specify gas fugacity')}</option><optgroup label={tr('Composition 中的含量','Composition contents')}>{available.map(row=><option key={targetKey(row.target)} value={targetKey(row.target)}>{row.label}</option>)}</optgroup></select></label>
  {issue&&<div className="wave-issue" role="status"><span>{issue.message}</span>{issue.location&&<button type="button" className="text-btn" onClick={locateIssue}>{tr('定位到输入','Go to input')} <ArrowRight size={14}/></button>}</div>}
   <p className="wave-range-note">{tr('species 详情中可查看数据库记录的温压适用范围。','Species details show the temperature and pressure ranges recorded in the database.')}</p>
  </div><div className="wave-preview"><SchedulePreview config={effective} items={items} selected={{inner,outer}} onSelect={(inner,outer)=>{setSelected({inner,outer});setLocalId('');}} onAdjust={adjust} onLocateIssue={issue?.location?locateIssue:undefined}/>{local&&<section className="wave-local" aria-label={tr('此点单独设置','Local point conditions')}>
   <h3>{tr(`单独设置 · 第 ${outer+1} 轮，位置 ${inner+1}`,`Local conditions · round ${outer+1}, position ${inner+1}`)}</h3>
   {localFields.map(({target,scope,setting,changed})=>{const description=targetDescription(target,effective),stage=stageAt(inner,outer);return <div className="wave-local-field" key={targetKey(target)} data-state={changed?'modified':'inherited'}>
    <label><span className="wave-local-label"><span>{description.label}{description.unit?` / ${description.unit}`:''}</span><small>{changed?tr('本点修改','Modified here'):tr('沿用规则','Inherited rule')}</small></span>
     <ReactionFormulaInput reference={{target,settingIds:[setting.id],overrideId:scope?.id}} help={{kind:target.kind==='temperature'?'temperature':target.kind==='pressure'?'pressure':'value',stage}} aria-label={`${description.label} ${tr('本点数值或公式','value or expression at this point')}`} value={profileFormula(setting.value,stage,scope).replace(/\bV\b/g,target.kind==='temperature'?'T':target.kind==='pressure'?'P':'X').replace(/\bR\b/g,target.kind==='temperature'?'Tr':target.kind==='pressure'?'Pr':'Xr')} onChange={e=>editLocal(target,e.target.value)}/>
    </label>
    {changed&&scope&&<button type="button" className="text-btn wave-local-reset" aria-label={`${scope.point?tr('恢复沿用','Restore inherited rule'):tr('恢复通常规则','Use general rule')} · ${description.label}`} onClick={e=>{const field=e.currentTarget.closest('.wave-local-field')?.querySelector('input');update(resetPointSetting(schedule,scope.id,target));field?.focus();}}>{scope.point?tr('恢复沿用','Restore inherited rule'):tr('恢复通常规则','Use general rule')}</button>}
   </div>;})}
   <p className="wave-local-note">{tr('仅本点修改会覆盖已有规则；恢复沿用后，继续随原规则变化。','Only edits at this point override existing rules. Restoring a rule keeps this point linked to it.')}</p>
   <select aria-label={tr('选择要单独修改的参数','Choose a parameter for this point')} value="" onChange={e=>{const row=scheduleTargets(effective).find(r=>targetKey(r.target)===e.target.value);if(row)update(setPointSetting(schedule,row.target,inner,outer,{mode:'fixed',value:plan?.valueAt(row.target,inner,outer,row.value)??row.value}));}}><option value="">{tr('＋ 添加本点条件','＋ Add a condition at this point')}</option>{scheduleTargets(effective).filter(row=>!localFields.some(p=>targetKey(p.target)===targetKey(row.target))).map(row=><option key={targetKey(row.target)} value={targetKey(row.target)}>{row.label}</option>)}</select>
  </section>}</div></div>
 </fieldset></FormulaDiagnosticContext.Provider>;
}
