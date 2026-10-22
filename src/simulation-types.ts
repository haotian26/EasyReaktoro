import {t} from './i18n';
import {normalizeStageRoutes} from './reaction-stages';
import {migrateSchedule,validateScheduleShape,type Schedule,type IndexScope} from './simulation-schedule';
import {encodeDraft,restoreDraft} from './draft-json';
import {validConstraintShape} from './equilibrium-constraints';
import {loopCounts,loopRoundConditions,loopValues,type LoopDefinition} from './simulation-loops';
export type Phase = 'aqueous' | 'mineral' | 'gas';
export type IonSize = { a_angstrom: number; source: string; reason: string; is_default?: boolean; resolution?: string };
export type SimSpecies = { id?:string;name: string; formula: string; phase: Phase | null; charge: number; elements: string[]; is_water: boolean; disabled: boolean; reason: string; ion_size: IonSize | null; state?:string; common_rank?:number;chemical_rank?:number };
export type InputRow = { species: string; amount: number; unit: 'mol' | 'g' | 'kg' };
export type Material = {id: string; name: string; inputs: InputRow[]};
export type Route = {id?:string;source:'material'|'previous_point'|'previous_cycle'|'output';phase:Phase|'all'|'species';fraction:number;material_id:string;fallback:'material'|'none'|'error';fallback_fraction:number;when:'always'|'first_cycle'|'after_first_cycle';point_id?:string;lag?:number;species?:string[]};
export type ReactionStageKey='first_start'|'first_following'|'later_start'|'later_following';
export type ReactionStages=Record<ReactionStageKey,Route[]>;
export type RoundConditions = {round:number;temperature_c:number;pressure_bar:number;pressure_mode?:'fixed'|'water_saturation'};
export type Point = {round_conditions?:RoundConditions[];id:string; label:string; temperature_c:number; pressure_bar:number; pressure_mode?:'fixed'|'water_saturation'; temperature_increment_c?:number;pressure_increment_bar?:number;routes?:Route[]};
export type EquilibriumConstraint = {id:string;value:number;rounds?:IndexScope;positions?:IndexScope} & ({kind:'ph';titrant:string;exchange:'add_only'|'both'} | {kind:'fugacity';species:string});
export type Config = {
  equilibrium_constraints?:EquilibriumConstraint[];
  schema_version:2; schedule?:Schedule; loops?:LoopDefinition; reaction_stages?:ReactionStages; name:string; species:string[]; materials:Material[]; points:Point[]; cycles:number;routes:Route[];
  activity_model:'nacl_edh'|'phreeqc'|'hkf'|'davies'|'ideal';gas_model:'ideal'|'peng_robinson'; water_species?:string;
  bootstrap:boolean;allow_database_defaults:boolean;allow_recorded_assignments:boolean;allow_non_nacl:boolean;
  allow_unsupported_water:boolean;balance_tolerance_mol:number;ion_size_overrides:Record<string,IonSize>;
  import_provenance?:Record<string,unknown>;
};
export type DatabaseSummary = {handle_id:string;kind:string;embedded_name?:string;group?:string;path?:string;dirty:boolean};
export type JobStatus = {job_id:string;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';execution?:{mode:'standard'|'custom';sha256?:string};completed:number;total:number;stage:string;message:string;diagnostic?:string;elapsed_seconds:number;warnings?:string[];output_path:string;name?:string;source?:{name:string;records_sha256?:string;path?:string;dirty?:boolean}};
export type PointSummary = {run_index:number;pass:number;step:number;point_id:string;temperature_c:number;pressure_bar:number;[key:string]:any};
export type SpeciesResult = {run_index:number;species:string;formula:string;phase_type:Phase;amount_mol:number;[key:string]:any};
export type Result = {summary:PointSummary[];species:SpeciesResult[];status:JobStatus;metadata:{config:Config;ion_size_audit:any[];process_balance:any[];warnings?:string[];[key:string]:any}};
export const PHASE_LABELS = {get aqueous(){return t('水相','Aqueous');},get mineral(){return t('矿物','Mineral');},get gas(){return t('气相','Gas');}};
export const newId = () => `id-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
export const makeRoute = (phase:Route['phase']='all',source:Route['source']='material',material_id='initial'):Route => ({id:newId(),phase,source,material_id,fraction:1,fallback:'material',fallback_fraction:1,when:'always'});
export const DEFAULT_CONFIG:Config = {schema_version:2,get name(){return t('新的平衡模拟','New equilibrium simulation');},species:[],materials:[{id:'initial',name:'Composition 1',inputs:[]}],points:[{id:'p1',label:'P1',temperature_c:250,pressure_bar:700}],cycles:1,routes:[makeRoute()],activity_model:'nacl_edh',gas_model:'ideal',bootstrap:true,allow_database_defaults:true,allow_recorded_assignments:true,allow_non_nacl:false,allow_unsupported_water:false,balance_tolerance_mol:1e-10,ion_size_overrides:{}};

export function readConfig(value:unknown,options:{allowDraft?:boolean}={}):Config {
  if(!value || typeof value!=='object')throw new Error(t('模拟设置格式无效。',"Invalid simulation settings format."));
  let cfg:any=restoreDraft(encodeDraft(value));
  if(cfg.schema_version!==undefined && ![1,2].includes(cfg.schema_version))throw new Error(t('不支持此模拟设置版本。',"This version of simulation settings is not supported."));
  if(cfg.schema_version!==2){
    if(!['single_point','independent_points','closed_path','repeated_flushing'].includes(cfg.mode) || !Array.isArray(cfg.inputs) || !Array.isArray(cfg.points))throw new Error(t('旧版模拟设置格式不完整。',"The legacy simulation settings are incomplete."));
    const flushing=cfg.mode==='repeated_flushing';
    cfg={...cfg,schema_version:2,materials:[{id:'initial',name:'Composition 1',inputs:cfg.inputs}],cycles:flushing?(cfg.passes??1):1,points:cfg.points.map((p:any,i:number)=>({...p,id:`p${i+1}`})),routes:(flushing?['aqueous','mineral','gas'] as const:['all'] as const).map(phase=>({...makeRoute(phase,flushing?(phase==='mineral'?'previous_cycle':'previous_point'):cfg.mode==='closed_path'?'previous_point':'material'),fallback_fraction:flushing && phase==='mineral' && cfg.solid_distribution==='total_evenly'?1/cfg.points.length:1}))};
    if(cfg.template_source){cfg.import_provenance=cfg.template_source;cfg.name=({'Basic Sample Template':'平衡计算','Water–Rock Interaction Sample Template':'水岩反应'} as any)[cfg.name] || cfg.name;}
    ['mode','passes','solid_distribution','inputs','template_source'].forEach(k=>delete cfg[k]);
  }
  if(options.allowDraft&&Array.isArray(cfg.materials))for(const material of cfg.materials)if(Array.isArray(material?.inputs))for(const row of material.inputs)if(row&&row.amount===null)row.amount=NaN;
  if(options.allowDraft&&Array.isArray(cfg.equilibrium_constraints))for(const row of cfg.equilibrium_constraints)if(row&&row.value===null)row.value=NaN;
  if(cfg.equilibrium_constraints!==undefined && (!Array.isArray(cfg.equilibrium_constraints)||cfg.equilibrium_constraints.length>100||!cfg.equilibrium_constraints.every((row:any)=>validConstraintShape(row,!!options.allowDraft))))throw new Error(t('平衡目标设置格式不完整。','The equilibrium target settings are incomplete.'));
  if(cfg.schedule===null)delete cfg.schedule;
  if(cfg.loops===null||cfg.schedule)delete cfg.loops;
  if(cfg.reaction_stages===null)delete cfg.reaction_stages;
  const object=(v:any)=>!!v && typeof v==='object' && !Array.isArray(v);
  const num=(v:any)=>typeof v==='number' && (options.allowDraft||Number.isFinite(v));
  const round=(r:any)=>object(r) && Number.isInteger(r.round) && r.round>=1 && r.round<=10000 && num(r.temperature_c) && num(r.pressure_bar) && (r.pressure_mode===undefined || ['fixed','water_saturation'].includes(r.pressure_mode));
  const route=(r:any,allowDraft=false)=>object(r) && ['material','previous_point','previous_cycle','output'].includes(r.source) && ['all','aqueous','mineral','gas','species'].includes(r.phase) && (num(r.fraction)||allowDraft&&typeof r.fraction==='number') && typeof r.material_id==='string' && ['material','none','error'].includes(r.fallback) && (num(r.fallback_fraction)||allowDraft&&typeof r.fallback_fraction==='number') && ['always','first_cycle','after_first_cycle'].includes(r.when) && (r.species===undefined || (Array.isArray(r.species) && r.species.every((n:any)=>typeof n==='string'))) && (r.source!=='output' || (typeof r.point_id==='string' && [0,1].includes(r.lag)));
  if(cfg.reaction_stages!==undefined){const keys=['first_start','first_following','later_start','later_following'];let dimensions={inner:NaN,outer:NaN};try{dimensions=loopCounts(cfg);}catch{}const inactive=(k:string)=>k.endsWith('following')&&dimensions.inner===1||k.startsWith('later')&&dimensions.outer===1;if(!object(cfg.reaction_stages)||Object.keys(cfg.reaction_stages).some(k=>!keys.includes(k))||keys.some(k=>!Array.isArray(cfg.reaction_stages[k])||cfg.reaction_stages[k].length>30||!cfg.reaction_stages[k].every((r:any)=>route(r,inactive(k)))))throw new Error(t('反应物组成设置不完整。',"The reactant composition is incomplete."));}
  if(!Array.isArray(cfg.species) || cfg.species.length>500 || !cfg.species.every((x:any)=>typeof x==='string') ||
    !Array.isArray(cfg.materials) || (!cfg.materials.length || cfg.materials.length>100) || !cfg.materials.every((m:any)=>object(m) && typeof m.id==='string' && typeof m.name==='string' && Array.isArray(m.inputs) && m.inputs.length<=500 && m.inputs.every((r:any)=>object(r) && typeof r.species==='string' && num(r.amount) && ['mol','g','kg'].includes(r.unit))) ||
    !Array.isArray(cfg.points) || (!cfg.points.length || cfg.points.length>10000) || (!cfg.loops && !cfg.schedule && !cfg.points.every((p:any)=>object(p) && typeof p.id==='string' && (p.round_conditions===undefined || (Array.isArray(p.round_conditions) && p.round_conditions.length<=10000 && p.round_conditions.every(round) && new Set(p.round_conditions.map((r:any)=>r.round)).size===p.round_conditions.length)) && num(p.temperature_c) && num(p.pressure_bar) && (p.pressure_mode===undefined || ['fixed','water_saturation'].includes(p.pressure_mode)) && (p.temperature_increment_c===undefined || num(p.temperature_increment_c)) && (p.pressure_increment_bar===undefined || num(p.pressure_increment_bar)) && (cfg.reaction_stages || p.routes===undefined || (Array.isArray(p.routes) && p.routes.every((r:any)=>route(r)))))) ||
    (!cfg.loops && !cfg.schedule && !num(cfg.cycles)) || !Array.isArray(cfg.routes) || (!cfg.reaction_stages && !cfg.routes.every((r:any)=>route(r))) ||
    !['nacl_edh','phreeqc','hkf','davies','ideal'].includes(cfg.activity_model) ||
    (cfg.name!==undefined && typeof cfg.name!=='string') || (cfg.gas_model!==undefined && !['ideal','peng_robinson'].includes(cfg.gas_model)) ||
    (cfg.water_species!==undefined && typeof cfg.water_species!=='string') || (cfg.balance_tolerance_mol!==undefined && !num(cfg.balance_tolerance_mol)) ||
    ['bootstrap','allow_database_defaults','allow_recorded_assignments','allow_non_nacl','allow_unsupported_water'].some(k=>k in cfg && typeof cfg[k]!=='boolean') ||
    (cfg.ion_size_overrides!==undefined && (!object(cfg.ion_size_overrides) || !Object.values(cfg.ion_size_overrides).every((x:any)=>object(x) && num(x.a_angstrom) && typeof x.source==='string' && typeof x.reason==='string'))))throw new Error(t('模拟设置格式不完整或包含无效数值。',"The simulation settings are incomplete or contain invalid values."));
  if(cfg.schedule===null)delete cfg.schedule;
  if(cfg.loops===null||cfg.schedule)delete cfg.loops;
  if(cfg.loops!==undefined && !validLoops(cfg.loops,options.allowDraft))throw new Error(t('反应条件设置不完整或包含无效数值。',"The reaction conditions are incomplete or contain invalid values."));
  if(cfg.schedule!==undefined&&!validateScheduleShape(cfg.schedule))throw new Error(t('反应条件设置格式不完整。',"The reaction conditions format is incomplete."));
  const normalized=normalizeStageRoutes({...structuredClone(DEFAULT_CONFIG),...cfg,routes:cfg.routes.map((r:Route,i:number)=>({...r,id:r.id||`route-${i+1}`})),points:cfg.points.map((p:any,i:number)=>({...p,label:typeof p.label==='string'?p.label:`P${i+1}`}))});
  const schedule=migrateSchedule(normalized);if(!schedule)return normalized;
  const {loops,...rest}=normalized;return {...rest,schedule};
}

export function filterSpecies(items:SimSpecies[],query:string,phase:string,elements:string[],match:string,onlySelected:boolean,selected:Set<string>){
  const q=query.trim().toLowerCase().replace(/[₀₁₂₃₄₅₆₇₈₉]/g,c=>String('₀₁₂₃₄₅₆₇₈₉'.indexOf(c))),allowed=new Set(elements);
  return items.filter(item=>(!q || `${item.name} ${item.formula}`.toLowerCase().includes(q)) && (!phase || item.phase===phase) && (!onlySelected || selected.has(item.name)) && (!elements.length || (match==='only'?item.elements.length>0 && item.elements.every(e=>allowed.has(e)):match==='all'?elements.every(e=>item.elements.includes(e)):elements.some(e=>item.elements.includes(e)))));
}
/** A saved empty selection is intentional; use this only for a genuinely new draft. */
export function basicAqueousSpecies(items:SimSpecies[]){
  const groups=[0,1,2].map(rank=>items.filter(x=>!x.disabled && (x.common_rank ?? (x.is_water?0:100))===rank));
  if(groups[0].length!==1)return [];
  return groups.filter(group=>group.length===1).map(group=>group[0].name);
}
export function sortSpecies(items:SimSpecies[],order='common'){
  const rank=(s:SimSpecies)=>s.common_rank ?? (s.is_water?0:100);
  const chemical=(s:SimSpecies)=>s.is_water?0:rank(s)<=2?rank(s):3+(s.chemical_rank??(s.phase==='aqueous'?(s.elements.length===1?1:3):s.phase==='mineral'?4:5));
  return [...items].sort((a,b)=>Number(a.disabled)-Number(b.disabled) || (order==='chemical'?chemical(a)-chemical(b):0) || (order==='common'?rank(a)-rank(b):0) || (order==='phase'?(['aqueous','mineral','gas',null].indexOf(a.phase)-['aqueous','mineral','gas',null].indexOf(b.phase)):0) || (order==='chemical'?a.formula.localeCompare(b.formula,undefined,{numeric:true}):0) || a.name.localeCompare(b.name,undefined,{numeric:true}));
}
export function linearRange(start:number,end:number,step:number):number[]{
  if(![start,end,step].every(Number.isFinite) || !step || (end-start)*step<0)throw new Error(t('步长须为非零有限数，方向与起止值一致。',"Enter a nonzero increment that moves from the starting value toward the ending value."));
  if(start===end)return [start];
  const count=Math.floor(Math.abs((end-start)/step)+1e-9)+1;
  if(count>10000)throw new Error(t('单轴点数不能超过 10,000。',"A series can contain at most 10,000 points."));
  const rows=Array.from({length:count},(_,i)=>Number((start+i*step).toPrecision(12)));
  if(Math.abs(rows[rows.length-1]-end)>Math.abs(step)*1e-8)rows.push(end);
  return rows;
}
export const numeric=(text:string)=>text.trim()===''?NaN:Number(text);
export const fmt=(value:unknown,digits=5)=>typeof value==='number' && Number.isFinite(value)?(value===0?'0':Math.abs(value)<1e-4 || Math.abs(value)>=1e5?value.toExponential(3):Number(value.toPrecision(digits)).toString()):'—';

function validLoops(value:any,allowDraft=false):boolean{
 const object=(v:any)=>!!v&&typeof v==='object'&&!Array.isArray(v),num=(v:any)=>typeof v==='number'&&(allowDraft||Number.isFinite(v));
 const binding=(v:any)=>object(v)&&typeof v.route_id==='string'&&['fraction','fallback_fraction'].includes(v.field);
 const target=(v:any)=>object(v)&&(['temperature','pressure'].includes(v.kind)||(v.kind==='material_amount'&&typeof v.material_id==='string'&&typeof v.species==='string')||(v.kind==='route_fraction'&&binding(v)&&(v.bindings===undefined||(Array.isArray(v.bindings)&&v.bindings.length>0&&v.bindings.length<=120&&v.bindings.every(binding)))));
 const loop=(v:any)=>object(v)&&(v.mode==='repeat'?num(v.count):v.mode==='range'?target(v.target)&&[v.start,v.end,v.step].every(num):v.mode==='list'?target(v.target)&&Array.isArray(v.values)&&v.values.length<=10000&&v.values.every(num):false);
 if(!allowDraft&&object(value)&&value.round_conditions!==undefined){try{loopRoundConditions(value,loopValues(value.outer).length);}catch{return false;}}
 return object(value)&&object(value.base)&&num(value.base.temperature_c)&&num(value.base.pressure_bar)&&(value.base.pressure_mode===undefined||['fixed','water_saturation'].includes(value.base.pressure_mode))&&loop(value.inner)&&loop(value.outer);
}
