// @vitest-environment jsdom
import React,{useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {SimulationConditions} from './SimulationConditions';
import {DEFAULT_CONFIG,Config} from './simulation-types';
import {compileSchedule,defaultSchedule} from './simulation-schedule';
import {setLanguage} from './i18n';
afterEach(()=>{cleanup();setLanguage('zh');});
let latest:Config;
const base=():Config=>({...structuredClone(DEFAULT_CONFIG),species:['H2O'],materials:[{id:'initial',name:'Composition 1',inputs:[{species:'H2O',amount:1,unit:'kg'}]}],schedule:{...defaultSchedule(),positions:3,rounds:3}});
function Editor({initial=base()}:{initial?:Config}){const [config,set]=useState(initial);latest=config;return <SimulationConditions config={config} patch={p=>set(c=>({...c,...p}))} items={[]} disabled={false} onError={vi.fn()}/>;}
it('shows all four steps and edits horizontal and vertical rules without switching panels',()=>{
 render(<Editor/>);
 for(const stage of ['first_start','first_following','later_start','later_following'])expect(screen.getByLabelText(`${stage} 温度`)).toBeTruthy();
 expect(screen.queryByText('Other variations…')).toBeNull();expect(screen.queryByText('更多条件与局部调整')).toBeNull();
 fireEvent.change(screen.getByLabelText('first_following 压力'),{target:{value:'P-5'}});
 fireEvent.change(screen.getByLabelText('first_following 物料 1 来源'),{target:{value:'previous_point'}});
 expect(compileSchedule(latest).point(2,0).pressure_bar).toBe(690);
 fireEvent.change(screen.getByLabelText('later_start 温度'),{target:{value:'Tr-10'}});
 expect(compileSchedule(latest).point(0,2).temperature_c).toBe(230);
 expect(compileSchedule(latest).point(2,0).pressure_bar).toBe(690);
});
it('defines the path end directly and keeps the terminal point',()=>{
 render(<Editor/>);
 fireEvent.change(screen.getByLabelText('first_following 压力'),{target:{value:'P-5'}});
 fireEvent.change(screen.getByLabelText('first 结束条件'),{target:{value:'P <= 150'}});
 expect(compileSchedule(latest).lengths[0]).toBe(111);expect(compileSchedule(latest).point(110,0).pressure_bar).toBe(150);
});
it('keeps invalid drafts visible instead of silently reverting to the last valid value',()=>{
 render(<Editor/>);fireEvent.change(screen.getByLabelText('first_start 温度'),{target:{value:''}});
 fireEvent.change(screen.getByLabelText('later_start 压力'),{target:{value:'600'}});
 expect((screen.getByLabelText('first_start 温度') as HTMLInputElement).value).toBe('');expect(()=>compileSchedule(latest)).toThrow();
});
it('renders English labels and keeps user composition names',()=>{
 setLanguage('en');render(<Editor/>);
 expect(screen.getByLabelText('first_start Pressure')).toBeTruthy();
 expect(screen.getByLabelText('first_following Material 1 source').textContent).toContain('Composition 1');
 expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
});
it('can end a pressure path before its previously invalid tail',()=>{
 const c=base();c.schedule!.positions=100;render(<Editor initial={c}/>);
 fireEvent.change(screen.getByLabelText('first_following 压力'),{target:{value:'P-10'}});
 expect(()=>compileSchedule(latest)).toThrow();
 fireEvent.change(screen.getByLabelText('first 结束条件'),{target:{value:'P <= 150'}});
 expect(compileSchedule(latest).point(55,0).pressure_bar).toBe(150);
});
it('exposes unfinished local ranges inline and preserves them until repaired',()=>{
 const c=base();c.schedule!.overrides=[{id:'unfinished',rounds:{start:NaN,end:3},positions:{start:1,end:1},parameters:[{id:'unfinished-temperature',target:{kind:'temperature'},value:{mode:'fixed',value:123}}]}];render(<Editor initial={c}/>);
 expect(Number.isNaN(latest.schedule!.overrides[0].rounds.start)).toBe(true);
 fireEvent.change(screen.getAllByLabelText('unfinished rounds start')[0],{target:{value:'2'}});
 expect(compileSchedule(latest).point(0,1).temperature_c).toBe(123);
});

it('shows actual fresh input at stages activated by imported stop expressions',()=>{
 const c=base();c.schedule!.positions=1;c.schedule!.rounds=1;c.schedule!.stop={first:'i=2',later:'i=2',rounds:'N=1'};render(<Editor initial={c}/>);
 for(const stage of ['first_start','first_following','later_start','later_following'])expect(within(screen.getByLabelText(stage)).getByText('实际加入：H2O 1 kg')).toBeTruthy();
});
it('closes the local point editor when moving to another coordinate',()=>{
 render(<Editor/>);fireEvent.click(screen.getByRole('button',{name:'单独调整此处'}));expect(screen.getByLabelText('此点单独设置')).toBeTruthy();fireEvent.change(screen.getByLabelText('预览路径位置'),{target:{value:'2'}});expect(screen.queryByLabelText('此点单独设置')).toBeNull();
});

it('keeps saturation pressure linked to temperature when only local temperature is edited',()=>{
 const c=base();c.schedule!.parameters[1].value={mode:'water_saturation'};render(<Editor initial={c}/>);
 const before=compileSchedule(latest).point(0,0);fireEvent.click(screen.getByRole('button',{name:'单独调整此处'}));
 expect(compileSchedule(latest).point(0,0)).toEqual(before);
 const field=screen.getByLabelText('温度 本点数值或公式');field.focus();
 fireEvent.change(field,{target:{value:''}});
 expect(screen.getByLabelText('温度 本点数值或公式')).toBe(field);expect(document.activeElement).toBe(field);
 expect((screen.getByLabelText('压力 本点数值或公式') as HTMLInputElement).value).toBe('Psat(T)');
 fireEvent.change(field,{target:{value:'100'}});expect(document.activeElement).toBe(field);
 const actual=compileSchedule(latest).point(0,0);
 expect(actual.temperature_c).toBe(100);expect(actual.pressure_mode).toBe('water_saturation');expect(actual.pressure_bar).toBeLessThan(before.pressure_bar);
 expect(compileSchedule(latest).point(1,0)).toMatchObject({temperature_c:250,pressure_mode:'water_saturation'});
});
