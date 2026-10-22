// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SimulationConditions} from './SimulationConditions';
import {SchedulePreview} from './SchedulePreview';
import {DEFAULT_CONFIG,readConfig,type Config} from './simulation-types';
import {defaultSchedule,compileSchedule} from './simulation-schedule';
import {setPointSetting} from './local-point-settings';
import {constraintPointCount} from './equilibrium-constraints';
import {toStageConfig} from './reaction-stages';
import {setLanguage} from './i18n';
afterEach(()=>{cleanup();setLanguage('zh-CN');});
const base=(positions=5,rounds=3):Config=>toStageConfig({...structuredClone(DEFAULT_CONFIG),schedule:{...defaultSchedule(),positions,rounds,stop:{first:`i = ${positions-1}`,later:`i = ${positions-1}`,rounds:`N = ${rounds-1}`}}});
it.each([[1,1],[5,3]])('lists first-point overrides in a %s by %s flow and navigates to them', (positions,rounds)=>{
 setLanguage('en');const c=base(positions,rounds),select=vi.fn();c.schedule=setPointSetting(c.schedule!,{kind:'temperature'},0,0,{mode:'fixed',value:100});
 render(<SchedulePreview config={c} items={[]} selected={{inner:0,outer:0}} onSelect={select} onAdjust={()=>{}}/>);
 expect(screen.getByText('1 set of local conditions')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/Round 1 · Position 1 Temperature: 100/}));expect(select).toHaveBeenCalledWith(0,0);
 if(positions>4)expect(screen.getByRole('button',{name:'Hide nearby steps'}).getAttribute('aria-expanded')).toBe('true');
 expect(compileSchedule(c).point(0,0).temperature_c).toBe(100);
});
it('retains and identifies local edits beyond the end condition, then reactivates them after extending the path',()=>{
 setLanguage('en');const c=base();c.schedule=setPointSetting(c.schedule!,{kind:'temperature'},7,0,{mode:'fixed',value:90});
 const restored=readConfig(JSON.parse(JSON.stringify(c)));const props={items:[],selected:{inner:0,outer:0},onSelect:vi.fn(),onAdjust:()=>{}};
 const view=render(<SchedulePreview {...props} config={restored}/>);expect(screen.getByText('Not applied in this run · condition retained')).toBeTruthy();
 const extended={...restored,schedule:{...restored.schedule!,stop:{...restored.schedule!.stop,first:'i = 7'}}};
 view.rerender(<SchedulePreview {...props} config={extended}/>);
 expect(screen.queryByText('Not applied in this run · condition retained')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/Round 1 · Position 8 Temperature: 90/}));expect(props.onSelect).toHaveBeenCalledWith(7,0);
 expect(compileSchedule(extended).point(7,0).temperature_c).toBe(90);
});
it('describes a retained open-ended range without reversing its bounds',()=>{
 setLanguage('en');const c=base();
 c.schedule!.overrides.push({id:'future',positions:{start:8},rounds:{start:1,end:1},parameters:[{id:'future-t',target:{kind:'temperature'},value:{mode:'fixed',value:90}}]});
 render(<SchedulePreview config={c} items={[]} selected={{inner:0,outer:0}} onSelect={()=>{}} onAdjust={()=>{}}/>);
 expect(screen.getByText('Round 1 · Positions 8 onward')).toBeTruthy();
 expect(screen.getByText('Not applied in this run · condition retained')).toBeTruthy();
});
it('counts actual points in uneven rounds, respecting both scope intervals',()=>{
 expect(constraintPointCount({rounds:{start:1,end:4,step:2},positions:{start:2,end:5,step:2}},[5,1,3,7])).toBe(3);
 expect(constraintPointCount({rounds:{start:2},positions:{start:3}},[5,1])).toBe(0);
 expect(constraintPointCount({positions:{start:NaN}},[5])).toBeUndefined();
 expect(constraintPointCount({},undefined)).toBeUndefined();
});
it('updates coverage after an end-condition edit and translates it without changing the draft',()=>{
 setLanguage('en');const c=base(3,2);c.schedule!.stop!.later='i = 0';c.equilibrium_constraints=[{id:'acid',kind:'ph',value:7,titrant:'HCl',exchange:'add_only',rounds:{start:2},positions:{start:2}}];
 let current=c;
 function Harness(){const [config,setConfig]=useState(c);current=config;return <SimulationConditions config={config} patch={patch=>setConfig(old=>({...old,...patch}))} items={[]} disabled={false} onError={()=>{}}/>;}
 render(<Harness/>);expect(screen.getByText('Not applied in this run · condition retained')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('later end condition'),{target:{value:'i = 2'}});
 expect(screen.getByText('Applies to 2 reaction points')).toBeTruthy();const before=JSON.stringify(current);
 act(()=>setLanguage('zh-CN'));expect(screen.getByText('作用于 2 个反应点')).toBeTruthy();expect(JSON.stringify(current)).toBe(before);
 fireEvent.change(screen.getByLabelText('later 结束条件'),{target:{value:'i ='}});
 expect(screen.getByText('补全反应条件后显示生效范围')).toBeTruthy();expect(screen.queryByText('本次不生效 · 条件已保留')).toBeNull();
});
it('offers generated output positions without materializing a duplicate point table',()=>{
 setLanguage('en');const c=base();const patch=vi.fn();render(<SimulationConditions config={c} patch={patch} items={[]} disabled={false} onError={()=>{}}/>);
 fireEvent.change(screen.getByLabelText('later_start Material 1 source'),{target:{value:'output'}});
 expect(patch.mock.calls.at(-1)![0].reaction_stages.later_start[0].point_id).toBe('loop-1');
 const next={...c,...patch.mock.calls.at(-1)![0]};cleanup();
 render(<SimulationConditions config={next} patch={patch} items={[]} disabled={false} onError={()=>{}}/>);
 expect(within(screen.getByLabelText('later_start Material 1 source position')).getAllByRole('option')).toHaveLength(5);
 expect(c.points).toHaveLength(1);expect(compileSchedule(next).counts.inner).toBe(5);
});
it('rejects a generated source in a missing part of a previous round even with a sparse saved point table',()=>{
 const c=base(3,2);c.schedule!.stop={first:'i = 0',later:'i = 2',rounds:'N = 1'};
 c.reaction_stages!.later_start[0]={...c.reaction_stages!.later_start[0],source:'output',point_id:'loop-3',lag:1};
 expect(()=>compileSchedule(c)).toThrow('物料来源在该位置之前已结束');
});

it('keeps run indices correct across ten thousand short rounds',()=>{
 const c=base(1,10000),p=compileSchedule(c);
 expect(p.counts).toEqual({inner:1,outer:10000,total:10000});
 expect(p.runIndex(0,9999)).toBe(9999);expect(p.point(0,9999).temperature_c).toBe(250);
 expect(compileSchedule(c)).toBe(p);
});
