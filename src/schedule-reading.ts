import {t,getLanguage} from './i18n';
import type {Config,Route,SimSpecies} from './simulation-types';
import {decimalSum,scheduleTargets,type CompiledSchedule} from './simulation-schedule';
import {routeId,targetKey,type LoopTarget} from './simulation-loops';
import {activeRouteEntries,stageAt} from './reaction-stages';

export type ActualVariationRow={key:string;label:string;value:string};
export type ActualVariationSummaries={path:ActualVariationRow[];rounds:ActualVariationRow[]};
type Selection={inner:number;outer:number};
type Sample={value:number;mode?:'fixed'|'water_saturation';used:boolean};
type RouteEntry=ReturnType<typeof activeRouteEntries>[number];
const finite=Number.isFinite;
const clamp=(value:number,count:number)=>Math.min(count-1,Math.max(0,Number.isInteger(value)?value:0));

type ReadingCache={language:ReturnType<typeof getLanguage>;entries:RouteEntry[];targets:ReturnType<typeof scheduleTargets>;path:Map<number,ActualVariationRow[]>;round:Map<number,ActualVariationRow[]>};
type ItemCaches={withoutItems?:ReadingCache;withItems:WeakMap<readonly SimSpecies[],ReadingCache>};
const caches=new WeakMap<Config,WeakMap<CompiledSchedule,ItemCaches>>();
const DIRECTION_CACHE_LIMIT=16;
function readingCache(config:Config,plan:CompiledSchedule,items?:readonly SimSpecies[]):ReadingCache{
 let plans=caches.get(config);if(!plans){plans=new WeakMap();caches.set(config,plans);}
 let catalogs=plans.get(plan);if(!catalogs){catalogs={withItems:new WeakMap()};plans.set(plan,catalogs);}
 const existing=items?catalogs.withItems.get(items):catalogs.withoutItems;if(existing&&existing.language===getLanguage())return existing;
 const created:ReadingCache={language:getLanguage(),entries:activeRouteEntries(config),targets:scheduleTargets(config).filter(item=>item.available&&(item.target.kind==='temperature'||item.target.kind==='pressure'||plan.hasSetting(item.target))),path:new Map(),round:new Map()};
 if(items)catalogs.withItems.set(items,created);else catalogs.withoutItems=created;
 return created;
}

function historyExists(route:Route,inner:number,outer:number,positions:number,config:Config){
 if(route.source==='material')return false;
 if(route.source==='previous_point')return inner>0;
 if(route.source==='previous_cycle')return outer>0;
 const generated=/^loop-([1-9]\d*)$/.exec(route.point_id||''),source=generated?Number(generated[1])-1:config.points.findIndex(p=>p.id===route.point_id),round=outer-(route.lag??1);
 return source>=0&&source<positions&&round>=0&&round*positions+source<outer*positions+inner;
}
function entryIsActive(entry:RouteEntry,inner:number,outer:number){
 const {route,stage}=entry;
 return (!stage||stage===stageAt(inner,outer))&&!(route.when==='first_cycle'&&outer!==0||route.when==='after_first_cycle'&&outer===0);
}
function routeIsUsed(entry:RouteEntry,target:Extract<LoopTarget,{kind:'route_fraction'}>,inner:number,outer:number,positions:number,config:Config){
 const {route,stage}=entry;
 if(!entryIsActive(entry,inner,outer))return false;
 const history=historyExists(route,inner,outer,positions,config);
 if(target.field==='fallback_fraction')return !stage&&route.source!=='material'&&!history&&route.fallback==='material';
 return route.source==='material'||history;
}
function materialIsUsed(target:Extract<LoopTarget,{kind:'material_amount'}>,entries:RouteEntry[],inner:number,outer:number,config:Config,plan:CompiledSchedule,items?:readonly SimSpecies[]){
 const phase=items?.find(item=>item.name===target.species)?.phase;
 return entries.some(entry=>{
  const {route,stage}=entry;
  if(!entryIsActive(entry,inner,outer)||route.material_id!==target.material_id)return false;
  if(route.phase==='species'?!route.species?.includes(target.species):route.phase!=='all'&&phase&&route.phase!==phase)return false;
  const fresh=route.source==='material',fallback=!stage&&!fresh&&!historyExists(route,inner,outer,plan.counts.inner,config)&&route.fallback==='material';
  if(!fresh&&!fallback)return false;
  const field=fresh?'fraction':'fallback_fraction';
  try{const factor=plan.valueAt({kind:'route_fraction',route_id:routeId(route,entry.index),field},inner,outer,route[field]);return finite(factor)&&factor>0;}catch{return false;}
 });
}
function validValue(target:LoopTarget,value:number,entry?:RouteEntry){
 if(!finite(value))return false;
 if(target.kind==='temperature')return value>-273.15;
 if(target.kind==='pressure')return value>0;
 if(value<0)return false;
 return target.kind!=='route_fraction'||target.field!=='fraction'||entry?.route.source==='material'||value<=1;
}
function formatter(values:number[]){
 // Keep the overview short, but never print distinct endpoints as equal.
 const samples=[...new Set(values.filter(finite))];let precision=7;
 while(precision<17&&new Set(samples.map(value=>Number(value.toPrecision(precision)).toString())).size<samples.length)precision++;
 return (value:number)=>Number(value.toPrecision(precision)).toString();
}
function summarize(samples:Sample[],unit:string,direction:'path'|'round',isPressure:boolean):string|null{
 const valid=samples.filter(sample=>sample.used&&finite(sample.value)),missing=samples.some(sample=>sample.used&&!finite(sample.value));
 if(!valid.length)return missing?t('实际值待填写',"Values needed"):null;
 const changed=valid.some(sample=>sample.value!==valid[0].value||isPressure&&sample.mode!==valid[0].mode);
 if(!changed)return missing?t('部分位置的实际值待填写',"Values needed at some positions"):null;
 const values=valid.map(sample=>sample.value),first=values[0],last=values.at(-1)!,minimum=Math.min(...values),maximum=Math.max(...values),delta=values.length>1?decimalSum([last,1],[first,-1])/(values.length-1):0;
 const number=formatter(samples.length<=4?[...values,delta]:[first,last,minimum,maximum,delta]);
 const suffix=unit?` ${unit}`:'';
 const value=(n:number)=>`${number(n)}${suffix}`;
 const sameMode=!isPressure||valid.every(sample=>sample.mode===valid[0].mode);
 const pressurePrefix=isPressure&&sameMode&&valid[0].mode==='water_saturation'?'Psat(T) · ':'';
 if(samples.length<=4){
  if(sameMode)return pressurePrefix+samples.map(sample=>!sample.used?t('未使用',"Not used"):!finite(sample.value)?t('待填写',"Value needed"):number(sample.value)).join(' → ')+suffix;
  return samples.map(sample=>!sample.used?t('未使用',"Not used"):!finite(sample.value)?t('待填写',"Value needed"):`${sample.mode==='water_saturation'?'Psat(T) ':t('指定 ',"Fixed ")}${value(sample.value)}`).join(' → ');
 }
 const complete=valid.length===samples.length,monotonic=values.every((n,i)=>!i||(last>first?n>=values[i-1]:n<=values[i-1]));
 const uniform=complete&&sameMode&&monotonic&&delta!==0&&finite(delta)&&values.every((n,i)=>{
  if(!i)return true;
  const actual=decimalSum([n,1],[values[i-1],-1]),rounding=Math.max(Math.abs(n),Math.abs(values[i-1]),Math.abs(delta))*Number.EPSILON*8;
  return Math.abs(actual-delta)<=Math.abs(delta)*1e-9+rounding;
 });
 if(uniform)return `${pressurePrefix}${value(first)} → ${value(last)} · ${direction==='path'?t('每步',"per reaction"):t('每轮',"per round")} ${delta<0?'−':'+'}${value(Math.abs(delta))}`;
 const modes=isPressure&&!sameMode?t('Psat(T) / 指定压力 · ',"Psat(T) / fixed pressure · "):pressurePrefix;
 const span=complete&&monotonic&&first!==last?`${value(first)} → ${value(last)}`:t(`范围 ${value(minimum)}–${value(maximum)}`,`Range ${value(minimum)}–${value(maximum)}`);
 return t(`${modes}${span} · 按设置变化${!complete?' · 仅使用位置':''}${missing?' · 部分值待填写':''}`,`${modes}${span} · as configured${!complete?' · active positions only':''}${missing?' · some values needed':''}`);
}

