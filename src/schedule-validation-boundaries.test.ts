import {describe,it,expect} from 'vitest';
import {DEFAULT_CONFIG,type Config,type EquilibriumConstraint} from './simulation-types';
import {compileSchedule,defaultSchedule,scheduleDiagnostic} from './simulation-schedule';
const base=():Config=>({...structuredClone(DEFAULT_CONFIG),schedule:defaultSchedule()});
const ph=(id='acid'):Extract<EquilibriumConstraint,{kind:'ph'}>=>({id,kind:'ph',value:7,titrant:'',exchange:'add_only',positions:{start:3}});
describe('targets follow the actual end conditions',()=>{
 it('checks a newly active position and newly active round before a run',()=>{
  const c=base();c.schedule!.stop={first:'i = 2',later:'i = 2',rounds:'N = 1'};c.equilibrium_constraints=[{...ph(),rounds:{start:2}}];
  expect(scheduleDiagnostic(c)?.location).toEqual({kind:'constraint',constraintId:'acid',field:'titrant'});
  c.equilibrium_constraints[0]={...ph(),titrant:'HCl',rounds:{start:2}};
  expect(compileSchedule(c).counts).toEqual({inner:3,outer:2,total:6});
 });
 it('does not block a path shortened before an unfinished target',()=>{
  const c=base();c.schedule!.positions=3;c.schedule!.stop={first:'i = 0'};c.equilibrium_constraints=[ph()];
  const before=structuredClone(c);expect(compileSchedule(c).lengths).toEqual([1]);expect(c).toEqual(before);
 });
 it('keeps unfinished targets outside the active part of a ragged grid',()=>{
  const c=base();c.schedule!.stop={first:'i = 2',later:'i = 0',rounds:'N = 1'};
  c.equilibrium_constraints=[{...ph(),rounds:{start:2}}, {id:'gas',kind:'fugacity',value:1,species:'',rounds:{start:2},positions:{start:2}}];
  expect(compileSchedule(c).lengths).toEqual([3,1]);
  c.schedule={...c.schedule!,stop:{...c.schedule!.stop,later:'i = 2'}};
  expect(scheduleDiagnostic(c)?.location).toMatchObject({constraintId:'acid',field:'titrant'});
 });
 it('detects new overlaps but ignores overlaps outside actual points',()=>{
  const c=base();c.schedule!.stop={first:'i = 0',later:'i = 2',rounds:'N = 1'};
  c.equilibrium_constraints=[{...ph('a'),titrant:'HCl',rounds:{start:1,end:1}},{...ph('b'),titrant:'NaOH',rounds:{start:1,end:1}}];
  expect(compileSchedule(c).counts.total).toBe(4);
  c.schedule={...c.schedule!,stop:{...c.schedule!.stop,first:'i = 2'}};
  expect(scheduleDiagnostic(c)?.location).toMatchObject({constraintId:'b',field:'rounds'});
 });
 it('honors round intervals rather than the bounding rectangle',()=>{
  const c=base();c.schedule!.stop={first:'i = 0',later:'i = N',rounds:'N = 2'};
  c.equilibrium_constraints=[{...ph(),positions:{start:2},rounds:{start:1,end:2,step:2}}];
  expect(compileSchedule(c).lengths).toEqual([1,2,3]);
 });
});
