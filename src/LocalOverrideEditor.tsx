import {useEffect,useRef} from 'react';
import {Trash2,X} from 'lucide-react';
import {t,useLanguage} from './i18n';
import {numeric,type Config} from './simulation-types';
import {targetDescription} from './simulation-loops';
import {stageAt} from './reaction-stages';
import {profileFormula} from './reaction-formula';
import {ReactionFormulaInput,revealInput} from './ReactionFormulaInput';
import type {IndexScope,ParameterProfile,Schedule} from './simulation-schedule';

/** Edit the stored group itself, including points that are outside today's run. */
export function LocalOverrideEditor({config,id,onChange,onClose}:{config:Config;id:string;onChange:(schedule:Schedule)=>void;onClose:()=>void}){
 useLanguage();const element=useRef<HTMLElement>(null),schedule=config.schedule,group=schedule?.overrides.find(row=>row.id===id);
 useEffect(()=>{const input=element.current?.querySelector('input');if(input)revealInput(input);},[id]);
 if(!schedule||!group)return null;
 const range=(s:IndexScope)=>`${s.start}${s.end===s.start?'':s.end===undefined?t(' 起',' onward'):`–${s.end}`}${(s.step??1)>1?t(`，每隔 ${s.step}`,`, every ${s.step}`):''}`;
 const title=t(`轮次 ${range(group.rounds)} · 位置 ${range(group.positions)}`,`${group.rounds.end===group.rounds.start?'Round':'Rounds'} ${range(group.rounds)} · ${group.positions.end===group.positions.start?'position':'positions'} ${range(group.positions)}`);
 const change=(settingId:string,value:ParameterProfile)=>onChange({...schedule,overrides:schedule.overrides.map(row=>row.id===id?{...row,parameters:row.parameters.map(p=>p.id===settingId?{...p,value}:p)}:row)});
 const remove=(settingId?:string)=>onChange({...schedule,overrides:schedule.overrides.flatMap(row=>{if(row.id!==id)return [row];const parameters=settingId?row.parameters.filter(p=>p.id!==settingId):[];return parameters.length?[{...row,parameters}]:[];})});
 return <section ref={element} className="wave-local wave-retained" aria-label={t('编辑保留的局部条件','Edit retained local conditions')}>
  <header className="wave-retained-heading"><div><h3>{t('编辑局部条件','Edit local conditions')}</h3><p>{title}</p></div><button type="button" className="sim-icon-btn" aria-label={t('关闭局部条件编辑','Close local conditions editor')} onClick={onClose}><X size={16}/></button></header>
  <p className="wave-local-note">{t('修改原有范围内的条件。路径不会延长；运行到这些位置时才生效。','Edit the conditions for this range. The path stays the same; these settings apply only when the run reaches them.')}</p>
  {group.parameters.map(setting=>{const description=targetDescription(setting.target,config),stage=stageAt(group.positions.start-1,group.rounds.start-1),profile=setting.value,symbol=setting.target.kind==='temperature'?'T':setting.target.kind==='pressure'?'P':'X';return <div className="wave-retained-field" key={setting.id} data-setting-id={setting.id}>
   <div><label><span>{description.label}{description.unit?` / ${description.unit}`:''}</span>{profile.mode!=='relative'&&<ReactionFormulaInput reference={{target:setting.target,settingIds:[setting.id],overrideId:id}} help={{kind:setting.target.kind==='temperature'?'temperature':setting.target.kind==='pressure'?'pressure':'value',stage}} aria-label={`${description.label} ${t('保留条件数值或公式','retained value or expression')}`} value={profileFormula(profile,stage,group).replace(/\bV\b/g,symbol).replace(/\bR\b/g,symbol+'r')} onChange={e=>change(setting.id,{mode:'expression',expression:e.target.value})}/>}</label>
    {profile.mode==='relative'&&<div className="wave-retained-relative">{(['start','step','other_step'] as const).map(field=>{const label=field==='start'?t('起始值','Initial value'):field==='step'?(profile.along==='path'?t('每步变化','Change per step'):t('每轮变化','Change per round')):(profile.along==='path'?t('起始值每轮变化','Initial value change per round'):t('起始值每步变化','Initial value change per step'));return <label key={field}><span>{label}</span><input aria-label={`${description.label} ${label}`} type="number" step="any" value={Number.isFinite(profile[field])?profile[field]:''} onChange={e=>change(setting.id,{...profile,[field]:numeric(e.target.value)})}/></label>;})}</div>}
   </div><button type="button" className="sim-icon-btn" aria-label={t(`移除局部条件 · ${description.label}`,`Remove local condition · ${description.label}`)} onClick={()=>remove(setting.id)}><Trash2 size={15}/></button>
  </div>;})}
  <button type="button" className="text-btn wave-retained-remove" onClick={()=>remove()}><Trash2 size={14}/>{t('移除这一组局部条件','Remove this set of local conditions')}</button>
 </section>;
}
