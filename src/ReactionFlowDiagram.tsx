import {t as tr,useLanguage,englishCount} from './i18n';
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {type DiagramMaterialStages} from './LoopDiagram';
import {flowInputs,flowKey,flowTextLines,type FlowCoordinate,type FlowInput,type FlowSource} from './reaction-flow-model';
import {ReactionFlowOverview} from './ReactionFlowOverview';
import {flowWindow,type FlowAnnotation} from './reaction-flow-overview';
import './reaction-flow-diagram.css';

type Point={temperature_c:number;pressure_bar:number;pressure_mode?:string};
type Props={active?:(i:number,o:number)=>boolean;runIndex?:(i:number,o:number)=>number;positions:number;rounds:number;selected:FlowCoordinate;materials:DiagramMaterialStages;point:(i:number,o:number)=>Point;onSelect:(i:number,o:number)=>void;showConditions?:boolean;onAdjust?:()=>void;annotations?:FlowAnnotation[];onEditOverride?:(id:string)=>void};
type FlowNode=FlowCoordinate&{key:string;x:number;y:number;height:number;point:Point;sources:FlowSource[];fresh:string[];external:boolean};
type FlowEdge={key:string;from:FlowNode;to:FlowNode;group:FlowSource;lines:string[]};
const NODE_WIDTH=116, COLUMN=252, LEFT=88, TOP=44;
const phases=():Record<string,string>=>({aqueous:tr('水相','Aqueous phase'),mineral:tr('固相','Solid phases'),gas:tr('气相','Gas phase'),all:tr('全部物料','All material'),species:'Species'});
const display=(v:number)=>Number.isFinite(v)?Number(v.toPrecision(5)).toString():'—';
const coordinate=({inner,outer}:FlowCoordinate)=>tr(`第 ${outer+1} 轮 · 位置 ${inner+1}`,`Round ${outer+1} · position ${inner+1}`);
const amountLabel=(input:FlowInput)=>input.source==='fresh'?`× ${display(input.amount)}`:`${display(input.amount*100)}%`;
const phaseLabel=(input:FlowInput)=>input.term.phase==='species'?input.term.species?.join(', ')||'Species':phases()[input.term.phase]||input.term.phase;
const inputLabel=(input:FlowInput)=>`${input.source==='fresh'?input.term.label.trim()||'Composition':phaseLabel(input)} ${amountLabel(input)}`;
const freshLabel=(input:FlowInput)=>`+ ${inputLabel(input)}${input.term.phase!=='all'?` · ${phaseLabel(input)}`:''}`;
function phase(group:FlowSource){const key=group.inputs[0]?.term.phase;return ['aqueous','mineral','gas','all','species'].includes(key)&&group.inputs.every(input=>input.term.phase===key)?key:'mixed';}
function color(group:FlowSource){return ` phase-${phase(group)}`;}
const alwaysActive=()=>true;

export function ReactionFlowDiagram(props:Props){
 useLanguage();
 const {positions,rounds,selected}=props;
 const large=positions>4||rounds>3;
 const [expanded,setExpanded]=useState(selected.inner!==0||selected.outer!==0);
 const previous=useRef(selected);
 useEffect(()=>{if(previous.current.inner!==selected.inner||previous.current.outer!==selected.outer)setExpanded(true);previous.current=selected;},[selected.inner,selected.outer]);
 if(!large)return <><PointFlowDiagram {...props}/><FlowAnnotations onEditOverride={props.onEditOverride} annotations={props.annotations} onSelect={props.onSelect}/></>;
 const explore=(p:FlowCoordinate)=>{props.onSelect(p.inner,p.outer);setExpanded(true);};
 return <section className="reaction-flow reaction-flow--overview" aria-label={tr('完整反应流程','Complete reaction flow')}>
  <ReactionFlowOverview {...props} active={props.active??alwaysActive} onExplore={explore}/>
  <FlowAnnotations onEditOverride={props.onEditOverride} annotations={props.annotations} onSelect={(inner,outer)=>explore({inner,outer})}/>
  <div className="reaction-flow__expand"><button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?tr('收起附近步骤','Hide nearby steps'):tr('查看所选位置附近的步骤','Show steps near the selected position')}</button><span>{coordinate(selected)}</span>{!expanded&&props.onAdjust&&<button type="button" onClick={()=>{setExpanded(true);props.onAdjust?.();}}>{tr('单独调整此处','Adjust this point')}</button>}</div>
  {expanded&&<PointFlowDiagram {...props} windowed/>}
 </section>;
}

