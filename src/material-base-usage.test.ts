import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG,makeRoute,type Config,type SimSpecies} from './simulation-types';
import * as schedule from './simulation-schedule';
import {materialBaseUsage} from './material-base-usage';
import {toStageConfig} from './reaction-stages';
afterEach(()=>vi.restoreAllMocks());
function legacy(size=40):Config{
 const inputs=Array.from({length:size},(_,i)=>({species:'s'+i,amount:1,unit:'mol' as const}));
 const config:Config={...structuredClone(DEFAULT_CONFIG),species:inputs.map(row=>row.species),materials:[{id:'initial',name:'initial',inputs}],routes:[{...makeRoute('all','material','initial'),id:'fresh'}],schedule:{...schedule.defaultSchedule(),positions:1000,rounds:20}};
 inputs.forEach(row=>config.schedule!.parameters.push({id:'amount-'+row.species,target:{kind:'material_amount',material_id:'initial',species:row.species},value:{mode:'fixed',value:2}}));return config;
}
const target=(species:string)=>({kind:'material_amount' as const,material_id:'initial',species});
it('shares one legacy migration and compilation across 40 inputs and reuses the evaluated results',()=>{
 const c=legacy(),compile=vi.spyOn(schedule,'compileSchedule'),started=performance.now();
 const first=c.materials[0].inputs.map(row=>materialBaseUsage(c,target(row.species)));const firstMs=performance.now()-started;
 expect(first.every(result=>result.known&&!result.baseRequired&&result.used===20000)).toBe(true);expect(compile).toHaveBeenCalledTimes(1);
 const repeatStart=performance.now(),second=c.materials[0].inputs.map(row=>materialBaseUsage(c,target(row.species))),repeatMs=performance.now()-repeatStart;
 second.forEach((result,index)=>expect(result).toBe(first[index]));expect(compile).toHaveBeenCalledTimes(1);
 console.info('materialBaseUsage 40 × 20,000 points',JSON.stringify({firstMs,repeatMs}));
});
it('recomputes after immutable changes to the settings or source fraction',()=>{
 const c=legacy(1),compile=vi.spyOn(schedule,'compileSchedule');expect(materialBaseUsage(c,target('s0')).baseRequired).toBe(false);
 const uncovered={...c,schedule:{...c.schedule!,parameters:c.schedule!.parameters.filter(p=>p.target.kind!=='material_amount')}};
 expect(materialBaseUsage(uncovered,target('s0'))).toMatchObject({baseRequired:true,firstBase:[0,0]});
 const unused={...uncovered,routes:uncovered.routes.map(route=>({...route,fraction:0}))};expect(materialBaseUsage(unused,target('s0'))).toMatchObject({known:true,baseRequired:false,used:0});expect(compile).toHaveBeenCalledTimes(3);
 expect(materialBaseUsage(c,target('s0')).used).toBe(20000);
});
it('separates catalog phase changes and explicitly supplied compiled plans',()=>{
 const c=legacy(1);c.routes[0].phase='aqueous';const item={name:'s0',phase:'aqueous'} as SimSpecies;
 expect(materialBaseUsage(c,target('s0'),[item]).used).toBe(20000);expect(materialBaseUsage(c,target('s0'),[{...item,phase:'mineral'}]).used).toBe(0);
 const plan=schedule.compileSchedule(toStageConfig(c)),different={...plan,valueAt:(...args:Parameters<typeof plan.valueAt>)=>args[0].kind==='route_fraction'?0:plan.valueAt(...args)};
 expect(materialBaseUsage(c,target('s0'),[item],different).used).toBe(0);expect(materialBaseUsage(c,target('s0'),[item],plan).used).toBe(20000);
});
it('does not cache a failed compilation as a usable plan',()=>{
 const c=legacy(1);c.schedule!.positions=NaN;const compile=vi.spyOn(schedule,'compileSchedule');expect(materialBaseUsage(c,target('s0')).known).toBe(false);
 c.schedule!.positions=1000;expect(materialBaseUsage(c,target('s0')).known).toBe(true);expect(compile).toHaveBeenCalledTimes(2);
});
