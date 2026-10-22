import {useMemo} from 'react';
import {t as tr,useLanguage} from './i18n';
import type {DiagramMaterialStages,DiagramStage} from './LoopDiagram';
import type {FlowCoordinate} from './reaction-flow-model';
import {flowOverview,flowStage,type FlowOverviewStage,type FlowOverviewInput,type FlowPoint,type FlowRange,type FlowAnnotation} from './reaction-flow-overview';

type Props={positions:number;rounds:number;materials:DiagramMaterialStages;point:(i:number,o:number)=>FlowPoint;active:(i:number,o:number)=>boolean;selected:FlowCoordinate;onExplore:(point:FlowCoordinate)=>void;annotations?:FlowAnnotation[];showConditions?:boolean};
const number=(value:number)=>Number.isFinite(value)?Number(value.toPrecision(5)).toString():'—';
const span=(value:FlowRange,scale=1)=>value.min===value.max?number(value.min*scale):`${number(value.min*scale)}–${number(value.max*scale)}`;
const phase=(input:FlowOverviewInput)=>input.term.phase==='species'?input.term.species?.join(', ')||'Species':({aqueous:tr('水相','Aqueous phase'),mineral:tr('固相','Solid phases'),gas:tr('气相','Gas phase'),all:tr('全部物料','All material')}[input.term.phase]||input.term.phase);
const phaseClass=(inputs:FlowOverviewInput[])=>inputs.length&&inputs.every(i=>i.term.phase===inputs[0].term.phase)?`phase-${inputs[0].term.phase}`:'';
const quantity=(input:FlowOverviewInput)=>input.source==='fresh'?`× ${span(input.amount)}`:`${span(input.amount,100)}%`;

