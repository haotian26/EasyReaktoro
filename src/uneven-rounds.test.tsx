// @vitest-environment jsdom
import {cleanup,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG,type Config,type ReactionStageKey,type SimSpecies,makeRoute} from './simulation-types';
import {compileSchedule,defaultSchedule,scheduleDiagnostic} from './simulation-schedule';
import {firstStagePoint,stageKeys} from './reaction-stages';
import {setupSteps} from './simulation-guidance';
import {SimulationConditions} from './SimulationConditions';
const water:SimSpecies={name:'water',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null};
const db={handle_id:'test',kind:'rtdb',dirty:false};
function config(first=1,later=3):Config{
 const c=structuredClone(DEFAULT_CONFIG);c.species=['water'];c.activity_model='ideal';
 c.materials=['used','unused'].map(id=>({id,name:id,inputs:[{species:'water',amount:1,unit:'kg'}]}));
 c.reaction_stages=Object.fromEntries(stageKeys.map(key=>[key,[{...makeRoute('all','material','used'),id:key,when:'always'}]])) as Config['reaction_stages'];
 c.schedule={...defaultSchedule(),stop:{first:`i = ${first-1}`,later:`i = ${later-1}`,rounds:'N = 1'}};return c;
}
afterEach(cleanup);
it.each([[1,3,'first_following'],[3,1,'later_following']] as [number,number,ReactionStageKey][])('uses actual round lengths %s / %s for empty stages, sources and material counts', (first,later,unused)=>{
 const c=config(first,later);c.reaction_stages![unused]=[];
 expect(compileSchedule(c).lengths).toEqual([first,later]);expect(setupSteps(c,[water],db)[2].issue).toBeUndefined();
 c.reaction_stages![unused]=[{...makeRoute('all','material','unused'),id:unused}];
 expect(setupSteps(c,[water],db)[1].detail).toBe('1 / 2 份 composition 实际投料');
 c.reaction_stages![unused][0].material_id='missing';expect(scheduleDiagnostic(c)).toBeUndefined();
 const extended={...c,schedule:{...c.schedule!,stop:{first:'i = 2',later:'i = 2',rounds:'N = 1'}}};
 expect(scheduleDiagnostic(extended)?.message).toContain('Composition 已不存在');expect(c.reaction_stages![unused][0].material_id).toBe('missing');
});
it('locates a later stage at the first round that actually reaches it',()=>{
 const c=config();c.schedule!.stop={first:'i = 0',later:'i = N - 1',rounds:'N = 2'};const plan=compileSchedule(c);
 expect(plan.lengths).toEqual([1,1,2]);expect(firstStagePoint('later_following',plan.counts,plan.lengths)).toEqual([1,2]);
 c.reaction_stages!.later_following[0].material_id='missing';expect(scheduleDiagnostic(c)?.location).toMatchObject({inner:1,outer:2});
});
it('marks unused compositions as retained and previews a later stage at its actual first point',()=>{
 const c=config();c.schedule!.stop={first:'i = 0',later:'i = N - 1',rounds:'N = 2'};
 c.schedule!.parameters.push({id:'dose',target:{kind:'material_amount',material_id:'used',species:'water'},value:{mode:'expression',expression:'N + 1'}});
 render(<SimulationConditions config={c} items={[water]} patch={vi.fn()} disabled={false} onError={vi.fn()}/>);
 const unused=within(screen.getByRole('region',{name:'first_following'})),later=within(screen.getByRole('region',{name:'later_following'}));
 expect(unused.getByText('本次不经过此阶段，设置保留。')).toBeTruthy();expect(unused.queryByText(/实际加入/)).toBeNull();
 expect(later.getByText('实际加入：water 3 kg')).toBeTruthy();
});

it('retains unfinished amount profiles belonging only to an unused stage',()=>{
 for(const value of [{mode:'expression',expression:''},{mode:'list',along:'path',values:[]},{mode:'relative',along:'path',start:NaN,step:NaN,other_step:0}] as const){
  const c=config();c.schedule!.parameters.push({id:'unused-dose',target:{kind:'route_fraction',route_id:'first_following',field:'fraction'},value:structuredClone(value) as any});
  expect(compileSchedule(c).lengths).toEqual([1,3]);
  const extended={...c,schedule:{...c.schedule!,stop:{first:'i = 2',later:'i = 2',rounds:'N = 1'}}};expect(()=>compileSchedule(extended)).toThrow();
 }
});
