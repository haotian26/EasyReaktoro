// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {Config,DEFAULT_CONFIG,makeRoute,SimSpecies,readConfig} from './simulation-types';
import {defaultLoops,loopCounts,loopIssue,routeId} from './simulation-loops';
import {RouteEditor,SimulationConditions} from './SimulationConditions';
import {toStageConfig} from './reaction-stages';
import {compileSchedule,scheduleCounts,scheduleIssue} from './simulation-schedule';
afterEach(()=>{cleanup();selectedStage='first_start';});
const items:SimSpecies[]=['H2O','H+','OH-','Quartz'].map(name=>({name,formula:name,phase:name==='Quartz'?'mineral':'aqueous',charge:name==='H+'?1:name==='OH-'?-1:0,elements:[],is_water:name==='H2O',disabled:false,reason:'',ion_size:null}));
function base(){const c=structuredClone(DEFAULT_CONFIG);c.species=items.map(s=>s.name);c.materials=[{id:'water',name:'流体',inputs:[{species:'H2O',amount:1,unit:'kg'},{species:'OH-',amount:0,unit:'mol'}]},{id:'rock',name:'岩石',inputs:[{species:'Quartz',amount:.1,unit:'mol'}]}];c.routes=[makeRoute('aqueous','material','water'),makeRoute('mineral','material','rock')];c.loops=defaultLoops();c.loops.inner={mode:'range',target:{kind:'pressure'},start:700,end:690,step:-5};c.loops.outer={mode:'repeat',count:2};return c;}
function Harness({initial}:{initial:Config}){const [c,set]=useState(initial);return <><SimulationConditions config={c} patch={p=>set({...c,...p})} disabled={false} items={items} onError={e=>{throw Error(e);}}/><output data-testid="config">{JSON.stringify(c)}</output></>;}
const current=()=>JSON.parse(screen.getByTestId('config').textContent!) as Config;
let selectedStage='first_start';
const panel=()=>screen.getByLabelText(selectedStage);
const input=(name:string)=>within(panel()).getByLabelText(`${selectedStage} ${name}`);
const openMaterials=()=>{selectedStage='first_start';};
const selectStage=(name:RegExp)=>{selectedStage=`${name.source.includes('2')?'later':'first'}_${name.source.includes('其余')?'following':'start'}`;};
it('lets each reaction position omit a material without removing its recipe or other positions',()=>{
 render(<Harness initial={base()}/>);selectStage(/第 2 轮起 其余位置/);
 fireEvent.click(input('移除物料 2'));fireEvent.change(input('物料 1 来源'),{target:{value:'previous_point'}});
 const c=current();expect(c.reaction_stages!.later_following).toHaveLength(1);expect(c.reaction_stages!.later_following[0]).toMatchObject({source:'previous_point',phase:'aqueous'});expect(c.reaction_stages!.first_start).toHaveLength(2);expect(c.materials).toHaveLength(2);
 fireEvent.click(within(panel()).getByRole('button',{name:'添加一项'}));fireEvent.change(input('物料 2 来源'),{target:{value:'previous_cycle'}});fireEvent.change(input('物料 2 相态'),{target:{value:'mineral'}});expect(current().reaction_stages!.later_following[1]).toMatchObject({source:'previous_cycle',phase:'mineral'});
 expect(document.body.textContent).not.toMatch(/内循环|外循环|没有前次结果时|各轮使用哪些反应物/);
});
it('shows actual filtered input and explicit checked species instead of a native blue highlight',()=>{
 render(<Harness initial={base()}/>);openMaterials();fireEvent.change(input('物料 1 用量'),{target:{value:'.5'}});expect(within(panel()).getByText('实际加入：H2O 0.5 kg')).toBeTruthy();
 fireEvent.change(input('物料 1 相态'),{target:{value:'gas'}});expect(within(panel()).queryByText(/实际加入：H2O/)).toBeNull();expect(within(panel()).getByText('当前选择没有可加入的物质。')).toBeTruthy();
 fireEvent.change(input('物料 1 相态'),{target:{value:'species'}});const hydroxide=within(panel()).getByRole('checkbox',{name:'OH-'});fireEvent.click(hydroxide);expect((hydroxide as HTMLInputElement).checked).toBe(true);expect(within(panel()).getByText('已选 1 species')).toBeTruthy();expect(within(panel()).queryByText(/实际加入：H2O/)).toBeNull();
 fireEvent.click(within(panel()).getByRole('checkbox',{name:'H2O'}));expect(within(panel()).getByText('已选 2 species')).toBeTruthy();expect(within(panel()).getByText('实际加入：H2O 0.5 kg')).toBeTruthy();fireEvent.click(within(panel()).getByRole('button',{name:'清除选择'}));expect(current().reaction_stages!.first_start[0].species).toEqual([]);
});
it('keeps controls and focus in place when a single point becomes a path and multiple rounds',()=>{
 const c=base();c.loops!.inner={mode:'repeat',count:1};c.loops!.outer={mode:'repeat',count:1};render(<Harness initial={c}/>);
 openMaterials();const input=screen.getByLabelText('first 结束条件'),composer=screen.getByLabelText('first_start');input.focus();fireEvent.change(input,{target:{value:'i=99'}});
 expect(screen.getByLabelText('first 结束条件')).toBe(input);expect(document.activeElement).toBe(input);expect(screen.getByLabelText('first_start')).toBe(composer);expect(document.querySelector('.loop-plan-layout--single')).toBeNull();
 fireEvent.change(screen.getByLabelText('later 结束条件'),{target:{value:'i=99'}});fireEvent.change(screen.getByLabelText('模拟结束条件'),{target:{value:'N=39'}});expect(compileSchedule(current()).counts.total).toBe(4000);
 fireEvent.change(input,{target:{value:'i=0'}});fireEvent.change(screen.getByLabelText('模拟结束条件'),{target:{value:'N=0'}});expect(screen.getByLabelText('first_start')).toBe(composer);expect(screen.getByText('当前只计算首轮')).toBeTruthy();
});
it('keeps the first charge unchanged when only downstream sources are edited',()=>{
 const c=base();c.routes[0].fraction=.2;render(<Harness initial={c}/>);selectStage(/第 1 轮 其余位置/);fireEvent.change(input('物料 1 来源'),{target:{value:'previous_point'}});
 expect(current().routes[0].fraction).toBe(.2);
 expect(current().reaction_stages!.first_start[0].fraction).toBe(.2);expect(current().reaction_stages!.first_following[0]).toMatchObject({fraction:.2,source:'previous_point'});
 selectStage(/第 1 轮 起点/);expect((input('物料 1 用量') as HTMLInputElement).value).toBe('0.2');
});
it('retains a migrated amount variation across all positions without making the target disappear',()=>{
 const c=base();c.loops!.outer={mode:'list',target:{kind:'route_fraction',route_id:routeId(c.routes[0],0),field:'fraction'},values:[.2,.4]};render(<Harness initial={c}/>);
 openMaterials();expect((input('物料 1 用量') as HTMLInputElement).value).toBe('list(N, 0.2, 0.4)');
 fireEvent.change(input('物料 2 用量'),{target:{value:'2'}});expect(scheduleIssue(current())).toBeUndefined();expect(compileSchedule(current()).valueAt({kind:'route_fraction',route_id:current().reaction_stages!.first_start[0].id!,field:'fraction'},0,0)).toBe(.2);selectStage(/第 2 轮起 起点/);expect(compileSchedule(current()).valueAt({kind:'route_fraction',route_id:current().reaction_stages!.later_start[0].id!,field:'fraction'},0,1)).toBe(.4);
});
it('copies a composition once and allows independent edits afterward',()=>{
 render(<Harness initial={base()}/>);selectStage(/第 2 轮起 其余位置/);fireEvent.change(input('复制组成'),{target:{value:'first_start'}});fireEvent.click(input('移除物料 2'));
 const c=current();expect(c.reaction_stages!.first_start).toHaveLength(2);expect(c.reaction_stages!.later_following).toHaveLength(1);expect(c.reaction_stages!.later_following[0].id).not.toBe(c.reaction_stages!.first_start[0].id);
});
it('keeps unfinished values in unused positions through settings loading',()=>{
 const c=toStageConfig(base());c.loops!.inner={mode:'repeat',count:1};c.loops!.outer={mode:'repeat',count:1};c.reaction_stages!.later_following[0].fraction=NaN;
 expect(Number.isNaN(readConfig(c).reaction_stages!.later_following[0].fraction)).toBe(true);
});
it('preserves starting portions in an existing individually configured route',()=>{
 const c=base();delete c.loops;c.routes[0].fraction=.2;
 function Legacy(){const [routes,set]=useState(c.routes);return <><RouteEditor routes={routes} config={c} onChange={set}/><output data-testid="config">{JSON.stringify({...c,routes})}</output></>;}
 render(<Legacy/>);fireEvent.change(screen.getByLabelText('规则 1 来源'),{target:{value:'previous_cycle'}});
 expect(current().routes[0]).toMatchObject({source:'previous_cycle',fraction:1,fallback_fraction:.2});
 fireEvent.change(screen.getByLabelText('规则 1 来源'),{target:{value:'material'}});expect(current().routes[0].fraction).toBe(.2);
});

it('keeps selected species visible as unavailable when changing to a different composition',()=>{
 render(<Harness initial={base()}/>);fireEvent.change(input('物料 1 相态'),{target:{value:'species'}});fireEvent.click(within(panel()).getByRole('checkbox',{name:'H2O'}));fireEvent.change(input('物料 1 来源'),{target:{value:'material:rock'}});
 expect(current().reaction_stages!.first_start[0].species).toEqual(['H2O']);expect(within(panel()).getByText('H2O · 不在此来源中')).toBeTruthy();expect(within(panel()).queryByRole('checkbox',{name:'H2O'})).toBeNull();fireEvent.click(within(panel()).getByRole('button',{name:/^移除$/}));expect(current().reaction_stages!.first_start[0].species).toEqual([]);
});