export function ReactionFlowOverview({positions,rounds,materials,point,active,selected,onExplore,annotations=[],showConditions=true}:Props){
 useLanguage();
 const model=useMemo(()=>flowOverview(positions,rounds,materials,point,active),[positions,rounds,materials,point,active]);
 const stage=model.stages,hasPath=positions>1,hasRounds=rounds>1;
 const coverage=(input:FlowOverviewInput,group:FlowOverviewStage)=>input.count<group.count?<button type="button" className="flow-overview__partial" title={tr('查看未取用的步骤','Inspect a step where this input is not used')} onClick={()=>onExplore(input.missing??input.example)}>{tr(`仅 ${input.count.toLocaleString()}/${group.count.toLocaleString()} 步取用`,`Used at ${input.count.toLocaleString()}/${group.count.toLocaleString()} steps`)}</button>:null;
 const line=(input:FlowOverviewInput,group:FlowOverviewStage,index:number)=><div className={`flow-overview__input phase-${input.term.phase}`} key={index}><span>{input.source==='fresh'?'+ ':''}{input.source==='fresh'?input.term.label||'Composition':phase(input)} <b>{quantity(input)}</b>{input.source==='fresh'&&input.term.phase!=='all'?` · ${phase(input)}`:''}</span>{coverage(input,group)}</div>;
 const connection=(key:DiagramStage,direction:'left'|'above')=>{
  const group=stage[key],inputs=group?.inputs.filter(i=>i.source===direction)||[];
  return <div className={`flow-overview__transfer flow-overview__transfer--${direction} ${phaseClass(inputs)}`} data-overview-transfer={inputs.length?direction:undefined} data-stage={key}>
   {group&&inputs.length>0?<><div className="flow-overview__transfer-label"><small>{direction==='left'?tr('每步从前一步取','From the previous step'):tr('从上一轮同位置取','From the same position above')}</small>{inputs.map((input,n)=>line(input,group,n))}</div><span className="flow-overview__arrow" aria-hidden="true"/></>:group&&direction==='left'?<small className="flow-overview__independent">{tr('不从前一步取料','No input from the previous step')}</small>:null}
  </div>;
 };
 const card=(key:DiagramStage)=>{
  const group=stage[key];if(!group)return <div className="flow-overview__absent">{tr('此处之前已结束','Ends before this stage')}</div>;
  const following=key.endsWith('following'),selectedHere=flowStage(selected)===key;
  const target=selectedHere?selected:group.first,begin=following?2:1;
  // Later rounds may have different lengths. The grouped node describes their
  // actual union, with total coverage and separate round-length information.
  const maxPosition=following?Math.max(...model.lengths.slice(key.startsWith('first')?0:1,key.startsWith('first')?1:undefined)):1;
  const pressure=[...(group.saturation?['Psat(T)']:[]),...(Number.isFinite(group.pressure.min)?[`${span(group.pressure)} bar`]:[])].join(' / ');
  return <article className={`flow-overview__stage${selectedHere?' is-selected':''}`} data-overview-stage={key} data-point-count={group.count}>
   <button type="button" className="flow-overview__stage-open" onClick={()=>onExplore(target)} aria-label={tr(`展开${key.startsWith('first')?'首轮':'后续轮次'}${following?'后续步骤':'起点'}附近`,`Explore ${key.startsWith('first')?'first-round':'later-round'} ${following?'path steps':'start'}`)}>
    <span className="flow-overview__symbols" aria-hidden="true">{following?<><i/><em>→</em><i/><em>⋯</em><i/></>:<i/>}</span>
    <strong>{following?tr(`位置 ${begin}–${maxPosition}`,`Positions ${begin}–${maxPosition}`):tr('位置 1','Position 1')}</strong>
    <small>{following?tr('逐步执行到本轮结束','Advance to the end of this round'):tr('本轮起点','Start of the round')}</small>
    {showConditions&&<span className="flow-overview__values"><span>T {span(group.temperature)} °C</span><span>P {pressure}</span></span>}
   </button>
   {group.inputs.some(i=>i.source==='fresh')&&<div className="flow-overview__fresh">{group.inputs.filter(i=>i.source==='fresh').map((input,n)=>line(input,group,n))}</div>}
   {group.inputs.filter(i=>i.source==='other').map((input,n)=><div key={n} className={`flow-overview__other phase-${input.term.phase}`}><button type="button" onClick={()=>onExplore(input.example)}>{input.differentSources?tr('↘ 其他位置，查看来源','↘ Other positions · inspect source'):tr(`↘ 来源：第 ${input.from!.outer+1} 轮 · 位置 ${input.from!.inner+1}`,`↘ From round ${input.from!.outer+1} · position ${input.from!.inner+1}`)}</button>{line(input,group,n)}</div>)}
  </article>;
 };
 const laterLengths=model.lengths.slice(1),minLength=Math.min(...laterLengths),maxLength=Math.max(...laterLengths);
 const partialInputs=Object.values(stage).flatMap(group=>group.inputs.filter(input=>input.count<group.count));
 return <div className="flow-overview" aria-label={tr('重复流程概览','Repeated flow overview')}>
  <div className="flow-overview__intro"><strong>{tr('流程概览','Flow overview')}</strong><span>{tr(`${positions.toLocaleString()} 个路径位置 · ${rounds.toLocaleString()} 轮`,`${positions.toLocaleString()} path positions · ${rounds.toLocaleString()} rounds`)}</span></div>
  <div className="flow-overview__scroll"><div className={`flow-overview__diagram${!hasPath?' flow-overview__diagram--single-path':''}`}>
   <div className="flow-overview__round" style={{gridRow:1}}><strong>{tr('第 1 轮','Round 1')}</strong><small>{tr(`${model.lengths[0]} 步`,`${model.lengths[0]} steps`)}</small></div>
   <div className="flow-overview__cell" style={{gridRow:1,gridColumn:2}}>{card('first_start')}</div>
   {hasPath&&<><div style={{gridRow:1,gridColumn:3}}>{connection('first_following','left')}</div><div className="flow-overview__cell" style={{gridRow:1,gridColumn:4}}>{card('first_following')}</div></>}
   {hasRounds&&<>
    <div style={{gridRow:2,gridColumn:2}}>{connection('later_start','above')}</div>{hasPath&&<div style={{gridRow:2,gridColumn:4}}>{connection('later_following','above')}</div>}
    <div className="flow-overview__round" style={{gridRow:3}}><strong>{rounds===2?tr('第 2 轮','Round 2'):tr(`第 2–${rounds} 轮`,`Rounds 2–${rounds}`)}</strong><small>{tr(`依次执行 ${rounds-1} 轮`,`${rounds-1} rounds`)}</small><small>{minLength===maxLength?tr(`每轮 ${minLength} 步`,`${minLength} steps per round`):tr(`每轮 ${minLength}–${maxLength} 步`,`${minLength}–${maxLength} steps per round`)}</small></div>
    <div className="flow-overview__cell" style={{gridRow:3,gridColumn:2}}>{card('later_start')}</div>{hasPath&&<><div style={{gridRow:3,gridColumn:3}}>{connection('later_following','left')}</div><div className="flow-overview__cell" style={{gridRow:3,gridColumn:4}}>{card('later_following')}</div></>}
   </>}
  </div></div>
  <p className="flow-overview__note">{tr('⋯ 表示依次重复的步骤。数值区间涵盖实际变化，每步仍按所填条件计算。点击一组步骤可展开附近流程。','⋯ marks successive steps. Ranges cover actual variation; each step uses its own conditions. Select a group to explore nearby steps.')}</p>
  {(annotations.length>0||partialInputs.length>0)&&<div className="flow-overview__exceptions"><strong>{tr('流程中的变化','Changes within the flow')}</strong>{partialInputs.length>0&&<p>{tr('部分取用并非每步发生，已在对应箭头或投料旁标明。','Some inputs are used only at certain steps, as marked beside each transfer or fresh input.')}</p>}{annotations.length>0&&<details open={annotations.length<=4}><summary>{tr(`${annotations.length} 组单独条件`,`${annotations.length} sets of local conditions`)}</summary><ul>{annotations.map(annotation=><li key={annotation.id}><button type="button" onClick={()=>onExplore(annotation.at)}><span>{annotation.label}</span><small>{annotation.detail}</small></button></li>)}</ul></details>}</div>}
 </div>;
}
