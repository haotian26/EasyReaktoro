// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {undo} from '@codemirror/commands';
import {setLanguage,useLanguage} from './i18n';
import {encodeDraft} from './draft-json';
import {Config,DEFAULT_CONFIG,makeRoute,SimSpecies} from './simulation-types';
import {defaultSchedule,compileSchedule} from './simulation-schedule';
import {targetDescription} from './simulation-loops';
import {ScheduleEditor} from './ScheduleEditor';
import {SchedulePreview} from './SchedulePreview';
import {ReactionStageEditor} from './ReactionStageEditor';
import {SimulationMaterials} from './SimulationSpecies';
import {SimulationActivity,MODEL_NAMES} from './SimulationActivity';
import SimulationCode,{codeCellTitle} from './SimulationCode';
import {CodeDocument,useSimulationCode} from './use-simulation-code';
import {SpeciesPreview,createSpeciesPreviewCache} from './SpeciesPreview';
const api=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:api.invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:vi.fn(),save:vi.fn()}));
const water:SimSpecies={name:'water',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null};
beforeEach(()=>{const storage=new Map<string,string>();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});setLanguage('zh-CN');api.invoke.mockReset();Element.prototype.scrollIntoView=vi.fn();Range.prototype.getClientRects=()=>[] as any;Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0,x:0,y:0,toJSON(){}});});
afterEach(()=>{cleanup();setLanguage('zh-CN');});
function config():Config{return {...structuredClone(DEFAULT_CONFIG),name:'My study',species:['water'],materials:[{id:'fluid',name:'User fluid',inputs:[{species:'water',amount:NaN,unit:'kg'}]}],reaction_stages:{first_start:[{...makeRoute('all','material'),id:'fresh',material_id:'fluid',fraction:2}],first_following:[{...makeRoute('all','previous_point'),id:'flow',fraction:.25}],later_start:[],later_following:[]},schedule:{...defaultSchedule(),positions:3,parameters:[{id:'T',target:{kind:'temperature'},value:{mode:'list',along:'path',values:[25,50,75]}},{id:'P',target:{kind:'pressure'},value:{mode:'fixed',value:1}},{id:'dose',target:{kind:'material_amount',material_id:'fluid',species:'water'},value:{mode:'fixed',value:1}},{id:'portion',target:{kind:'route_fraction',route_id:'fresh',field:'fraction'},value:{mode:'fixed',value:2}},{id:'fraction',target:{kind:'route_fraction',route_id:'flow',field:'fraction'},value:{mode:'fixed',value:.25}}]}};}
const switchTo=(language:'en'|'zh-CN')=>act(()=>setLanguage(language));
describe('simulation language switching preserves scientific inputs',()=>{
 it('keeps sequence drafts and compiles the same values while fractions and portions retain their scales',()=>{
  let current=config();function Harness(){const [value,setValue]=useState(current);current=value;return <ScheduleEditor config={value} schedule={value.schedule!} onChange={schedule=>setValue({...value,schedule})}/>;}
  const view=render(<Harness/>),original=structuredClone(current),before=compileSchedule(current),fractionTarget={kind:'route_fraction' as const,route_id:'flow',field:'fraction' as const},portionTarget={kind:'route_fraction' as const,route_id:'fresh',field:'fraction' as const};
  const sequence=screen.getByLabelText('温度 数列') as HTMLTextAreaElement;fireEvent.change(sequence,{target:{value:'25, 50, 75, '}});expect(sequence.value).toBe('25, 50, 75, ');
  switchTo('en');expect(screen.getByLabelText('Temperature sequence')).toBe(sequence);expect(sequence.value).toBe('25, 50, 75, ');
  const fraction=view.container.querySelector('#schedule-setting-fraction input') as HTMLInputElement,portions=view.container.querySelector('#schedule-setting-portion input') as HTMLInputElement;
  expect(fraction.value).toBe('25');expect(portions.value).toBe('2');expect(targetDescription(fractionTarget,current).quantityKind).toBe('fraction');
  for(let i=0;i<3;i++){expect(compileSchedule(current).point(i,0)).toEqual(before.point(i,0));expect(compileSchedule(current).valueAt(fractionTarget,i,0)).toBe(.25);expect(compileSchedule(current).valueAt(portionTarget,i,0)).toBe(2);}
  fireEvent.change(fraction,{target:{value:'40'}});expect(compileSchedule(current).valueAt(fractionTarget,1,0)).toBe(.4);expect(Number.isNaN(current.materials[0].inputs[0].amount)).toBe(true);
  switchTo('zh-CN');expect(screen.getByLabelText('温度 数列')).toBe(sequence);expect(sequence.value).toBe('25, 50, 75, ');expect(fraction.value).toBe('40');expect(original.materials).toEqual(current.materials);
 });
 it('labels local round scopes correctly in English without changing the selected scope',()=>{
  const c=config();c.schedule!.rounds=4;c.schedule!.overrides=[{id:'local',rounds:{start:2,end:4,step:2},positions:{start:1},parameters:[]}];
  const change=vi.fn();render(<ScheduleEditor config={c} schedule={c.schedule!} onChange={change} highlightId="local"/>);switchTo('en');fireEvent.click(screen.getByText('Adjust the round and position ranges'));
  expect(screen.getByText('Starting round')).toBeTruthy();expect(screen.getByText('Every N rounds')).toBeTruthy();expect((screen.getByLabelText('Rounds range start') as HTMLInputElement).value).toBe('2');expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Rounds selection interval'),{target:{value:'3'}});expect(change.mock.calls[0][0].overrides[0].rounds).toEqual({start:2,end:4,step:3});
 });
 it('updates actual reaction labels and table units without resetting the selected point or metric',()=>{
  const c=config(),change=vi.fn(),view=render(<SchedulePreview config={c} items={[water]} selected={{inner:1,outer:0}} onSelect={change} onAdjust={vi.fn()}/>);
  fireEvent.click(screen.getByRole('tab',{name:'逐点条件表'}));const metric=screen.getByLabelText('条件表附加参数');fireEvent.change(metric,{target:{value:'route:flow:fraction'}});
  // Use the option identity exposed by the control, independent of translated text.
  const select=metric as HTMLSelectElement;const option=[...select.options].find(o=>o.textContent?.includes('取用比例'));if(option)fireEvent.change(metric,{target:{value:option.value}});
  const chosen=select.value;expect(chosen).not.toBe('');switchTo('en');expect(screen.getByLabelText('Additional parameter in the conditions table')).toBe(select);expect(select.value).toBe(chosen);expect(screen.getByRole('tab',{name:'Conditions by point'}).getAttribute('aria-selected')).toBe('true');
  expect(view.container.querySelector('[data-actual-temperature]')?.textContent).toContain('50');expect(change).not.toHaveBeenCalled();expect(view.container.textContent).not.toMatch(/[\u3400-\u9fff]/);
 });
 it('preserves an incomplete Python edit and CodeMirror undo while translating standard module headings',()=>{
  const original:CodeDocument={version:2,cells:[{id:'conditions',title:'反应路径与条件',description:'',source:'temperature = 25\n'},{id:'process',title:'My custom module',description:'User explanation',kind:'execution',source:'# 我的注释\n',baseline_source:'# 我的注释\n'}]};let current=original;
  function Harness(){const [document,setDocument]=useState(original);current=document;return <SimulationCode document={document} onChange={(id,source)=>setDocument(d=>({...d,cells:d.cells.map(c=>c.id===id?{...c,source}:c)}))} disabled={false} visible dirty processing={false} issues={[]} persisted onApply={vi.fn()} onDiscard={vi.fn()} onRestore={vi.fn()} canRestore={false} custom onResetProgram={vi.fn()}/>;}
  const view=render(<Harness/>),content=screen.getByLabelText('反应路径与条件代码'),editor=EditorView.findFromDOM(content)!;act(()=>editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:'temperature = 100e'}}));
  switchTo('en');expect(screen.getByLabelText('Reaction path and conditions code')).toBe(content);expect(EditorView.findFromDOM(content)).toBe(editor);expect(editor.state.doc.toString()).toBe('temperature = 100e');expect(current.cells[0].title).toBe('反应路径与条件');expect(current.cells[1].source).toBe('# 我的注释\n');expect(codeCellTitle(current.cells[1])).toBe('My custom module');expect(view.container.textContent).toContain('User explanation');
  expect(view.container.textContent).toContain('Set temperature, pressure, or input changes'); // English module help is evaluated at render time.
  act(()=>{expect(undo(editor)).toBe(true);});expect(editor.state.doc.toString()).toBe('temperature = 25\n');switchTo('zh-CN');expect(screen.getByLabelText('反应路径与条件代码')).toBe(content);
 });
 it('refreshes model explanations and native parameter labels without refetching species data',async()=>{
  const c=config();c.activity_model='ideal';const change=vi.fn(),view=render(<SimulationActivity config={c} items={[water]} patch={change} disabled={false} phreeqcAvailable={false}/>);const formula=view.container.querySelector('.katex')?.innerHTML;
  switchTo('en');expect(MODEL_NAMES.ideal).toBe('Ideal aqueous solution');expect(view.container.textContent).toContain('molality');expect(view.container.textContent).not.toMatch(/[\u3400-\u9fff]/);expect(view.container.querySelector('.katex')?.innerHTML).toBe(formula);expect(change).not.toHaveBeenCalled();view.unmount();
  api.invoke.mockResolvedValue({model:{native_type:'HKF'},model_parameters:{HKF:{charge:2,Tmax:500}}});switchTo('zh-CN');render(<SpeciesPreview item={water} handleId="db" rect={{left:20,right:100,top:200,bottom:240}} id="peek" cache={createSpeciesPreviewCache()}/>);await screen.findByText('最高温度');switchTo('en');expect(screen.getByText('Maximum temperature')).toBeTruthy();expect(screen.getByText('Charge')).toBeTruthy();expect(api.invoke).toHaveBeenCalledTimes(1);
 });
 it('keeps unfilled composition amounts and free-form names unchanged through both languages',()=>{
  const c=config();c.schedule!.parameters=c.schedule!.parameters.filter(s=>s.id!=='dose');c.materials[0].name='我的 fluid';const patch=vi.fn(),view=render(<SimulationMaterials config={c} items={[water]} patch={patch} disabled={false} onError={vi.fn()}/>);const amount=screen.getByLabelText('water 投料量') as HTMLInputElement;expect(amount.value).toBe('');switchTo('en');expect(screen.getByLabelText('water input amount')).toBe(amount);expect(amount.value).toBe('');expect(screen.getByDisplayValue('我的 fluid')).toBeTruthy();switchTo('zh-CN');expect(Number.isNaN(c.materials[0].inputs[0].amount)).toBe(true);expect(patch).not.toHaveBeenCalled();expect(view.container.querySelectorAll('.sim-material-editor')).toHaveLength(1);
 });
 it('does not reload, parse, or rewrite a restored incomplete code draft on a language change',async()=>{
  const c=config(),ids=['system','materials','conditions','transfers','activity','solver','runtime','build','states','equilibrium','inventory','collect','process','execute'];
  const document:CodeDocument={version:2,cells:ids.map((id,index)=>({id,title:id,description:id,source:index<6?'value = [':'# custom source',baseline_source:index<6?undefined:'# standard source',kind:index<6?undefined:'execution'}))};
  const key='test.simulation.language.draft';localStorage.setItem(key+':code',JSON.stringify(encodeDraft({version:1,mode:'code',config:c,document,dirty:true})));
  api.invoke.mockImplementation(async(_command,args)=>args.payload.action==='code_render'?{...document,cells:document.cells.map(cell=>({...cell}))}:{});
  let hook:ReturnType<typeof useSimulationCode>;const error=vi.fn();function Harness(){useLanguage();const [value,setValue]=useState(c);hook=useSimulationCode(value,setValue,key,true,error);return <output>{hook.ready?'ready':'loading'}</output>;}
  render(<Harness/>);await screen.findByText('ready');await waitFor(()=>expect(hook!.document).not.toBeNull());const snapshot=JSON.stringify(encodeDraft(hook!.snapshot())),stored=localStorage.getItem(key+':code'),calls=api.invoke.mock.calls.length;
  switchTo('en');switchTo('zh-CN');expect(JSON.stringify(encodeDraft(hook!.snapshot()))).toBe(snapshot);expect(localStorage.getItem(key+':code')).toBe(stored);expect(hook!.mode).toBe('code');expect(hook!.dirty).toBe(true);expect(api.invoke).toHaveBeenCalledTimes(calls);expect(error).not.toHaveBeenCalled();localStorage.removeItem(key+':code');
 });

});
