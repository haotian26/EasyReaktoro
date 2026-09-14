import {describe,it,expect} from 'vitest';
import {DEFAULT_CONFIG,makeRoute} from './simulation-types';
import {removeSystemSpecies,restoreSpeciesSelections} from './simulation-species-cleanup';
import {defaultSchedule} from './simulation-schedule';
describe('removing unavailable species',()=>{
 it('clears recipe, solvent, activity, path and every stage selection without changing run count',()=>{
  const c=structuredClone(DEFAULT_CONFIG);c.species=['old','valid'];c.water_species='old';c.materials[0].inputs=[{species:'old',amount:1,unit:'kg'},{species:'valid',amount:2,unit:'mol'}];c.ion_size_overrides.old={a_angstrom:3,source:'ref',reason:''};
  const route={...makeRoute('species'),species:['old','valid']};c.routes=[route];c.points[0].routes=[route];c.reaction_stages={first_start:[route],first_following:[route],later_start:[route],later_following:[route]};c.loops={base:{temperature_c:250,pressure_bar:700},inner:{mode:'range',target:{kind:'material_amount',material_id:'initial',species:'old'},start:1,end:5,step:1},outer:{mode:'repeat',count:2}};
  const n=removeSystemSpecies(c,new Set(['old']));expect(n.species).toEqual(['valid']);expect(n.water_species).toBeUndefined();expect(n.materials[0].inputs.map(x=>x.species)).toEqual(['valid']);expect(n.ion_size_overrides).toEqual({});expect(n.loops?.inner).toEqual({mode:'repeat',count:5});
  for(const r of [...n.routes,...n.points[0].routes!,...Object.values(n.reaction_stages!).flat()])expect(r.species).toEqual(['valid']);expect(c.species).toEqual(['old','valid']);
 });
 it('can restore selected route species without discarding later route edits',()=>{
  const c=structuredClone(DEFAULT_CONFIG);const r={...makeRoute('species'),species:['old','valid']};c.routes=[r];c.species=['old'];const n=removeSystemSpecies(c,new Set(['old']));n.routes[0].fraction=.5;
  const restored=restoreSpeciesSelections(n,c);expect(restored.routes?.[0].species).toEqual(['valid','old']);expect(restored.routes?.[0].fraction).toBe(.5);
 });
 it('restores a removed solvent and its automatic axis reset, while preserving a later deliberate axis edit',()=>{
  const c=structuredClone(DEFAULT_CONFIG);c.species=['water'];c.water_species='water';c.loops={base:{temperature_c:250,pressure_bar:700},inner:{mode:'range',target:{kind:'material_amount',material_id:'initial',species:'water'},start:1,end:3,step:1},outer:{mode:'repeat',count:1}};
  const after=removeSystemSpecies(c,new Set(['water'])),restored=restoreSpeciesSelections(after,c,after);expect(restored.water_species).toBe('water');expect(restored.loops?.inner).toEqual(c.loops.inner);
  const edited={...after,loops:{...after.loops!,inner:{mode:'repeat' as const,count:4}}};expect(restoreSpeciesSelections(edited,c,after).loops).toBeUndefined();
 });

 it('restores per-position legacy selectors in their own context even when ids are shared',()=>{
  const c=structuredClone(DEFAULT_CONFIG);c.species=['B'];c.routes=[{...makeRoute('species'),id:'shared',species:['A']}];c.points[0].routes=[{...makeRoute('species'),id:'shared',species:['B']}];
  const after=removeSystemSpecies(c,new Set(['B'])),restored=restoreSpeciesSelections(after,c,after);expect(restored.routes?.[0].species).toEqual(['A']);expect(restored.points?.[0].routes?.[0].species).toEqual(['B']);
 });

 it('removes scheduled species quantities and restores only those IDs after a later temperature edit',()=>{
  const c=structuredClone(DEFAULT_CONFIG);c.species=['old','valid'];c.materials[0].inputs=[{species:'old',amount:0,unit:'mol'},{species:'valid',amount:1,unit:'mol'}];
  c.schedule={...defaultSchedule(),positions:100,rounds:3};c.schedule.parameters.push({id:'old-amount',target:{kind:'material_amount',material_id:'initial',species:'old'},value:{mode:'linear',start:1,path_step:1,round_step:2}});
  c.schedule.overrides=[{id:'round-three',rounds:{start:3,end:3},positions:{start:1},parameters:[{id:'local-old',target:{kind:'material_amount',material_id:'initial',species:'old'},value:{mode:'fixed',value:5}}]}];
  const after=removeSystemSpecies(c,new Set(['old'])),edited={...after,schedule:{...after.schedule!,parameters:after.schedule!.parameters.map(p=>p.target.kind==='temperature'?{...p,value:{mode:'fixed' as const,value:150}}:p)}};
  const restored=restoreSpeciesSelections(edited,{...c,species:['old']},after);
  expect(after.schedule!.overrides).toEqual([]);expect(after.schedule!.positions).toBe(100);expect(restored.schedule!.parameters.find(p=>p.id==='temperature')!.value).toEqual({mode:'fixed',value:150});expect(restored.schedule!.parameters.find(p=>p.id==='old-amount')).toEqual(c.schedule.parameters.at(-1));expect(restored.schedule!.overrides).toEqual(c.schedule.overrides);expect(restored.schedule!.rounds).toBe(3);
 });

});
