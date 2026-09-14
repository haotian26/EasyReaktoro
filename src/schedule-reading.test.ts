import {describe,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG,makeRoute,type Config,type SimSpecies} from './simulation-types';
import {compileSchedule,defaultSchedule,type ParameterSetting} from './simulation-schedule';
import {stageKeys} from './reaction-stages';
import {saturationPressure} from './process-layout';
import {actualVariationSummaries} from './schedule-reading';
const setting=(id:string,target:ParameterSetting['target'],value:ParameterSetting['value']):ParameterSetting=>({id,target,value});
const fixed=(value:number)=>({mode:'fixed' as const,value});
const water:SimSpecies={name:'H2O',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null};
const mineral:SimSpecies={...water,name:'Calcite',formula:'CaCO3',phase:'mineral',is_water:false};
const items=[water,mineral];
function config(positions=5,rounds=2):Config{
 const c=structuredClone(DEFAULT_CONFIG);c.species=['H2O','Calcite'];c.materials=[{id:'initial',name:'Composition A',inputs:[{species:'H2O',amount:1,unit:'kg'},{species:'Calcite',amount:.01,unit:'mol'}]}];
 c.reaction_stages=Object.fromEntries(stageKeys.map(stage=>[stage,[{...makeRoute(),id:stage,material_id:'initial',fallback:'error',when:'always'}]])) as Config['reaction_stages'];
 c.schedule={...defaultSchedule(),positions,rounds,parameters:[setting('t',{kind:'temperature'},fixed(100)),setting('p',{kind:'pressure'},fixed(700))]};return c;
}
const read=(c:Config,inner=0,outer=0)=>actualVariationSummaries(c,compileSchedule(c),{inner,outer},items);
const text=(rows:ReturnType<typeof read>['path'])=>rows.map(row=>row.label+': '+row.value).join('\n');
const byKey=(rows:ReturnType<typeof read>['path'],key:string)=>rows.find(row=>row.key===key)!;

