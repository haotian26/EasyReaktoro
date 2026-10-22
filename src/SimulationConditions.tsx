import {t as tr,useLanguage} from './i18n';
import {useMemo,useState,useEffect} from 'react';
import type {ParameterEditLocation} from './schedule-references';
import {Config,SimSpecies,ReactionStageKey,newId} from './simulation-types';
import {LegacySimulationConditions} from './LegacySimulationConditions';
import {ArrowRight,ArrowDown,Trash2} from 'lucide-react';
import {ReactionConditionFields} from './ReactionConditionFields';
import {WaveComposition} from './WaveComposition';
import {toStageConfig} from './reaction-stages';
import {SchedulePreview,type ScheduleSelection} from './SchedulePreview';
import {compileSchedule,migrateSchedule,scheduleIssue,schedulePoints,scheduleTargets,type Schedule,type StopRules} from './simulation-schedule';
import {profileFormula,replaceParameterFormula} from './reaction-formula';
import {targetDescription,targetKey} from './simulation-loops';
import {EquilibriumConstraintFields} from './EquilibriumConstraintFields';
import {removeConstraint} from './equilibrium-constraints';
import {isolateSchedulePoint} from './schedule-point-edit';
import './wave-editor.css';
export {NumberField,RouteEditor} from './LegacySimulationConditions';
type Props={config:Config;patch:(value:Partial<Config>)=>void;items:SimSpecies[];disabled:boolean;onError:(e:string)=>void;onMaterials?:()=>void;editParameter?:ParameterEditLocation & {serial:number}};

