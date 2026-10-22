import {t} from './i18n';
import type {Config,SimSpecies} from './simulation-types';
import {stageAt,toStageConfig} from './reaction-stages';
import {compileSchedule,migrateSchedule,type CompiledSchedule} from './simulation-schedule';

type MaterialTarget={kind:'material_amount';material_id:string;species:string};
export type MaterialBaseUsage={known:boolean;used:number;baseRequired:boolean;firstUse?:[number,number];firstBase?:[number,number]};
type UsageContext={effective:Config;plan?:CompiledSchedule;results:WeakMap<CompiledSchedule,Map<string,MaterialBaseUsage>>};
const contexts=new WeakMap<Config,UsageContext>();
/** A composition's stored amount matters only where its input is actually added. */
export function materialBaseUsage(config:Config,target:MaterialTarget,items?:readonly SimSpecies[],compiled?:CompiledSchedule):MaterialBaseUsage{
 const unknown:MaterialBaseUsage={known:false,used:0,baseRequired:true};
 try{
  let context=contexts.get(config);
  if(!context){const schedule=migrateSchedule(config);if(!schedule)return unknown;const effective=toStageConfig(config.schedule?config:{...config,schedule});context={effective,results:new WeakMap()};}
  const plan=compiled||context.plan||compileSchedule(context.effective),stages=context.effective.reaction_stages;if(!stages)return unknown;
  // The UI updates configurations immutably. Retain the original object's migration
  // so each composition input shares one compilation, including legacy routes.
  if(!compiled)context.plan=plan;contexts.set(config,context);
  const phase=items?.find(item=>item.name===target.species)?.phase,key=JSON.stringify([target.material_id,target.species,phase||null]);
  let results=context.results.get(plan);if(!results){results=new Map();context.results.set(plan,results);}const previous=results.get(key);if(previous)return previous;
  const remember=(value:MaterialBaseUsage)=>{results!.set(key,value);return value;};
  const candidates=Object.fromEntries(Object.entries(stages).map(([key,routes])=>[key,routes.filter(route=>route.source==='material'&&route.material_id===target.material_id&&(route.phase==='all'||route.phase==='species'?(route.phase==='all'||route.species?.includes(target.species)):!phase||route.phase===phase))]));
  let used=0,firstUse:[number,number]|undefined;
  for(let oi=0;oi<plan.counts.outer;oi++)for(let ii=0;ii<plan.counts.inner;ii++){
   if(!plan.active(ii,oi))continue;
   const added=candidates[stageAt(ii,oi)].some(route=>{const amount=plan.valueAt({kind:'route_fraction',route_id:route.id!,field:'fraction'},ii,oi,route.fraction);if(!Number.isFinite(amount)||amount<0)throw new Error(t('物料份数尚未填完整',"Enter the number of material portions"));return amount>0;});
   if(!added)continue;used++;firstUse??=[ii,oi];
   if(!plan.hasSetting(target,ii,oi))return remember({known:true,used,baseRequired:true,firstUse,firstBase:[ii,oi]});
   const amount=plan.valueAt(target,ii,oi);if(!Number.isFinite(amount)||amount<0)return unknown;
  }
  return remember({known:true,used,baseRequired:false,firstUse});
 }catch{return unknown;}
}
