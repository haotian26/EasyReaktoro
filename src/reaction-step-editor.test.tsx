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

it('locates the precise stage input and clears its error after repair without changing other rules',()=>{
 render(<Editor/>);
 const field=screen.getByLabelText('first_following 压力');
 fireEvent.change(field,{target:{value:'unknown + 1'}});
 expect(field.getAttribute('aria-invalid')).toBe('true');
 expect(screen.getByLabelText('first_start 压力').getAttribute('aria-invalid')).toBeNull();
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);
 expect(document.activeElement).toBe(field);
 expect((field as HTMLInputElement).value).toBe('unknown + 1');
 fireEvent.change(field,{target:{value:'P-5'}});
 expect(field.getAttribute('aria-invalid')).toBeNull();
 expect(screen.queryByRole('button',{name:'定位到输入'})).toBeNull();
 expect(compileSchedule(latest).point(2,0).pressure_bar).toBe(690);
 expect(compileSchedule(latest).point(2,1).pressure_bar).toBe(700);
});
it('locates an invalid temperature dependency rather than blaming saturation pressure',()=>{
 const c=base();c.schedule!.parameters[1].value={mode:'water_saturation'};render(<Editor initial={c}/>);
 fireEvent.change(screen.getByLabelText('first_start 温度'),{target:{value:'bad_T'}});
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);
 expect(document.activeElement).toBe(screen.getByLabelText('first_start 温度'));
 expect(screen.getByLabelText('first_start 压力').getAttribute('aria-invalid')).toBeNull();
 expect((screen.getByLabelText('first_start 压力') as HTMLInputElement).value).toBe('Psat(T)');
});
it('locates both kinds of stopping conditions and preserves an invalid draft',()=>{
 render(<Editor/>);
 const completion=screen.getByLabelText('模拟结束条件');
 fireEvent.change(completion,{target:{value:'P < 1'}});
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);expect(document.activeElement).toBe(completion);
 fireEvent.change(completion,{target:{value:'N = 2'}});
 const end=screen.getByLabelText('later 结束条件');fireEvent.change(end,{target:{value:'Tr < 1'}});
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);expect(document.activeElement).toBe(end);
 expect((end as HTMLInputElement).value).toBe('Tr < 1');
});
it('locates a negative composition term instead of a temperature field',()=>{
 render(<Editor/>);
 const amount=screen.getByLabelText('later_following 物料 1 用量');fireEvent.change(amount,{target:{value:'-0.5'}});
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);expect(document.activeElement).toBe(amount);
 expect(amount.getAttribute('aria-invalid')).toBe('true');
 fireEvent.change(amount,{target:{value:'0.5'}});expect(()=>compileSchedule(latest)).not.toThrow();
});
it('locates an unfinished local range without silently completing it',()=>{
 const c=base();c.schedule!.overrides=[{id:'unfinished',rounds:{start:NaN,end:3},positions:{start:1,end:1},parameters:[{id:'unfinished-temperature',target:{kind:'temperature'},value:{mode:'fixed',value:123}}]}];render(<Editor initial={c}/>);
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);
 expect(document.activeElement?.getAttribute('aria-label')).toBe('unfinished rounds start');
 expect(Number.isNaN(latest.schedule!.overrides[0].rounds.start)).toBe(true);
});
it('shows stage-specific help on focus and dismisses it with Escape without changing the formula',()=>{
 setLanguage('en');render(<Editor/>);
 const temperature=screen.getByLabelText('first_start Temperature');fireEvent.focus(temperature);
 expect(temperature.parentElement?.dataset.helpOpen).toBe('true');
 expect(temperature.parentElement?.textContent).toContain('There are no previous conditions here.');
 fireEvent.keyDown(temperature,{key:'Escape'});expect(temperature.parentElement?.dataset.helpOpen).toBeUndefined();
 const pressure=screen.getByLabelText('first_start Pressure');fireEvent.focus(pressure);
 expect(pressure.parentElement?.textContent).toContain('T: current temperature');
 expect(pressure.parentElement?.textContent).not.toContain('P: pressure at the previous');
 const later=screen.getByLabelText('later_start Temperature');fireEvent.focus(later);
 expect(later.parentElement?.textContent).toContain('the previous round’s initial step');
 expect(later.parentElement?.textContent).toContain('Tr, Pr');
 expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
 expect(compileSchedule(latest).point(0,0).temperature_c).toBe(250);
});
it('opens a hidden local amount error without editing or isolating the schedule',()=>{
 const c=base();c.schedule!.overrides=[{id:'dose',rounds:{start:2,end:2},positions:{start:2,end:2},parameters:[{id:'dose-value',target:{kind:'material_amount',material_id:'initial',species:'H2O'},value:{mode:'fixed',value:-1}}]}];
 render(<Editor initial={c}/>);const before=structuredClone(latest.schedule);
 expect(screen.queryByLabelText('此点单独设置')).toBeNull();
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);
 const local=screen.getByLabelText('此点单独设置');
 expect(local.contains(document.activeElement)).toBe(true);
 expect((document.activeElement as HTMLInputElement).value).toBe('-1');
 expect(latest.schedule).toEqual(before);
});
it('shows the actual error beside the focused field and places help above a low input',()=>{
 const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
  const top=this.classList.contains('wave-formula-field')?window.innerHeight-40:0;
  const height=this.classList.contains('wave-formula-help')?150:36;
  return {x:0,y:top,top,left:0,right:300,bottom:top+height,width:300,height,toJSON:()=>({})};
 });
 try{
  setLanguage('en');render(<Editor/>);
  const field=screen.getByLabelText('first_start Temperature');fireEvent.change(field,{target:{value:'unknown'}});fireEvent.focus(field);
  expect(field.parentElement?.dataset.helpAbove).toBe('true');
  expect(field.parentElement?.querySelector('.wave-formula-error')?.textContent).toBe('Unknown variable: unknown.');
 }finally{rect.mockRestore();}
});

