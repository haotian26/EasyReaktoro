// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SchedulePreview,ScheduleSelection} from './SchedulePreview';
import {Config,DEFAULT_CONFIG,makeRoute,SimSpecies} from './simulation-types';
import {defaultSchedule,ParameterSetting} from './simulation-schedule';
import {stageKeys} from './reaction-stages';
import {saturationPressure} from './process-layout';
afterEach(cleanup);
const water:SimSpecies={name:'H2O',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null};
const calcite:SimSpecies={...water,name:'Calcite',formula:'CaCO3',phase:'mineral',is_water:false,elements:['Ca','C','O']};
const items=[water,calcite];
const setting=(id:string,target:ParameterSetting['target'],value:ParameterSetting['value']):ParameterSetting=>({id,target,value});
function config():Config{
 const c=structuredClone(DEFAULT_CONFIG);c.name='点选择验证';c.species=['H2O','Calcite'];c.activity_model='ideal';c.materials[0].inputs=[{species:'H2O',amount:1,unit:'kg'},{species:'Calcite',amount:.01,unit:'mol'}];
 c.reaction_stages=Object.fromEntries(stageKeys.map(key=>[key,[{...makeRoute(),id:'feed-'+key,when:'always',fallback:'error'}]])) as Config['reaction_stages'];
 c.schedule={...defaultSchedule(),positions:4,rounds:2,parameters:[setting('temperature',{kind:'temperature'},{mode:'linear',start:250,path_step:-50,round_step:0}),setting('pressure',{kind:'pressure'},{mode:'water_saturation'})],overrides:[{id:'pressure-second',rounds:{start:2,end:2},positions:{start:1},parameters:[setting('fixed-pressure',{kind:'pressure'},{mode:'fixed',value:700})]}]};return c;
}
function Harness({initial,selection={inner:0,outer:0},adjust=()=>{}}:{initial:Config;selection?:ScheduleSelection;adjust?:(ii:number,oi:number)=>void}){const [selected,setSelected]=useState(selection);return <SchedulePreview config={initial} items={items} selected={selected} onSelect={(inner,outer)=>setSelected({inner,outer})} onAdjust={adjust}/>;}
it('shows actual temperature and pressure at an exact point, with location axes rather than one chosen variable',()=>{
 const {container}=render(<Harness initial={config()}/>);expect(container.querySelector('[data-actual-temperature]')?.textContent).toContain('250');expect(container.querySelector('[data-actual-pressure]')?.textContent).toContain(Number(saturationPressure(250).toPrecision(5)).toString());expect(screen.getByText('纯水饱和蒸汽压')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('预览路径位置'),{target:{value:'3'}});fireEvent.change(screen.getByLabelText('预览反应轮次'),{target:{value:'2'}});
 expect(container.querySelector('[data-actual-temperature]')?.textContent).toContain('150');expect(container.querySelector('[data-actual-pressure]')?.textContent).toContain('700');expect(screen.queryByText('纯水饱和蒸汽压')).toBeNull();
 expect(screen.getByRole('region',{name:'第 2 轮位置 3 的实际设置'})).toBeTruthy();expect(container.querySelector('.reaction-flow__position')?.textContent).toContain('位置');expect(container.querySelector('.reaction-flow__round')?.textContent).toContain('轮');
 expect(container.querySelectorAll('.reaction-flow__point.is-selected')).toHaveLength(1);
});
it('multiplies actual composition amounts and route portions after the phase/species selection',()=>{
 const c=config(),r=c.reaction_stages!.later_following[0];r.phase='species';r.species=['H2O'];
 c.schedule!.parameters.push(setting('water',{kind:'material_amount',material_id:'initial',species:'H2O'},{mode:'list',along:'path',values:[1,2,3,4]}),setting('portions',{kind:'route_fraction',route_id:r.id!,field:'fraction'},{mode:'linear',start:.1,path_step:.1,round_step:.2}));
 const {container}=render(<Harness initial={c} selection={{inner:2,outer:1}}/>),rows=container.querySelector('.schedule-preview__input-rows');
 expect(rows?.textContent).toContain('H2O 1.5 kg');expect(rows?.textContent).not.toContain('Calcite');expect(container.querySelector('.schedule-preview__material-heading')?.textContent).toContain('0.5 份');
 expect(screen.getByText('4 项参数变化 · 1 组单独设置')).toBeTruthy();expect(container.querySelector('.schedule-preview__changes')?.textContent).toContain('H2O');
});
it('selects a precise grid point rather than every point in its four-stage category',()=>{
 const adjust=vi.fn(),{container}=render(<Harness initial={config()} adjust={adjust}/>);
 const point=container.querySelector('.reaction-flow__point[data-inner-index="2"][data-outer-index="1"]')!;fireEvent.click(point);
 expect(screen.getByRole('region',{name:'第 2 轮位置 3 的实际设置'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'单独调整此处'}));expect(adjust).toHaveBeenCalledWith(2,1);
 fireEvent.click(screen.getByRole('button',{name:'预览上一位置'}));expect(screen.getByRole('region',{name:'第 2 轮位置 2 的实际设置'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'预览上一轮次'}));expect(screen.getByRole('region',{name:'第 1 轮位置 2 的实际设置'})).toBeTruthy();
});
it('finds the middle-only feed at point 51 of 100 without changing the configured count',()=>{
 const c=config();c.schedule!.positions=100;c.schedule!.rounds=1;c.schedule!.parameters=[setting('t',{kind:'temperature'},{mode:'fixed',value:100}),setting('p',{kind:'pressure'},{mode:'fixed',value:700})];c.schedule!.overrides=[{id:'middle-feed',positions:{start:51,end:51},rounds:{start:1,end:1},parameters:[setting('feed',{kind:'material_amount',material_id:'initial',species:'H2O'},{mode:'fixed',value:2})]}];c.materials[0].inputs=[{species:'H2O',amount:0,unit:'kg'}];const before=JSON.stringify(c);
 const {container}=render(<Harness initial={c}/>);expect(screen.getByText('当前选取部分没有投料。')).toBeTruthy();fireEvent.change(screen.getByLabelText('预览路径位置'),{target:{value:'51'}});
 expect(container.querySelector('.schedule-preview__input-rows')?.textContent).toContain('H2O 2 kg');expect(screen.queryByText('当前选取部分没有投料。')).toBeNull();
 const point=container.querySelector('.reaction-flow__point.is-selected');expect(point?.getAttribute('data-inner-index')).toBe('50');expect(point?.querySelector('.reaction-flow__fresh')?.textContent).toContain('+');expect(JSON.stringify(c)).toBe(before);
});
it('distinguishes selected portions of a preceding result from uncomputed species amounts',()=>{
 const c=config(),r=c.reaction_stages!.later_following[0];r.source='previous_cycle';r.phase='mineral';r.fraction=.6;
 const {container}=render(<Harness initial={c} selection={{inner:2,outer:1}}/>);expect(container.querySelector('.schedule-preview__material-heading')?.textContent).toContain('第 1 轮 · 位置 3 的反应结果');expect(container.querySelector('.schedule-preview__material-heading')?.textContent).toContain('60 %');expect(screen.getByText('实际组成由该来源的平衡结果决定。')).toBeTruthy();expect(container.querySelector('.schedule-preview__input-rows')).toBeNull();
});
it('shows a useful incomplete-state message rather than a false graph or adjustable point',()=>{
 const c=config();c.schedule!.positions=0;const {container}=render(<Harness initial={c}/>);expect(screen.getByRole('status')).toBeTruthy();expect(container.querySelector('svg.loop-diagram')).toBeNull();expect(screen.queryByRole('button',{name:'单独调整此处'})).toBeNull();
});
it('keeps a one-reaction preview compact with only the real adjustment action',()=>{
 const c=config();c.schedule!.positions=1;c.schedule!.rounds=1;const {container}=render(<Harness initial={c}/>);expect(container.querySelector('.loop-diagram__canvas')).toBeNull();expect(screen.queryByRole('button',{name:'查看反应物'})).toBeNull();expect(screen.getByRole('button',{name:'单独调整此处'})).toBeTruthy();expect((screen.getByLabelText('预览路径位置') as HTMLInputElement).value).toBe('1');
});
it('does not select an out-of-range coordinate while a number field is being edited',()=>{
 render(<Harness initial={config()}/>);const input=screen.getByLabelText('预览路径位置');fireEvent.change(input,{target:{value:'100'}});expect(input.getAttribute('aria-invalid')).toBe('true');expect(screen.getByRole('region',{name:'第 1 轮位置 1 的实际设置'})).toBeTruthy();fireEvent.blur(input);expect((input as HTMLInputElement).value).toBe('1');
});


it('does not claim that a future or out-of-range output already exists',()=>{
 const c=config();c.reaction_stages!.first_following[0]={...c.reaction_stages!.first_following[0],source:'output',point_id:'loop-3',lag:0};
 const {container}=render(<Harness initial={c} selection={{inner:1,outer:0}}/>);expect(screen.getAllByRole('status').length).toBeGreaterThan(0);expect(screen.queryByText('第 1 轮 · 位置 3 的反应结果')).toBeNull();expect(container.querySelector('[data-source="other"][data-to-inner="1"][data-to-outer="0"]')).toBeNull();
});
