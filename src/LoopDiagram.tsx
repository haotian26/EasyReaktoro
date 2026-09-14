import {t as tr,useLanguage} from './i18n';
import {useId} from 'react';
import './loop-diagram.css';

export type LoopDiagramAxis={label:string;unit:string;values:number[];mode:'repeat'|'range'|'list';step?:number};
export type DiagramStage='first_start'|'first_following'|'later_start'|'later_following';
export type DiagramMaterialTerm={
  source:'fresh'|'left'|'above'|'other';
  phase:string;
  fraction:number;
  label:string;
  phaseLabel?:string;
  species?:string[];
  quantityLabel?:string;
  fractionAt?:(innerIndex:number,outerIndex:number)=>number;
  sourceAt?:(innerIndex:number,outerIndex:number)=>{inner:number;outer:number}|null;
};
export type DiagramMaterialStages=Record<DiagramStage,readonly DiagramMaterialTerm[]>;
export type LoopDiagramProps={
  inner:LoopDiagramAxis;outer:LoopDiagramAxis;fixedConditions:string[];reactants?:string[];
  materialStages?:DiagramMaterialStages;selectedStage?:DiagramStage;outerAnnotations?:string[];
  selectedPoint?:{inner:number;outer:number};pointLabel?:(innerIndex:number,outerIndex:number)=>string;showMaterialLedger?:boolean;
  materialFlow?:{inner:string;outer:string};
  onSelect?:(innerIndex:number,outerIndex:number)=>void;
};
const stageNames=():Record<DiagramStage,string>=>({first_start:tr('首次起点',"First round, start"),first_following:tr('首轮后续位置',"First round, later positions"),later_start:tr('后续轮起点',"Later rounds, start"),later_following:tr('后续轮其余位置',"Later rounds, later positions")});
const stageOf=(ii:number,oi:number):DiagramStage=>oi===0?(ii===0?'first_start':'first_following'):(ii===0?'later_start':'later_following');
const phaseNames=():Record<string,string>=>({all:tr('全部物料',"All material"),aqueous:tr('水相',"Aqueous"),mineral:tr('矿物',"Minerals"),gas:tr('气相',"Gas"),species:tr('指定 species',"Selected species")});
const phaseKeys=['all','aqueous','mineral','gas','species','mixed'] as const;
// Imported display aliases are data, so their classification must not depend on the UI language.
const phaseAliases:Record<string,string>={'全部物料':'all','全部':'all','All material':'all','All':'all','水相':'aqueous','Aqueous':'aqueous','矿物':'mineral','固相':'mineral','Minerals':'mineral','Solids':'mineral','气相':'gas','Gas':'gas','指定 species':'species','Selected species':'species'};
function phaseKey(phase:string){return phaseKeys.includes(phase as typeof phaseKeys[number])?phase:phaseAliases[phase]||'all';}
const phaseName=(term:DiagramMaterialTerm)=>term.phaseLabel||phaseNames()[phaseAliases[term.phase]||term.phase]||term.phase||tr('物料',"Material");
function number(value:number,precision=6){
  if(!Number.isFinite(value))return '—';
  if(value!==0&&(Math.abs(value)<1e-4||Math.abs(value)>=1e5))return value.toExponential(precision-2).replace(/\.?0+e/,'e');
  return Number(value.toPrecision(precision)).toString();
}
const valueLabel=(axis:LoopDiagramAxis,index:number,precision=6)=>`${number(axis.values[index],precision)}${axis.unit?` ${axis.unit}`:''}`;
function sampledIndices(length:number,limit=4,selected?:number){
  if(length<=limit)return Array.from({length},(_,i)=>i);
  if(selected!==undefined&&selected>1&&selected<length-2)return [...new Set([0,selected-1,selected,selected+1,length-1])];
  return [0,1,length-2,length-1];
}
function axisSummary(axis:LoopDiagramAxis,rounds=false){
  const n=axis.values.length;
  if(axis.mode==='repeat')return rounds?tr(`第 1 轮 → 第 ${n} 轮`,`Round 1 → round ${n}`):tr(`第 1 步 → 第 ${n} 步`,`Position 1 → position ${n}`);
  if(n===1)return valueLabel(axis,0,12);
  const ends=`${number(axis.values[0],12)} → ${valueLabel(axis,n-1,12)}`;
  if(axis.mode==='list')return tr(`${ends} · ${n} 组条件，按指定顺序`,`${ends} · ${n} conditions, in the specified order`);
  const delta=axis.values[1]-axis.values[0];
  const uniform=axis.values.every((v,i)=>!i||Math.abs(v-axis.values[i-1]-delta)<=Math.abs(delta)*1e-7+Math.max(Math.abs(v),Math.abs(axis.values[i-1]))*Number.EPSILON*8);
  const rounding=Math.max(Math.abs(axis.values[0]),Math.abs(axis.values[1]))*Number.EPSILON*8;
  const configured=axis.step!==undefined&&Number.isFinite(axis.step)&&Math.abs(Math.abs(axis.step)-Math.abs(delta))<=Math.abs(delta)*1e-7+rounding;
  const increment=configured?Math.sign(delta)*Math.abs(axis.step!):delta;
  return tr(`${ends} · ${uniform?`${rounds?'每轮':'每步'} ${number(increment,12)}${axis.unit?` ${axis.unit}`:''}`:'不等间隔'} · ${n} 组条件`,`${ends} · ${uniform?`${number(increment,12)}${axis.unit?` ${axis.unit}`:''} ${rounds?'per round':'per position'}`:'uneven intervals'} · ${n} conditions`);
}
const axisTitle=(axis:LoopDiagramAxis,rounds=false)=>axis.mode==='repeat'?(rounds?tr('反应轮次',"Reaction rounds"):tr('反应路径',"Reaction path")):`${axis.label}${axis.unit?` / ${axis.unit}`:''}`;
const conditionLabel=(axis:LoopDiagramAxis,index:number,rounds=false)=>axis.mode==='repeat'?tr(`第 ${index+1} ${rounds?'轮':'步'}`,`${rounds?'Round':'Position'} ${index+1}`):valueLabel(axis,index);
function fractionAt(term:DiagramMaterialTerm,ii:number,oi:number){try{return term.fractionAt?term.fractionAt(ii,oi):term.fraction;}catch{return NaN;}}
const quantity=(term:DiagramMaterialTerm,value:number)=>term.source==='fresh'?tr(`${number(value)} 份`,`${number(value)} portions`):`${number(value*100)}%`;
function sourceName(term:DiagramMaterialTerm){
  if(term.source==='fresh')return term.label.trim()||'composition';
  const where=term.source==='left'?tr('本轮前一步',"Previous position in this round"):term.source==='above'?tr('上一轮同位置',"Previous round, same position"):tr('指定来源',"Specified source");
  const aliases=term.source==='left'?['本轮前一步','上一个位置','上一步','上一位置','Previous position in this round']:term.source==='above'?['上一轮同位置','上一轮同一位置','上一轮对应位置','Previous round, same position']:[];
  const label=term.label.trim();
  return !label||label===where||aliases.includes(label)?where:`${where} · ${label}`;
}
const allowed=(source:DiagramMaterialTerm['source'],ii:number,oi:number)=>source==='left'?ii>0:source==='above'?oi>0:true;
type ActiveTerm={term:DiagramMaterialTerm;fraction:number};
type Edge={source:'fresh'|'left'|'above'|'other';stage:DiagramStage;ii:number;oi:number;fromInner?:number;fromOuter?:number;x1:number;y1:number;x2:number;y2:number;terms:ActiveTerm[]};

