import type {Config,Route} from './simulation-types';
import {removeParameterReferences,restoreRemovedScheduleReferences} from './schedule-references';
/** Removing a system species also removes every input/selection that refers to it. */
export function removeSystemSpecies(config:Config,names:Set<string>):Config{
 const clean=(route:Route):Route=>route.species?{...route,species:route.species.filter(name=>!names.has(name))}:route;
 const next={...config,species:config.species.filter(name=>!names.has(name)),water_species:config.water_species&&names.has(config.water_species)?undefined:config.water_species,
  materials:config.materials.map(m=>({...m,inputs:m.inputs.filter(row=>!names.has(row.species))})),
  routes:config.routes.map(clean),points:config.points.map(p=>p.routes?{...p,routes:p.routes.map(clean)}:p),
  reaction_stages:config.reaction_stages?Object.fromEntries(Object.entries(config.reaction_stages).map(([stage,routes])=>[stage,routes.map(clean)])) as Config['reaction_stages']:undefined,
  ion_size_overrides:Object.fromEntries(Object.entries(config.ion_size_overrides).filter(([name])=>!names.has(name)))};
 return {...next,...removeParameterReferences(config,target=>target.kind==='material_amount'&&names.has(target.species))};
}
export function restoreSpeciesSelections(config:Config,removed:Config,after?:Config):Partial<Config>{
 const names=new Set(removed.species);
 const restoreList=(routes:Route[],original:Route[])=>routes.map((route,index)=>{const old=route.id?original.find(r=>r.id===route.id):original[index];if(!old||old.source!==route.source||old.phase!==route.phase||old.material_id!==route.material_id||!old.species)return route;return {...route,species:[...new Set([...(route.species||[]),...old.species.filter(name=>names.has(name))])]};});
 const extra:Partial<Config>={};
 if(removed.water_species&&names.has(removed.water_species)&&config.water_species===after?.water_species)extra.water_species=removed.water_species;
 if(after?.loops&&config.loops&&removed.loops){const loops={...config.loops};let restored=false;for(const axis of ['inner','outer'] as const){const old=removed.loops[axis];if(old.mode!=='repeat'&&old.target.kind==='material_amount'&&names.has(old.target.species)&&JSON.stringify(config.loops[axis])===JSON.stringify(after.loops[axis])){loops[axis]=old;restored=true;}}if(restored)extra.loops=loops;}
 if(config.schedule&&removed.schedule&&after?.schedule)extra.schedule=restoreRemovedScheduleReferences(config.schedule,removed.schedule,after.schedule);
 return {...extra,routes:restoreList(config.routes,removed.routes),points:config.points.map(p=>p.routes?{...p,routes:restoreList(p.routes,removed.points.find(old=>old.id===p.id)?.routes||[])}:p),reaction_stages:config.reaction_stages?Object.fromEntries(Object.entries(config.reaction_stages).map(([stage,routes])=>[stage,restoreList(routes,removed.reaction_stages?.[stage as keyof NonNullable<Config['reaction_stages']>]||[])])) as Config['reaction_stages']:undefined};
}
