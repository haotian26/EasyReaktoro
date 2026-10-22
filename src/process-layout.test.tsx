// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG,Config,makeRoute,readConfig} from './simulation-types';
import {pointConditions,saturationPressure,matrixShape,chooseFlow} from './process-layout';
import {ProcessMap} from './ProcessMap';
import {SimulationConditions} from './SimulationConditions';
import {sourcePoint} from './process-preview';
afterEach(cleanup);
it('matches water saturation benchmarks without imposing a 1 bar minimum and rejects out of range temperatures',()=>{
 for(const [t,p] of [[.01,.006116570697405098],[25,.03169824486313973],[100,1.0141799381792782],[250,39.76204322580225]])expect(saturationPressure(t)).toBeCloseTo(p,11);
 for(const t of [0,373.946,400,NaN])expect(Number.isNaN(saturationPressure(t))).toBe(true);
 const p={...DEFAULT_CONFIG.points[0],temperature_c:100,pressure_mode:'water_saturation' as const,temperature_increment_c:50};expect(pointConditions(p,2).pressure).toBeCloseTo(saturationPressure(150),10);
 expect(readConfig({...DEFAULT_CONFIG,points:[p]}).points[0].pressure_mode).toBe('water_saturation');
 expect(()=>readConfig({...DEFAULT_CONFIG,points:[{...p,pressure_mode:'unknown'}]})).toThrow();
});
it('distinguishes within-round predecessors from the same position in the previous round',()=>{
 const c={...structuredClone(DEFAULT_CONFIG),cycles:3,points:[{...DEFAULT_CONFIG.points[0],id:'a'},{...DEFAULT_CONFIG.points[0],id:'b'}]};
 expect(sourcePoint(c,makeRoute('aqueous','previous_point'),1,2)).toEqual({index:0,cycle:2,valid:true});
 expect(sourcePoint(c,makeRoute('mineral','previous_cycle'),1,2)).toEqual({index:1,cycle:1,valid:true});
 expect(sourcePoint(c,makeRoute('all','previous_point'),0,2)).toBe(null);
});
it('shows real source points and sequential run numbers across rounds',()=>{
 const c={...structuredClone(DEFAULT_CONFIG),cycles:3,points:[{...DEFAULT_CONFIG.points[0],id:'a',label:'A'},{...DEFAULT_CONFIG.points[0],id:'b',label:'B'}],routes:[makeRoute('aqueous','previous_point'),makeRoute('mineral','previous_cycle')]};
 const select=vi.fn();render(<ProcessMap config={c} index={1} cycle={2} onSelect={select}/>);fireEvent.click(screen.getByRole('button',{name:'运行顺序'}));
 expect(screen.getByRole('button',{name:'预览第 2 轮第 1 点'}).classList.contains('source')).toBe(true);
 expect(screen.getByRole('button',{name:'预览第 1 轮第 2 点'}).classList.contains('source')).toBe(true);
 expect(screen.getByRole('button',{name:'预览第 2 轮第 2 点'}).textContent).toContain('#4');
 fireEvent.click(screen.getByRole('button',{name:'预览第 3 轮第 1 点'}));expect(select).toHaveBeenCalledWith(0,3);
});
it('shows temperature inside pressure when the user defines those two loop directions',()=>{
 function Harness(){const [c,patch]=useState(structuredClone(DEFAULT_CONFIG));return <SimulationConditions config={c} patch={v=>patch(c=>({...c,...v}))} items={[]} disabled={false} onError={e=>{throw Error(e);}}/>;}
 render(<Harness/>);
 fireEvent.change(screen.getByLabelText('first 结束条件'),{target:{value:'i=1'}});fireEvent.change(screen.getByLabelText('later 结束条件'),{target:{value:'i=1'}});fireEvent.change(screen.getByLabelText('模拟结束条件'),{target:{value:'N=1'}});
 for(const stage of ['first_start','first_following','later_start','later_following']){fireEvent.change(screen.getByLabelText(`${stage} 温度`),{target:{value:'100+100*i'}});fireEvent.change(screen.getByLabelText(`${stage} 压力`),{target:{value:'10+10*N'}});}
 expect(screen.getAllByText(/温度/).length).toBeGreaterThan(0);expect(screen.getAllByText(/压力/).length).toBeGreaterThan(0);fireEvent.click(screen.getByRole('button',{name:'预览下一位置'}));fireEvent.click(screen.getByRole('button',{name:'预览下一轮次'}));expect(document.querySelector('[data-actual-temperature]')?.textContent).toContain('200');expect(document.querySelector('[data-actual-pressure]')?.textContent).toContain('20');
});
it('keeps the inferred loop definition when a legacy simulation first edits an explicit source',()=>{
 let latest:Config=structuredClone(DEFAULT_CONFIG);
 function Harness(){const [c,set]=useState(latest);return <SimulationConditions config={c} patch={v=>set(c=>{latest={...c,...v};return latest;})} items={[]} disabled={false} onError={e=>{throw Error(e);}}/>;}
 render(<Harness/>);fireEvent.change(screen.getByLabelText('first 结束条件'),{target:{value:'i=1'}});fireEvent.change(screen.getByLabelText('first_following 物料 1 来源'),{target:{value:'output'}});
 expect(latest.schedule).toBeTruthy();expect(latest.reaction_stages!.first_following[0].point_id).toBe('loop-1');expect(screen.getByLabelText('first 结束条件')).toBeTruthy();
});
it('does not treat repeated coordinates as a complete matrix',()=>{
 const p=DEFAULT_CONFIG.points[0];expect(matrixShape([{...p,temperature_c:1,pressure_bar:1},{...p,temperature_c:2,pressure_bar:2},{...p,temperature_c:2,pressure_bar:1},{...p,temperature_c:2,pressure_bar:1}])).toBeNull();
});

it('keeps the stable source identity when returning from details to the same material flow',()=>{const routes=[makeRoute('all','material','initial')];expect(chooseFlow('fresh',routes,'initial')).toBe(routes);expect(chooseFlow('fresh',routes,'initial')[0].id).toBe(routes[0].id);});
