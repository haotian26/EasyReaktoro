// @vitest-environment jsdom
import {Profiler,useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SimulationConditions} from './SimulationConditions';
import {useSimulationUndo} from './use-simulation-undo';
import {Config,DEFAULT_CONFIG,readConfig} from './simulation-types';
import {compileSchedule,defaultSchedule} from './simulation-schedule';
import {toStageConfig} from './reaction-stages';
import {encodeDraft,restoreDraft} from './draft-json';
import {setLanguage} from './i18n';
import * as schedules from './simulation-schedule';
afterEach(()=>{cleanup();vi.restoreAllMocks();setLanguage('zh');});
const items:[]=[];
function initial():Config{
 const c=toStageConfig({...structuredClone(DEFAULT_CONFIG),schedule:{...defaultSchedule(),positions:1,rounds:1,stop:{first:'i = 2',later:'i = 2',rounds:'N = 0'},overrides:[{id:'retained',point:true,positions:{start:4,end:4},rounds:{start:3,end:3},parameters:[{id:'saved-t',target:{kind:'temperature'},value:{mode:'fixed',value:175}},{id:'saved-p',target:{kind:'pressure'},value:{mode:'fixed',value:350}}]}]}});return c;
}
function mount(config=initial(),onPatch:()=>void=()=>{},onRender:()=>void=()=>{}){
 let current=config;
 function Harness(){const [value,setValue]=useState(config);current=value;const undo=useSimulationUndo('retained',true,{config:value},v=>setValue(v.config));return <Profiler id="editing" onRender={onRender}><div data-simulation-undo><SimulationConditions config={value} items={items} disabled={false} onError={vi.fn()} patch={patch=>{onPatch();setValue(old=>({...old,...patch}));}}/><button onClick={undo.undo}>Undo</button><button onClick={undo.redo}>Redo</button><button onClick={()=>setValue(readConfig(restoreDraft(JSON.parse(JSON.stringify(encodeDraft(value)))),{allowDraft:true}))}>Reload saved draft</button></div></Profiler>;}
 const view=render(<Harness/>);return {...view,current:()=>current};
}
const field=(label:string)=>screen.getByLabelText(label) as HTMLInputElement;
const open=()=>fireEvent.click(screen.getByRole('button',{name:/轮次 3 · 位置 4/}));
it('edits a retained point at its original location, keeps it through save/load, and applies it when the path reaches it',()=>{
 const h=mount();open();expect(document.activeElement).toBe(field('温度 保留条件数值或公式'));
 fireEvent.change(field('温度 保留条件数值或公式'),{target:{value:'165'}});expect(compileSchedule(h.current()).counts).toEqual({inner:3,outer:1,total:3});
 expect(h.current().schedule!.overrides.find(o=>o.id==='retained')).toMatchObject({positions:{start:4,end:4},rounds:{start:3,end:3},parameters:[{id:'saved-t',value:{mode:'expression',expression:'165'}},{id:'saved-p',value:{mode:'fixed',value:350}}]});
 fireEvent.click(screen.getByText('Reload saved draft'));expect(field('温度 保留条件数值或公式').value).toBe('165');
 fireEvent.change(field('first 结束条件'),{target:{value:'i = 3'}});fireEvent.change(field('later 结束条件'),{target:{value:'i = 3'}});fireEvent.change(field('模拟结束条件'),{target:{value:'N = 2'}});
 const plan=compileSchedule(h.current());expect(plan.counts).toEqual({inner:4,outer:3,total:12});expect(plan.point(3,2)).toMatchObject({temperature_c:165,pressure_bar:350});expect(plan.point(2,2).temperature_c).toBe(250);
});
it('removes one or all retained conditions with lossless undo, including an unfinished draft',()=>{
 const h=mount();open();fireEvent.change(field('温度 保留条件数值或公式'),{target:{value:''}});fireEvent.click(screen.getByText('Reload saved draft'));
 expect(field('温度 保留条件数值或公式').value).toBe('');fireEvent.click(screen.getByRole('button',{name:'移除局部条件 · 压力'}));expect(h.current().schedule!.overrides[0].parameters).toHaveLength(1);
 fireEvent.click(screen.getByText('Undo'));expect(h.current().schedule!.overrides[0].parameters).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'移除这一组局部条件'}));expect(h.current().schedule!.overrides).toHaveLength(0);
 fireEvent.click(screen.getByText('Undo'));expect(field('温度 保留条件数值或公式').value).toBe('');expect(compileSchedule(h.current()).counts.total).toBe(3);
});
it('keeps the original interval and relative recurrence when editing a retained range',()=>{
 const c=initial();c.schedule!.overrides[0]={id:'retained',rounds:{start:3,end:5,step:2},positions:{start:1,end:4},parameters:[{id:'saved-t',target:{kind:'temperature'},value:{mode:'relative',along:'path',start:100,step:-5,other_step:10}}]};
 const h=mount(c);fireEvent.click(screen.getByRole('button',{name:/轮次 3–5.*位置 1–4/}));fireEvent.change(field('温度 每步变化'),{target:{value:'-8'}});
 expect(h.current().schedule!.overrides[0]).toMatchObject({rounds:{start:3,end:5,step:2},positions:{start:1,end:4},parameters:[{value:{mode:'relative',along:'path',start:100,step:-8,other_step:10}}]});
 fireEvent.change(field('模拟结束条件'),{target:{value:'N = 4'}});const plan=compileSchedule(h.current());expect([0,1,2].map(i=>plan.point(i,2).temperature_c)).toEqual([120,112,104]);expect(plan.point(1,3).temperature_c).toBe(250);
});
it('commits the input before rebuilding its preview and never compiles inside the change callback',()=>{
 const spy=vi.spyOn(schedules,'compileSchedule'),commits:{value:string;pending:boolean;inert:boolean;temperature:string|undefined}[]=[];
 const h=mount(initial(),()=>expect(spy).not.toHaveBeenCalled(),()=>{const input=document.querySelector<HTMLInputElement>('[aria-label="first_start 温度"]');if(input)commits.push({value:input.value,pending:!!document.querySelector('[aria-busy=true]'),inert:!!document.querySelector('.wave-preview-content[inert]'),temperature:document.querySelector('[data-actual-temperature]')?.textContent??undefined});});
 spy.mockClear();commits.length=0;fireEvent.change(field('first_start 温度'),{target:{value:'180'}});
 expect(commits.some(c=>c.value==='180'&&c.pending&&c.inert&&c.temperature?.includes('250'))).toBe(true);expect(commits.at(-1)).toMatchObject({value:'180',pending:false});expect(compileSchedule(h.current()).point(0,0).temperature_c).toBe(180);
});

it('keeps an open point editor at its original position when the path is shortened',()=>{
 const h=mount();fireEvent.change(field('预览路径位置'),{target:{value:'3'}});fireEvent.click(screen.getByRole('button',{name:'单独调整此处'}));
 fireEvent.change(field('温度 本点数值或公式'),{target:{value:'160'}});fireEvent.change(field('first 结束条件'),{target:{value:'i = 0'}});
 expect(screen.getByText('单独设置 · 第 1 轮，位置 3')).toBeTruthy();expect(screen.getByText('本次不经过此位置，修改会保留在原位置。')).toBeTruthy();
 fireEvent.change(field('温度 本点数值或公式'),{target:{value:'150'}});expect(compileSchedule(h.current()).point(0,0).temperature_c).toBe(250);
 fireEvent.change(field('first 结束条件'),{target:{value:'i = 2'}});expect(compileSchedule(h.current()).point(2,0).temperature_c).toBe(150);
});