/** Actual inputs along the selected round and selected path position; never result metrics. */
export function actualVariationSummaries(config:Config,plan:CompiledSchedule,selected:Selection,items?:readonly SimSpecies[]):ActualVariationSummaries{
 const inner=clamp(selected.inner,plan.counts.inner),outer=clamp(selected.outer,plan.counts.outer),cache=readingCache(config,plan,items),{entries,targets}=cache;
 const direction=(along:'path'|'round'):ActualVariationRow[]=>{
  // Moving within a round cannot change that round's path summary, and vice versa.
  // Separate bounded LRUs retain nearby selections without keeping every coordinate.
  const saved=cache[along],coordinate=along==='path'?outer:inner,existing=saved.get(coordinate);
  if(existing){saved.delete(coordinate);saved.set(coordinate,existing);return existing;}
  const count=along==='path'?plan.counts.inner:plan.counts.outer,rows:ActualVariationRow[]=[];
  for(const item of targets){
   const {target}=item,route=target.kind==='route_fraction'?entries.find(entry=>routeId(entry.route,entry.index)===target.route_id):undefined;
   const samples=Array.from({length:count},(_,index):Sample=>{
    const ii=along==='path'?index:inner,oi=along==='round'?index:outer;
    if(target.kind==='route_fraction'&&(!route||!routeIsUsed(route,target,ii,oi,plan.counts.inner,config)))return {value:NaN,used:false};
    if(target.kind==='material_amount'&&!materialIsUsed(target,entries,ii,oi,config,plan,items))return {value:NaN,used:false};
    try{
     const point=target.kind==='pressure'||target.kind==='temperature'?plan.point(ii,oi):undefined;
     const value=target.kind==='pressure'?point!.pressure_bar:target.kind==='temperature'?point!.temperature_c:plan.valueAt(target,ii,oi,item.value);
     return {value:validValue(target,value,route)?value*(item.quantityKind==='fraction'?100:1):NaN,used:true,...(target.kind==='pressure'?{mode:point!.pressure_mode||'fixed'}:{})};
    }catch{return {value:NaN,used:true};}
   });
   const value=summarize(samples,item.quantityKind==='fraction'?'%':item.unit,along,target.kind==='pressure');
   if(value)rows.push({key:targetKey(target),label:item.label,value});
  }
  const result=rows.length?rows:[{key:'constant',label:t('条件',"Conditions"),value:t('保持不变',"Constant")}];
  if(saved.size>=DIRECTION_CACHE_LIMIT)saved.delete(saved.keys().next().value!);
  saved.set(coordinate,result);return result;
 };
 return {path:direction('path'),rounds:direction('round')};
}