export function LoopDiagram({inner,outer,fixedConditions,reactants,materialStages,selectedStage,materialFlow,outerAnnotations,selectedPoint,pointLabel,showMaterialLedger=true,onSelect}:LoopDiagramProps){
 useLanguage();
  const id=useId().replace(/:/g,'');
  const ni=inner.values.length,no=outer.values.length,valid=ni>0&&no>0&&inner.values.every(Number.isFinite)&&outer.values.every(Number.isFinite);
  const single=ni===1&&no===1,matrix=ni>1&&no>1,vertical=ni===1&&no>1;
  const columns=sampledIndices(ni,4,selectedPoint?.inner),rows=sampledIndices(no,4,selectedPoint?.outer),sampled=columns.length<ni||rows.length<no;
  const stages:DiagramStage[]=['first_start',...(ni>1?['first_following' as const]:[]),...(no>1?['later_start' as const]:[]),...(matrix?['later_following' as const]:[])];
  const currentStage=selectedPoint?stageOf(selectedPoint.inner,selectedPoint.outer):selectedStage&&stages.includes(selectedStage)?selectedStage:'first_start';
  const conditions=[...new Set([...fixedConditions,...(ni===1&&inner.mode!=='repeat'?[`${inner.label} ${valueLabel(inner,0,12)}`]:[]),...(no===1&&outer.mode!=='repeat'?[`${outer.label} ${valueLabel(outer,0,12)}`]:[]),...(single&&outerAnnotations?.[0]?[outerAnnotations[0]]:[])].map(v=>v.trim()).filter(Boolean))];
  if(!valid)return <section className="loop-diagram loop-diagram--empty" aria-label={tr("反应示意图","Reaction diagram")}><strong>{tr("反应示意图","Reaction diagram")}</strong><p>{tr("补全反应条件后，这里会显示反应路径。","Complete the reaction conditions to see the path here.")}</p></section>;
  const active=(ii:number,oi:number,source:DiagramMaterialTerm['source'])=>(materialStages?.[stageOf(ii,oi)]||[]).filter(t=>t.source===source&&allowed(t.source,ii,oi)).map(term=>({term,fraction:fractionAt(term,ii,oi)})).filter(t=>Number.isFinite(t.fraction)&&t.fraction>0);
  const phaseShort:Record<string,string>={all:tr('全部',"All"),aqueous:tr('水相',"Aq."),mineral:tr('固相',"Solid"),gas:tr('气相',"Gas"),species:'species'};
  const phaseList=(terms:ActiveTerm[])=>[...new Set(terms.map(t=>phaseKey(t.term.phase)))];
  const maxPhases=(r:number,source:DiagramMaterialTerm['source'])=>Math.max(0,...columns.map(ii=>phaseList(active(ii,rows[r],source)).length));
  // Fresh inputs, horizontal transfers and vertical transfers each get their own label band.
  // Label height determines spacing, so adding phases cannot collide with another flow or an axis.
  const freshHeights=rows.map((_,r)=>maxPhases(r,'fresh')*18+18);
  const leftHeights=rows.map((_,r)=>maxPhases(r,'left')*18+12);
  const aboveHeights=rows.map((_,r)=>maxPhases(r,'above')*18+18);
  const ys:number[]=[];
  rows.forEach((_,r)=>ys.push(r===0?Math.max(62,freshHeights[r]+24):ys[r-1]+16+leftHeights[r-1]+aboveHeights[r]+freshHeights[r]+14));
  const x=(c:number)=>vertical?130:130+c*390/Math.max(columns.length-1,1),y=(r:number)=>ys[r];
  const width=vertical?370:620,lastY=y(rows.length-1),height=lastY+leftHeights[rows.length-1]+(vertical?35:70);
  const edges:Edge[]=[];
  for(const [r,oi] of rows.entries())for(const [c,ii] of columns.entries()){
    const cx=x(c),cy=y(r),stage=stageOf(ii,oi),fresh=active(ii,oi,'fresh'),left=active(ii,oi,'left'),above=active(ii,oi,'above');
    if(fresh.length)edges.push({source:'fresh',stage,ii,oi,x1:cx-24,y1:cy-27,x2:cx-13,y2:cy-18,terms:fresh});
    if(left.length&&c>0&&columns[c-1]===ii-1)edges.push({source:'left',stage,ii,oi,fromInner:ii-1,fromOuter:oi,x1:x(c-1)+38,y1:cy,x2:cx-38,y2:cy,terms:left});
    if(above.length&&r>0&&rows[r-1]===oi-1)edges.push({source:'above',stage,ii,oi,fromInner:ii,fromOuter:oi-1,x1:cx+23,y1:y(r-1)+18,x2:cx+23,y2:cy-18,terms:above});
    for(const input of active(ii,oi,'other')){
      let from:{inner:number;outer:number}|null=null;try{from=input.term.sourceAt?.(ii,oi)||null;}catch{}
      if(!from||from.inner<0||from.outer<0||from.outer*ni+from.inner>=oi*ni+ii)continue;
      const fc=columns.indexOf(from.inner),fr=rows.indexOf(from.outer);if(fc<0||fr<0)continue;
      const dx=cx-x(fc),dy=cy-y(fr),distance=Math.hypot(dx,dy);if(!distance)continue;
      edges.push({source:'other',stage,ii,oi,fromInner:from.inner,fromOuter:from.outer,x1:x(fc)+dx/distance*38,y1:y(fr)+dy/distance*22,x2:cx-dx/distance*38,y2:cy-dy/distance*22,terms:[input]});
    }
  }
  const edgeColor=(edge:Edge)=>{const phases=phaseList(edge.terms);return phases.length===1?phases[0]:'mixed';};
  const materialEdges=edges.map((edge,i)=>{
    const c=columns.indexOf(edge.ii),r=rows.indexOf(edge.oi),phases=phaseList(edge.terms),color=edgeColor(edge);
    const tx=edge.source==='fresh'?x(c)-23:edge.source==='above'?edge.x1+9:(edge.x1+edge.x2)/2;
    const top=edge.source==='fresh'?y(r)-38-(phases.length-1)*18:edge.source==='above'?y(r-1)+16+leftHeights[r-1]+18:edge.source==='other'?(edge.y1+edge.y2)/2-10:y(r)+34;
    const full=edge.terms.map(t=>`${sourceName(t.term)} · ${phaseName(t.term)}${t.term.species?.length?` (${t.term.species.join(', ')})`:''} ${quantity(t.term,t.fraction)}`).join('；');
    return <g key={i} className={`loop-diagram__material-edge phase-${color}${edge.source==='other'?' loop-diagram__material-edge--other':''}`} data-source={edge.source} data-stage={edge.stage} data-from-inner={edge.fromInner} data-from-outer={edge.fromOuter} data-to-inner={edge.ii} data-to-outer={edge.oi}>
      <title>{tr(`第 ${edge.oi*ni+edge.ii+1} 次反应：${full}`,`Equilibrium ${edge.oi*ni+edge.ii+1}: ${full}`)}</title>
      <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} markerEnd={`url(#material-${color}-${id})`}/>
      <g className="loop-diagram__edge-label" data-label-top={top-13} data-label-bottom={top+(phases.length-1)*18+3}>{phases.map((phase,j)=><text key={phase} className={`phase-${phase}`} x={tx} y={top+j*18} textAnchor={edge.source==='above'?'start':'middle'}>{edge.source==='fresh'?'+ ':''}{phaseShort[phase]||tr('物料',"Material")}</text>)}</g>
    </g>;
  });
  const point=(ii:number,oi:number,c:number,r:number)=>{
    const stage=stageOf(ii,oi),run=oi*ni+ii+1,isSelected=selectedPoint?ii===selectedPoint.inner&&oi===selectedPoint.outer:!!materialStages&&currentStage===stage,label=tr(`第 ${run} 次反应，${stageNames()[stage]}；${inner.mode==='repeat'?`路径第 ${ii+1} 步`:`${inner.label} ${valueLabel(inner,ii,12)}`}；${outer.mode==='repeat'?`第 ${oi+1} 轮`:`${outer.label} ${valueLabel(outer,oi,12)}`}${pointLabel?`; ${pointLabel(ii,oi)}`:''}`,`Equilibrium ${run}, ${stageNames()[stage]}; ${inner.mode==='repeat'?`path position ${ii+1}`:`${inner.label} ${valueLabel(inner,ii,12)}`}; ${outer.mode==='repeat'?`round ${oi+1}`:`${outer.label} ${valueLabel(outer,oi,12)}`}${pointLabel?`; ${pointLabel(ii,oi)}`:''}`);
    return <g key={`${ii}-${oi}`} className={`loop-diagram__point${onSelect?' loop-diagram__point--selectable':''}${isSelected?' loop-diagram__point--selected':''}`} data-inner-index={ii} data-outer-index={oi} data-stage={stage}
      role={onSelect?'button':undefined} tabIndex={onSelect?0:undefined} aria-label={onSelect?label:undefined} aria-pressed={onSelect&&(materialStages||selectedPoint)?isSelected:undefined}
      onClick={onSelect?()=>onSelect(ii,oi):undefined} onKeyDown={onSelect?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(ii,oi);}}:undefined}>
      <title>{label}</title><rect className="loop-diagram__node" x={x(c)-34} y={y(r)-16} width="68" height="32" rx="8"/><text x={x(c)} y={y(r)+5} textAnchor="middle" className="loop-diagram__node-number" style={{fontSize:run>=100000?12:15}}>{tr("第","#")}{run}{tr("次","")}</text>
    </g>;
  };
  type MaterialEntry={term:DiagramMaterialTerm;amount:string;stages:DiagramStage[];inactive:boolean;unavailable:boolean};
  const ledger=new Map<string,MaterialEntry>();
  if(materialStages&&showMaterialLedger)for(const stage of stages)for(const term of materialStages[stage]){
    const ii=stage.endsWith('following')?1:0,oi=stage.startsWith('later')?1:0,value=fractionAt(term,ii,oi),unavailable=!allowed(term.source,ii,oi);
    let hasAmount=false;
    // Sampling is only a drawing choice. The ledger describes the entire plan.
    for(let o=0;o<no&&!hasAmount;o++)for(let i=0;i<ni;i++)if(stageOf(i,o)===stage){const v=fractionAt(term,i,o);if(Number.isFinite(v)&&v>0){hasAmount=true;break;}}
    const amount=term.source==='fresh'&&value===0&&!hasAmount?tr('此处没有投料',"No material added here"):term.quantityLabel||(value===0&&hasAmount?tr('部分位置加入',"Added at some positions"):quantity(term,value)),key=JSON.stringify([term.source,term.label,term.phase,term.phaseLabel,term.species,amount,unavailable]);
    const existing=ledger.get(key);if(existing)existing.stages.push(stage);else ledger.set(key,{term,amount,stages:[stage],inactive:unavailable||!Number.isFinite(value)||!hasAmount,unavailable});
  }
  const entries=[...ledger.values()];
  const materialList=materialStages&&showMaterialLedger&&<div className="loop-diagram__material-stages" aria-label={tr("物料来源与用量","Material sources and quantities")}><strong className="loop-diagram__materials-title">{tr("物料来源与用量","Material sources and quantities")}</strong><ul className="loop-diagram__material-ledger">{entries.map(({term,amount,stages:used,unavailable,inactive},i)=><li key={i} className={`loop-diagram__material-entry phase-${phaseKey(term.phase)}${used.includes(currentStage)?' is-selected':''}${inactive?' is-inactive':''}`} data-stage={used.join(' ')}><span className="loop-diagram__source-symbol" aria-hidden="true">{term.source==='fresh'?'+':term.source==='left'?'→':term.source==='above'?'↓':'·'}</span><div><div className="loop-diagram__material-description"><b>{sourceName(term)}</b><span>{phaseName(term)}</span><strong>{amount}</strong></div>{term.species?.length?<span className="loop-diagram__species-list">{term.species.join(' · ')}</span>:null}<small>{used.map(stage=>stageNames()[stage]).join(' · ')}{unavailable?tr(` · 此处没有${term.source==='left'?'上一个位置':'上一轮结果'}`,` · No ${term.source==='left'?'previous position':'previous-round result'} here`):''}</small></div></li>)}</ul>{!entries.length&&<p>{tr("尚未设置物料来源。","No material sources set yet.")}</p>}</div>;
  const annotationLines=(value:string)=>{const lines:string[]=[];let line='',width=0;for(const char of value){const size=/[\u0020-\u007e]/.test(char)?7:14;if(width+size>72&&line){lines.push(line);line='';width=0;}line+=char;width+=size;}if(line)lines.push(line);return lines;};
  return <section className={`loop-diagram${single?' loop-diagram--single':''}`} aria-label={tr("反应示意图","Reaction diagram")}>
    <header className="loop-diagram__heading"><strong>{single?tr('单次反应',"Single equilibrium"):no>1?tr('多轮反应',"Multiple rounds"):tr('反应路径',"Reaction path")}</strong><span>{(ni*no).toLocaleString()} {tr("次平衡"," equilibria")}</span></header>
    {!materialStages&&reactants?.length&&<div className="loop-diagram__reactants" aria-label={tr("反应物","Reactants")}><b>{tr("反应物","Reactants")}</b>{[...new Set(reactants)].map(v=><span key={v}>{v}</span>)}</div>}
    {conditions.length>0&&<div className="loop-diagram__conditions" aria-label={tr("反应条件","Reaction conditions")}>{conditions.map(v=><span key={v}>{v}</span>)}</div>}
    {single?(onSelect&&showMaterialLedger&&<div className="loop-diagram__single"><button type="button" className="text-btn" onClick={()=>onSelect(0,0)}>{tr("查看反应物","View reactants")}</button></div>):<>
      <div className="loop-diagram__axes">{ni>1&&<div data-reaction-axis="path"><div className="loop-diagram__axis-heading"><strong>{axisTitle(inner)}</strong>{inner.mode!=='repeat'&&<small>{tr("反应路径","Reaction path")}</small>}</div><span>{axisSummary(inner)}</span></div>}{no>1&&<div data-reaction-axis="round"><div className="loop-diagram__axis-heading"><strong>{axisTitle(outer,true)}</strong>{outer.mode!=='repeat'&&<small>{tr("反应轮次","Reaction rounds")}</small>}</div><span>{axisSummary(outer,true)}</span></div>}</div>
      <div className={`loop-diagram__canvas${vertical?' loop-diagram__canvas--vertical':''}`}>
        <svg viewBox={`0 0 ${width} ${height}`} role={onSelect?'group':'img'} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
          <title id={`${id}-title`}>{tr("反应条件与物料传递","Conditions and material transfer")}</title>
          <defs>{phaseKeys.map(phase=><marker key={phase} id={`material-${phase}-${id}`} className={`phase-${phase}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 1 1 L 7 4 L 1 7" className="loop-diagram__material-arrowhead"/></marker>)}</defs>
          {materialEdges}
          {rows.map((oi,r)=><g key={oi}>{no>1&&<g className="loop-diagram__row-heading"><text x="73" y={y(r)+(outerAnnotations?.[oi]?-5:5)} textAnchor="end" className="loop-diagram__value">{conditionLabel(outer,oi,true)}</text>{outerAnnotations?.[oi]&&<text x="73" y={y(r)+17} textAnchor="end" className="loop-diagram__row-annotation">{annotationLines(outerAnnotations[oi]).map((line,j)=><tspan key={j} x="73" dy={j?17:0}>{line}</tspan>)}</text>}</g>}{columns.map((ii,c)=>point(ii,oi,c,r))}{r>0&&oi>rows[r-1]+1&&<text x={width-14} y={(y(r)+y(r-1))/2+5} textAnchor="middle" className="loop-diagram__gap" aria-hidden="true">⋮</text>}</g>)}
          {columns.map((ii,c)=><g key={ii}>{!vertical&&<text x={x(c)} y={lastY+leftHeights[rows.length-1]+34} textAnchor="middle" className="loop-diagram__value">{conditionLabel(inner,ii)}</text>}{c>0&&ii>columns[c-1]+1&&rows.map((oi,r)=><text key={oi} x={(x(c)+x(c-1))/2} y={y(r)+5} textAnchor="middle" className="loop-diagram__gap" aria-hidden="true">⋯</text>)}</g>)}
        </svg>
      </div>
      <div className="loop-diagram__caption"><span id={`${id}-description`}>{materialStages?tr('编号表示计算顺序，箭头表示物料传递。',"Numbers show calculation order; arrows show material transfer."):tr('编号表示计算顺序。',"Numbers show calculation order.")}</span>{sampled&&<span className="loop-diagram__sampling">{tr("显示部分反应条件，共 ","Showing selected conditions; ")}{ni*no} {tr("次平衡"," equilibria in total")}</span>}</div>
    </>}
    {materialList}
    {!materialStages&&materialFlow&&(materialFlow.inner||materialFlow.outer)&&<div className="loop-diagram__material-flow" aria-label={tr("反应物如何衔接","How reactants continue")}>{materialFlow.inner&&<span><b>{tr("沿路径","Along the path")}</b>{materialFlow.inner}</span>}{materialFlow.outer&&<span><b>{tr("轮次间","Between rounds")}</b>{materialFlow.outer}</span>}</div>}
  </section>;
}
