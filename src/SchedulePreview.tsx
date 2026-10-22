import {t as tr,useLanguage} from './i18n';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ArrowDown,ArrowLeft,ArrowRight,ArrowUp,SlidersHorizontal} from 'lucide-react';
import {Config,fmt,ReactionStageKey,Route,SimSpecies} from './simulation-types';
import {compileSchedule,migrateSchedule,scheduleTargets,scheduleScopeIndices,scheduleSettingSummary,type CompiledSchedule,type IndexScope} from './simulation-schedule';
import {routeId,targetDescription,targetKey} from './simulation-loops';
import {activeRouteEntries,stageAt,stageKeys,toStageConfig} from './reaction-stages';
import {evaluatedRecipeInputs,phaseTitles,recipeInputs,sourceLabel} from './ReactionStageEditor';
import {type DiagramMaterialStages,type DiagramMaterialTerm} from './LoopDiagram';
import {ReactionFlowDiagram} from './ReactionFlowDiagram';
import type {FlowAnnotation} from './reaction-flow-overview';
import {actualVariationSummaries} from './schedule-reading';
import {constraintActiveAt} from './equilibrium-constraints';
import './schedule-preview.css';

export type ScheduleSelection={inner:number;outer:number};
export type SchedulePreviewProps={config:Config;items:SimSpecies[];selected:ScheduleSelection;onSelect:(inner:number,outer:number)=>void;onAdjust:(inner:number,outer:number)=>void;onLocateIssue?:()=>void;onEditOverride?:(id:string)=>void};
const finite=Number.isFinite;
const clamped=(value:number,count:number)=>Math.max(0,Math.min(count-1,Number.isInteger(value)?value:0));
const fraction=(plan:CompiledSchedule,route:Route,ii:number,oi:number)=>plan.valueAt({kind:'route_fraction',route_id:route.id!,field:'fraction'},ii,oi,route.fraction);
function scopeLabel(scope:IndexScope,count:number,unit:string){const end=scope.end??count,range=scope.end===undefined&&scope.start>count?tr(`${scope.start} 起`,`${scope.start} onward`):scope.start===end?`${scope.start}`:`${scope.start}–${end}`;return tr(`${unit} ${range}${scope.step&&scope.step!==1?`（每 ${scope.step} 个）`:''}`, `${unit} ${range}${scope.step&&scope.step!==1?` (every ${scope.step})`:''}`);}
function PointNumber({value,count,label,onChange}:{value:number;count:number;label:string;onChange:(value:number)=>void}){
 useLanguage();
 const [text,setText]=useState(String(value+1));useEffect(()=>setText(String(value+1)),[value,count]);
 const valid=/^\d+$/.test(text)&&Number(text)>=1&&Number(text)<=count;
 return <label className="schedule-preview__coordinate"><span>{label}</span><input data-local-undo type="number" min={1} max={count} step={1} aria-label={tr(`预览${label}`, `Preview ${label}`)} aria-invalid={!valid} value={text} onChange={e=>{setText(e.target.value);const next=Number(e.target.value);if(e.target.value.trim()&&Number.isInteger(next)&&next>=1&&next<=count)onChange(next-1);}} onBlur={()=>setText(String(value+1))}/><small>/ {count}</small></label>;
}
function sourceCoordinate(route:Route,ii:number,oi:number,config:Config,positions?:number):{inner:number;outer:number}|null{
 if(route.source==='previous_point')return ii>0?{inner:ii-1,outer:oi}:null;
 if(route.source==='previous_cycle')return oi>0?{inner:ii,outer:oi-1}:null;
 if(route.source!=='output')return null;
 const generated=/^loop-([1-9]\d*)$/.exec(route.point_id||''),inner=generated?Number(generated[1])-1:config.points.findIndex(p=>p.id===route.point_id),outer=oi-(route.lag??1);
 return inner>=0&&outer>=0&&(!positions||inner<positions&&outer*positions+inner<oi*positions+ii)?{inner,outer}:null;
}
function actualSource(route:Route,ii:number,oi:number,config:Config,positions:number){
 if(route.source==='material')return sourceLabel(route,config);
 const from=sourceCoordinate(route,ii,oi,config,positions);
 return from?tr(`第 ${from.outer+1} 轮 · 位置 ${from.inner+1} 的反应结果`, `Reaction result at round ${from.outer+1} · position ${from.inner+1}`):tr("此处尚无对应来源结果", "No corresponding source result exists here yet");
}

