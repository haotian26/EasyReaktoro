import {t as tr,useLanguage} from './i18n';
import {ReactNode,useEffect,useRef,useState} from 'react';
import {Config,fmt,numeric} from './simulation-types';
import {controlledBy,Loop,LoopAxis,LoopDefinition,LoopTarget,loopValues,routeId,targetDescription,targetKey} from './simulation-loops';
import {HelpTip} from './HelpTip';
import {Plus,Trash2} from 'lucide-react';
import {activeRouteEntries} from './reaction-stages';
import './loop-editor.css';

function SequenceList({values,onChange,label}:{values:number[];onChange:(v:number[])=>void;label:string}){
 const signature=values.join(', '),last=useRef(signature),[text,setText]=useState(signature);
 useEffect(()=>{if(signature!==last.current){last.current=signature;setText(signature);}},[signature]);
 return <label className="sim-field loop-list-field"><span>{tr("按反应顺序填写各步条件","Enter conditions in reaction order")}</span><textarea aria-label={label} rows={3} value={text} placeholder={tr("以逗号、空格或换行分隔","Separate values with commas, spaces or line breaks")} onChange={e=>{const raw=e.target.value;setText(raw);const next=raw.trim()?raw.trim().split(/[\s,，;；]+/).filter(Boolean).map(Number):[];last.current=next.join(', ');onChange(next);}}/></label>;
}
function LoopNumber({label,value,onChange,ariaLabel,min,step='any'}:{label:string;value:number;onChange:(v:number)=>void;ariaLabel:string;min?:number;step?:string}){return <label className="sim-field"><span>{label}</span><input aria-label={ariaLabel} type="number" step={step} min={min} value={Number.isFinite(value)?value:''} onChange={e=>onChange(numeric(e.target.value))}/></label>;}
function LoopCard({axis,loop,config,onChange,children}:{axis:LoopAxis;loop:Loop;config:Config;onChange:(value:Loop)=>void;children?:ReactNode}){
 const name=axis==='inner'?tr('反应路径',"Reaction path"):tr('反应轮次',"Reaction rounds");
 const modeDrafts=useRef<Partial<Record<Loop['mode'],Loop>>>({});
 const lastVariable=useRef<Exclude<Loop,{mode:'repeat'}>|null>(null);
 modeDrafts.current[loop.mode]=loop;
 if(loop.mode!=='repeat')lastVariable.current=loop;
 const targets:{target:LoopTarget;group:string}[]=[{target:{kind:'temperature'},group:tr('条件',"Conditions")},{target:{kind:'pressure'},group:tr('条件',"Conditions")},...config.materials.flatMap(m=>m.inputs.map(r=>({target:{kind:'material_amount' as const,material_id:m.id,species:r.species},group:tr('Composition 投料量',"Composition dose")}))),...activeRouteEntries(config).flatMap(({route:r,index:i})=>[{target:{kind:'route_fraction' as const,route_id:routeId(r,i),field:'fraction' as const},group:tr('物料份数与比例',"Portions and transfer fractions")},...(!config.reaction_stages&&r.source!=='material'&&r.fallback==='material'?[{target:{kind:'route_fraction' as const,route_id:routeId(r,i),field:'fallback_fraction' as const},group:tr('物料份数与比例',"Portions and transfer fractions")}]:[])])];
 const target=loop.mode==='repeat'?{kind:axis==='inner'?'pressure':'temperature'} as LoopTarget:loop.target,desc=targetDescription(target,config);
 if(loop.mode!=='repeat'&&loop.target.kind==='route_fraction'&&loop.target.bindings&&loop.target.bindings.length>1)targets.push({target:loop.target,group:tr('物料份数与比例',"Portions and transfer fractions")});
 let values:number[]=[],issue='';try{values=loopValues(loop);}catch(e){issue=(e as Error).message;}
 const changeMode=(mode:Loop['mode'])=>{
  const saved=modeDrafts.current[mode];
  if(saved&&(saved.mode==='repeat'||targetDescription(saved.target,config).available)){onChange(saved);return;}
  if(saved)delete modeDrafts.current[mode];
  if(lastVariable.current&&!targetDescription(lastVariable.current.target,config).available)lastVariable.current=null;
  if(mode==='repeat'){onChange({mode,count:values.length||1});return;}
  if(loop.mode==='repeat'&&lastVariable.current){const previous=lastVariable.current;let previousValues:number[];try{previousValues=loopValues(previous);}catch{previousValues=previous.mode==='list'?previous.values:[previous.start];}onChange(mode==='list'?{mode,target:previous.target,values:previousValues}:{mode,target:previous.target,start:previousValues[0],end:previousValues.at(-1)!,step:previousValues.length>1?(previousValues.at(-1)!-previousValues[0])/(previousValues.length-1)||1:1});return;}
  if(mode==='list'){onChange({mode,target,values:loop.mode==='repeat'?[desc.value]:values.length?values:[desc.value]});return;}
  const start=loop.mode==='repeat'?desc.value:values[0]??desc.value,end=loop.mode==='repeat'?desc.value:values.at(-1)??desc.value;
  onChange({mode,target,start,end,step:values.length>1&&loop.mode!=='repeat'?(end-start)/(values.length-1)||1:1});
 };
 const changeTarget=(next:LoopTarget)=>{modeDrafts.current={};lastVariable.current=null;const value=targetDescription(next,config).value;onChange(loop.mode==='list'?{mode:'list',target:next,values:[value]}:{mode:'range',target:next,start:value,end:value,step:1});};
 return <section className={`loop-card loop-card-${axis}`} aria-label={tr(`${name}设置`,`${name} settings`)}>
  <header><div><span className="loop-axis-symbol">{axis==='inner'?'→':'↓'}</span><h3>{name}</h3><HelpTip label={name}>{axis==='inner'?tr('沿路径依次反应。可以逐步改变压力、温度或投料量，也可以保持条件不变，让物料继续反应。',"Follow the path in order. Pressure, temperature or dose can change at each position, or conditions can remain fixed while the material continues reacting."):tr('一轮就是沿完整路径反应一次。各轮可以分别改变条件，使用新的 composition，或从前次结果中选择各相物料。',"A round is one complete pass through the path. Each round can use different conditions, a fresh composition, or selected phases from previous results.")}</HelpTip></div><span className="loop-count">{values.length||'—'} {tr("次"," times")}</span></header>
  <label className="sim-field"><span>{axis==='inner'?tr('沿路径怎样变化',"Variation along the path"):tr('各轮条件怎样变化',"Variation between rounds")}</span><select aria-label={tr(`${name}方式`,`${name} mode`)} value={loop.mode} onChange={e=>changeMode(e.target.value as Loop['mode'])}><option value="repeat">{tr("保持条件不变","Keep conditions fixed")}</option><option value="range">{tr("逐步增加或减少","Increase or decrease stepwise")}</option><option value="list">{tr("分别指定条件","Specify each value")}</option></select></label>
  {loop.mode==='repeat'?<LoopNumber label={axis==='inner'?tr('路径位置数',"Path positions"):tr('总轮数（含第 1 轮）',"Total rounds, including round 1")} ariaLabel={tr(`${name}次数`,`${name} count`)} value={loop.count} min={1} step="1" onChange={count=>onChange({...loop,count})}/>:<>
   <label className="sim-field"><span>{tr("变化的量","Quantity to vary")}{desc.unit&&<small> · {desc.unit}</small>}</span><select aria-label={tr(`${name}变量`,`${name} variable`)} value={targetKey(target)} onChange={e=>{const next=targets.find(t=>targetKey(t.target)===e.target.value);if(next)changeTarget(next.target);}}>{!targets.some(t=>targetKey(t.target)===targetKey(target))&&<option value={targetKey(target)}>{tr("所选参数已移除，请重新选择","The selected parameter was removed. Choose another.")}</option>}{[tr('条件',"Conditions"),tr('Composition 投料量',"Composition dose"),tr('物料份数与比例',"Portions and transfer fractions")].map(group=><optgroup key={group} label={group}>{targets.filter(t=>t.group===group).filter((t,i,rows)=>rows.findIndex(r=>targetKey(r.target)===targetKey(t.target))===i).map(t=>{const d=targetDescription(t.target,config);return <option key={targetKey(t.target)} value={targetKey(t.target)}>{d.label}{d.unit?` / ${d.unit}`:''}</option>;})}</optgroup>)}</select></label>
   {loop.mode==='range'?<div className="loop-range-fields"><LoopNumber label={tr("起始值","Start value")} ariaLabel={tr(`${name}起点`,`${name} start`)} value={loop.start} onChange={start=>onChange({...loop,start})}/><LoopNumber label={axis==='inner'?tr('每步变化 ±',"Change per position ±"):tr('每轮变化 ±',"Change per round ±")} ariaLabel={tr(`${name}步长`,`${name} increment`)} value={loop.step} onChange={step=>onChange({...loop,step})}/><LoopNumber label={tr("结束值","End value")} ariaLabel={tr(`${name}终点`,`${name} end`)} value={loop.end} onChange={end=>onChange({...loop,end})}/></div>:<SequenceList label={tr(`${name}数列`,`${name} values`)} values={loop.values} onChange={values=>onChange({...loop,values})}/>}
   {desc.unit===tr('比例',"Fraction")&&<p className="loop-hint">1 = 100%，0.5 = 50%。</p>}
  </>}
  <div className="loop-sequence-summary">{issue?<span role="status">{issue}</span>:loop.mode==='repeat'?<span>{axis==='inner'?tr('条件保持不变，按下方设置加入或承接物料。',"Conditions stay fixed; add or reuse materials as set below."):tr('每轮沿完整反应路径走一遍。',"Each round follows the complete reaction path.")}</span>:<><strong>{fmt(values[0])} → {fmt(values.at(-1))} {desc.unit}</strong><span>{loop.mode==='range'?tr(`每${axis==='inner'?'步':'轮'}${loop.step<0?'减少':'增加'} ${fmt(Math.abs(loop.step))} ${desc.unit}；到达结束值，或再继续会超出范围时结束。`,`${loop.step<0?'Decrease':'Increase'} by ${fmt(Math.abs(loop.step))} ${desc.unit} ${axis==='inner'?'per position':'per round'}; stop at the end value or before the next increment would exceed it.`):tr('按填写顺序反应；可以重复条件，也可以先升高再降低。',"React in the specified order. Values can repeat or rise and then fall.")}</span></>}</div>
 {children}
 </section>;
}
function RoundPressureEditor({definition,onChange}:{definition:LoopDefinition;onChange:(value:LoopDefinition)=>void}){
 const rows=definition.round_conditions||[];const [expanded,setExpanded]=useState(rows.length>0);let count=1;try{count=loopValues(definition.outer).length;}catch{}
 const change=(index:number,patch:Partial<NonNullable<LoopDefinition['round_conditions']>[number]>)=>onChange({...definition,round_conditions:rows.map((row,i)=>i===index?{...row,...patch}:row)});
 const add=()=>{const used=new Set(rows.map(row=>row.round));let round=1;while(used.has(round))round++;onChange({...definition,round_conditions:[...rows,{round,pressure_mode:definition.base.pressure_mode||'fixed',...(definition.base.pressure_mode==='water_saturation'?{}:{pressure_bar:definition.base.pressure_bar})}]});};
 return <details className="round-pressure-editor" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}>
  <summary>{tr("按轮次单独设置压力","Set pressure for individual rounds")}{rows.length>0&&<span> · {rows.length} {tr("轮"," rounds")}</span>}</summary>
  <p>{tr("未列出的轮次沿用上方条件。这里仅调整所选轮次的压力，温度仍按反应路径变化。","Unlisted rounds use the conditions above. Only pressure is changed here; temperature still follows the reaction path.")}</p>
  {rows.map((row,index)=><div className="round-pressure-row" key={index}>
   <LoopNumber label={tr("第几轮","Round")} ariaLabel={tr(`压力设置 ${index+1} 轮次`,`Pressure setting ${index+1} round`)} value={row.round} min={1} step="1" onChange={round=>change(index,{round})}/>
   <label className="sim-field"><span>{tr("压力方式","Pressure mode")}</span><select aria-label={tr(`压力设置 ${index+1} 方式`,`Pressure setting ${index+1} mode`)} value={row.pressure_mode} onChange={e=>change(index,{pressure_mode:e.target.value as 'fixed'|'water_saturation'})}><option value="water_saturation">{tr("纯水饱和蒸汽压","Pure-water saturation pressure")}</option><option value="fixed">{tr("指定压力","Specified pressure")}</option></select></label>
   {row.pressure_mode==='fixed'?<label className="sim-field"><span>{tr("压力 / bar","Pressure / bar")}</span><input aria-label={tr(`压力设置 ${index+1} 数值`,`Pressure setting ${index+1} value`)} type="number" min="0" step="any" value={row.pressure_bar??''} placeholder={tr("沿用路径或基础压力","Use path or base pressure")} onChange={e=>change(index,{pressure_bar:e.target.value.trim()===''?undefined:numeric(e.target.value)})}/></label>:<div className="round-pressure-note">Psat(T)<span>{tr("随当前温度计算","Calculated from current temperature")}</span></div>}
   <button className="sim-icon-btn" aria-label={tr(`删除压力设置 ${index+1}`,`Delete pressure setting ${index+1}`)} onClick={()=>onChange({...definition,round_conditions:rows.filter((_,i)=>i!==index)})}><Trash2 size={14}/></button>
   {row.round>count&&<small className="round-pressure-inactive">{tr("当前共 ","There are currently ")}{count} {tr("轮；此项保留，增加轮数后生效。"," rounds. This setting is retained and takes effect if the round count is increased.")}</small>}
  </div>)}
  <button className="text-btn" disabled={rows.length>=10000} onClick={add}><Plus size={14}/>{tr("设置另一轮的压力","Set another round's pressure")}</button>
 </details>;
}
export function LoopEditor({config,definition,onChange,initialMaterials,pathMaterials,roundMaterials}:{config:Config;definition:LoopDefinition;onChange:(value:LoopDefinition)=>void;initialMaterials?:ReactNode;pathMaterials?:ReactNode;roundMaterials?:ReactNode}){
 useLanguage();
 const t=controlledBy(definition,{kind:'temperature'}),p=controlledBy(definition,{kind:'pressure'}),axisName=(axis:LoopAxis)=>axis==='inner'?tr('反应路径',"Reaction path"):tr('反应轮次',"Reaction rounds");
 return <div className="loop-editor"><section className="loop-fixed" aria-label={tr("基础条件","Base conditions")}><div className="loop-fixed-title"><h3>{tr("反应条件","Reaction conditions")}</h3><HelpTip label={tr("基础条件","Base conditions")}>{tr("温度、压力或投料量若在下方指定逐步变化，则使用对应位置的数值；其余条件保持这里的设置。下方“每次用什么反应”设置实际加入的物料。","Parameters varied below use the value at each position; all others keep these base conditions. The material-source settings determine what actually enters each equilibrium.")}</HelpTip></div>
   <div className="loop-fixed-fields">{t?<div className="loop-controlled">{tr("温度","Temperature")}<span>{tr("由","Set by ")}{axisName(t)}{tr("设定","")}</span></div>:<LoopNumber label={tr("温度 / °C","Temperature / °C")} ariaLabel={tr("基础温度","Base temperature")} value={definition.base.temperature_c} onChange={temperature_c=>onChange({...definition,base:{...definition.base,temperature_c}})}/>}
    <label className="sim-field"><span>{tr("压力方式","Pressure mode")}</span><select aria-label={tr("基础压力方式","Base pressure mode")} value={definition.base.pressure_mode||'fixed'} onChange={e=>onChange({...definition,base:{...definition.base,pressure_mode:e.target.value as any}})}><option value="fixed">{tr("指定压力","Specified pressure")}</option><option value="water_saturation">{tr("纯水饱和蒸汽压","Pure-water saturation pressure")}</option></select></label>
    {p?<div className="loop-controlled">{tr("压力","Pressure")}<span>{tr("由","Set by ")}{axisName(p)}{tr("设定","")}</span></div>:definition.base.pressure_mode==='water_saturation'?<div className="loop-controlled">{tr("压力","Pressure")}<span>{tr("随本次温度计算","Calculated from this point's temperature")}</span></div>:<LoopNumber label={tr("压力 / bar","Pressure / bar")} ariaLabel={tr("基础压力","Base pressure")} value={definition.base.pressure_bar} onChange={pressure_bar=>onChange({...definition,base:{...definition.base,pressure_bar}})}/>}
   </div><p className="loop-hint">{tr("温压可超出数据库记录的范围；需要时可在物种详情中查看所记录的适用范围。","Temperature and pressure may exceed recorded database ranges. You can review the recorded validity ranges in species details.")}</p>
  {initialMaterials}</section><div className="loop-cards">{(['inner','outer'] as const).map(axis=><LoopCard key={axis} axis={axis} loop={definition[axis]} config={{...config,loops:definition}} onChange={value=>onChange({...definition,[axis]:value})}>{axis==='inner'?pathMaterials:<>{roundMaterials}<RoundPressureEditor definition={definition} onChange={onChange}/></>}</LoopCard>)}</div>
 </div>;
}
