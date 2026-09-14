// @vitest-environment jsdom
import React,{useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {DEFAULT_CONFIG,type Config} from './simulation-types';
import {compileSchedule,defaultSchedule,type Schedule} from './simulation-schedule';
import {ScheduleEditor,generatedProfile} from './ScheduleEditor';
import {SimulationConditions} from './SimulationConditions';
afterEach(cleanup);
function base():Config{return {...structuredClone(DEFAULT_CONFIG),schedule:{...defaultSchedule(),positions:4,rounds:3}};}
it('bulk generation preserves the independently configured round change',()=>{
 const initial=base();initial.schedule!.parameters[0].value={mode:'linear',start:250,path_step:-10,round_step:25};
 function Harness(){const [config,setConfig]=useState(initial);return <><ScheduleEditor config={config} schedule={config.schedule!} onChange={schedule=>setConfig({...config,schedule})}/><output>{JSON.stringify(config)}</output></>;}
 render(<Harness/>);const row=screen.getByLabelText('温度 变化方式').closest('article')!;
 fireEvent.click(within(row).getByRole('button',{name:'按起止值批量生成'}));fireEvent.change(screen.getByLabelText('温度 批量结束值'),{target:{value:'240'}});fireEvent.change(screen.getByLabelText('温度 批量增减'),{target:{value:'-5'}});fireEvent.click(screen.getByRole('button',{name:'应用并设为 3 步'}));
 const config=JSON.parse(document.querySelector('output')!.textContent!) as Config;const plan=compileSchedule(config);
 expect(config.schedule).toMatchObject({positions:3,rounds:3});expect([0,1,2].map(i=>plan.point(i,1).temperature_c)).toEqual([275,270,265]);
});
it('changing round starts preserves actual previous-point recurrence',()=>{
 expect(generatedProfile({mode:'relative',along:'path',start:250,step:-5,other_step:0},'round',[250,275,300],25)).toEqual({mode:'relative',along:'path',start:250,step:-5,other_step:25});
});
it('does not silently replace a nonuniform path list with a round list',()=>{
 const c=base();c.schedule!.parameters[0].value={mode:'list',along:'path',values:[250,220,180,100]};render(<ScheduleEditor config={c} schedule={c.schedule!} onChange={vi.fn()}/>);
 fireEvent.click(within(screen.getByLabelText('温度 变化方式').closest('article')!).getByRole('button',{name:'按起止值批量生成'}));fireEvent.change(screen.getByLabelText('温度 批量方向'),{target:{value:'round'}});
 expect(screen.getByText(/避免替换已填的数列/)).toBeTruthy();expect((screen.getByRole('button',{name:/应用并设为/}) as HTMLButtonElement).disabled).toBe(true);
});
it('new local settings apply to the point being inspected',()=>{
 const c=base();let result:Schedule|undefined;render(<ScheduleEditor config={c} schedule={c.schedule!} coordinate={{inner:2,outer:1}} onChange={s=>{result=s;}}/>);fireEvent.click(screen.getByRole('button',{name:'添加单独设置'}));expect(result!.overrides[0]).toMatchObject({positions:{start:3,end:3},rounds:{start:2,end:2}});
});
it('reopens a collapsed existing point adjustment on a repeated request',()=>{
 Element.prototype.scrollIntoView=vi.fn();const c=base();c.schedule!.overrides=[{id:'local',rounds:{start:1,end:1},positions:{start:1,end:1},parameters:[]}];
 const {rerender}=render(<ScheduleEditor config={c} schedule={c.schedule!} onChange={vi.fn()} highlightId="local" highlightSerial={1}/>);
 const details=document.getElementById('schedule-local') as HTMLDetailsElement;expect(details.open).toBe(true);fireEvent.click(details.querySelector('summary')!);expect(details.open).toBe(false);
 rerender(<ScheduleEditor config={c} schedule={c.schedule!} onChange={vi.fn()} highlightId="local" highlightSerial={2}/>);expect(details.open).toBe(true);
});
it('exposes the actual local condition in the table and opens that exact point',async()=>{
 const {SchedulePreview}=await import('./SchedulePreview');const config=base();config.schedule!.overrides=[{id:'local',rounds:{start:2,end:2},positions:{start:3,end:3},parameters:[{id:'local-t',target:{kind:'temperature'},value:{mode:'fixed',value:123}}]}];const onAdjust=vi.fn();
 render(<SchedulePreview config={config} items={[]} selected={{inner:2,outer:1}} onSelect={vi.fn()} onAdjust={onAdjust}/>);fireEvent.click(screen.getByRole('tab',{name:'逐点条件表'}));
 const row=screen.getByRole('button',{name:'查看第 2 轮位置 3'}).closest('tr')!;expect(row.textContent).toContain('123');expect(row.classList.contains('selected')).toBe(true);fireEvent.click(within(row).getByRole('button',{name:'调整第 2 轮位置 3'}));expect(onAdjust).toHaveBeenCalledWith(2,1);
});

it('does not present an unused source quantity as actual input at later positions',async()=>{
 const {SchedulePreview}=await import('./SchedulePreview');const {toStageConfig}=await import('./reaction-stages');const config=toStageConfig(base());const route=config.reaction_stages!.first_start[0];config.schedule!.parameters.push({id:'start-only',target:{kind:'route_fraction',route_id:route.id!,field:'fraction'},value:{mode:'linear',start:1,path_step:-1,round_step:0}});
 render(<SchedulePreview config={config} items={[]} selected={{inner:0,outer:0}} onSelect={vi.fn()} onAdjust={vi.fn()}/>);fireEvent.click(screen.getByRole('tab',{name:'逐点条件表'}));fireEvent.change(screen.getByLabelText('条件表附加参数'),{target:{value:JSON.stringify(['route_fraction',route.id,'fraction'])}});
 const row=screen.getByRole('button',{name:'查看第 1 轮位置 3'}).closest('tr')!;expect(within(row).getByLabelText('此处不取用该来源')).toBeTruthy();expect(row.textContent).not.toContain('-1');
});
