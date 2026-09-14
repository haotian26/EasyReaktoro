// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DirectorySetting} from './WorkbenchSettings';
import {SIMULATION_DEFAULTS,simulationPreferences,resultPreferences} from './workbench-preferences';
import {SpeciesGrid} from './SimulationSpecies';
import {decodeDocument,encodeDraft} from './simulation-history';
import {DEFAULT_CONFIG} from './simulation-types';
const mocks=vi.hoisted(()=>({open:vi.fn(),invoke:vi.fn()}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:mocks.open}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
beforeEach(()=>vi.clearAllMocks());afterEach(cleanup);
it('a directory can be chosen, cleared and chosen again without retaining a hidden default',async()=>{
 function Test(){const [value,set]=useState<string>();return <DirectorySetting title="保存位置" value={value} onChange={set}/>;}
 render(<Test/>);mocks.open.mockResolvedValue('/chosen');fireEvent.click(screen.getByRole('button',{name:'选择…'}));await screen.findByText('/chosen');
 fireEvent.click(screen.getByRole('button',{name:'清除'}));expect(screen.getByText('未指定；保存时选择位置。')).toBeTruthy();mocks.open.mockResolvedValue(null);fireEvent.click(screen.getByRole('button',{name:'选择…'}));await waitFor(()=>expect(mocks.open).toHaveBeenLastCalledWith({title:'保存位置',directory:true,multiple:false,defaultPath:undefined}));
});
it('saved preference values remain explicit while new defaults enable both ion-size options',()=>{
 expect(simulationPreferences({allow_database_defaults:false,allow_recorded_assignments:false}).allow_database_defaults).toBe(false);
 expect(simulationPreferences(null)).toMatchObject({allow_database_defaults:true,allow_recorded_assignments:true,species_order:'chemical'});
 expect(resultPreferences({playback_ms:250,layout:'grid'})).toMatchObject({playback_ms:250,layout:'grid'});
 expect(resultPreferences({playback_ms:-1})).toMatchObject({playback_ms:600});
});
it('history restores blank inputs while rejecting damaged code before replacing current content',()=>{
 const config=structuredClone(DEFAULT_CONFIG);config.points[0].temperature_c=NaN;
 const document={version:1,id:'test',database:{kind:'rtdb',path:'/test.rtdb'},config,updated_at:'2026-09-08'};
 expect(Number.isNaN(decodeDocument(encodeDraft(document)).config.points[0].temperature_c)).toBe(true);
 expect(()=>decodeDocument({...document,code_editor:{version:1,mode:'code',document:{cells:[]}}})).toThrow();
});
it('species preview uses the precise record identity and ignores a delayed response after moving to another record',async()=>{
 let finish:(value:any)=>void=()=>{};const item={id:'a',name:'CuCl A',formula:'CuCl+',phase:'aqueous' as const,charge:1,elements:['Cu','Cl'],disabled:false,reason:'',is_water:false,ion_size:null};
 const other={...item,id:'b',name:'CuCl B'};mocks.invoke.mockImplementation((_command,args)=>args.speciesId==='a'?new Promise(resolve=>finish=resolve):Promise.resolve({model:{type:'hkf',parameters:{Gf:22}},references:['B reference']}));
 const view=render(<SpeciesGrid items={[item]} selected={new Set()} disabled={false} handleId="db" onToggle={()=>{}}/>);
 fireEvent.focus(screen.getByRole('button',{name:'参与平衡 CuCl A'}));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('species_details',{handleId:'db',speciesId:'a',name:'CuCl A'}));
 view.rerender(<SpeciesGrid items={[other]} selected={new Set()} disabled={false} handleId="db" onToggle={()=>{}}/>);fireEvent.focus(screen.getByRole('button',{name:'参与平衡 CuCl B'}));await screen.findByText('B reference');
 await act(async()=>finish({model:{type:'hkf',parameters:{Gf:11}},references:['A reference']}));expect(screen.queryByText('A reference')).toBeNull();expect(screen.getByRole('tooltip').textContent).toContain('22');
 fireEvent.keyDown(window,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();
});