function FlowAnnotations({annotations=[],onSelect,onEditOverride}:{annotations?:FlowAnnotation[];onSelect:(inner:number,outer:number)=>void;onEditOverride?:(id:string)=>void}){
 useLanguage();if(!annotations.length)return null;
 return <div className="flow-overview__exceptions reaction-flow__local-conditions"><details open={annotations.length<=4}><summary>{tr(`${annotations.length} 组单独条件`,englishCount(annotations.length,'set of local conditions','sets of local conditions'))}</summary><ul>{annotations.map(annotation=><li key={annotation.id}>{annotation.at?<button type="button" onClick={()=>onSelect(annotation.at!.inner,annotation.at!.outer)}><span>{annotation.label}</span><small>{annotation.detail}</small></button>:onEditOverride?<button type="button" className="reaction-flow__inactive-condition" onClick={()=>onEditOverride(annotation.id)}><span>{annotation.label}</span><small>{annotation.detail}</small><small>{tr('本次不生效 · 条件已保留','Not applied in this run · condition retained')}</small><b>{tr('编辑条件','Edit conditions')}</b></button>:<div className="reaction-flow__inactive-condition"><span>{annotation.label}</span><small>{annotation.detail}</small><small>{tr('本次不生效 · 条件已保留','Not applied in this run · condition retained')}</small></div>}</li>)}</ul></details></div>;
}

