import {t as tr} from './i18n';
import {useEffect,useRef,useState} from 'react';
import {encodeDraft,restoreDraft} from './draft-json';
import {Config,readConfig,type SimSpecies} from './simulation-types';
import {firstStagePoint} from './reaction-stages';
import type {ReactionStageKey} from './simulation-types';
import {materialBaseUsage} from './material-base-usage';
import {loopCounts,routeTargetBindings} from './simulation-loops';
import {compileSchedule,scheduleScopeIndices,type ParameterSetting} from './simulation-schedule';
import {simulationCall,simulationError} from './simulation-api';
import {constraintActiveAt,constraintDefinitionsIssue} from './equilibrium-constraints';

export type CodeCell={id:string;title:string;description:string;source:string;kind?:'execution';baseline_source?:string};
export type CodeDocument={version:1|2;cells:CodeCell[]};
export type CodeIssue={cell_id?:string;line?:number;column?:number;message:string};
export type EditorDraft={version:1;mode:'ui'|'code';document:CodeDocument|null;config:Config;dirty:boolean;recovery?:{document:CodeDocument;config:Config}};
export class CodeSyncError extends Error{}
export class CodeContextChanged extends Error{}
const ids=['system','materials','conditions','transfers','activity','solver'];
export function isCodeDocument(value:any):value is CodeDocument{
 const expected=[...ids,...(value?.version===2?['runtime','build','states','equilibrium','inventory','collect','process','execute']:[])];
 return [1,2].includes(value?.version) && Array.isArray(value.cells) && value.cells.length===expected.length
  && value.cells.every((c:any,i:number)=>c && c.id===expected[i] && typeof c.source==='string' && typeof c.title==='string' && typeof c.description==='string' && (c.baseline_source===undefined || typeof c.baseline_source==='string'))
  && value.cells.reduce((n:number,c:any)=>n+c.source.length+(c.baseline_source?.length || 0),0)<=2_000_000;
}
export function normalizeEditorDraft(value:EditorDraft):EditorDraft{
 if(value.version!==1||!['ui','code'].includes(value.mode)||(value.document!==null&&!isCodeDocument(value.document)))throw new Error(tr("代码草稿格式不完整", "The code draft is incomplete"));
 if(value.recovery&&!isCodeDocument(value.recovery.document))throw new Error(tr("恢复代码格式不完整", "The recovery code is incomplete"));
 return {...value,config:readConfig(value.config,{allowDraft:true}),...(value.recovery?{recovery:{...value.recovery,config:readConfig(value.recovery.config,{allowDraft:true})}}:{})};
}
function finiteConfig(config:Config,items?:readonly SimSpecies[]){
 config=readConfig(config,{allowDraft:true});
 const labels:Record<string,string>={equilibrium_constraints:tr('平衡目标','Equilibrium targets'),titrant:tr('pH 调节物质','pH adjustment substance'),schedule:tr("反应条件", "Reaction conditions"),parameters:tr("参数", "Parameter"),overrides:tr("单独调整", "Local adjustment"),positions:tr("路径位置", "Path positions"),rounds:tr("轮次", "Rounds"),value:tr("数值", "Value"),path_step:tr("每步变化", "Change per step"),round_step:tr("每轮变化", "Change per round"),other_step:tr("另一方向的变化", "Change in the other direction"),loops:tr("反应路径设置", "Reaction path settings"),base:tr("基础条件", "Base conditions"),inner:tr("反应路径", "Reaction path"),outer:tr("反应轮次", "Reaction rounds"),count:tr("次数", "Count"),start:tr("起点", "Start"),end:tr("终点", "End"),step:tr("步长", "Step size"),values:tr("数列", "Sequence"),materials:tr("初始物质", "Initial materials"),inputs:tr("投料", "Input"),amount:tr("数量", "Amount"),points:tr("温压点", "Temperature–pressure point"),round_conditions:tr("单独设置的轮次", "Individually adjusted rounds"),round:tr("轮次", "Rounds"),temperature_c:tr("温度", "Temperature"),pressure_bar:tr("压力", "Pressure"),temperature_increment_c:tr("每轮温度变化", "Temperature change per round"),pressure_increment_bar:tr("每轮压力变化", "Pressure change per round"),cycles:tr("反应轮数", "Number of reaction rounds"),routes:tr("物料来源", "Material sources"),reaction_stages:tr("反应组成", "Reaction inputs"),first_start:tr("首次起点", "First starting point"),first_following:tr("首轮后续位置", "Remaining positions in the first round"),later_start:tr("后续轮起点", "Starting points in later rounds"),later_following:tr("后续轮其余位置", "Remaining positions in later rounds"),fraction:tr("取用比例", "Fraction taken"),fallback_fraction:tr("首次份数", "Initial portions"),lag:tr("来源轮次", "Source round"),ion_size_overrides:tr("离子尺寸", "Ion size"),a_angstrom:tr("尺寸参数", "Size parameter"),balance_tolerance_mol:tr("守恒误差容限", "Balance tolerance")};
 const visit=(v:any,path:string)=>{if(typeof v==='number' && !Number.isFinite(v))throw new CodeSyncError(path+tr(" 的数值尚未填完整，请补全后切换。", " has an incomplete numeric value. Complete it before switching."));if(v && typeof v==='object')Object.entries(v).forEach(([k,x])=>visit(x,path+' → '+(labels[k] || (/^\d+$/.test(k)?tr(`第 ${Number(k)+1} 项`,`Item ${Number(k)+1}`):k))));};
 const {points,cycles,routes,reaction_stages,schedule,loops,materials,equilibrium_constraints,...parameters}=config;
 // Validate unfinished target values where they are actually used, without
 // filling or deleting the original drafts sent to the notebook and history.
 const incomplete=(value:unknown):boolean=>typeof value==='number'?!Number.isFinite(value):!!value&&typeof value==='object'&&Object.values(value).some(incomplete);
 const targetDrafts=incomplete(equilibrium_constraints)||(schedule&&[...schedule.parameters,...schedule.overrides.flatMap(group=>group.parameters)].some(setting=>setting.target.kind==='equilibrium_constraint'&&incomplete(setting.value)));
 if(targetDrafts){
  if(schedule){try{compileSchedule(config);}catch(error){throw new CodeSyncError(simulationError(error));}}
  else {
   const issue=constraintDefinitionsIssue(config);if(issue)throw new CodeSyncError(issue);
   const counts=loopCounts(config);
   if(!Number.isInteger(counts.inner)||!Number.isInteger(counts.outer)||counts.inner<1||counts.outer<1||counts.total>20000)throw new CodeSyncError(tr('请补全有效的反应位置数和轮数。','Complete the valid number of positions and rounds.'));
   for(const row of equilibrium_constraints||[])for(let outer=0;outer<counts.outer;outer++)for(let inner=0;inner<counts.inner;inner++)if(constraintActiveAt(row,inner,outer))visit(row,tr('平衡目标','Equilibrium targets'));
  }
 }
 const checkedConstraints=equilibrium_constraints?.map(row=>targetDrafts?{...row,value:0}:row);
 let plan;try{if(schedule)plan=compileSchedule(config);}catch{}
 const checkedMaterials=materials.map(material=>({...material,inputs:material.inputs.map(row=>!Number.isFinite(row.amount)&&Number.isNaN(row.amount)&&!materialBaseUsage(config,{kind:'material_amount',material_id:material.id,species:row.species},items).baseRequired?{...row,amount:0}:row)}));const counts=loopCounts(config);const activeStages=reaction_stages?Object.fromEntries(Object.entries(reaction_stages).filter(([key])=>firstStagePoint(key as ReactionStageKey,counts,plan?.lengths))):undefined;
 const unusedRoutes=new Set(reaction_stages?Object.entries(reaction_stages).filter(([key])=>!firstStagePoint(key as ReactionStageKey,counts,plan?.lengths)).flatMap(([,routes])=>routes.map(r=>r.id)):[]);
 const activeParameters=(rows:ParameterSetting[],positions:number,rounds:number)=>rows.filter(s=>s.target.kind!=='route_fraction'||!routeTargetBindings(s.target).every(b=>unusedRoutes.has(b.route_id))).map(setting=>({...setting,value:targetDrafts&&setting.target.kind==='equilibrium_constraint'?{mode:'fixed' as const,value:0}:setting.value.mode==='list'?{...setting.value,values:setting.value.values.slice(0,setting.value.along==='path'?positions:rounds)}:setting.value}));
 const activeSchedule=schedule?{...schedule,parameters:activeParameters(schedule.parameters,counts.inner,counts.outer),overrides:schedule.overrides.flatMap(group=>{const positions=scheduleScopeIndices(group.positions,counts.inner),rounds=scheduleScopeIndices(group.rounds,counts.outer),used=positions.length&&rounds.length&&(!plan||rounds.some(o=>positions.some(i=>plan.active(i-1,o-1))));return used?[{...group,parameters:activeParameters(group.parameters,positions.length,rounds.length)}]:[];})}:undefined;
 visit({...parameters,...(checkedConstraints?{equilibrium_constraints:checkedConstraints}:{}),materials:checkedMaterials,...(activeSchedule?{schedule:activeSchedule}:{}),...(!schedule&&config.loops?{loops:{...config.loops,round_conditions:config.loops.round_conditions?.filter(row=>row.round<=counts.outer)}}:{}),...(!schedule&&!config.loops?{points:reaction_stages?points.map(({routes,...point})=>point):points,cycles}:{}),...(reaction_stages?{reaction_stages:activeStages}:{routes})},tr("模拟参数", "Simulation parameters"));return config;
}
async function refreshExecutionModules(old:EditorDraft):Promise<EditorDraft>{
 if(!old.document)return old;
 // Use a finite transport copy only to render execution modules. Never parse or
 // replace unfinished parameter text, and keep the original numeric UI draft.
 const config=JSON.parse(JSON.stringify(old.config,(_,v)=>typeof v==='number'&&!Number.isFinite(v)?0:v));
 const document=await simulationCall<CodeDocument>('code_render',{config,previous:{config,cells:old.document.cells}});
 if(!isCodeDocument(document))throw new Error(tr("这份代码草稿暂时无法打开，请重新载入保存的设置。", "This code draft cannot currently be opened. Reload the saved settings."));
 const original=new Map(old.document.cells.map(cell=>[cell.id,cell]));
 return {...old,document:{...document,cells:document.cells.map(cell=>{const prior=original.get(cell.id);return ids.includes(cell.id)&&prior?{...cell,source:prior.source}:cell;})}};
}
export function useSimulationCode(config:Config,setConfig:(c:Config)=>void,storageKey:string,ready:boolean,onError:(s:string)=>void,items?:readonly SimSpecies[]){
 const [draft,setDraft]=useState<EditorDraft|null>(null),[hydrated,setHydrated]=useState(''),[processing,setProcessing]=useState(false),[issues,setIssues]=useState<CodeIssue[]>([]),[persisted,setPersisted]=useState(true),[restoreEpoch,setRestoreEpoch]=useState(0);
 const draftRef=useRef(draft),configRef=useRef(config),context=useRef({storageKey,ready}),request=useRef(0),refreshRequired=useRef(false);
 draftRef.current=draft;configRef.current=config;context.current={storageKey,ready};
 const update=(next:EditorDraft|null)=>{draftRef.current=next;setDraft(next);};
 const key=storageKey?storageKey+':code':'';
 useEffect(()=>{
  request.current++;setProcessing(false);setIssues([]);refreshRequired.current=false;
  if(!ready || !key){setHydrated('');return;}
  let next:EditorDraft|null=null;
  try{
   const raw=localStorage.getItem(key);
   if(raw){const stored=restoreDraft(JSON.parse(raw));if(stored.version!==1 || !['ui','code'].includes(stored.mode) || (stored.document!==null && !isCodeDocument(stored.document)))throw new Error(tr("代码草稿格式不完整", "The code draft is incomplete"));
    next=normalizeEditorDraft({...stored,dirty:stored.dirty===true});
   }
  }catch{let backedUp=false;try{const raw=localStorage.getItem(key);if(raw){localStorage.setItem(key+'.recovery',raw);backedUp=true;}}catch{}onError(backedUp?tr("代码草稿无法读取，原内容已另存为本机恢复副本。当前图形参数可继续使用。", "The code draft could not be read. Its original content was saved in a local recovery copy. You can continue using the current visual parameters."):tr("代码草稿无法读取，请先另存当前设置。", "The code draft could not be read. Save the current settings to a separate file first."));setPersisted(false);}
  refreshRequired.current=!!next?.document;update(next);setHydrated(key);
 },[key,ready]);
 useEffect(()=>{
  if(!key || hydrated!==key || !ready || !draft)return;
  try{localStorage.setItem(key,JSON.stringify(encodeDraft(draft)));setPersisted(true);}
  catch{setPersisted(false);}
 },[key,hydrated,ready,draft]);
 useEffect(()=>{
  const old=draftRef.current;
  if(!ready || hydrated!==key || !old?.document)return;
  const id=++request.current,origin=storageKey;let cancelled=false;setProcessing(true);
  refreshRequired.current=true;
  refreshExecutionModules(old).then(restored=>{
   if(cancelled || id!==request.current || context.current.storageKey!==origin)return;
   refreshRequired.current=false;update(restored);
  }).catch(e=>{if(!cancelled && id===request.current && context.current.storageKey===origin)onError(simulationError(e));}).finally(()=>{if(!cancelled && id===request.current)setProcessing(false);});
  return()=>{cancelled=true;};
 },[ready,hydrated,key,restoreEpoch]);
 const currentMode=ready && hydrated===key?draft?.mode || 'ui':'ui';
 const sameContext=(id:number,origin:string)=>{if(id!==request.current || context.current.storageKey!==origin || !context.current.ready)throw new CodeContextChanged();};
 async function showCode(){
  if(processing || !ready)return;
  const origin=storageKey,id=++request.current;setProcessing(true);setIssues([]);
  try{
   const snapshot=finiteConfig(configRef.current,items),old=draftRef.current;
   if(old?.dirty && old.document){const restored=refreshRequired.current?await refreshExecutionModules(old):old;sameContext(id,origin);refreshRequired.current=false;update({...restored,mode:'code'});return;}
   const document=await simulationCall<CodeDocument>('code_render',{config:snapshot,previous:old?.document && !old.dirty?{cells:old.document.cells,config:old.config}:undefined});
   sameContext(id,origin);if(!isCodeDocument(document))throw new Error(tr("代码未能完整载入，请重试。", "The code did not load completely. Try again."));
   refreshRequired.current=false;update({version:1,mode:'code',document,config:snapshot,dirty:false,recovery:old?.recovery});
  }catch(e){if(!(e instanceof CodeContextChanged))onError(simulationError(e));}
  finally{if(id===request.current)setProcessing(false);}
 }
 async function resolveConfig(parametersOnly=false):Promise<Config>{
  let old=draftRef.current;
  const customLogic=old?.document?.cells.some(c=>!ids.includes(c.id) && c.source!==c.baseline_source);
  if(!old?.document || (!refreshRequired.current && currentMode!=='code' && (!customLogic || parametersOnly)))return finiteConfig(configRef.current,items);
  const origin=storageKey,id=++request.current;setProcessing(true);setIssues([]);
  try{
   if(refreshRequired.current){old=await refreshExecutionModules(old);sameContext(id,origin);refreshRequired.current=false;update(old);}
   if(currentMode==='ui'){
    const cfg=finiteConfig(configRef.current,items);
    const document=await simulationCall<CodeDocument>('code_render',{config:cfg,previous:{config:old.config,cells:old.document!.cells}});
    sameContext(id,origin);if(!isCodeDocument(document))throw new Error(tr("代码未能完整载入，请重试。", "The code did not load completely. Try again."));
    old={...old,document,config:cfg};
   }
   const response=await simulationCall<{valid:boolean;config?:Config;errors:CodeIssue[]}>('code_parse',{document:old.document,config:configRef.current,parameters_only:parametersOnly});
   sameContext(id,origin);
   if(!response.valid){update({...old,mode:'code',dirty:true});setIssues(response.errors || []);throw new CodeSyncError(tr("代码尚未同步：请修正模块中标出的错误。当前代码和上次有效参数均已保留。", "Code is not synchronized. Correct the errors marked in the modules. Your current code and last valid parameters have been kept."));}
   let next:Config;
   try{next=finiteConfig(response.config!,items);}catch(e){setIssues([{message:tr("参数无法显示在图形界面中：", "These parameters cannot be shown in the visual editor: ")+simulationError(e)}]);throw new CodeSyncError(tr("代码参数结构不完整，未替换当前图形参数。", "The code parameter structure is incomplete. Current visual parameters were kept."));}
   setConfig(next);configRef.current=next;update({...old,config:next,dirty:false});return next;
  }finally{if(id===request.current)setProcessing(false);}
 }
 async function showUI(){
  try{await resolveConfig(true);if(draftRef.current)update({...draftRef.current,mode:'ui'});}
  catch(e){if(!(e instanceof CodeContextChanged))onError(simulationError(e));}
 }
 function edit(cellId:string,source:string){
  const old=draftRef.current;if(!old?.document)return;
  request.current++;setIssues(value=>value.filter(x=>x.cell_id!==cellId));
  update({...old,dirty:true,document:{...old.document,cells:old.document.cells.map(c=>c.id===cellId?{...c,source}:c)}});
 }
 async function resetProgram(){
  const old=draftRef.current;if(!old?.document)return;
  try{
   const cfg=await resolveConfig(true),origin=storageKey,id=++request.current;setProcessing(true);
   const document=await simulationCall<CodeDocument>('code_render',{config:cfg,previous:{config:cfg,cells:old.document.cells.filter(c=>ids.includes(c.id))}});
   sameContext(id,origin);if(!isCodeDocument(document))throw new Error(tr("代码未能完整载入，请重试。", "The code did not load completely. Try again."));
   update({...old,mode:'code',document,config:cfg,dirty:false,recovery:{document:old.document,config:old.config}});setIssues([]);
  }catch(e){if(!(e instanceof CodeContextChanged))onError(simulationError(e));}finally{setProcessing(false);}
 }
 function discard(){
  const old=draftRef.current;if(!old?.document)return;
  request.current++;setProcessing(false);setIssues([]);
  update({...old,mode:'ui',document:null,dirty:false,config:configRef.current,recovery:{document:old.document,config:old.config}});
 }
 function restore(){
  const old=draftRef.current;if(!old?.recovery)return;
  request.current++;setIssues([]);
  refreshRequired.current=true;update({...old,mode:'code',document:old.recovery.document,dirty:true,recovery:undefined});setRestoreEpoch(n=>n+1);
 }
 function replace(config:Config,raw?:unknown){
  const old=draftRef.current;request.current++;setProcessing(false);setIssues([]);
  const imported=raw?normalizeEditorDraft(raw as EditorDraft):undefined;
  if(imported && (imported.version!==1 || !['ui','code'].includes(imported.mode) || (imported.document!==null && !isCodeDocument(imported.document))))throw new Error(tr("设置中的代码模块格式不完整，未载入这份设置。", "The code modules in this settings file are incomplete. The file was not loaded."));
  const recovery=old?.document?{document:old.document,config:old.config}:old?.recovery;
  const base=imported?.document?readConfig(imported.config,{allowDraft:true}):readConfig(config,{allowDraft:true});
  refreshRequired.current=!!imported?.document;update(imported?{version:1,mode:imported.document?imported.mode:'ui',document:imported.document,config:base,dirty:!!imported.document && (imported.mode==='code' || imported.dirty),recovery}:{version:1,mode:'ui',document:null,config:base,dirty:false,recovery});setRestoreEpoch(n=>n+1);
 }
 return {ready:ready && hydrated===key,mode:currentMode,document:draft?.document || null,dirty:!!draft?.dirty,processing,issues,persisted,
  restoreSnapshot:(editor?:EditorDraft)=>{request.current++;setProcessing(false);setIssues([]);refreshRequired.current=!!editor?.document;update(editor?normalizeEditorDraft(structuredClone(editor)):null);setRestoreEpoch(n=>n+1);},
  showCode,showUI,edit,resolveConfig,discard,restore,canRestore:!!draft?.recovery,replace,
  custom:ready && hydrated===key && !!draft?.document?.cells.some(c=>!ids.includes(c.id) && c.source!==c.baseline_source),resetProgram,
  snapshot:()=>draftRef.current?structuredClone(draftRef.current):undefined};
}
