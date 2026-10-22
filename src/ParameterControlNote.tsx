import {t as tr,useLanguage} from './i18n';
import {ArrowUpRight} from 'lucide-react';
import type {ParameterControl,ParameterEditLocation} from './schedule-references';
import './parameter-control.css';
export function ParameterControlNote({control,onEdit,currentOnly=false,label=tr("数值", "Value")}:{control:ParameterControl;onEdit?:(location:ParameterEditLocation)=>void;currentOnly?:boolean;label?:string}){
 useLanguage();
 if(!control.entries.length)return null;
 const entries=currentOnly&&control.entries.some(entry=>entry.atCoordinate)?control.entries.filter(entry=>entry.atCoordinate):control.entries;
 return <div className="parameter-control-note"><span>{currentOnly?entries.some(entry=>entry.atCoordinate)?tr(`此处${label}由以下设置确定`, "Controlled by the following settings:"):tr(`此处可编辑${label}；其他范围另有设置`, "Edit this value here; other ranges have separate settings."):control.allCovered?tr("每份含量由计算流程设置，基础数量在当前范围不使用", "The calculation process defines per-portion amounts. The base amount is not used in the current range."):tr("这里编辑未单独设置处的每份含量", "Edit the per-portion amount for points without a separate setting")}</span>{entries.map(entry=><div className="parameter-control-entry" key={`${entry.overrideId||'general'}:${entry.settingId}`}><span><b>{entry.scope}</b><span>{entry.summary}{entry.active?'':tr(" · 当前范围不使用", " · Not used in the current range")}</span></span>{onEdit&&<button type="button" className="text-btn" aria-label={tr(`修改${entry.scope}中的${label}`, `Edit ${label} in ${entry.scope}`)} onClick={()=>onEdit({settingId:entry.settingId,...(entry.overrideId?{overrideId:entry.overrideId}:{})})}>{tr("修改", "Edit")}<ArrowUpRight size={12}/></button>}</div>)}</div>;
}
