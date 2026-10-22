// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CodeSyncError,useSimulationCode} from './use-simulation-code';
import {DEFAULT_CONFIG,readConfig,type Config,type EquilibriumConstraint,type SimSpecies} from './simulation-types';
import {compileSchedule,defaultSchedule,migrateSchedule} from './simulation-schedule';
import {SimulationConditions} from './SimulationConditions';
import {useSimulationUndo} from './use-simulation-undo';
import {decodeDocument} from './simulation-history';
import {encodeDraft,restoreDraft} from './draft-json';
import {setLanguage} from './i18n';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
const documentFor=(config:Config)=>({version:1,cells:['system','materials','conditions','transfers','activity','solver'].map(id=>({id,title:id,description:id,source:id==='conditions'?JSON.stringify(encodeDraft(config)):'# parameters'}))});
const ph=(value=7):EquilibriumConstraint=>({id:'acid',kind:'ph',value,titrant:'HCl',exchange:'add_only'});
const target={kind:'equilibrium_constraint' as const,constraint_id:'acid'};
function base():Config{return {...structuredClone(DEFAULT_CONFIG),schedule:defaultSchedule({temperature_c:25,pressure_bar:1}),activity_model:'ideal'};}
beforeEach(()=>{const values=new Map<string,string>();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});setLanguage('zh-CN');mocks.invoke.mockReset();mocks.invoke.mockImplementation(async(_command,{payload})=>payload.action==='code_render'?documentFor(restoreDraft(payload.config)):payload.action==='code_parse'?{valid:true,config:restoreDraft(JSON.parse(payload.document.cells.find((c:any)=>c.id==='conditions').source)),errors:[]}:{});});
afterEach(cleanup);
async function editor(config:Config){const errors=vi.fn(),setConfig=vi.fn();const hook=renderHook(({config})=>useSimulationCode(config,setConfig,'target-boundary',true,errors),{initialProps:{config}});await waitFor(()=>expect(hook.result.current.ready).toBe(true));return {...hook,errors,setConfig};}
it('keeps inactive unfinished targets through code transport and back to UI',async()=>{
 const c=base();c.equilibrium_constraints=[{...ph(NaN),rounds:{start:2}}];c.schedule!.parameters.push({id:'target-value',target,value:{mode:'fixed',value:NaN}});
 const hook=await editor(c);await act(async()=>{await hook.result.current.showCode();});expect(hook.errors).not.toHaveBeenCalled();expect(hook.result.current.mode).toBe('code');
 const payload=mocks.invoke.mock.calls.find(([,args])=>args.payload.action==='code_render')![1].payload;expect(payload.config.equilibrium_constraints[0].value).toEqual({easyreaktoro_empty_number:true});
 await act(async()=>{await hook.result.current.showUI();});expect(hook.errors).not.toHaveBeenCalled();expect(hook.result.current.mode).toBe('ui');expect(hook.setConfig.mock.calls.at(-1)![0].equilibrium_constraints[0].value).toBeNaN();expect(c.equilibrium_constraints[0].value).toBeNaN();
});
it('accepts a blank default overridden everywhere the target applies, but blocks newly uncovered positions',async()=>{
 const c=base();c.schedule!.positions=3;c.equilibrium_constraints=[{...ph(NaN),positions:{start:2,end:2}}];c.schedule!.parameters.push({id:'target-value',target,value:{mode:'fixed',value:NaN}});c.schedule!.overrides=[{id:'actual',rounds:{start:1},positions:{start:2,end:2},parameters:[{id:'actual-value',target,value:{mode:'fixed',value:-1}}]}];
 const hook=await editor(c);let resolved:Config|undefined;await act(async()=>{resolved=await hook.result.current.resolveConfig();});expect(compileSchedule(resolved!).valueAt(target,1,0)).toBe(-1);expect(resolved!.equilibrium_constraints![0].value).toBeNaN();
 const widened=structuredClone(c);widened.equilibrium_constraints![0].positions={start:1};hook.rerender({config:widened});await expect(hook.result.current.resolveConfig()).rejects.toThrow(/位置 1.*缺少有效数值/);
});
it('does not hide incomplete temperature settings behind a dormant equilibrium target',async()=>{
 const c=base();c.equilibrium_constraints=[{...ph(NaN),positions:{start:2}}];c.schedule!.parameters[0].value={mode:'fixed',value:NaN};const hook=await editor(c);await expect(hook.result.current.resolveConfig()).rejects.toBeInstanceOf(CodeSyncError);expect(mocks.invoke).not.toHaveBeenCalled();
});
it('requires active unfinished target values and leaves their draft intact',async()=>{
 const c=base();c.equilibrium_constraints=[ph(NaN)];const hook=await editor(c);await act(async()=>{await hook.result.current.showCode();});expect(hook.errors).toHaveBeenCalledWith(expect.stringMatching(/pH.*缺少有效数值/));expect(c.equilibrium_constraints[0].value).toBeNaN();expect(hook.result.current.mode).toBe('ui');
});
const items:SimSpecies[]=[{name:'CO2(g)',formula:'CO2',phase:'gas',charge:0,elements:['C','O'],is_water:false,disabled:false,reason:'',ion_size:null}];
function legacy():Config{const c=base();delete c.schedule;c.points=[{...c.points[0],routes:structuredClone(c.routes)}];c.cycles=2;c.equilibrium_constraints=[{...ph(6),rounds:{start:1,end:1}}];return c;}
let latest:Config;
function LegacyEditor({initial=legacy()}){const [config,set]=useState(initial);latest=config;return <SimulationConditions config={config} items={items} patch={patch=>set(c=>({...c,...patch}))} disabled={false} onError={vi.fn()}/>;}
it('makes imported targets editable on a position-specific legacy path without changing its sources',()=>{
 const c=legacy();expect(migrateSchedule(c)).toBeNull();render(<LegacyEditor initial={c}/>);const panel=screen.getByRole('region',{name:'平衡目标'});expect(within(panel).getByLabelText('pH 调节物质')).toHaveProperty('value','HCl');
 fireEvent.change(within(panel).getByLabelText('目标 1 数值'),{target:{value:'-1'}});fireEvent.change(within(panel).getByLabelText('pH 调节物质'),{target:{value:'NaOH'}});expect(latest.equilibrium_constraints![0]).toMatchObject({value:-1,titrant:'NaOH',rounds:{start:1,end:1}});expect(latest.points).toEqual(c.points);expect(latest.schedule).toBeUndefined();
 fireEvent.click(within(panel).getByRole('button',{name:'指定气体逸度'}));fireEvent.change(within(panel).getByLabelText('逸度目标气体'),{target:{value:'CO2(g)'}});expect(latest.equilibrium_constraints![1]).toMatchObject({kind:'fugacity',species:'CO2(g)'});expect(latest.species).toEqual(c.species);
 fireEvent.click(within(panel).getByRole('button',{name:'删除平衡目标 1'}));expect(latest.equilibrium_constraints).toHaveLength(1);expect(latest.points).toEqual(c.points);
});
it('preserves unfinished legacy target values through history, and rejects them only after their scope becomes active',async()=>{
 const c=legacy();c.equilibrium_constraints=[{...ph(NaN),rounds:{start:3}}];const stored=decodeDocument(encodeDraft({version:1,id:'saved',database:{kind:'rtdb',path:'/db'},config:c,updated_at:'2026-09-28'}));expect(stored.config.equilibrium_constraints![0].value).toBeNaN();const hook=await editor(stored.config);await expect(hook.result.current.resolveConfig()).resolves.toMatchObject({cycles:2});
 hook.rerender({config:{...stored.config,cycles:3}});await expect(hook.result.current.resolveConfig()).rejects.toThrow(/数值尚未填完整/);
});
it('undo and redo preserve target identities, scopes, and unfinished numbers',()=>{
 const initial=base();initial.equilibrium_constraints=[ph(6)];let state:Config=initial;
 const hook=renderHook(({config})=>useSimulationUndo('target-undo',true,{config},value=>{state=value.config;}),{initialProps:{config:initial}});
 const changed=readConfig(encodeDraft({...initial,equilibrium_constraints:[{...ph(NaN),positions:{start:2,end:3}}]}),{allowDraft:true});hook.rerender({config:changed});act(()=>hook.result.current.undo());expect(state.equilibrium_constraints).toEqual(initial.equilibrium_constraints);hook.rerender({config:state});act(()=>hook.result.current.redo());expect(state.equilibrium_constraints![0].id).toBe('acid');expect(state.equilibrium_constraints![0].value).toBeNaN();expect(state.equilibrium_constraints![0].positions).toEqual({start:2,end:3});
});