function diagramMaterials(effective:Config,plan:CompiledSchedule,items:SimSpecies[]){
 const materialStages:DiagramMaterialStages={first_start:[],first_following:[],later_start:[],later_following:[]};
 for(const key of stageKeys)materialStages[key]=(effective.reaction_stages?.[key]||[]).map(route=>{
  const source:DiagramMaterialTerm['source']=route.source==='material'?'fresh':route.source==='previous_point'?'left':route.source==='previous_cycle'?'above':'other',inputs=source==='fresh'?recipeInputs(effective,route,items):[];
  return {source,phase:route.phase,phaseLabel:phaseTitles[route.phase],species:route.phase==='species'?route.species:undefined,label:sourceLabel(route,effective),fraction:route.fraction,
   sourceAt:(i,o)=>sourceCoordinate(route,i,o,effective,plan.counts.inner),fractionAt:(i,o)=>{const factor=fraction(plan,route,i,o);if(source!=='fresh'||!finite(factor)||factor<=0)return factor;
    const values=inputs.map(row=>plan.valueAt({kind:'material_amount',material_id:route.material_id,species:row.species},i,o,row.amount));return values.some(v=>!finite(v))?NaN:values.some(v=>v>0)?factor:0;}};
 });
 return materialStages;
}

export function SchedulePreview({config,items,selected,onSelect,onAdjust,onLocateIssue,onEditOverride}:SchedulePreviewProps){
 const language=useLanguage();
 const [view,setView]=useState<'diagram'|'table'>('diagram');
 const previewElement=useRef<HTMLElement>(null),validHeight=useRef(0);
 const prepared=useMemo(()=>{
  try{const effective=toStageConfig(config),schedule=migrateSchedule(effective);if(!schedule)throw new Error(tr("这份模拟尚未定义统一反应路径。", "This simulation has no unified reaction path yet."));const plan=compileSchedule(effective,schedule);return {effective,schedule,plan,materialStages:diagramMaterials(effective,plan,items)};}
  catch(e){return {error:e instanceof Error?e.message:tr("请补全反应条件。", "Complete the reaction conditions.")};}
 },[config,language,items]);
 useLayoutEffect(()=>{
  const el=previewElement.current;if(!prepared.plan||!el)return;
  const measure=()=>{validHeight.current=el.getBoundingClientRect().height;};measure();
  if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(measure);observer.observe(el);return ()=>observer.disconnect();
 },[prepared.plan,view]);
 if(!prepared.plan||!prepared.effective||!prepared.schedule)return <aside ref={previewElement} style={validHeight.current?{minHeight:validHeight.current}:undefined} className="schedule-preview schedule-preview--empty" aria-label={tr("反应预览", "Reaction preview")}><h3>{tr("反应预览", "Reaction preview")}</h3><p role="status">{prepared.error}</p>{onLocateIssue&&<button type="button" className="text-btn" onClick={onLocateIssue}>{tr("定位到输入", "Go to input")} <ArrowRight size={14}/></button>}</aside>;
 const {plan,effective,schedule}=prepared,counts=plan.counts,oi=clamped(selected.outer,counts.outer),ii=clamped(selected.inner,plan.lengths[oi]),stage=stageAt(ii,oi),routes=effective.reaction_stages?.[stage]||[];
 let point;try{point=plan.point(ii,oi);}catch{}
 const materialStages=prepared.materialStages;
 const variations=actualVariationSummaries(effective,plan,{inner:ii,outer:oi},items);
 const changed=schedule.parameters.filter(setting=>setting.value.mode!=='fixed'),overrides=schedule.overrides;
 const completeStageAxis=(scope:IndexScope,count:number)=>!scope.step||scope.step===1?((scope.start===1&&(scope.end===1||scope.end===undefined||scope.end>=count))||(scope.start===2&&(scope.end===undefined||scope.end>=count))):false;
 const annotations:FlowAnnotation[]=overrides.flatMap(override=>{
  if(!override.point&&completeStageAxis(override.positions,counts.inner)&&completeStageAxis(override.rounds,counts.outer))return [];
  const positions=scheduleScopeIndices(override.positions,counts.inner),rounds=scheduleScopeIndices(override.rounds,counts.outer);
  let at:ScheduleSelection|undefined;
  for(const outer of rounds){const inner=positions.find(inner=>plan.active(inner-1,outer-1));if(inner!==undefined){at={inner:inner-1,outer:outer-1};break;}}
  return [{id:override.id,at,label:`${scopeLabel(override.rounds,counts.outer,tr('轮次',override.rounds.start===(override.rounds.end??counts.outer)?'Round':'Rounds'))} · ${scopeLabel(override.positions,counts.inner,tr('位置',override.positions.start===(override.positions.end??counts.inner)?'Position':'Positions'))}`,detail:override.parameters.map(setting=>`${targetDescription(setting.target,effective).label}: ${scheduleSettingSummary(setting,effective,{positions:positions.length,rounds:rounds.length})}`).join(' · ')}];
 });
 return <aside ref={previewElement} className="schedule-preview" aria-label={tr("反应预览", "Reaction preview")}>
  <header className="schedule-preview__heading"><div><h3>{tr("反应预览", "Reaction preview")}</h3><p>{tr("横向是反应路径，纵向是轮次传递；重复流程合并展示，可展开附近步骤。", "Follow the path across and the rounds down. Repetitions are grouped; expand nearby steps for detail.")}</p></div><span>{counts.total.toLocaleString()} {tr("次平衡", counts.total===1?"equilibrium":"equilibria")}</span></header>
  <div className="schedule-preview__selectors">
   <div><button type="button" className="sim-icon-btn" aria-label={tr("预览上一位置", "Preview previous position")} disabled={ii===0} onClick={()=>onSelect(ii-1,oi)}><ArrowLeft size={14}/></button><PointNumber label={tr("路径位置", "Position")} value={ii} count={plan.lengths[oi]} onChange={index=>onSelect(index,oi)}/><button type="button" className="sim-icon-btn" aria-label={tr("预览下一位置", "Preview next position")} disabled={ii===plan.lengths[oi]-1} onClick={()=>onSelect(ii+1,oi)}><ArrowRight size={14}/></button></div>
   <div><button type="button" className="sim-icon-btn" aria-label={tr("预览上一轮次", "Preview previous round")} disabled={oi===0} onClick={()=>onSelect(ii,oi-1)}><ArrowUp size={14}/></button><PointNumber label={tr("反应轮次", "Round")} value={oi} count={counts.outer} onChange={index=>onSelect(ii,index)}/><button type="button" className="sim-icon-btn" aria-label={tr("预览下一轮次", "Preview next round")} disabled={oi===counts.outer-1} onClick={()=>onSelect(ii,oi+1)}><ArrowDown size={14}/></button></div>
  </div>
  <div className="schedule-preview__views" role="tablist" aria-label={tr("核对反应设置", "Review reaction settings")}><button type="button" role="tab" aria-selected={view==='diagram'} onClick={()=>setView('diagram')}>{tr("物料传递图", "Material flow")}</button><button type="button" role="tab" aria-selected={view==='table'} onClick={()=>setView('table')}>{tr("逐点条件表", "Point values")}</button></div>
  {view==='diagram'?<ReactionFlowDiagram active={plan.active} runIndex={plan.runIndex} annotations={annotations} onEditOverride={onEditOverride} showConditions={true} positions={counts.inner} rounds={counts.outer} materials={materialStages} selected={{inner:ii,outer:oi}} point={plan.point} onSelect={onSelect} onAdjust={()=>onAdjust(ii,oi)}/>:<PointTable config={effective} plan={plan} inner={ii} outer={oi} onSelect={onSelect} onAdjust={onAdjust}/>}
  {view==='diagram'&&counts.total>1&&<div className="schedule-preview__directions" aria-label={tr("实际参数变化", "Actual parameter changes")}>{counts.inner>1&&<section data-reaction-axis="path"><h4><ArrowRight size={14}/>{tr("沿路径 ", "Along the path ")}<small>{tr(`第 ${oi+1} 轮`, `Round ${oi+1}`)}</small></h4><dl>{variations.path.map(row=><div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></section>}{counts.outer>1&&<section data-reaction-axis="round"><h4><ArrowDown size={14}/>{tr("轮次之间 ", "Between rounds ")}<small>{tr("位置 ", "Position ")}{ii+1}</small></h4><dl>{variations.rounds.map(row=><div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></section>}</div>}
  {(view==='table'||!!effective.equilibrium_constraints?.length)&&<section className="schedule-preview__point" aria-label={tr(`第 ${oi+1} 轮位置 ${ii+1} 的实际设置`, `Actual settings at round ${oi+1}, position ${ii+1}`)}>
   <header><div><strong>{tr("第 ", "Round ")}{oi+1} {tr("轮 · 位置 ", "· position ")}{ii+1}</strong><small>{tr(`第 ${plan.runIndex(ii,oi)+1} 次反应`, `Reaction ${plan.runIndex(ii,oi)+1}`)}</small></div>{view==='table'&&<button type="button" className="text-btn" onClick={()=>onAdjust(ii,oi)}><SlidersHorizontal size={14}/>{tr("单独调整此处", "Adjust this point")}</button>}</header>
   {view==='table'&&<dl className="schedule-preview__conditions"><div><dt>{tr("温度", "Temperature")}</dt><dd data-actual-temperature>{fmt(point?.temperature_c)} <small>°C</small></dd></div><div><dt>{point?.pressure_mode==='water_saturation'?tr("纯水饱和蒸汽压", "Pure-water saturation pressure"):tr("压力", "Pressure")}</dt><dd data-actual-pressure>{fmt(point?.pressure_bar)} <small>bar</small></dd></div></dl>}
   {!!effective.equilibrium_constraints?.length&&<div className="schedule-preview__targets"><strong>{tr('本次平衡目标','Equilibrium targets at this point')}</strong><dl>{effective.equilibrium_constraints.filter(c=>constraintActiveAt(c,ii,oi)).map(c=><div key={c.id}><dt>{c.kind==='ph'?`pH · ${c.titrant}`:tr(`${c.species} 逸度`,`${c.species} fugacity`)}</dt><dd>{fmt(plan.valueAt({kind:'equilibrium_constraint',constraint_id:c.id},ii,oi,c.value))}{c.kind==='fugacity'?' bar':''}</dd></div>)}</dl><p>{effective.equilibrium_constraints.some(c=>constraintActiveAt(c,ii,oi))?tr('所需外部物质交换量由平衡计算确定。','The equilibrium calculation determines the external material exchange required.'):tr('此处没有启用额外目标。','No additional targets apply here.')}</p></div>}
  </section>}
  <details className="schedule-preview__composition" aria-label={tr(`第 ${oi+1} 轮位置 ${ii+1} 的物料`, `Materials at round ${oi+1}, position ${ii+1}`)}>
   <summary>{tr("本次加入与取用", "Inputs and fractions at this point")}</summary>
   <ul className="schedule-preview__materials">{routes.map((route,index)=><PreviewMaterial key={route.id||index} route={route} config={effective} items={items} stage={stage} ii={ii} oi={oi} plan={plan}/>)}</ul>
   {!routes.length&&<p className="schedule-preview__muted">{tr("此处尚未设置物料。", "No material sources set here yet.")}</p>}
  </details>
  {(changed.length>0||overrides.length>0)&&<details className="schedule-preview__changes"><summary>{tr("完整条件说明", "All condition rules")}</summary><ul>{changed.map(setting=><li key={setting.id}>{targetDescription(setting.target,effective).label}{tr("：",": ")}{scheduleSettingSummary(setting,effective)}</li>)}{overrides.map(override=><li key={override.id}><strong>{override.name||tr(`${scopeLabel(override.rounds,counts.outer,'轮次')} · ${scopeLabel(override.positions,counts.inner,'位置')}`, `${scopeLabel(override.rounds,counts.outer,'rounds')} · ${scopeLabel(override.positions,counts.inner,'positions')}`)}</strong>{override.parameters.map(setting=><span key={setting.id}>{targetDescription(setting.target,effective).label}{tr("：",": ")}{scheduleSettingSummary(setting,effective,{positions:scheduleScopeIndices(override.positions,counts.inner).length,rounds:scheduleScopeIndices(override.rounds,counts.outer).length})}</span>)}</li>)}</ul></details>}
 </aside>;
}
function PreviewMaterial({route,config,items,stage,ii,oi,plan}:{route:Route;config:Config;items:SimSpecies[];stage:ReactionStageKey;ii:number;oi:number;plan:CompiledSchedule}){
 useLanguage();
 let amount=NaN,rows:ReturnType<typeof evaluatedRecipeInputs>=[];try{amount=fraction(plan,route,ii,oi);if(route.source==='material')rows=evaluatedRecipeInputs(config,route,stage,items,[ii,oi],plan);}catch{}
 const fresh=route.source==='material',invalidSource=!fresh&&!sourceCoordinate(route,ii,oi,config,plan.counts.inner),positive=fresh?rows.some(row=>finite(row.amount)&&row.amount>0):!invalidSource&&finite(amount)&&amount>0,invalid=!finite(amount)||rows.some(row=>!finite(row.amount)),source=actualSource(route,ii,oi,config,plan.counts.inner);
 return <li className={`schedule-preview__material phase-${route.phase}${!positive?' is-zero':''}`}>
  <div className="schedule-preview__material-heading"><span className="schedule-preview__flow" aria-hidden="true">{fresh?'+':route.source==='previous_point'?'→':route.source==='previous_cycle'?'↓':'↘'}</span><strong>{source}</strong><b>{fmt(amount*(fresh?1:100))} {fresh?tr("份", "portions"):'%'}</b></div>
  <p>{phaseTitles[route.phase]}{route.phase==='species'?tr(` · ${route.species?.join('、')||'尚未选择 species'}`, `· ${route.species?.join(', ')||'No species selected'}`):''}</p>
  {fresh&&rows.length>0&&<div className="schedule-preview__input-rows">{rows.map(row=><span key={row.species}><strong>{row.species}</strong> {fmt(row.amount)} {row.unit}</span>)}</div>}
  {invalidSource?<small role="status">{tr("请选择此时已经完成的反应结果。", "Choose a reaction result that has already completed at this point.")}</small>:invalid?<small role="status">{tr("此处用量尚未填写完整。", "Complete the amount for this point.")}</small>:!positive?<small>{fresh?tr("当前选取部分没有投料。", "The selected part contains no input material."):tr("此处不取用该来源。", "This source is not used at this point.")}</small>:!fresh?<small>{tr("实际组成由该来源的平衡结果决定。", "The actual composition is determined by equilibrium at the source.")}</small>:null}
 </li>;
}

function PointTable({config,plan,inner,outer,onSelect,onAdjust}:{config:Config;plan:CompiledSchedule;inner:number;outer:number;onSelect:(i:number,o:number)=>void;onAdjust:(i:number,o:number)=>void}){
 useLanguage();
 const [metric,setMetric]=useState(''),[page,setPage]=useState(Math.floor(inner/20));
 useEffect(()=>setPage(Math.floor(inner/20)),[inner,outer]);
 const pages=Math.ceil(plan.lengths[outer]/20),actualPage=Math.min(page,pages-1),start=actualPage*20;
 const targets=scheduleTargets(config).filter(t=>!['temperature','pressure'].includes(t.target.kind)),chosen=targets.find(t=>targetKey(t.target)===metric);
 const routeEntries=chosen?.target.kind==='route_fraction'?activeRouteEntries(config).filter(entry=>routeId(entry.route,entry.index)===(chosen.target as {route_id:string}).route_id):[];
 const activeAt=(index:number)=>{if(chosen?.target.kind==='equilibrium_constraint'){const row=config.equilibrium_constraints?.find(c=>c.id===(chosen.target as {constraint_id:string}).constraint_id);return !!row&&constraintActiveAt(row,index,outer);}return !chosen||chosen.target.kind!=='route_fraction'||routeEntries.some(entry=>!entry.stage||entry.stage===stageAt(index,outer));};
 const rows=Array.from({length:Math.min(20,plan.lengths[outer]-start)},(_,n)=>{const index=start+n;return {index,point:plan.point(index,outer)};});
 return <section className="schedule-point-table" aria-label={tr("本轮逐点条件", "Conditions along this round")}>
  <label>{tr("更多参数", "Additional parameters")}<select aria-label={tr("条件表附加参数", "Additional parameter in the conditions table")} value={chosen?metric:''} onChange={e=>setMetric(e.target.value)}><option value="">{tr("仅温度与压力", "Temperature and pressure only")}</option>{targets.map(t=><option key={targetKey(t.target)} value={targetKey(t.target)}>{t.label}</option>)}</select></label>
  <div className="schedule-point-table-scroll"><table><thead><tr><th>{tr("位置", "Position")}</th><th>{tr("温度 / °C", "Temperature / °C")}</th><th>{tr("压力 / bar", "Pressure / bar")}</th>{chosen&&<th>{chosen.label}{(chosen.quantityKind==='fraction'||chosen.unit)?` / ${chosen.quantityKind==='fraction'?'%':chosen.unit}`:''}</th>}<th><span className="sr-only">{tr("编辑", "Edit")}</span></th></tr></thead><tbody>{rows.map(({index,point})=><tr key={index} className={index===inner?'selected':''}><td><button type="button" aria-label={tr(`查看第 ${outer+1} 轮位置 ${index+1}`, `View round ${outer+1}, position ${index+1}`)} onClick={()=>onSelect(index,outer)}>{index+1}</button></td><td>{fmt(point.temperature_c)}</td><td>{fmt(point.pressure_bar)}{point.pressure_mode==='water_saturation'&&<small>Psat(T)</small>}</td>{chosen&&<td>{activeAt(index)?fmt(plan.valueAt(chosen.target,index,outer,chosen.value)*(chosen.quantityKind==='fraction'?100:1)):<span title={chosen.target.kind==='equilibrium_constraint'?tr("此处不施加该目标", "This target does not apply here"):tr("此处不取用该来源", "This source is not used here")} aria-label={chosen.target.kind==='equilibrium_constraint'?tr("此处不施加该目标", "This target does not apply here"):tr("此处不取用该来源", "This source is not used here")}>—</span>}</td>}<td><button type="button" className="text-btn" aria-label={tr(`调整第 ${outer+1} 轮位置 ${index+1}`, `Adjust round ${outer+1}, position ${index+1}`)} onClick={()=>onAdjust(index,outer)}>{tr("调整", "Adjust")}</button></td></tr>)}</tbody></table></div>
  <footer><span>{tr("第 ", "Round ")}{outer+1} {tr("轮 · 位置 ", "· position ")}{start+1}–{start+rows.length}</span>{pages>1&&<div><button type="button" className="sim-icon-btn" aria-label={tr("条件表上一页", "Previous conditions page")} disabled={actualPage===0} onClick={()=>setPage(actualPage-1)}><ArrowLeft size={13}/></button><span>{actualPage+1} / {pages}</span><button type="button" className="sim-icon-btn" aria-label={tr("条件表下一页", "Next conditions page")} disabled={actualPage===pages-1} onClick={()=>setPage(actualPage+1)}><ArrowRight size={13}/></button></div>}</footer>
 </section>;
}
