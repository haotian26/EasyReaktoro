// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SpeciesGrid} from './SimulationSpecies';
import {SimSpecies} from './simulation-types';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
const first:SimSpecies={id:'record-a',name:'CuCl A',formula:'CuCl+',phase:'aqueous',charge:1,elements:['Cu','Cl'],disabled:false,reason:'',is_water:false,ion_size:null};
const second:SimSpecies={...first,id:'record-b',name:'CuCl B'};
const props={items:[first,second],selected:new Set<string>(),disabled:false,handleId:'database-a',onToggle:vi.fn()};
const tile=(name:string)=>screen.getByRole('button',{name:`参与平衡 ${name}`});
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();mocks.invoke.mockResolvedValue({model:{type:'HKF',parameters:{Gf:100}},references:['Current reference']});});
afterEach(()=>{cleanup();vi.useRealTimers();});
async function pause(ms=120){await act(async()=>{vi.advanceTimersByTime(ms);});}
it('crossing tiles never opens an abandoned preview, and a visible preview cannot intercept selection',async()=>{
 render(<SpeciesGrid {...props}/>);
 fireEvent.mouseEnter(tile(first.name));await pause(80);fireEvent.mouseLeave(tile(first.name));fireEvent.mouseEnter(tile(second.name));
 await pause(80);expect(screen.queryByRole('tooltip')).toBeNull();expect(mocks.invoke).not.toHaveBeenCalled();
 await pause(40);const preview=screen.getByRole('tooltip');expect(preview.textContent).toContain(second.name);expect(preview.style.pointerEvents).toBe('none');
 expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('species_details',{handleId:'database-a',speciesId:'record-b',name:second.name});
 fireEvent.click(tile(second.name));expect(props.onToggle).toHaveBeenCalledWith(second);
 fireEvent.mouseLeave(tile(second.name));expect(screen.queryByRole('tooltip')).toBeNull();
});
it('ignores a stale response and reuses an in-flight request when comparing the same record again',async()=>{
 const resolvers=new Map<string,(value:any)=>void>();mocks.invoke.mockImplementation((_command,args)=>new Promise(resolve=>resolvers.set(args.speciesId,resolve)));
 render(<SpeciesGrid {...props}/>);
 fireEvent.focus(tile(first.name));expect(screen.getByRole('tooltip').textContent).toContain(first.name);
 fireEvent.blur(tile(first.name));fireEvent.focus(tile(second.name));
 await act(async()=>resolvers.get('record-a')!({model:{type:'HKF',parameters:{Gf:111}},references:['Old reference']}));
 expect(screen.getByRole('tooltip').textContent).not.toContain('111');expect(screen.queryByText('Old reference')).toBeNull();
 fireEvent.blur(tile(second.name));fireEvent.focus(tile(first.name));await pause(0);
 expect(screen.getByRole('tooltip').textContent).toContain('111');expect(mocks.invoke).toHaveBeenCalledTimes(2);
 fireEvent.blur(tile(first.name));fireEvent.focus(tile(second.name));await act(async()=>resolvers.get('record-b')!({model:{type:'HKF',parameters:{Gf:222}},references:['New reference']}));
 expect(screen.getByRole('tooltip').textContent).toContain('222');expect(screen.queryByText('Old reference')).toBeNull();expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
it('does not reset a comparison after selecting a species, and hides immediately on scrolling or filtering away the active record',async()=>{
 const view=render(<SpeciesGrid {...props}/>);fireEvent.focus(tile(first.name));await pause(0);
 view.rerender(<SpeciesGrid {...props} items={[{...first},{...second}]} selected={new Set([first.name])}/>);
 expect(screen.getByRole('tooltip').textContent).toContain(first.name);expect(mocks.invoke).toHaveBeenCalledTimes(1);
 fireEvent.scroll(window);expect(screen.queryByRole('tooltip')).toBeNull();
 fireEvent.mouseEnter(tile(first.name));view.rerender(<SpeciesGrid {...props} items={[second]}/>);await pause();
 expect(screen.queryByRole('tooltip')).toBeNull();expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it('isolates the same species identity between databases and clears focus help with Escape',async()=>{
 const view=render(<SpeciesGrid {...props}/>);fireEvent.focus(tile(first.name));await pause(0);
 expect(tile(first.name).getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
 view.rerender(<SpeciesGrid {...props} handleId="database-b"/>);expect(screen.queryByRole('tooltip')).toBeNull();
 fireEvent.focus(tile(first.name));await pause(0);expect(mocks.invoke).toHaveBeenLastCalledWith('species_details',{handleId:'database-b',speciesId:'record-a',name:first.name});
 fireEvent.keyDown(window,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();expect(tile(first.name).getAttribute('aria-describedby')).toBeNull();
});
it('allows a failed metadata read to be retried without showing another species details',async()=>{
 mocks.invoke.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({model:{type:'HKF',parameters:{Gf:7}}});
 render(<SpeciesGrid {...props}/>);fireEvent.focus(tile(first.name));await pause(0);expect(screen.getByText('参数暂时无法读取')).toBeTruthy();
 fireEvent.blur(tile(first.name));fireEvent.focus(tile(first.name));await pause(0);expect(screen.getByRole('tooltip').textContent).toContain('7');expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it('omits the absent HKF temperature limit serialized as zero without hiding real zero coefficients',async()=>{
 const details={model:{type:'reaktoro-native',native_type:'HKF'},model_parameters:{HKF:{Tmax:0,Gf:0,Hf:0,Sr:-10.042,a1:1.703e-7}},valid_tp:{}};
 const original=JSON.stringify(details);mocks.invoke.mockResolvedValue(details);render(<SpeciesGrid {...props}/>);fireEvent.focus(tile(first.name));await pause(0);
 const preview=screen.getByRole('tooltip');expect(preview.textContent).not.toContain('最高温度');expect(preview.textContent).not.toContain('Tmax');
 expect([...preview.querySelectorAll('dd')].map(v=>v.textContent)).toEqual(['0','0','-10.042','1.703e-7']);expect(JSON.stringify(details)).toBe(original);
});
it('retains an explicitly recorded positive HKF maximum temperature',async()=>{
 mocks.invoke.mockResolvedValue({model:{type:'HKF',parameters:{Tmax:873.15,Gf:-540573}}});render(<SpeciesGrid {...props}/>);fireEvent.focus(tile(first.name));await pause(0);
 const preview=screen.getByRole('tooltip');expect(preview.textContent).toContain('最高温度K873.15');expect(preview.textContent).toContain('-540573');
});

it('refreshes changed database parameters even when the record name and handle stay the same',async()=>{
 const catalog=[first,second];const view=render(<SpeciesGrid {...props} catalogIdentity={catalog}/>);
 fireEvent.focus(tile(first.name));await pause(0);expect(screen.getByRole('tooltip').textContent).toContain('100');
 mocks.invoke.mockResolvedValue({model:{type:'HKF',parameters:{Gf:987}}});
 view.rerender(<SpeciesGrid {...props} catalogIdentity={[{...first},second]}/>);expect(screen.queryByRole('tooltip')).toBeNull();
 fireEvent.focus(tile(first.name));await pause(0);expect(screen.getByRole('tooltip').textContent).toContain('987');expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
