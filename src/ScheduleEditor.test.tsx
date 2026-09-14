// @vitest-environment jsdom
import React,{useState} from 'react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {DEFAULT_CONFIG,type Config} from './simulation-types';
import {ScheduleEditor,ScheduleSize} from './ScheduleEditor';
import {compileSchedule,defaultSchedule,type Schedule} from './simulation-schedule';
import {SimulationConditions} from './SimulationConditions';
afterEach(cleanup);
function initial():Config{return {...structuredClone(DEFAULT_CONFIG),species:['H2O'],materials:[{id:'initial',name:'Water',inputs:[{species:'H2O',amount:1,unit:'kg'}]}],schedule:{...defaultSchedule(),positions:100,rounds:3}};}
function Harness(){const [config,setConfig]=useState(initial());const update=(schedule:Schedule)=>setConfig(c=>({...c,schedule}));return <><ScheduleSize schedule={config.schedule!} onChange={update}/><ScheduleEditor config={config} schedule={config.schedule!} onChange={update}/><output data-testid="config">{JSON.stringify(config)}</output></>;}
const current=()=>JSON.parse(screen.getByTestId('config').textContent!);
describe('schedule editing as a single model',()=>{
 it('changes several parameter methods without changing the grid size',()=>{render(<Harness/>);fireEvent.change(screen.getByLabelText('温度 变化方式'),{target:{value:'linear'}});fireEvent.change(screen.getByLabelText('温度 每步变化'),{target:{value:'-2'}});fireEvent.change(screen.getByLabelText('压力 变化方式'),{target:{value:'relative-path'}});fireEvent.change(screen.getByLabelText('压力 比前一步增减'),{target:{value:'-5'}});expect(current().schedule).toMatchObject({positions:100,rounds:3});expect(current().schedule.parameters.map((p:any)=>p.value.mode)).toEqual(['linear','relative']);});
 it('generates a hundred-point path in one atomic configuration change',()=>{render(<Harness/>);const pressure=screen.getByLabelText('压力 变化方式').closest('article')!;fireEvent.click(within(pressure).getByRole('button',{name:'按起止值批量生成'}));fireEvent.change(screen.getByLabelText('压力 批量结束值'),{target:{value:'150'}});fireEvent.change(screen.getByLabelText('压力 批量增减'),{target:{value:'-5'}});fireEvent.click(screen.getByRole('button',{name:'应用并设为 111 步'}));const c=current();expect(c.schedule.positions).toBe(111);expect(c.schedule.rounds).toBe(3);expect(compileSchedule(c).point(110,0).pressure_bar).toBe(150);});
 it('offers temperature, pressure, species amount and reaction amount in the same local editor',()=>{render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'添加单独设置'}));const selector=screen.getByLabelText('选择要单独修改的参数');expect(within(selector).getAllByRole('option').map(o=>o.textContent).join(' ')).toMatch(/温度.*压力.*H2O.*份数/);fireEvent.change(selector,{target:{value:'temperature'}});expect(current().schedule.overrides[0].parameters[0].target).toEqual({kind:'temperature'});expect(screen.queryByText('按轮次单独设置压力')).toBeNull();});
 it('displays output fractions as percent including increments',()=>{const c=initial();c.routes[0].source='previous_point';c.schedule!.parameters.push({id:'f',target:{kind:'route_fraction',route_id:c.routes[0].id!,field:'fraction'},value:{mode:'linear',start:.5,path_step:.1,round_step:0}});render(<ScheduleEditor config={c} schedule={c.schedule!} onChange={vi.fn()}/>);expect(screen.getAllByDisplayValue('50').length).toBeGreaterThan(0);expect(screen.getAllByDisplayValue('10').length).toBeGreaterThan(0);expect(screen.getAllByText('百分点').length).toBe(2);});
 it('selects the exact preview coordinate for a local adjustment',()=>{Element.prototype.scrollIntoView=vi.fn();const c=initial();c.schedule!.positions=4;c.schedule!.rounds=3;function Whole(){const [config,setConfig]=useState(c);return <><SimulationConditions config={config} patch={p=>setConfig(c=>({...c,...p}))} items={[]} disabled={false} onError={vi.fn()}/><output data-testid="config">{JSON.stringify(config)}</output></>;}render(<Whole/>);fireEvent.change(screen.getByLabelText('预览路径位置'),{target:{value:'3'}});fireEvent.change(screen.getByLabelText('预览反应轮次'),{target:{value:'2'}});fireEvent.click(screen.getByRole('button',{name:'单独调整此处'}));expect(current().schedule.overrides[0]).toMatchObject({positions:{start:3,end:3},rounds:{start:2,end:2}});expect(screen.getByLabelText('选择要单独修改的参数')).toBeTruthy();});
});

it('keeps a parameter method draft across the materials panel and previews empty local groups',()=>{
 Element.prototype.scrollIntoView=vi.fn();
 function Whole(){const [config,setConfig]=useState(initial());return <SimulationConditions config={config} patch={p=>setConfig(c=>({...c,...p}))} items={[]} disabled={false} onError={vi.fn()}/>;}
 render(<Whole/>);fireEvent.change(screen.getByLabelText('路径位置数'),{target:{value:'4'}});
 fireEvent.change(screen.getByLabelText('温度 变化方式'),{target:{value:'list'}});fireEvent.change(screen.getByLabelText('温度 数列'),{target:{value:'250, 220, 180, 100'}});
 fireEvent.change(screen.getByLabelText('温度 变化方式'),{target:{value:'fixed'}});fireEvent.click(screen.getByRole('tab',{name:'物料来源'}));fireEvent.click(screen.getByRole('tab',{name:'条件与用量'}));
 fireEvent.change(screen.getByLabelText('温度 变化方式'),{target:{value:'list'}});expect((screen.getByLabelText('温度 数列') as HTMLTextAreaElement).value).toBe('250, 220, 180, 100');
 fireEvent.click(screen.getByRole('button',{name:'添加单独设置'}));expect(screen.getByLabelText('预览路径位置')).toBeTruthy();expect(document.querySelector('[data-actual-temperature]')?.textContent).toContain('250');
});
it('does not offer unused origin inputs for a relative change wholly after the first position',()=>{
 const c=initial();c.schedule!.overrides=[{id:'local',rounds:{start:1},positions:{start:3,end:4},parameters:[{id:'local-temperature',target:{kind:'temperature'},value:{mode:'relative',along:'path',start:99,step:-10,other_step:4}}]}];
 render(<ScheduleEditor config={c} schedule={c.schedule!} onChange={vi.fn()} highlightId="local"/>);
 expect(screen.queryByLabelText('温度 首次值')).toBeNull();expect(screen.queryByLabelText('温度 各轮起点变化')).toBeNull();expect(screen.getByLabelText('温度 比前一步增减')).toBeTruthy();
});