describe('actual variation readings',()=>{
 it('reads the selected row and column, including mixed saturation and fixed pressure',()=>{
  const c=config(3,2);c.schedule!.parameters=[setting('t',{kind:'temperature'},{mode:'linear',start:250,path_step:-50,round_step:0}),setting('p',{kind:'pressure'},{mode:'water_saturation'})];
  c.schedule!.overrides=[{id:'later-pressure',rounds:{start:2},positions:{start:1},parameters:[setting('fixed',{kind:'pressure'},fixed(700))]}];
  const first=read(c,1,0),later=read(c,1,1);
  expect(byKey(first.path,'temperature').value).toBe('250 → 200 → 150 °C');expect(byKey(first.path,'pressure').value).toContain('Psat(T)');
  expect(byKey(first.rounds,'pressure').value).toContain('Psat(T)');expect(byKey(first.rounds,'pressure').value).toContain('指定 700 bar');
  expect(first.rounds.some(row=>row.key==='temperature')).toBe(false);expect(later.path.some(row=>row.key==='pressure')).toBe(false);
 });
 it('keeps all actual temperature, pressure, composition and portion changes with their units',()=>{
  const c=config();c.schedule!.parameters=[setting('t',{kind:'temperature'},{mode:'linear',start:100,path_step:10,round_step:0}),setting('p',{kind:'pressure'},{mode:'linear',start:10,path_step:2,round_step:5}),setting('water',{kind:'material_amount',material_id:'initial',species:'H2O'},{mode:'linear',start:1,path_step:.25,round_step:.5}),setting('portion',{kind:'route_fraction',route_id:'first_following',field:'fraction'},{mode:'linear',start:1,path_step:.1,round_step:0})];
  const rows=read(c).path;expect(rows).toHaveLength(4);expect(byKey(rows,'temperature').value).toBe('100 °C → 140 °C · 每步 +10 °C');
  expect(text(rows)).toContain('1 kg → 2 kg · 每步 +0.25 kg');expect(text(rows)).toContain('配方份数');expect(text(rows)).toContain('份');expect(text(rows)).not.toContain('molality');
  const round=read(c,2).rounds;expect(text(round)).toContain('14 → 19 bar');expect(text(round)).toContain('1.5 → 2 kg');
 });
 it('does not describe a nonmonotonic sequence with equal endpoints as constant or a linear direction',()=>{
  const c=config();c.schedule!.parameters[0].value={mode:'list',along:'path',values:[5,9,5,1,5]};
  const value=byKey(read(c).path,'temperature').value;expect(value).toBe('范围 1 °C–9 °C · 按设置变化');expect(value).not.toContain('每步');
 });
 it('describes actual relative propagation and fixed linear profiles differently after a local replacement',()=>{
  const results:string[]=[];
  for(const mode of ['relative','linear'] as const){const c=config();c.schedule!.parameters[0].value=mode==='relative'?{mode,start:10,along:'path',step:1,other_step:0}:{mode,start:10,path_step:1,round_step:0};c.schedule!.overrides=[{id:'middle',rounds:{start:1,end:1},positions:{start:2,end:2},parameters:[setting('replace',{kind:'temperature'},fixed(99))]}];results.push(byKey(read(c).path,'temperature').value);}
  expect(results).toEqual(['10 °C → 102 °C · 按设置变化','范围 10 °C–99 °C · 按设置变化']);
 });
 it('reports a pressure mode change even if every numerical pressure is identical',()=>{
  const c=config(1,3);c.schedule!.parameters[1].value={mode:'water_saturation'};c.schedule!.overrides=[{id:'fixed-middle',rounds:{start:2,end:2},positions:{start:1},parameters:[setting('p2',{kind:'pressure'},fixed(saturationPressure(100)))]}];
  const summary=read(c);expect(summary.path).toEqual([{key:'constant',label:'条件',value:'保持不变'}]);expect(byKey(summary.rounds,'pressure').value).toContain('Psat(T)');expect(byKey(summary.rounds,'pressure').value).toContain('指定 ');
 });
 it('does not display inactive negative route values or call nonconsecutive used positions uniform',()=>{
  const c=config();const r=c.reaction_stages!.first_following[0];r.source='previous_point';r.phase='aqueous';
  c.schedule!.parameters.push(setting('transfer',{kind:'route_fraction',route_id:r.id!,field:'fraction'},{mode:'linear',start:-.25,path_step:.25,round_step:0}));
  const summary=read(c);expect(text(summary.path)).toContain('范围 0 %–75 % · 按设置变化 · 仅使用位置');expect(text(summary.path)).not.toMatch(/[-−]25/);expect(summary.rounds).toEqual([{key:'constant',label:'条件',value:'保持不变'}]);
 });
 it('filters a composition amount by the actual material source, phase, species subset and nonzero portion',()=>{
  for(const filter of ['phase','species','zero','history'] as const){const c=config();c.materials[0].inputs[0].amount=NaN;c.schedule!.overrides=[{id:'initial-only',rounds:{start:1},positions:{start:1,end:1},parameters:[setting('initial-water',{kind:'material_amount',material_id:'initial',species:'H2O'},fixed(1))]}];
   const r=c.reaction_stages!.first_following[0];if(filter==='phase')r.phase='mineral';if(filter==='species'){r.phase='species';r.species=['Calcite'];}if(filter==='zero')r.fraction=0;if(filter==='history')r.source='previous_point';
   const summary=read(c);expect(summary.path).toEqual([{key:'constant',label:'条件',value:'保持不变'}]);expect(text(summary.path)).not.toMatch(/待填写|NaN/);
  }
 });
 it('expands legacy multi-stage bindings and only shows the corresponding active stage',()=>{
  const c=config(3,2);c.schedule!.parameters.push(setting('portions',{kind:'route_fraction',route_id:'first_following',field:'fraction',bindings:[{route_id:'first_following',field:'fraction'},{route_id:'later_following',field:'fraction'}]},{mode:'linear',start:1,path_step:1,round_step:0}));
  const first=read(c).path,later=read(c,0,1).path;expect(first).toHaveLength(1);expect(later).toHaveLength(1);expect(first[0].label).toContain('首轮后续位置');expect(later[0].label).toContain('后续轮其余位置');expect(first[0].value).toBe('未使用 → 2 → 3 份');
 });
 it('keeps tiny actual changes distinguishable and sparse overrides irregular',()=>{
  const c=config(5);c.schedule!.parameters[0].value={mode:'linear',start:1,path_step:1e-12,round_step:0};const value=byKey(read(c).path,'temperature').value;expect(value).toContain('1 °C →');expect(value).toContain('每步 +1e-12 °C');expect(value).toContain('1.000000000004');
  const sparse=config(5);sparse.schedule!.overrides=[{id:'sparse',rounds:{start:1},positions:{start:2,end:4,step:2},parameters:[setting('t2',{kind:'temperature'},fixed(200))]}];expect(byKey(read(sparse).path,'temperature').value).toBe('范围 100 °C–200 °C · 按设置变化');
 });
 it('shares the saturation label and unit in short sequences while retaining every distinct value',()=>{
  const c=config(4,1);c.schedule!.parameters=[setting('t',{kind:'temperature'},{mode:'list',along:'path',values:[250,200,150,100]}),setting('p',{kind:'pressure'},{mode:'water_saturation'})];
  const summary=read(c),pressure=byKey(summary.path,'pressure').value;
  expect(pressure.match(/Psat\(T\)/g)).toHaveLength(1);expect(pressure.match(/bar/g)).toHaveLength(1);expect(pressure.split(' → ')).toHaveLength(4);expect(pressure.startsWith('Psat(T) · ')).toBe(true);expect(pressure.endsWith(' bar')).toBe(true);
  expect(byKey(summary.path,'temperature').value).toBe('250 → 200 → 150 → 100 °C');
  const small=config(3,1);small.schedule!.parameters[0].value={mode:'linear',start:1,path_step:1e-12,round_step:0};expect(byKey(read(small).path,'temperature').value).toBe('1 → 1.000000000001 → 1.000000000002 °C');
 });
 it('does not alter settings or select anything in the result workspace',()=>{
  const c=config(1,1),before=JSON.stringify(c),summary=read(c,999,-1);expect(summary.path).toEqual([{key:'constant',label:'条件',value:'保持不变'}]);expect(summary.rounds).toEqual(summary.path);expect(JSON.stringify(c)).toBe(before);
 });
});