function PointFlowDiagram({positions,rounds,selected,materials,point,onSelect,onAdjust,showConditions=true,active=alwaysActive,runIndex=(i,o)=>o*positions+i,windowed=false}:Props&{windowed?:boolean}){
 const language=useLanguage(),id=useId().replace(/:/g,''),viewport=useRef<HTMLDivElement>(null);
 const [frame,setFrame]=useState({left:0,top:0,width:1000,height:560});
 const [manualZoom,setManualZoom]=useState<number|null>(null);
 const i=Math.max(0,Math.min(positions-1,selected.inner)),o=Math.max(0,Math.min(rounds-1,selected.outer));
 const columns=windowed?flowWindow(positions,i):{start:0,end:positions},rowWindow=windowed?flowWindow(rounds,o):{start:0,end:rounds};
 const graph=useMemo(()=>{
  const nodes:FlowNode[]=[],byKey=new Map<string,FlowNode>(),rows:{outer:number;y:number;height:number;gap:number}[]=[];
  let y=TOP;
  for(let outer=rowWindow.start;outer<rowWindow.end;outer++) {
   const row:FlowNode[]=[];let height=54,gap=64,headroom=TOP;
   for(let inner=columns.start;inner<columns.end;inner++) {
    if(!active(inner,outer))continue;
    const sources=flowInputs(materials,{inner,outer},positions,rounds,active);
    const fresh=sources.filter(g=>g.source==='fresh').flatMap(g=>g.inputs.flatMap(input=>flowTextLines(freshLabel(input),19)));
    const external=sources.some(g=>g.from&&(g.from.inner<columns.start||g.from.inner>=columns.end||g.from.outer<rowWindow.start||g.from.outer>=rowWindow.end));
    const node:FlowNode={inner,outer,key:flowKey({inner,outer}),x:LEFT+(inner-columns.start)*COLUMN,y,height:54+(fresh.length?12+fresh.length*15:0)+(external?23:0),point:point(inner,outer),sources,fresh,external};
    row.push(node);nodes.push(node);byKey.set(node.key,node);height=Math.max(height,node.height);
    for(const source of sources)if(source.source!=='fresh'){
     const lines=source.inputs.flatMap(input=>flowTextLines(inputLabel(input),20)).length;
     gap=Math.max(gap,lines*15+36);
     if(source.source==='left')headroom=Math.max(headroom,34+(lines-1)*15);
    }
   }
   if(rows.length){const previous=rows.at(-1)!;y=previous.y+previous.height+Math.max(previous.gap,gap,headroom);}else y=headroom;
   for(const node of row)node.y=y;
   rows.push({outer,y,height,gap});
  }
  const edges:FlowEdge[]=nodes.flatMap(to=>to.sources.filter(g=>g.from).map(group=>({key:`${flowKey(group.from!)}>${to.key}`,from:byKey.get(flowKey(group.from!))!,to,group,lines:group.inputs.flatMap(input=>flowTextLines(inputLabel(input),20))}))).filter(edge=>edge.from);
  return {nodes,byKey,edges,rows,width:LEFT+(columns.end-columns.start-1)*COLUMN+NODE_WIDTH+(edges.some(e=>e.group.source==='other')?170:36),height:y+(rows.at(-1)?.height??54)+24};
 },[positions,rounds,materials,active,point,language,columns.start,columns.end,rowWindow.start,rowWindow.end]);
 const zoom=manualZoom??Math.min(1,Math.max(.8,(frame.width-8)/graph.width));
 const chosen=graph.byKey.get(flowKey({inner:i,outer:o}));
 const height=Math.max(170,Math.min(560,graph.height*zoom+20));
 const updateFrame=()=>{const el=viewport.current;if(el)setFrame({left:el.scrollLeft,top:el.scrollTop,width:el.clientWidth||1000,height:el.clientHeight||560});};
 useEffect(()=>{
  updateFrame();const el=viewport.current;if(!el||typeof ResizeObserver==='undefined')return;
  const observer=new ResizeObserver(updateFrame);observer.observe(el);return ()=>observer.disconnect();
 },[]);
 // Selecting a coordinate reveals it in the same continuous diagram. Panning
 // alone never changes selection or replaces the overview with a local graph.
 useEffect(()=>{
  const el=viewport.current,node=graph.byKey.get(flowKey({inner:i,outer:o}));if(!el||!node)return;
  const left=node.x*zoom,right=(node.x+NODE_WIDTH)*zoom,top=node.y*zoom,bottom=(node.y+node.height)*zoom;
  if(left<el.scrollLeft+25||right>el.scrollLeft+(el.clientWidth||1000)-25)el.scrollLeft=Math.max(0,left-(el.clientWidth||1000)/2+NODE_WIDTH*zoom/2);
  if(top<el.scrollTop+30||bottom>el.scrollTop+(el.clientHeight||560)-20)el.scrollTop=Math.max(0,top-(el.clientHeight||560)/2+node.height*zoom/2);
  updateFrame();
 },[i,o,zoom,positions,rounds,graph.height]);
 const view={left:frame.left/zoom-80,right:(frame.left+frame.width)/zoom+80,top:frame.top/zoom-80,bottom:(frame.top+frame.height)/zoom+80};
 const visible=(n:FlowNode)=>n.x+NODE_WIDTH>=view.left&&n.x<=view.right&&n.y+n.height>=view.top&&n.y<=view.bottom;
 const nodes=graph.nodes.filter(visible);
 const edges=graph.edges.filter(e=>Math.max(e.from.x,e.to.x)+NODE_WIDTH>=view.left&&Math.min(e.from.x,e.to.x)<=view.right&&Math.max(e.from.y+e.from.height,e.to.y+e.to.height)>=view.top&&Math.min(e.from.y,e.to.y)<=view.bottom);
 const arrow=(edge:FlowEdge)=>{
  const {from,to,group,lines}=edge;let d:string,lx:number,ly:number,anchor:'start'|'middle'='middle';
  if(group.source==='left'){
   const y=to.y+27;d=`M${from.x+NODE_WIDTH+5},${y} H${to.x-6}`;lx=(from.x+NODE_WIDTH+to.x)/2;ly=y-9-(lines.length-1)*15;
  }else if(group.source==='above'){
   const x=to.x+NODE_WIDTH/2;d=`M${x},${from.y+from.height+5} V${to.y-6}`;lx=x;ly=(from.y+from.height+to.y)/2-(lines.length-1)*7.5;
  }else{
   // A nonadjacent dependency stays attached to its true source, including a
   // result in a non-neighbouring round. It is never disguised as an adjacent edge.
   const sx=from.x+NODE_WIDTH-12,sy=from.y+from.height+5,tx=to.x+NODE_WIDTH-16,ty=to.y-6;
   const row=graph.rows.find(row=>row.outer===from.outer)!,channelY=row.y+row.height+16,laneX=to.x-22;
   d=from.outer===to.outer?`M${sx},${sy} V${channelY} H${laneX} V${to.y+27} H${to.x-6}`:`M${sx},${sy} V${channelY} H${laneX} V${to.y-18} H${tx} V${ty}`;
   lx=to.x+NODE_WIDTH+10;ly=to.y+59;anchor='start';
  }
  const related=from.key===chosen?.key||to.key===chosen?.key;
  return <g key={edge.key} className={`reaction-flow__connection${color(group)}${related?' is-related':''}`} data-source={group.source} data-from-inner={from.inner} data-from-outer={from.outer} data-to-inner={to.inner} data-to-outer={to.outer}>
   <title>{`${coordinate(from)} → ${coordinate(to)}: ${group.inputs.map(inputLabel).join('; ')}`}</title>
   <path d={d} markerEnd={`url(#${id}-arrow-${phase(group)})`}/>
   {group.source==='above'&&<rect className="reaction-flow__edge-label-bg" x={lx-Math.min(130,Math.max(...lines.map(l=>l.length))*6.4)/2-3} y={ly-12} width={Math.min(130,Math.max(...lines.map(l=>l.length))*6.4)+6} height={lines.length*15+2} rx="3"/>}
   <text x={lx} y={ly} textAnchor={anchor}>{lines.map((line,n)=><tspan key={n} x={lx} dy={n?15:0}>{line}</tspan>)}</text>
  </g>;
 };
 const keyboard=(event:React.KeyboardEvent,node:FlowNode)=>{
  if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(node.inner,node.outer);return;}
  const delta:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
  const next=delta[event.key];if(!next)return;event.preventDefault();const inner=i+next[0],outer=o+next[1];if(inner>=0&&inner<positions&&outer>=0&&outer<rounds&&active(inner,outer)){onSelect(inner,outer);requestAnimationFrame(()=>viewport.current?.querySelector<SVGElement>(`[data-inner="${inner}"][data-outer="${outer}"]`)?.focus({preventScroll:true}));}
 };
 return <section className="reaction-flow" aria-label={windowed?tr('附近步骤','Nearby steps'):tr('完整反应流程','Complete reaction flow')}>
  <div className="reaction-flow__toolbar"><p>{windowed?tr(`第 ${rowWindow.start+1}–${rowWindow.end} 轮 · 位置 ${columns.start+1}–${columns.end}`,`Rounds ${rowWindow.start+1}–${rowWindow.end} · positions ${columns.start+1}–${columns.end}`):tr('横向：沿路径反应　纵向：下一轮','Across: along the path · Down: next round')}</p><div className="reaction-flow__zoom" aria-label={tr('流程图缩放','Diagram zoom')}><button type="button" aria-label={tr('缩小流程图','Zoom out')} disabled={zoom<=.25} onClick={()=>setManualZoom(Math.max(.25,zoom-.2))}>−</button><button type="button" aria-label={tr('恢复流程图比例','Reset diagram zoom')} onClick={()=>setManualZoom(null)}>{Math.round(zoom*100)}%</button><button type="button" aria-label={tr('放大流程图','Zoom in')} disabled={zoom>=1.6} onClick={()=>setManualZoom(Math.min(1.6,zoom+.2))}>+</button></div></div>
  <div className="reaction-flow__viewport" ref={viewport} onScroll={updateFrame} style={{height}} role="region" aria-label={windowed?tr('局部流程图','Local flow diagram'):tr('可滚动的完整流程图','Scrollable complete flow diagram')} tabIndex={0}>
   <svg className="reaction-flow__map" width={graph.width*zoom} height={graph.height*zoom} viewBox={`0 0 ${graph.width} ${graph.height}`} aria-label={windowed?tr(`附近流程：第 ${rowWindow.start+1}–${rowWindow.end} 轮，位置 ${columns.start+1}–${columns.end}`,`Nearby flow: rounds ${rowWindow.start+1}–${rowWindow.end}, positions ${columns.start+1}–${columns.end}`):tr(`${rounds} 轮、${positions} 个路径位置的反应流程`,`${rounds} rounds and ${positions} path positions`)}>
    <defs>{['aqueous','mineral','gas','all','species','mixed'].map(phase=><marker key={phase} className={`phase-${phase}`} id={`${id}-arrow-${phase}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1L8 5L1 9" fill="none" stroke="var(--flow-color)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></marker>)}</defs>
    {edges.map(arrow)}
    {nodes.map(node=><g key={node.key} className={`reaction-flow__node${node.key===chosen?.key?' is-selected':''}`} data-inner={node.inner} data-outer={node.outer} role="button" tabIndex={node.key===chosen?.key?0:-1} aria-pressed={node.key===chosen?.key} aria-label={tr(`查看第 ${node.outer+1} 轮位置 ${node.inner+1}`,`View round ${node.outer+1}, position ${node.inner+1}`)} onClick={()=>onSelect(node.inner,node.outer)} onKeyDown={event=>keyboard(event,node)}>
     <rect x={node.x} y={node.y} width={NODE_WIDTH} height={node.height} rx="8"/>
     {showConditions?<><text className="reaction-flow__node-temperature" x={node.x+NODE_WIDTH/2} y={node.y+23} textAnchor="middle">{display(node.point.temperature_c)} °C</text><text className="reaction-flow__node-pressure" x={node.x+NODE_WIDTH/2} y={node.y+42} textAnchor="middle">{node.point.pressure_mode==='water_saturation'?'Psat(T)':`${display(node.point.pressure_bar)} bar`}</text></>:<text className="reaction-flow__node-temperature" x={node.x+NODE_WIDTH/2} y={node.y+32} textAnchor="middle">{tr(`位置 ${node.inner+1}`,`Position ${node.inner+1}`)}</text>}
     {!!node.fresh.length&&<g className="reaction-flow__feed" data-source="fresh" data-to-inner={node.inner} data-to-outer={node.outer}><line x1={node.x+10} x2={node.x+NODE_WIDTH-10} y1={node.y+53} y2={node.y+53}/>{node.fresh.map((line,n)=><text key={n} x={node.x+NODE_WIDTH/2} y={node.y+71+n*15} textAnchor="middle">{line}</text>)}</g>}
     {node.external&&<text className="reaction-flow__external" x={node.x+NODE_WIDTH/2} y={node.y+node.height-9} textAnchor="middle">{tr('↖ 含图外来源','↖ Source outside view')}</text>}
    </g>)}
    <g className="reaction-flow__axis-backdrop" aria-hidden="true"><rect x={frame.left/zoom} y={frame.top/zoom} width={LEFT-12} height={frame.height/zoom}/><rect x={frame.left/zoom} y={frame.top/zoom} width={frame.width/zoom} height="35"/></g>
    {graph.rows.filter(row=>row.y+row.height>=view.top&&row.y<=view.bottom).map(row=><g key={row.outer} className="reaction-flow__axis"><rect x={frame.left/zoom} y={row.y+5} width={LEFT-13} height="42"/><text x={frame.left/zoom+12} y={row.y+31}>{tr(`第 ${row.outer+1} 轮`,`Round ${row.outer+1}`)}</text></g>)}
    {Array.from({length:columns.end-columns.start},(_,index)=>index+columns.start).filter(inner=>LEFT+(inner-columns.start)*COLUMN+NODE_WIDTH>=view.left&&LEFT+(inner-columns.start)*COLUMN<=view.right).map(inner=><g key={inner} className="reaction-flow__axis"><rect x={LEFT+(inner-columns.start)*COLUMN-10} y={frame.top/zoom} width={NODE_WIDTH+20} height="35"/><text x={LEFT+(inner-columns.start)*COLUMN+NODE_WIDTH/2} y={frame.top/zoom+23} textAnchor="middle">{tr(`位置 ${inner+1}`,`Position ${inner+1}`)}</text></g>)}
   </svg>
  </div>
  <p className="reaction-flow__caption">{windowed?tr('这里是连续的附近步骤，图外来源在下方详情中列出。切换坐标可查看其他位置，上方概览始终保留。','These are consecutive nearby steps. Sources outside this view are listed in the details below. Change coordinates to explore elsewhere; the overview stays visible.'):tr('箭头表示实际物料传递，+ 表示新投料。点击任一反应查看详情。','Arrows show material transfers; + marks fresh input. Select any reaction for details.')}</p>
  {chosen?<div className="reaction-flow__current" aria-label={coordinate(chosen)}>
   <div className="reaction-flow__current-heading"><div><strong>{coordinate(chosen)}</strong><small>{tr(`第 ${runIndex(i,o)+1} 次平衡计算`,`Equilibrium calculation ${runIndex(i,o)+1}`)}</small></div>{showConditions&&<dl className="reaction-flow__conditions"><div><dt>{tr('温度','Temperature')}</dt><dd data-actual-temperature>{display(chosen.point.temperature_c)} <small>°C</small></dd></div><div><dt>{chosen.point.pressure_mode==='water_saturation'?'Psat(T)':tr('压力','Pressure')}</dt><dd data-actual-pressure>{display(chosen.point.pressure_bar)} <small>bar</small></dd></div></dl>}{onAdjust&&<button type="button" className="reaction-flow__adjust" onClick={onAdjust}>{tr('单独调整此处','Adjust this point')}</button>}</div>
   <div className="reaction-flow__sources">{chosen.sources.map((group,n)=><div key={n} className={`reaction-flow__source${color(group)}`}><strong>{group.from?<button type="button" aria-label={tr(`查看来源：${coordinate(group.from)}`,`View source: ${coordinate(group.from)}`)} onClick={()=>onSelect(group.from!.inner,group.from!.outer)}>{coordinate(group.from)} →</button>:tr('新投料','Fresh input')}</strong><span>{group.inputs.map(input=>input.source==='fresh'?freshLabel(input).slice(2):inputLabel(input)).join(' · ')}</span></div>)}{!chosen.sources.length&&<p className="reaction-flow__empty">{tr('这一步没有投料或取用的反应结果。','No fresh material or previous result is used at this step.')}</p>}</div>
  </div>:<p className="reaction-flow__empty">{tr('本轮在该位置之前已结束。','This round ended before this position.')}</p>}
 </section>;
}
