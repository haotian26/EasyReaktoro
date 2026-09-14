import {t as tr,useLanguage} from './i18n';
import {useId,type ReactNode} from 'react';
import {DiagramMaterialStages,DiagramMaterialTerm} from './LoopDiagram';
import './reaction-flow-diagram.css';

type Point={temperature_c:number;pressure_bar:number;pressure_mode?:string};
type Props={positions:number;rounds:number;selected:{inner:number;outer:number};materials:DiagramMaterialStages;point:(i:number,o:number)=>Point;onSelect:(i:number,o:number)=>void};
const stage=(i:number,o:number)=>o===0?(i===0?'first_start':'first_following'):(i===0?'later_start':'later_following');
const phaseNames=():Record<string,string>=>({aqueous:tr('水相',"Aqueous"),mineral:tr('固相',"Solids"),gas:tr('气相',"Gas"),all:tr('全部',"All"),species:'species'});
export function nearbyIndices(count:number,selected:number){const start=Math.max(0,Math.min(count-3,selected-1));return Array.from({length:Math.min(count,3)},(_,n)=>start+n);}
function display(value:number){return Number.isFinite(value)?Number(value.toPrecision(5)).toString():'—';}
type Input={term:DiagramMaterialTerm;amount:number};
function description(inputs:Input[]){return inputs.map(({term,amount})=>tr(`${term.label} · ${term.phaseLabel||phaseNames()[term.phase]||term.phase}${term.species?.length?` (${term.species.join(', ')})`:''} · ${display(amount*(term.source==='fresh'?1:100))}${term.source==='fresh'?' 份':'%'}`,`${term.label} · ${term.phaseLabel||phaseNames()[term.phase]||term.phase}${term.species?.length?` (${term.species.join(', ')})`:''} · ${display(amount*(term.source==='fresh'?1:100))}${term.source==='fresh'?' portions':'%'}`)).join('；');}
function flowColor(inputs:Input[]){const phases=[...new Set(inputs.map(v=>v.term.phase))];return phases.length===1?` phase-${phases[0]}`:'';}
function flowLabel(inputs:Input[]){const compact:Record<string,string>={aqueous:tr('水相','Aq.'),mineral:tr('固相','Solid'),gas:tr('气相','Gas'),all:tr('全部','All'),species:'species'};const names=[...new Set(inputs.map(({term})=>compact[term.phase]||term.phase))];return names.length===1?names[0]:tr('混合物料','Mixed');}
export function ReactionFlowDiagram({positions,rounds,selected,materials,point,onSelect}:Props){
 const language=useLanguage();
 const id=useId(),columns=nearbyIndices(positions,selected.inner),rows=nearbyIndices(rounds,selected.outer);
 const inputs=(i:number,o:number,source:DiagramMaterialTerm['source']):Input[]=>materials[stage(i,o)].filter(term=>term.source===source&&(source!=='left'||i>0)&&(source!=='above'||o>0)).map(term=>({term,amount:term.fractionAt?.(i,o)??term.fraction})).filter(({amount})=>Number.isFinite(amount)&&amount>0);
 const cells:ReactNode[]=[];
 for(const [r,o] of rows.entries()){
  cells.push(<div key={`round-${o}`} className="reaction-flow__round" style={{gridColumn:1,gridRow:r*2+2,...(language==='en'?{writingMode:'horizontal-tb' as const,letterSpacing:0}: {})}}>{tr("第","Round ")}{o+1}{tr("轮","")}</div>);
  for(const [c,i] of columns.entries()){
   const p=point(i,o),fresh=inputs(i,o,'fresh'),left=inputs(i,o,'left'),above=inputs(i,o,'above'),other=inputs(i,o,'other').filter(({term})=>{const from=term.sourceAt?.(i,o);return from&&from.inner>=0&&from.inner<positions&&from.outer>=0&&from.outer*positions+from.inner<o*positions+i;});
   const col=c*2+2,row=r*2+2,chosen=i===selected.inner&&o===selected.outer;
   const full=tr(`第 ${o+1} 轮 · 位置 ${i+1}；${p.temperature_c} °C；${p.pressure_mode==='water_saturation'?'纯水饱和蒸汽压 ':''}${p.pressure_bar} bar`,`Round ${o+1} · position ${i+1}; ${p.temperature_c} °C; ${p.pressure_mode==='water_saturation'?'pure-water saturation pressure ':''}${p.pressure_bar} bar`);
   cells.push(<button type="button" key={`point-${i}-${o}`} className={`reaction-flow__point${chosen?' is-selected':''}`} style={{gridColumn:col,gridRow:row}} aria-label={full} aria-pressed={chosen} onClick={()=>onSelect(i,o)} title={full} data-inner-index={i} data-outer-index={o}>
    <span className="reaction-flow__order">#{o*positions+i+1}</span><strong>{display(p.temperature_c)} <small>°C</small></strong><strong>{display(p.pressure_bar)} <small>bar</small></strong>{p.pressure_mode==='water_saturation'&&<span className="reaction-flow__psat">Psat(T)</span>}
    {fresh.length>0&&<span className="reaction-flow__fresh" title={tr(`加入：${description(fresh)}`,`Add: ${description(fresh)}`)}>+ {fresh.length===1?flowLabel(fresh):tr(`${fresh.length} 项投料`,`${fresh.length} inputs`)}</span>}
    {other.length>0&&<span className="reaction-flow__other" title={other.map(({term})=>{const from=term.sourceAt!(i,o)!;return tr(`第 ${from.outer+1} 轮位置 ${from.inner+1} → ${description(other.filter(v=>v.term===term))}`,`Round ${from.outer+1}, position ${from.inner+1} → ${description(other.filter(v=>v.term===term))}`);}).join('；')}>{other.length===1?(()=>{const from=other[0].term.sourceAt!(i,o)!;return tr(`↳ 第${from.outer+1}轮·位置${from.inner+1} ${display(other[0].amount*100)}%`,`↳ Round ${from.outer+1} · position ${from.inner+1} ${display(other[0].amount*100)}%`);})():tr(`↳ ${other.length} 项指定来源`,`↳ ${other.length} specified sources`)}</span>}
   </button>);
   if(left.length&&c>0)cells.push(<div key={`left-${i}-${o}`} className={`reaction-flow__edge reaction-flow__edge--left${flowColor(left)}`} style={{gridColumn:col-1,gridRow:row}} title={tr(`本轮位置 ${i} → 位置 ${i+1}：${description(left)}`,`This round, position ${i} → position ${i+1}: ${description(left)}`)} data-source="left" data-from-inner={i-1} data-from-outer={o} data-to-inner={i} data-to-outer={o}><span>{flowLabel(left)}</span><b aria-hidden="true">→</b>{left.length===1&&<small>{display(left[0].amount*100)}%</small>}</div>);
   if(above.length&&r>0)cells.push(<div key={`above-${i}-${o}`} className={`reaction-flow__edge reaction-flow__edge--above${flowColor(above)}`} style={{gridColumn:col,gridRow:row-1}} title={tr(`第 ${o} 轮 → 第 ${o+1} 轮，位置 ${i+1}：${description(above)}`,`Round ${o} → round ${o+1}, position ${i+1}: ${description(above)}`)} data-source="above" data-from-inner={i} data-from-outer={o-1} data-to-inner={i} data-to-outer={o}><b aria-hidden="true">↓</b><span>{flowLabel(above)}{above.length===1&&<small> {display(above[0].amount*100)}%</small>}</span></div>);
   if((left.length&&c===0)||(above.length&&r===0))cells.push(<span key={`omitted-${i}-${o}`} className="reaction-flow__omitted" style={{gridColumn:col,gridRow:row}} title={[left.length&&c===0?tr(`左侧未展开的位置 ${i}：${description(left)}`,`Position ${i}, beyond the left edge: ${description(left)}`):'',above.length&&r===0?tr(`上方未展开的第 ${o} 轮：${description(above)}`,`Round ${o}, above the displayed area: ${description(above)}`):''].filter(Boolean).join('；')}>{left.length&&c===0?'← ':''}{above.length&&r===0?'↑ ':''}{tr("图外来源","Source outside view")}</span>);
  }
 }
 return <section className="reaction-flow" aria-label={tr("反应条件与物料传递","Conditions and material transfer")} aria-describedby={`${id}-caption`}>
  {positions*rounds>1&&<><div className="reaction-flow__grid" style={{gridTemplateColumns:`${language==='en'?48:32}px ${columns.map((_,i)=>`${i?'40px ':''}minmax(0,1fr)`).join(' ')}`}}>{columns.map((i,c)=><div key={i} className="reaction-flow__position" style={{gridColumn:c*2+2,gridRow:1}}>{tr("位置 ","Position ")}{i+1}</div>)}{cells}</div><p className="reaction-flow__caption" id={`${id}-caption`}>{tr("箭头表示设置的物料来源与取用比例。点击反应点查看详情，继承的实际组成由平衡结果决定。","Arrows show the chosen material sources and fractions. Click a reaction point for details; the actual composition of reused material is determined by equilibrium.")}{(positions>3||rounds>3)&&<span>{tr("显示所选点附近的位置；完整路径共 ","Showing positions near the selected point. The full path has ")}{positions} {tr("个位置、"," positions and ")}{rounds} {tr("轮。"," rounds.")}</span>}</p></>}
 </section>;
}
