import {useContext,useState} from 'react';
import {t,useLanguage} from './i18n';
import type {Config,ReactionStageKey} from './simulation-types';
import type {Schedule} from './simulation-schedule';
import {stageCondition,setStageCondition} from './reaction-stage-conditions';
import {conditionFormula,parameterSettings,replaceParameterFormula} from './reaction-formula';
import {FormulaDiagnosticContext,ReactionFormulaInput,matchesFormulaInput} from './ReactionFormulaInput';

export function ReactionConditionFields({config,stage,onChange}:{config:Config;stage:ReactionStageKey;onChange:(schedule:Schedule)=>void;onAdvanced?:()=>void}){
 useLanguage();
 return <div className="wave-conditions">{(['temperature','pressure'] as const).map(kind=><Condition key={kind} {...{config,stage,kind,onChange}}/>)}</div>;
}
function Condition({config,stage,kind,onChange}:{config:Config;stage:ReactionStageKey;kind:'temperature'|'pressure';onChange:(schedule:Schedule)=>void}){
 const diagnostic=useContext(FormulaDiagnosticContext);
 const [error,setError]=useState('');
 const state=stageCondition(config,stage,kind),symbol=kind==='temperature'?'T':'P',title=kind==='temperature'?t('温度','Temperature'):t('压力','Pressure'),unit=kind==='temperature'?'°C':'bar';
 const rules=parameterSettings(config,{kind}).filter(r=>state.settingIds.includes(r.setting.id));
 const only=state.rawProfile??state.profile,scope=rules.length===1?rules[0].scope:undefined;
 const change=(text:string)=>{try{onChange(setStageCondition(config.schedule!,stage,{kind},{mode:'expression',expression:text}));setError('');}catch(e){setError(String(e instanceof Error?e.message:e));}};
 return <div className="wave-condition">
  <label htmlFor={`${stage}-${kind}`}><span>{title}</span><small>{unit}</small></label><span className="wave-equals">{symbol} =</span>
  {only?<ReactionFormulaInput id={`${stage}-${kind}`} aria-label={`${stage} ${title}`} reference={{target:{kind},stage,settingIds:state.settingIds}} help={{kind,stage}} value={conditionFormula(only,kind,stage,scope)} onChange={e=>change(e.target.value)}/>:<div className="wave-existing-rules">{rules.map(({setting,scope})=><label key={setting.id}>
   <span>{scope?t(`轮次 ${scope.rounds.start}–${scope.rounds.end??'末'} · 位置 ${scope.positions.start}–${scope.positions.end??'末'}`,`Rounds ${scope.rounds.start}–${scope.rounds.end??'end'} · positions ${scope.positions.start}–${scope.positions.end??'end'}`):t('其余位置','Other positions')}</span>
   {scope&&<div className="wave-inline-scope">{(['rounds','positions'] as const).map(axis=><label key={axis}><span>{axis==='rounds'?t('轮次','Rounds'):t('位置','Positions')}</span>{(['start','end',...(scope[axis].step!==undefined&&scope[axis].step!==1?['step' as const]:[])] as const).map(field=>{
    const reference={scope:{overrideId:scope.id,axis,field}};
    return <input key={field} aria-label={`${scope.id} ${axis} ${field}`} data-formula-reference={JSON.stringify(reference)} aria-invalid={matchesFormulaInput(reference,diagnostic?.location)||undefined} type="number" min={1} max={10000} title={field==='start'?t('起始编号','Start'):field==='end'?t('结束编号','End'):t('间隔','Interval')} placeholder={field==='end'?t('末尾','End'):field==='step'?t('间隔','Interval'):''} value={Number.isFinite(scope[axis][field])?scope[axis][field]:''} onChange={e=>onChange({...config.schedule!,overrides:config.schedule!.overrides.map(o=>o.id===scope.id?{...o,[axis]:{...o[axis],[field]:e.target.value.trim()===''?(field==='end'?undefined:NaN):Number(e.target.value)}}:o)})}/>;
   })}</label>)}</div>}
   <ReactionFormulaInput aria-label={`${stage} ${title} ${setting.id}`} reference={{target:{kind},stage,settingIds:[setting.id]}} help={{kind,stage}} value={conditionFormula(setting.value,kind,stage,scope)} onChange={e=>onChange(replaceParameterFormula(config.schedule!,setting.id,e.target.value))}/>
  </label>)}</div>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