export function SimulationConditions(props:Props){
 useLanguage();const {config,patch,items,disabled,onMaterials}=props;
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
 const adjust=(ii:number,oi:number)=>{const isolated=isolateSchedulePoint(schedule,ii,oi);update(isolated.schedule);setLocalId(isolated.id);setSelected({inner:ii,outer:oi});};
 const issue=scheduleIssue(effective),extra=[...schedule.parameters.filter(s=>!['temperature','pressure','route_fraction'].includes(s.target.kind)),...(effective.equilibrium_constraints||[]).filter(c=>!schedule.parameters.some(s=>s.target.kind==='equilibrium_constraint'&&s.target.constraint_id===c.id)).map(c=>({id:`base-${c.id}`,target:{kind:'equilibrium_constraint' as const,constraint_id:c.id},value:{mode:'fixed' as const,value:c.value}}))];
 const available=scheduleTargets(effective).filter(s=>s.target.kind==='material_amount'&&!extra.some(e=>targetKey(e.target)===targetKey(s.target)));
 const add=(key:string)=>{if(key==='ph'||key==='fugacity'){const id=newId(),row=key==='ph'?{id,kind:'ph' as const,value:7,titrant:'',exchange:'add_only' as const}:{id,kind:'fugacity' as const,value:1,species:''};apply({equilibrium_constraints:[...(effective.equilibrium_constraints||[]),row],schedule:{...schedule,parameters:[...schedule.parameters,{id:newId(),target:{kind:'equilibrium_constraint',constraint_id:id},value:{mode:'fixed',value:row.value}}]}});}else{const row=available.find(r=>targetKey(r.target)===key);if(row)update({...schedule,parameters:[...schedule.parameters,{id:newId(),target:row.target,value:{mode:'fixed',value:row.value}}]});}};
 const local=schedule.overrides.find(o=>o.id===localId);
 // Showing an editor does not freeze inherited rules such as Psat(T). A local
 // setting is created only when its input is changed.
 const localFields=local?[...(['temperature','pressure'] as const).map(kind=>local.parameters.find(s=>s.target.kind===kind)??{id:`inherited-${kind}`,target:{kind},value:schedule.parameters.find(s=>s.target.kind===kind)?.value.mode==='water_saturation'?{mode:'water_saturation' as const}:{mode:'fixed' as const,value:plan?.valueAt({kind},inner,outer)??NaN}}),...local.parameters.filter(s=>s.target.kind!=='temperature'&&s.target.kind!=='pressure')]:[];
 const editLocal=(id:string,target:typeof localFields[number]['target'],expression:string)=>{
  if(local?.parameters.some(s=>s.id===id))update(replaceParameterFormula(schedule,id,expression));
  else update({...schedule,overrides:schedule.overrides.map(o=>o.id===local?.id?{...o,parameters:[...o.parameters,{id:newId(),target,value:{mode:'expression',expression}}]}:o)});
 };
 return <fieldset className="sim-process-page wave-workspace" disabled={disabled}>
  <header className="wave-workspace-header"><div><h2>{tr('反应步骤','Reaction steps')}</h2><p>{tr('先定义如何沿路径反应，再定义下一轮如何开始。','Define how reactions move along the path, then how the next round starts.')}</p></div>{onMaterials&&<button type="button" className="secondary" onClick={onMaterials}>{tr('编辑 Composition','Edit compositions')}</button>}</header>
  <div className="wave-layout"><div className="wave-definition">
   {(['first','later'] as const).map(wave=><section className="wave-block" key={wave} aria-label={wave==='first'?tr('首轮反应','First round'):tr('后续轮次','Subsequent rounds')}>
    <header className="wave-heading"><div>{wave==='later'&&<ArrowDown size={18}/>}<h3>{wave==='first'?tr('首轮反应','First round'):tr('后续轮次','Subsequent rounds')}</h3><code>{wave==='first'?'N = 0':'N ≥ 1'}</code></div>{wave==='later'&&counts.outer===1&&<small>{tr('当前只计算首轮','Only the first round is currently calculated')}</small>}</header>
    <div className="wave-step-pair">{(['start','following'] as const).map(step=>{const stage=`${wave}_${step}` as ReactionStageKey;return <section className="wave-step" key={step} aria-label={stage}>
     <header><h4>{step==='start'?tr('第一步','Initial step'):<><ArrowRight size={16}/>{tr('后续每一步','Each following step')}</>}</h4><code>{step==='start'?'i = 0':'i ≥ 1'}</code></header>
     <ReactionConditionFields config={effective} stage={stage} onChange={update}/>
     <WaveComposition config={effective} stage={stage} items={items} onChange={apply}/>
    </section>;})}</div>
    <label className="wave-stop"><span>{tr('本轮何时结束','End this round when')}</span><input aria-label={`${wave} ${tr('结束条件','end condition')}`} className="wave-formula" value={stopText(wave)} spellCheck={false} onChange={e=>stop(wave,e.target.value)}/><small>{plan?wave==='first'?tr(`${plan.lengths[0]} 步`,`${plan.lengths[0]} steps`):tr(`${Math.min(...plan.lengths.slice(1))===Infinity?'—':Math.min(...plan.lengths.slice(1))}${new Set(plan.lengths.slice(1)).size>1?'–'+Math.max(...plan.lengths.slice(1)):''} 步 / 轮`,`${plan.lengths.length>1?Math.min(...plan.lengths.slice(1)):'—'}${new Set(plan.lengths.slice(1)).size>1?'–'+Math.max(...plan.lengths.slice(1)):''} steps / round`):'—'}</small></label>
   </section>)}
   <label className="wave-stop wave-finish"><span>{tr('整个模拟何时结束','Finish the simulation when')}</span><input aria-label={tr('模拟结束条件','Simulation completion condition')} className="wave-formula" value={stopText('rounds')} spellCheck={false} onChange={e=>stop('rounds',e.target.value)}/><small>{plan?tr(`共 ${counts.outer} 轮 · ${counts.total} 次平衡`,`${counts.outer} rounds · ${counts.total} equilibria`):'—'}</small></label>
   <div className="wave-guide"><p>{tr('直接填数值或公式。i 从 0 开始计步，N 从 0 开始计轮；达到结束条件的这一步仍会计算。','Enter a value or expression. Step index i and round index N start at 0. The step that meets the end condition is included.')}</p><p>{tr('温压公式取前一步的实际值；每轮起点取上一轮起点。压力公式中的 T、用量公式中的 T 和 P 使用本步条件。Tr、Pr 始终取上一轮同位置。','Temperature and pressure expressions use the previous step, or the previous round’s start. T in a pressure expression, and T and P in an amount expression, use the current step. Tr and Pr refer to the same position in the previous round.')}</p><p><code>T - 50</code> {tr('降温','cooling')}<span> · </span><code>Psat(T)</code> {tr('饱和蒸汽压','saturation pressure')}<span> · </span><code>0.5</code> {tr('取一半物料','take half the material')}<span> · </span><code>i = 3</code> {tr('共 4 步','4 steps')}</p></div>
   {(extra.length>0||effective.equilibrium_constraints?.length)&&<section className="wave-extra"><h3>{tr('其他指定条件','Additional specified conditions')}</h3>{extra.map(setting=>{const description=targetDescription(setting.target,effective),constraint=setting.target.kind==='equilibrium_constraint'?effective.equilibrium_constraints?.find(c=>c.id===(setting.target as {constraint_id:string}).constraint_id):undefined;return <div className="wave-extra-item" id={`schedule-setting-${setting.id}`} data-setting-id={setting.id} key={setting.id}><label><span>{description.label}{description.unit?` / ${description.unit}`:''}</span><input aria-label={`${description.label} ${tr('数值或公式','value or expression')}`} className="wave-formula" value={profileFormula(setting.value).replace(/\bV\b/g,'X').replace(/\bR\b/g,'Xr')} onChange={e=>update(setting.id.startsWith('base-')?{...schedule,parameters:[...schedule.parameters,{...setting,id:newId(),value:{mode:'expression',expression:e.target.value}}]}:replaceParameterFormula(schedule,setting.id,e.target.value))}/></label><button type="button" className="sim-icon-btn" aria-label={tr('移除此条件','Remove this condition')} onClick={()=>constraint?apply(removeConstraint(effective,constraint.id)):update({...schedule,parameters:schedule.parameters.filter(s=>s.id!==setting.id)})}><Trash2 size={14}/></button>{constraint&&<EquilibriumConstraintFields row={constraint} items={items} positions={counts.inner} rounds={counts.outer} onChange={row=>apply({equilibrium_constraints:effective.equilibrium_constraints?.map(c=>c.id===row.id?row:c)})}/>}</div>;})}</section>}
   <label className="wave-add-condition"><select aria-label={tr('添加指定条件','Add a specified condition')} value="" onChange={e=>add(e.target.value)}><option value="">{tr('＋ 添加指定条件','＋ Add a specified condition')}</option><option value="ph">{tr('指定 pH','Specify pH')}</option><option value="fugacity">{tr('指定气体逸度','Specify gas fugacity')}</option><optgroup label={tr('Composition 中的含量','Composition contents')}>{available.map(row=><option key={targetKey(row.target)} value={targetKey(row.target)}>{row.label}</option>)}</optgroup></select></label>
   {issue&&<div className="loop-error" role="status">{issue}</div>}
   <p className="wave-range-note">{tr('species 详情中可查看数据库记录的温压适用范围。','Species details show the temperature and pressure ranges recorded in the database.')}</p>
  </div><div className="wave-preview"><SchedulePreview config={effective} items={items} selected={{inner,outer}} onSelect={(inner,outer)=>{setSelected({inner,outer});setLocalId('');}} onAdjust={adjust}/>{local&&<section className="wave-local" aria-label={tr('此点单独设置','Local point conditions')}><h3>{tr(`单独设置 · 第 ${outer+1} 轮，位置 ${inner+1}`,`Local conditions · round ${outer+1}, position ${inner+1}`)}</h3>{localFields.map(setting=><label key={targetKey(setting.target)}><span>{targetDescription(setting.target,effective).label}</span><input aria-label={`${targetDescription(setting.target,effective).label} ${tr('本点数值或公式','value or expression at this point')}`} className="wave-formula" value={profileFormula(setting.value,undefined,local).replace(/\bV\b/g,setting.target.kind==='temperature'?'T':setting.target.kind==='pressure'?'P':'X').replace(/\bR\b/g,setting.target.kind==='temperature'?'Tr':setting.target.kind==='pressure'?'Pr':'Xr')} onChange={e=>editLocal(setting.id,setting.target,e.target.value)}/></label>)}<p className="wave-local-note">{tr('未改动的参数继续沿用原规则。','Unchanged parameters keep their existing rules.')}</p><select aria-label={tr('选择要单独修改的参数','Choose a parameter for this point')} value="" onChange={e=>{const row=scheduleTargets(effective).find(r=>targetKey(r.target)===e.target.value);if(row)update({...schedule,overrides:schedule.overrides.map(o=>o.id===local.id?{...o,parameters:[...o.parameters,{id:newId(),target:row.target,value:{mode:'fixed',value:plan?.valueAt(row.target,inner,outer,row.value)??row.value}}]}:o)});}}><option value="">{tr('＋ 添加本点条件','＋ Add a condition at this point')}</option>{scheduleTargets(effective).filter(row=>!localFields.some(p=>targetKey(p.target)===targetKey(row.target))).map(row=><option key={targetKey(row.target)} value={targetKey(row.target)}>{row.label}</option>)}</select></section>}</div></div>
 </fieldset>;
}
