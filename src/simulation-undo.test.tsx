// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG,numeric,type Config} from './simulation-types';
import {useSimulationUndo} from './use-simulation-undo';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function mount(initial:Config=structuredClone(DEFAULT_CONFIG)){
 let current=initial;
 function Harness(){
  const [config,setConfig]=useState(initial),[key,setKey]=useState('a'),[,setSaved]=useState(0);current=config;
  const undo=useSimulationUndo(key,true,{config},snapshot=>setConfig(snapshot.config));
  return <><input aria-label="Name" value={config.name} onChange={e=>setConfig({...config,name:e.target.value})}/><input aria-label="Temperature" type="number" value={Number.isFinite(config.points[0].temperature_c)?config.points[0].temperature_c:''} onChange={e=>setConfig({...config,points:config.points.map((p,i)=>i?p:{...p,temperature_c:numeric(e.target.value)})})}/><button onClick={()=>setConfig({...config,cycles:config.cycles+1})}>Add round</button><button onClick={()=>setSaved(n=>n+1)}>Save</button><button onClick={()=>{setKey('b');setConfig(structuredClone(DEFAULT_CONFIG));}}>Other simulation</button><button disabled={!undo.canUndo} onClick={undo.undo}>Undo</button><button disabled={!undo.canRedo} onClick={undo.redo}>Redo</button></>;
 }
 render(<Harness/>);return ()=>current;
}
const type=(label:string,values:string[])=>{const field=screen.getByLabelText(label);field.focus();for(const value of values)fireEvent.change(field,{target:{value}});};
const click=(name:string)=>fireEvent.click(screen.getByRole('button',{name}));
it('undoes a complete number edit, including a temporarily blank draft, then redoes its final value',()=>{
 const current=mount();type('Temperature',['','1','12','125']);expect(current().points[0].temperature_c).toBe(125);
 click('Undo');expect(current().points[0].temperature_c).toBe(DEFAULT_CONFIG.points[0].temperature_c);
 click('Redo');expect(current().points[0].temperature_c).toBe(125);
});
it('keeps different fields and add/remove commands as independent undo steps',()=>{
 const current=mount();type('Name',['A','AB']);type('Temperature',['1','18','180']);click('Add round');
 click('Undo');expect(current().cycles).toBe(DEFAULT_CONFIG.cycles);expect(current().points[0].temperature_c).toBe(180);
 click('Undo');expect(current().points[0].temperature_c).toBe(DEFAULT_CONFIG.points[0].temperature_c);expect(current().name).toBe('AB');
 click('Undo');expect(current().name).toBe(DEFAULT_CONFIG.name);
});
it('starts a new edit after blur or a pause and keeps earlier edits across save',()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);const current=mount();
 type('Name',['A','AB']);now+=2000;type('Name',['ABC']);click('Undo');expect(current().name).toBe('AB');click('Redo');
 fireEvent.blur(screen.getByLabelText('Name'));type('Name',['ABCD']);click('Save');click('Undo');expect(current().name).toBe('ABC');
});
it('drops the old redo branch after a new edit and resets history between simulations',()=>{
 const current=mount();type('Name',['A','AB']);click('Undo');type('Name',['Z','ZZ']);
 expect((screen.getByRole('button',{name:'Redo'}) as HTMLButtonElement).disabled).toBe(true);
 click('Undo');expect(current().name).toBe(DEFAULT_CONFIG.name);click('Redo');expect(current().name).toBe('ZZ');
 click('Other simulation');expect((screen.getByRole('button',{name:'Undo'}) as HTMLButtonElement).disabled).toBe(true);
});
it('retains non-finite original drafts through grouped undo',()=>{
 const initial=structuredClone(DEFAULT_CONFIG);initial.points[0].temperature_c=NaN;const current=mount(initial);
 type('Temperature',['2','25','250']);click('Undo');expect(Number.isNaN(current().points[0].temperature_c)).toBe(true);
});
