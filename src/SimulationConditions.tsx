import {t as tr,useLanguage} from './i18n';
import {useEffect,useMemo,useState} from 'react';
import type {ParameterEditLocation} from './schedule-references';
import {Config,SimSpecies,newId,ReactionStageKey} from './simulation-types';
import {LegacySimulationConditions} from './LegacySimulationConditions';
import {ReactionStageEditor} from './ReactionStageEditor';
import {stageAt,toStageConfig} from './reaction-stages';
import {ScheduleEditor,ScheduleSize} from './ScheduleEditor';
import {SchedulePreview,type ScheduleSelection} from './SchedulePreview';
import {migrateSchedule,scheduleCounts,scheduleIssue,schedulePoints,type Schedule} from './simulation-schedule';
import {isolateSchedulePoint} from './schedule-point-edit';
export {NumberField,RouteEditor} from './LegacySimulationConditions';
type Props={config:Config;patch:(value:Partial<Config>)=>void;items:SimSpecies[];disabled:boolean;onError:(e:string)=>void;onMaterials?:()=>void;editParameter?:ParameterEditLocation & {serial:number}};

export function SimulationConditions(props:Props){
 useLanguage();
 const {config,patch,items,disabled,onMaterials}=props;
 const [panel,setPanel]=useState<'parameters'|'materials'>('parameters'),[selected,setSelected]=useState<ScheduleSelection>({inner:0,outer:0}),[highlight,setHighlight]=useState<{id?:string;settingId?:string;serial:number}>({serial:0});
 useEffect(()=>{if(props.editParameter){setPanel('parameters');setHighlight({id:props.editParameter.overrideId,settingId:props.editParameter.settingId,serial:props.editParameter.serial});}},[props.editParameter]);
 const effective=useMemo(()=>{
  const schedule=migrateSchedule(config);if(!schedule)return null;
  const normalized=toStageConfig({...config,schedule,loops:undefined});
  const points=schedulePoints(normalized),count=Number.isInteger(schedule.positions)&&schedule.positions>=1&&schedule.positions<=10000?schedule.positions:1;
  return {...normalized,cycles:schedule.rounds,points:points.length?points:Array.from({length:count},(_,i)=>({...config.points[0],id:`loop-${i+1}`,label:tr(`路径位置 ${i+1}`, `Path position ${i+1}`)}))};
 },[config]);
 if(!effective?.schedule)return <LegacySimulationConditions {...props}/>;
 const schedule=effective.schedule,counts=scheduleCounts(schedule),inner=Math.max(0,Math.min(selected.inner,(Number.isFinite(counts.inner)?counts.inner:1)-1)),outer=Math.max(0,Math.min(selected.outer,(Number.isFinite(counts.outer)?counts.outer:1)-1));
 const apply=(value:Partial<Config>)=>patch({schedule,loops:undefined,reaction_stages:effective.reaction_stages,...value});
 const update=(next:Schedule)=>apply({schedule:next});
 const selectStage=(stage:ReactionStageKey)=>setSelected({inner:stage.endsWith('following')?Math.max(1,inner):0,outer:stage.startsWith('later')?Math.max(1,outer):0});
 const adjust=(ii:number,oi:number)=>{
  const isolated=isolateSchedulePoint(schedule,ii,oi),id=isolated.id;if(isolated.schedule!==schedule)update(isolated.schedule);
  setPanel('parameters');setHighlight(previous=>({id,serial:previous.serial+1}));setSelected({inner:ii,outer:oi});
 };
 const issue=scheduleIssue(effective);
 return <fieldset className="sim-process-page reaction-workspace" disabled={disabled}>
  <div className="reaction-workbench-toolbar"><ScheduleSize schedule={schedule} onChange={update}/><div className="reaction-workbench-tabs" role="tablist" aria-label={tr("编辑反应过程", "Edit reaction process")}><button role="tab" aria-selected={panel==='parameters'} onClick={()=>setPanel('parameters')}>{tr("条件与用量", "Conditions and amounts")}</button><button role="tab" aria-selected={panel==='materials'} onClick={()=>setPanel('materials')}>{tr("物料来源", "Material sources")}</button></div></div>
  <div className="reaction-workbench"><div className="reaction-workbench-main"><div hidden={panel!=='parameters'}><ScheduleEditor config={effective} schedule={schedule} onChange={update} highlightId={highlight.id} highlightSettingId={highlight.settingId} highlightSerial={highlight.serial} coordinate={{inner,outer}}/></div><div hidden={panel!=='materials'}><ReactionStageEditor config={effective} items={items} selected={stageAt(inner,outer)} coordinate={[inner,outer]} onSelect={selectStage} onChange={apply} onMaterials={onMaterials} onEditParameter={location=>{setPanel('parameters');setHighlight(previous=>({id:location.overrideId,settingId:location.settingId,serial:previous.serial+1}));}}/></div><p className="schedule-workspace-help">{tr("温压可超出数据库记录的范围；species 详情中可查看所记录的适用范围。", "Temperature and pressure can exceed the ranges recorded in the database. Species details show the recorded ranges.")}</p>{issue&&<div className="loop-error" role="status">{issue}</div>}</div><div className="reaction-workbench-preview"><SchedulePreview config={effective} items={items} selected={{inner,outer}} onSelect={(inner,outer)=>setSelected({inner,outer})} onAdjust={adjust}/></div></div>
 </fieldset>;
}