it('opens local conditions without changing the schedule, then restores a live stage formula',()=>{
 render(<Editor/>);fireEvent.change(screen.getByLabelText('first_following 温度'),{target:{value:'T-20'}});
 fireEvent.change(screen.getByLabelText('预览路径位置'),{target:{value:'2'}});
 const before=structuredClone(latest.schedule);fireEvent.click(screen.getByRole('button',{name:'单独调整此处'}));expect(latest.schedule).toEqual(before);
 const local=screen.getByLabelText('此点单独设置');expect(within(local).getAllByText('沿用规则')).toHaveLength(2);
 fireEvent.change(screen.getByLabelText('温度 本点数值或公式'),{target:{value:'100'}});
 expect(within(local).getByText('本点修改')).toBeTruthy();expect(compileSchedule(latest).point(2,0).temperature_c).toBe(80);
 fireEvent.change(screen.getByLabelText('first_following 温度'),{target:{value:'T-10'}});
 fireEvent.click(within(local).getByRole('button',{name:'恢复沿用 · 温度'}));
 expect(compileSchedule(latest).point(1,0).temperature_c).toBe(240);
 expect((screen.getByLabelText('温度 本点数值或公式') as HTMLInputElement).value).toBe('T-10');
 expect(within(local).queryByText('本点修改')).toBeNull();
});
it('locates missing pH and fugacity inputs and clears the matching error after repair',()=>{
 render(<Editor/>);fireEvent.change(screen.getByLabelText('添加指定条件'),{target:{value:'ph'}});
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);expect(document.activeElement).toBe(screen.getByLabelText('pH 调节物质'));
 fireEvent.change(screen.getByLabelText('pH 调节物质'),{target:{value:'HCl'}});expect(screen.getByLabelText('pH 调节物质').getAttribute('aria-invalid')).toBeNull();
 fireEvent.change(screen.getByLabelText('添加指定条件'),{target:{value:'fugacity'}});
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);expect(document.activeElement).toBe(screen.getByLabelText('逸度目标气体'));
 expect(screen.getByLabelText('pH 调节物质').getAttribute('aria-invalid')).toBeNull();
});
it('opens a collapsed constraint range and focuses its invalid bound without altering it',()=>{
 const c=base();c.equilibrium_constraints=[{id:'acid',kind:'ph',value:7,titrant:'HCl',exchange:'add_only',rounds:{start:2,end:1}}];render(<Editor initial={c}/>);
 const field=screen.getByLabelText('适用轮次 终点'),details=field.closest('details')!;expect(details.open).toBe(false);
 const before=structuredClone(latest);fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);
 expect(details.open).toBe(true);expect(document.activeElement).toBe(field);expect(latest).toEqual(before);
 fireEvent.change(field,{target:{value:'3'}});expect(field.getAttribute('aria-invalid')).toBeNull();
});
it('takes overlapping targets to the second target range rather than an unrelated value',()=>{
 const c=base();c.equilibrium_constraints=[{id:'a',kind:'ph',value:7,titrant:'HCl',exchange:'add_only'},{id:'b',kind:'ph',value:6,titrant:'CO2',exchange:'add_only'}];render(<Editor initial={c}/>);
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);
 expect(document.activeElement).toBe(screen.getAllByLabelText('适用轮次')[1]);expect(document.activeElement?.closest('details')?.open).toBe(true);
});
it('locates an unavailable material result at the source control',()=>{
 const c=base();c.reaction_stages={first_start:[{...c.routes[0],id:'bad-source',source:'previous_point',when:'always'}],first_following:[],later_start:[],later_following:[]};render(<Editor initial={c}/>);
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);expect(document.activeElement).toBe(screen.getByLabelText('first_start 物料 1 来源'));
});
it('locates the specific source position rather than the source-type selector',()=>{
 const c=base();c.reaction_stages={first_start:[{...c.routes[0],id:'first',when:'always'}],first_following:[{...c.routes[0],id:'bad-position',source:'output',point_id:'loop-99',lag:0,when:'always'}],later_start:[],later_following:[]};render(<Editor initial={c}/>);
 fireEvent.click(screen.getAllByRole('button',{name:'定位到输入'})[0]);expect(document.activeElement).toBe(screen.getByLabelText('first_following 物料 1 来源位置'));
});
it('uses singular English counts for one step, round and equilibrium',()=>{
 setLanguage('en');const c=base();c.schedule!.positions=1;c.schedule!.rounds=1;render(<Editor initial={c}/>);
 expect(screen.getByText('1 step')).toBeTruthy();expect(screen.getByText('1 round · 1 equilibrium')).toBeTruthy();
 expect(document.body.textContent).not.toMatch(/\b1 (steps|rounds|equilibria)\b/);
});