describe('bounded directional reading cache',()=>{
 const tracked=(c:Config)=>{const compiled=compileSchedule(c);return {...compiled,point:vi.fn(compiled.point),valueAt:vi.fn(compiled.valueAt),hasSetting:vi.fn(compiled.hasSetting)};};
 it('reuses the current row while moving across columns, and the current column while changing rows',()=>{
  const c=config(3,2);c.schedule!.parameters[0].value={mode:'linear',start:100,path_step:1,round_step:10};const plan=tracked(c);
  const at=(inner:number,outer:number)=>actualVariationSummaries(c,plan,{inner,outer},items);
  const initial=at(0,0);expect(plan.point).toHaveBeenCalledTimes(10);plan.point.mockClear();
  const same=at(0,0);expect(plan.point).not.toHaveBeenCalled();expect(same.path).toBe(initial.path);expect(same.rounds).toBe(initial.rounds);
  const nextPosition=at(1,0);expect(plan.point).toHaveBeenCalledTimes(4);expect(plan.point.mock.calls.every(([inner])=>inner===1)).toBe(true);expect(nextPosition.path).toBe(initial.path);plan.point.mockClear();
  const nextRound=at(1,1);expect(plan.point).toHaveBeenCalledTimes(6);expect(plan.point.mock.calls.every(([,outer])=>outer===1)).toBe(true);expect(nextRound.rounds).toBe(nextPosition.rounds);plan.point.mockClear();
  expect(at(1,0).path).toBe(initial.path);expect(plan.point).not.toHaveBeenCalled();
 });
 it('refreshes for changed config, plan or species-catalog identities while preserving the old identity cache',()=>{
  const c=config(3,2);for(const key of stageKeys)c.reaction_stages![key][0].phase='aqueous';c.schedule!.parameters.push(setting('water',{kind:'material_amount',material_id:'initial',species:'H2O'},{mode:'linear',start:1,path_step:1,round_step:1}));
  const plan=tracked(c),selection={inner:0,outer:0},first=actualVariationSummaries(c,plan,selection,items);expect(first.path[0].label).toContain('H2O');plan.point.mockClear();
  const sameCatalog=[...items],copied=actualVariationSummaries(c,plan,selection,sameCatalog);expect(plan.point).toHaveBeenCalled();expect(copied).toEqual(first);expect(copied.path).not.toBe(first.path);plan.point.mockClear();
  const changedCatalog=[{...water,phase:'gas' as const},mineral],filtered=actualVariationSummaries(c,plan,selection,changedCatalog);expect(filtered.path).toEqual([{key:'constant',label:'条件',value:'保持不变'}]);expect(plan.point).toHaveBeenCalled();plan.point.mockClear();
  expect(actualVariationSummaries(c,plan,selection,items).path).toBe(first.path);expect(plan.point).not.toHaveBeenCalled();
  const nextPlan={...plan},sameData=actualVariationSummaries(c,nextPlan,selection,items);expect(plan.point).toHaveBeenCalled();expect(sameData).toEqual(first);expect(sameData.path).not.toBe(first.path);plan.point.mockClear();
  const nextConfig=structuredClone(c),newConfigRead=actualVariationSummaries(nextConfig,plan,selection,items);expect(plan.point).toHaveBeenCalled();expect(newConfigRead).toEqual(first);plan.point.mockClear();
  nextConfig.schedule!.parameters[0].value={mode:'linear',start:200,path_step:10,round_step:0};const changed=actualVariationSummaries(nextConfig,tracked(nextConfig),selection,items);expect(byKey(changed.path,'temperature').value).toBe('200 → 210 → 220 °C');
  const noCatalog=actualVariationSummaries(c,plan,selection);expect(noCatalog).toEqual(first);expect(noCatalog.path).not.toBe(first.path);
 });
 it('keeps at most sixteen coordinates per direction and refreshes least-recently-used entries only',()=>{
  const c=config(20,20);c.schedule!.parameters[0].value={mode:'linear',start:100,path_step:1,round_step:20};const plan=tracked(c),at=(n:number)=>actualVariationSummaries(c,plan,{inner:n,outer:n},items);
  const zero=at(0),one=at(1);for(let n=2;n<16;n++)at(n);plan.point.mockClear();
  expect(at(0).path).toBe(zero.path);expect(plan.point).not.toHaveBeenCalled();at(16);plan.point.mockClear();
  const retained=at(0);expect(retained.path).toBe(zero.path);expect(retained.rounds).toBe(zero.rounds);expect(plan.point).not.toHaveBeenCalled();
  const evicted=at(1);expect(plan.point).toHaveBeenCalledTimes(80);expect(evicted).toEqual(one);expect(evicted.path).not.toBe(one.path);expect(evicted.rounds).not.toBe(one.rounds);
 });
});
