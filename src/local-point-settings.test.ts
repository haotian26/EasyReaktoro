import {describe,it,expect} from 'vitest';
import {DEFAULT_CONFIG,type Config} from './simulation-types';
import {compileSchedule,defaultSchedule,type Schedule} from './simulation-schedule';
import {setStageCondition} from './reaction-stage-conditions';
import {pointSetting,setPointSetting,resetPointSetting} from './local-point-settings';
import {readConfig} from './simulation-types';

const config=(schedule:Schedule):Config=>({...structuredClone(DEFAULT_CONFIG),schedule});
const base=()=>setStageCondition({...defaultSchedule(),positions:3,rounds:2},'first_following',{kind:'temperature'},{mode:'expression',expression:'T-20'});
const temperatures=(s:Schedule)=>{const p=compileSchedule(config(s));return [0,1,2].map(i=>p.point(i,0).temperature_c);};
describe('a local point inherits its live parent rule',()=>{
 it('restores a changed stage rule without splitting ranges or changing other targets',()=>{
  let s=base();const stage=s.overrides[0];s=setPointSetting(s,{kind:'temperature'},1,0,{mode:'fixed',value:100});
  expect(s.overrides[0]).toBe(stage);expect(temperatures(s)).toEqual([250,100,80]);
  s=setStageCondition(s,'first_following',{kind:'temperature'},{mode:'expression',expression:'T-10'});
  expect(temperatures(s)).toEqual([250,100,90]);
  const local=pointSetting(s,{kind:'temperature'},1,0).scope!;
  s=resetPointSetting(s,local.id,{kind:'temperature'});
  expect(temperatures(s)).toEqual([250,240,230]);expect(s.overrides).toHaveLength(1);
 });
 it('keeps Psat linked to temperature before and after a pressure reset',()=>{
  let s=setStageCondition(base(),'first_following',{kind:'pressure'},{mode:'water_saturation'});
  s=setPointSetting(s,{kind:'temperature'},1,0,{mode:'fixed',value:100});
  const saturation=compileSchedule(config(s)).point(1,0);
  s=setPointSetting(s,{kind:'pressure'},1,0,{mode:'fixed',value:700});
  expect(compileSchedule(config(s)).point(1,0).pressure_bar).toBe(700);
  s=resetPointSetting(s,pointSetting(s,{kind:'pressure'},1,0).scope!.id,{kind:'pressure'});
  expect(compileSchedule(config(s)).point(1,0)).toEqual(saturation);
  expect(s.overrides.find(o=>o.point)?.parameters.map(p=>p.target.kind)).toEqual(['temperature']);
 });
 it('edits and restores one material input without deleting a shared rule for another',()=>{
  const a={route_id:'fluid',field:'fraction' as const},b={route_id:'rock',field:'fraction' as const};
  let s=setPointSetting(base(),{kind:'route_fraction',...a,bindings:[a,b]},1,0,{mode:'fixed',value:0.5});
  s=setPointSetting(s,{kind:'route_fraction',...a},1,0,{mode:'fixed',value:0.2});
  expect(pointSetting(s,{kind:'route_fraction',...a},1,0).setting?.value).toEqual({mode:'fixed',value:0.2});
  expect(pointSetting(s,{kind:'route_fraction',...b},1,0).setting?.value).toEqual({mode:'fixed',value:0.5});
  const local=pointSetting(s,{kind:'route_fraction',...a},1,0).scope!;
  s=resetPointSetting(s,local.id,{kind:'route_fraction',...a});
  expect(s.overrides.find(o=>o.point)?.parameters).toHaveLength(1);
  expect(pointSetting(s,{kind:'route_fraction',...b},1,0).setting?.value).toEqual({mode:'fixed',value:0.5});
 });
 it('retains point semantics through saved settings and rejects ambiguous overlaps',()=>{
  const s=setPointSetting(base(),{kind:'temperature'},1,0,{mode:'fixed',value:100});
  const loaded=readConfig(JSON.parse(JSON.stringify(config(s))));expect(temperatures(loaded.schedule!)).toEqual([250,100,80]);
  const local=s.overrides.find(o=>o.point)!;
  const duplicate={...local,id:'duplicate',parameters:local.parameters.map(p=>({...p,id:'duplicate-value'}))};
  expect(()=>compileSchedule(config({...s,overrides:[...s.overrides,duplicate]}))).toThrow(/重复修改/);
  expect(()=>compileSchedule(config({...s,overrides:[{...local,positions:{start:1,end:2}}]}))).toThrow();
 });
});
