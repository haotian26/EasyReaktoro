// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {Config,DEFAULT_CONFIG,makeRoute,ReactionStageKey} from './simulation-types';
import {defaultLoops} from './simulation-loops';
import {ReactionStageEditor,availableRouteSpecies} from './ReactionStageEditor';
afterEach(cleanup);
function config():Config{return {...structuredClone(DEFAULT_CONFIG),species:['NaCl','H2O','H+','OH-'],materials:[{id:'salt',name:'composition 3',inputs:[{species:'NaCl',amount:1,unit:'mol'}]},{id:'water',name:'composition 1',inputs:[{species:'H2O',amount:1,unit:'kg'},{species:'NaCl',amount:0,unit:'mol'}]}],loops:{...defaultLoops(),inner:{mode:'repeat',count:3},outer:{mode:'repeat',count:2}},reaction_stages:{first_start:[{...makeRoute('species','material','salt'),id:'r1',species:[]}],first_following:[],later_start:[],later_following:[]}};}
function Editor({initial,stage='first_start'}:{initial:Config;stage?:ReactionStageKey}){const [value,setValue]=useState(initial);return <><ReactionStageEditor config={value} items={[]} selected={stage} onSelect={()=>{}} onChange={patch=>setValue({...value,...patch})}/><output data-testid="current">{JSON.stringify(value)}</output></>;}
const current=():Config=>JSON.parse(screen.getByTestId('current').textContent!);
it('limits a fresh species picker to that composition, retaining zero rows that can vary later',()=>{
 const c=config();render(<Editor initial={c}/>);expect(screen.getAllByRole('checkbox').map(e=>e.textContent)).toEqual(['NaCl']);expect(screen.queryByRole('checkbox',{name:'H+'})).toBeNull();fireEvent.click(screen.getByRole('checkbox',{name:'NaCl'}));expect(current().reaction_stages!.first_start[0].species).toEqual(['NaCl']);
 expect(availableRouteSpecies(c,{...c.reaction_stages!.first_start[0],material_id:'water'})).toEqual(['H2O','NaCl']);
});
it('offers all system species for result sources and clears incompatible choices only after reviewing the source change',()=>{
 const c=config();c.reaction_stages!.later_following=[{...makeRoute('species','previous_point','salt'),id:'r1',species:['H+','NaCl']}];render(<Editor initial={c} stage="later_following"/>);
 expect(screen.getAllByRole('checkbox')).toHaveLength(4);fireEvent.change(screen.getByLabelText('物料 1 来源'),{target:{value:'material:salt'}});
 expect(current().reaction_stages!.later_following[0].source).toBe('previous_point');expect(screen.getByText(/以下 species 不在新来源中/).textContent).toContain('H+');
 fireEvent.click(screen.getByRole('button',{name:'保留原来源'}));expect(current().reaction_stages!.later_following[0].species).toEqual(['H+','NaCl']);
 fireEvent.change(screen.getByLabelText('物料 1 来源'),{target:{value:'material:salt'}});fireEvent.click(screen.getByRole('button',{name:'确认切换'}));
 expect(current().reaction_stages!.later_following[0]).toMatchObject({source:'material',material_id:'salt',species:['NaCl']});expect(screen.getAllByRole('checkbox').map(e=>e.textContent)).toEqual(['NaCl']);
});
it('does not substitute all species when switching to a composition that has none of the previous selection',()=>{
 const c=config();c.reaction_stages!.first_start[0]={...c.reaction_stages!.first_start[0],material_id:'water',species:['H2O'],fraction:.2};render(<Editor initial={c}/>);
 fireEvent.change(screen.getByLabelText('物料 1 来源'),{target:{value:'material:salt'}});expect(current().reaction_stages!.first_start[0].material_id).toBe('water');expect(screen.getByText(/切换后尚未选择 species/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'确认切换'}));
 expect(current().reaction_stages!.first_start[0]).toMatchObject({material_id:'salt',phase:'species',species:[],fraction:.2});
});
it('reviews a quantity-unit change before resetting a fresh portion to a result percentage',()=>{
 const c=config();c.reaction_stages!.later_following=[{...makeRoute('all','material','salt'),id:'r1',fraction:.2}];render(<Editor initial={c} stage="later_following"/>);
 fireEvent.change(screen.getByLabelText('物料 1 来源'),{target:{value:'previous_cycle'}});expect(current().reaction_stages!.later_following[0].fraction).toBe(.2);expect(screen.getByText('当前 0.2 份会改为取用 100%。')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'确认切换'}));expect(current().reaction_stages!.later_following[0]).toMatchObject({source:'previous_cycle',fraction:1});
});
it('makes imported incompatible selections visible without silently rewriting a saved simulation',()=>{
 const c=config();c.reaction_stages!.first_start[0].species=['H+','NaCl'];render(<Editor initial={c}/>);expect(screen.getByText(/不在当前 composition 中/)).toBeTruthy();expect(current().reaction_stages!.first_start[0].species).toEqual(['H+','NaCl']);fireEvent.click(screen.getByRole('button',{name:'移除这些选择'}));expect(current().reaction_stages!.first_start[0].species).toEqual(['NaCl']);
});
it('uses one neutral add action and the same phase selector for fresh, previous-step and previous-round sources',()=>{
 const c=config();render(<Editor initial={c} stage="later_following"/>);expect(screen.queryByText(/前一步水相/)).toBeNull();expect(screen.queryByText(/上一轮固相/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'添加物料'}));const phases=()=>Array.from((screen.getByLabelText('物料 1 相态') as HTMLSelectElement).options,o=>o.value);expect(phases()).toEqual(['all','aqueous','mineral','gas','species']);fireEvent.change(screen.getByLabelText('物料 1 来源'),{target:{value:'previous_point'}});expect(phases()).toEqual(['all','aqueous','mineral','gas','species']);fireEvent.change(screen.getByLabelText('物料 1 来源'),{target:{value:'previous_cycle'}});expect(phases()).toEqual(['all','aqueous','mineral','gas','species']);
});
