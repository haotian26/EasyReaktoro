import {describe,expect,it} from 'vitest';
import {Config,DEFAULT_CONFIG} from './simulation-types';
import {compileSchedule,defaultSchedule,scheduleIssue,type ParameterProfile,type Schedule,type ScheduleOverride} from './simulation-schedule';
import {isolateSchedulePoint} from './schedule-point-edit';
import {targetDescription} from './simulation-loops';
const makeConfig=(schedule:Schedule):Config=>({...structuredClone(DEFAULT_CONFIG),species:['salt'],materials:[{id:'initial',name:'盐水',inputs:[{species:'salt',amount:1,unit:'mol'}]}],schedule});
const grid=(schedule:Schedule)=>{const plan=compileSchedule(makeConfig(schedule));return Array.from({length:schedule.rounds},(_,oi)=>Array.from({length:schedule.positions},(_,ii)=>plan.point(ii,oi).temperature_c));};
const base=():Schedule=>({...defaultSchedule(),positions:7,rounds:5});
const group=(value:ParameterProfile,extra:Partial<ScheduleOverride>={}):ScheduleOverride=>({id:'local',name:'反应条件',positions:{start:2,step:2},rounds:{start:1,step:2},parameters:[{id:'local-temperature',target:{kind:'temperature'},value}],...extra});

describe('editing one point without altering its surrounding conditions',()=>{
 it.each<ParameterProfile>([
  {mode:'fixed',value:80},
  {mode:'linear',start:10,path_step:2,round_step:3},
  {mode:'list',along:'path',values:[10,20,30,40,50,60]},
  {mode:'list',along:'round',values:[10,20,30,40,50,60]},
  {mode:'relative',along:'path',start:30,step:2,other_step:10},
  {mode:'relative',along:'round',start:30,step:2,other_step:10},
 ])('keeps $mode $along values and open-ended stepped scopes after splitting',value=>{
  const schedule={...base(),overrides:[group(value)]},snapshot=structuredClone(schedule),next=isolateSchedulePoint(schedule,3,2);
  expect(grid(next.schedule)).toEqual(grid(schedule));expect(schedule).toEqual(snapshot);
  expect(grid({...next.schedule,positions:11,rounds:9})).toEqual(grid({...schedule,positions:11,rounds:9}));
  const point=next.schedule.overrides.find(row=>row.id===next.id)!;expect(point.positions).toEqual({start:4,end:4});expect(point.rounds).toEqual({start:3,end:3});
 });
 it('preserves finite future ends, unused list entries, and non-selected cells',()=>{
  const schedule={...base(),overrides:[group({mode:'list',along:'path',values:[10,20,30,40,50,60,70]},{positions:{start:2,end:12,step:2},rounds:{start:1,end:9,step:2}})]};
  const next=isolateSchedulePoint(schedule,3,2).schedule;
  expect(grid({...next,positions:14,rounds:11})).toEqual(grid({...schedule,positions:14,rounds:11}));
  expect(next.overrides.filter(o=>o.positions.end!==undefined).every(o=>o.positions.end!<=12)).toBe(true);
 });
 it('preserves disjoint parameter scopes when both pass through the selected point',()=>{
  const temperature=group({mode:'linear',start:10,path_step:3,round_step:20});
  const pressure:ScheduleOverride={id:'pressure-scope',positions:{start:1},rounds:{start:2},parameters:[{id:'local-pressure',target:{kind:'pressure'},value:{mode:'list',along:'path',values:[100,200,300,400,500,600,700,800,900,1000,1100]}}]};
  const schedule={...base(),overrides:[temperature,pressure]},next=isolateSchedulePoint(schedule,3,2),before=compileSchedule(makeConfig(schedule)),after=compileSchedule(makeConfig(next.schedule));
  for(let oi=0;oi<5;oi++)for(let ii=0;ii<7;ii++)expect(after.point(ii,oi)).toEqual(before.point(ii,oi));
  expect(next.schedule.overrides.find(row=>row.id===next.id)!.parameters.map(p=>p.target.kind)).toEqual(['temperature','pressure']);
 });
 it('reuses an existing isolated point and retains an unmatched named range unchanged',()=>{
  const exact=group({mode:'fixed',value:123},{positions:{start:4,end:4},rounds:{start:3,end:3}}),elsewhere=group({mode:'fixed',value:99},{id:'unrelated',name:'保留说明',positions:{start:6},rounds:{start:1},parameters:[{id:'other-t',target:{kind:'temperature'},value:{mode:'fixed',value:99}}]});
  const schedule={...base(),overrides:[exact,elsewhere]},next=isolateSchedulePoint(schedule,3,2);
  expect(next.schedule).toBe(schedule);expect(next.id).toBe(exact.id);
 });
 it('lets an edited point propagate through relative continuation but not through a linear sequence',()=>{
  for(const value of [{mode:'relative',along:'path',start:10,step:2,other_step:0},{mode:'linear',start:10,path_step:2,round_step:0}] as ParameterProfile[]){
   const schedule={...base(),positions:5,rounds:1,overrides:[group(value,{positions:{start:1},rounds:{start:1}})]},isolated=isolateSchedulePoint(schedule,1,0);
   const edited={...isolated.schedule,overrides:isolated.schedule.overrides.map(row=>row.id===isolated.id?{...row,parameters:row.parameters.map(p=>({...p,value:{mode:'fixed' as const,value:100}}))}:row)};
   expect(grid(edited)[0]).toEqual(value.mode==='relative'?[10,100,102,104,106]:[10,100,14,16,18]);
  }
 });
 it('does not create a spurious negative quantity by shifting a decimal linear profile',()=>{
  const target={kind:'material_amount' as const,material_id:'initial',species:'salt'};
  const schedule={...base(),positions:4,rounds:1,overrides:[group({mode:'fixed',value:1},{positions:{start:1},rounds:{start:1},parameters:[{id:'salt-amount',target,value:{mode:'linear',start:.3,path_step:-.1,round_step:0}}]})]};
  const before=compileSchedule(makeConfig(schedule)),next=isolateSchedulePoint(schedule,1,0).schedule;
  expect(scheduleIssue(makeConfig(next))).toBeUndefined();const after=compileSchedule(makeConfig(next));
  expect(Array.from({length:4},(_,ii)=>after.valueAt(target,ii,0))).toEqual(Array.from({length:4},(_,ii)=>before.valueAt(target,ii,0)));
 });
 it('names the composition input as the amount in one portion',()=>{
  expect(targetDescription({kind:'material_amount',material_id:'initial',species:'salt'},makeConfig(base()))).toMatchObject({label:'盐水 · salt 每份含量',unit:'mol',value:1});
 });
});
