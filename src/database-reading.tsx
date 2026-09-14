import {t,useLanguage} from './i18n';
import {useEffect,useState} from 'react';
import {Check,Copy} from 'lucide-react';
import './database-reading.css';
export type TemperatureUnit='°C'|'K';
export type PressureUnit='bar'|'MPa'|'Pa';
export type TrialTP={temperature:string;pressure:string;temperatureUnit:TemperatureUnit;pressureUnit:PressureUnit;temperatureK?:number;pressurePa?:number};
export const DEFAULT_TRIAL_TP:TrialTP={temperature:'25',pressure:'1',temperatureUnit:'°C',pressureUnit:'bar'};
const pressureScale:Record<PressureUnit,number>={bar:100000,MPa:1000000,Pa:1};
function inputNumber(text:string){return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())?Number(text):NaN;}
export function readTrialTP(value:TrialTP){
 const temperature=inputNumber(value.temperature),pressure=inputNumber(value.pressure);
 return {temperatureK:Number.isFinite(temperature)?value.temperatureK??temperature+(value.temperatureUnit==='°C'?273.15:0):NaN,pressurePa:Number.isFinite(pressure)?value.pressurePa??pressure*pressureScale[value.pressureUnit]:NaN};
}
export function changeTrialUnit(value:TrialTP,kind:'temperature',unit:TemperatureUnit):TrialTP;
export function changeTrialUnit(value:TrialTP,kind:'pressure',unit:PressureUnit):TrialTP;
export function changeTrialUnit(value:TrialTP,kind:'temperature'|'pressure',unit:TemperatureUnit|PressureUnit):TrialTP{
 const canonical=readTrialTP(value),number=kind==='temperature'?canonical.temperatureK:canonical.pressurePa;
 if(!Number.isFinite(number))return {...value,[kind+'Unit']:unit};
 const display=kind==='temperature'?number-(unit==='°C'?273.15:0):number/pressureScale[unit as PressureUnit];
 // Keep the canonical quantity across unit changes; display rounding never changes the trial condition.
 return {...value,[kind]:String(Number(display.toPrecision(15))),[kind+'Unit']:unit,[kind==='temperature'?'temperatureK':'pressurePa']:number};
}
export function TrialConditions({value,onChange}:{value:TrialTP;onChange:(value:TrialTP)=>void}){
  useLanguage();
 return <div className="database-trial-grid"><label><span>{t("温度", "Temperature")}</span><div><input aria-label={t(`试算温度 (${value.temperatureUnit})`, `Trial temperature (${value.temperatureUnit})`)} inputMode="decimal" value={value.temperature} onChange={e=>onChange({...value,temperature:e.target.value,temperatureK:undefined})}/><select aria-label={t("试算温度单位", "Trial temperature unit")} value={value.temperatureUnit} onChange={e=>onChange(changeTrialUnit(value,'temperature',e.target.value as TemperatureUnit))}><option>°C</option><option>K</option></select></div></label><label><span>{t("压力", "Pressure")}</span><div><input aria-label={t(`试算压力 (${value.pressureUnit})`, `Trial pressure (${value.pressureUnit})`)} inputMode="decimal" value={value.pressure} onChange={e=>onChange({...value,pressure:e.target.value,pressurePa:undefined})}/><select aria-label={t("试算压力单位", "Trial pressure unit")} value={value.pressureUnit} onChange={e=>onChange(changeTrialUnit(value,'pressure',e.target.value as PressureUnit))}><option>bar</option><option>MPa</option><option>Pa</option></select></div></label></div>;
}
export function readingNumber(value:number,digits=8){if(!Number.isFinite(value))return t("未提供", "Not provided");if(value===0)return '0';const rounded=Number(value.toPrecision(digits)),abs=Math.abs(rounded);return abs>=1e7||abs<1e-4?rounded.toExponential():String(rounded);}
export function ReadableNumber({value}:{value:number}){
  useLanguage();
 const [copied,setCopied]=useState(false),[error,setError]=useState(false),shown=readingNumber(value),raw=String(value);
 useEffect(()=>{setCopied(false);setError(false);},[value]);
 if(shown===raw||!Number.isFinite(value))return <strong>{shown}</strong>;
 return <details className="reading-number" onToggle={event=>{if(!event.currentTarget.open){setCopied(false);setError(false);}}}><summary title={t("查看完整数值", "View full value")} aria-label={t(`查看完整数值 ${shown}`, `View full value ${shown}`)}>{shown}</summary><div className="reading-number-original"><code>{raw}</code><button type="button" aria-label={t(`复制完整数值 ${raw}`, `Copy full value ${raw}`)} onClick={async()=>{try{await navigator.clipboard.writeText(raw);setCopied(true);setError(false);}catch{setError(true);}}}>{copied?<Check size={13}/>:<Copy size={13}/>}<span>{copied?t("已复制", "Copied"):t("复制", "Copy")}</span></button>{error&&<small role="status">{t("无法自动复制，可选中上方数值复制。", "Could not copy automatically. Select the value above to copy it.")}</small>}</div></details>;
}
