// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {useState} from 'react';
import {useSimulationCode} from './use-simulation-code';
import {encodeDraft} from './draft-json';
import scheduledEmptyBase from './fixtures/scheduled-empty-base.ersim.json';
import {historyDocuments,mockHistory,currentHistory,flushHistory} from './test-history';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Simulation from './Simulation';
import {DEFAULT_CONFIG,Config,readConfig} from './simulation-types';
import {compileSchedule,defaultSchedule} from './simulation-schedule';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn(),save:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:mocks.open,save:mocks.save}));
// The Python parser is exercised against real source in test_simulation_code.py.
// This transport fixture tests orchestration, stale replies and lossless drafts.
vi.mock('./SimulationCode',()=>({default:(p:any)=><div>{p.document.cells.map((c:any)=><textarea key={c.id} aria-label={c.id+' source'} value={c.source} disabled={p.disabled || p.processing} onChange={e=>p.onChange(c.id,e.target.value)}/>)}<button onClick={p.onDiscard}>放弃代码</button></div>}));
const key='easyreaktoro.simulation.v2:/test/code.rtdb';
const cfg={...structuredClone(DEFAULT_CONFIG),name:'代码测试',species:['water'],activity_model:'ideal' as const,materials:[{id:'initial',name:'water recipe',inputs:[{species:'water',amount:1,unit:'kg' as const}]}]};
const summary={handle_id:'db',kind:'rtdb',path:'/test/code.rtdb',dirty:false};
const runtime={available:true};
const items=[{name:'water',formula:'H2O',phase:'aqueous',elements:['H','O'],is_water:true,disabled:false,reason:'',charge:0,ion_size:null}];
const documentFor=(c:any)=>({version:2,cells:['system','materials','conditions','transfers','activity','solver','runtime','build','states','equilibrium','inventory','collect','process','execute'].map(id=>({id,title:id,description:id,baseline_source:'# preserved comment',kind:['runtime','build','states','equilibrium','inventory','collect','process','execute'].includes(id)?'execution':undefined,source:id==='conditions'?JSON.stringify(c):'# preserved comment'}))});
let custom:((a:string,p:any)=>any)|null;
beforeEach(()=>{
 const values=new Map<string,string>();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
 vi.clearAllMocks();historyDocuments.clear();custom=null;localStorage.setItem(key,JSON.stringify(cfg));
 mocks.invoke.mockImplementation(async(command,{payload:p})=>{
  if(command==='simulation_history')return mockHistory(p);
  const special=custom?.(p.action,p);if(special!==undefined)return special;
  if(p.action==='catalog')return {items};
  if(p.action==='code_render'){const result=documentFor(p.config);for(const c of result.cells){if(c.kind==='execution'){const prev=p.previous?.cells.find((x:any)=>x.id===c.id);if(prev && prev.source!==prev.baseline_source)c.source=prev.source;}}return result;}
  if(p.action==='code_parse'){try{return {valid:true,config:JSON.parse(p.document.cells.find((c:any)=>c.id==='conditions').source),errors:[]};}catch{return {valid:false,errors:[{cell_id:'conditions',line:1,message:'incomplete'}]};}}
  if(p.action==='validate')return {total:1};
  if(p.action==='save_settings')return {success:true,output_path:p.path};
  if(p.action==='start')return {job_id:'test',output_path:'/test/run',status:'completed',completed:1,total:1};
  return {};
 });
});
afterEach(cleanup);
async function openCode(){const view=render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await waitFor(()=>expect((screen.getByRole('button',{name:'代码'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'代码'}));await screen.findByLabelText('conditions source');return view;}
function edit(next:any){fireEvent.change(screen.getByLabelText('conditions source'),{target:{value:typeof next==='string'?next:JSON.stringify(next)}});}
const calls=(action:string)=>mocks.invoke.mock.calls.filter(([,a])=>a.payload.action===action).map(([,a])=>a.payload);
const actualConditions=(c:Config)=>compileSchedule(readConfig(c,{allowDraft:true})).point(0,0);
function conditionInput(label:'温度'|'压力'){return screen.getByLabelText(`first_start ${label}`) as HTMLInputElement;}

describe('UI and code integration',()=>{
 it('keeps unfinished code in its own simulation when creating and switching history',async()=>{
  await openCode();edit('unfinished custom calculation [');fireEvent.click(screen.getByRole('button',{name:'新建模拟'}));await screen.findByText(/已新建模拟/);
  expect(screen.queryByLabelText('conditions source')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));fireEvent.click(screen.getByRole('button',{name:/^代码测试/}));
  await screen.findByLabelText('conditions source');expect((screen.getByLabelText('conditions source') as HTMLTextAreaElement).value).toBe('unfinished custom calculation [');expect(calls('start')).toHaveLength(0);
 });
 it('round-trips current UI values and runs the edited code configuration',async()=>{
  await openCode();const next=structuredClone(cfg);next.points[0].temperature_c=180;next.materials[0].inputs[0].amount=.35;edit(next);
  fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));
  fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));expect((conditionInput('温度') as HTMLInputElement).value).toBe('180');
  fireEvent.change(conditionInput('压力'),{target:{value:'75'}});fireEvent.click(screen.getByRole('button',{name:'代码'}));await waitFor(()=>expect(calls('code_render')).toHaveLength(2));
  expect(actualConditions(calls('code_render')[1].config).pressure_bar).toBe(75);expect(calls('code_render')[1].previous.cells[0].source).toBe('# preserved comment');
  next.points[0].temperature_c=210;edit(next);mocks.open.mockResolvedValue('/test/output');fireEvent.click(screen.getByRole('button',{name:'检查并运行代码'}));
  await waitFor(()=>expect(calls('start')).toHaveLength(1));expect(calls('start')[0].config.points[0].temperature_c).toBe(210);expect(actualConditions(calls('start')[0].config).temperature_c).toBe(210);expect(calls('start')[0].config.materials[0].inputs[0].amount).toBe(.35);expect(calls('start')[0].code_editor.document.cells[2].source).toBe(JSON.stringify(next));
 });
 it('regenerates code from edited formulas, stop rules and input fractions, then uses those same parameters for execution',async()=>{
  await openCode();fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));
  fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));
  fireEvent.change(screen.getByLabelText('first_start 温度'),{target:{value:'150'}});
  fireEvent.change(screen.getByLabelText('first_following 温度'),{target:{value:'T-20'}});
  fireEvent.change(screen.getByLabelText('first_start 压力'),{target:{value:'Psat(T)'}});
  fireEvent.change(screen.getByLabelText('first_following 压力'),{target:{value:'Psat(T)'}});
  fireEvent.change(screen.getByLabelText('first_following 物料 1 用量'),{target:{value:'1/(i+1)'}});
  fireEvent.change(screen.getByLabelText('first 结束条件'),{target:{value:'T <= 90'}});
  fireEvent.click(screen.getByRole('button',{name:'代码'}));await waitFor(()=>expect(screen.getByRole('button',{name:'代码'}).getAttribute('aria-pressed')).toBe('true'));
  const shown=JSON.parse((screen.getByLabelText('conditions source') as HTMLTextAreaElement).value),plan=compileSchedule(shown);
  expect(plan.lengths).toEqual([4]);expect(plan.point(3,0).temperature_c).toBe(90);expect(plan.point(3,0).pressure_bar).toBeCloseTo(.7018267758,9);
  const route=shown.reaction_stages.first_following[0];expect(plan.valueAt({kind:'route_fraction',route_id:route.id,field:'fraction'},3,0,route.fraction)).toBe(.25);
  mocks.open.mockResolvedValue('/test/output');fireEvent.click(screen.getByRole('button',{name:'运行 4 个平衡点'}));await waitFor(()=>expect(calls('start')).toHaveLength(1));
  expect(calls('start')[0].config.schedule).toEqual(shown.schedule);expect(calls('start')[0].config.reaction_stages).toEqual(shown.reaction_stages);
 });
 it('applies edited legacy loop source after history migration without losing custom solver code',async()=>{
  const legacy={...structuredClone(cfg),loops:{base:{temperature_c:25,pressure_bar:1},inner:{mode:'repeat' as const,count:1},outer:{mode:'repeat' as const,count:1}}};
  const document=documentFor(legacy),oldSource='loops = {"base": {"temperature_c": 25, "pressure_bar": 1}, "inner": {"mode": "repeat", "count": 1}, "outer": {"mode": "repeat", "count": 1}}';
  document.cells.find(cell=>cell.id==='conditions')!.source=oldSource;
  document.cells.find(cell=>cell.id==='process')!.source='# keep my custom reaction process';
  localStorage.setItem(key,JSON.stringify(legacy));localStorage.setItem(key+':code',JSON.stringify({version:1,mode:'code',document,config:legacy,dirty:false}));
  await openCode();expect((screen.getByLabelText('conditions source') as HTMLTextAreaElement).value).toBe(oldSource);
  const editedSource=oldSource.replace('temperature_c": 25','temperature_c": 100');edit(editedSource);
  custom=(action,p)=>{
   if(action!=='code_parse')return undefined;
   // The real parser clears the competing schedule when the visible source sets loops.
   // Verify this reachable migration boundary and that the UI accepts its canonical result.
   expect(p.config.loops).toBeUndefined();expect(actualConditions(p.config).temperature_c).toBe(25);
   expect(p.document.cells.find((cell:any)=>cell.id==='conditions').source).toBe(editedSource);
   return {valid:true,config:{...p.config,schedule:undefined,loops:{...legacy.loops,base:{temperature_c:100,pressure_bar:1}}},errors:[]};
  };
  fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));
  fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));expect(conditionInput('温度').value).toBe('100');await act(flushHistory);
  expect(currentHistory().config.loops).toBeUndefined();expect(actualConditions(currentHistory().config).temperature_c).toBe(100);
  expect(currentHistory().code_editor!.document!.cells.find(cell=>cell.id==='conditions')!.source).toBe(editedSource);
  expect(currentHistory().code_editor!.document!.cells.find(cell=>cell.id==='process')!.source).toBe('# keep my custom reaction process');
 });
 it('opens the effective composition parameter from its quantity field and immediately reflects the edit',async()=>{
  Element.prototype.scrollIntoView=vi.fn();const c={...structuredClone(cfg),schedule:defaultSchedule()};c.schedule.parameters.push({id:'actual-water',target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:2}});
  localStorage.setItem(key,JSON.stringify(c));render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await screen.findByRole('button',{name:'参与平衡 water'});
  fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));expect((screen.getByLabelText('water 投料量') as HTMLInputElement).value).toBe('2');fireEvent.click(screen.getByRole('button',{name:'修改通常设置中的water 每份含量'}));
  await waitFor(()=>expect(screen.getByRole('tab',{name:/计算流程/}).getAttribute('aria-selected')).toBe('true'));
  const actual=document.getElementById('schedule-setting-actual-water')!;expect(actual).toBeTruthy();const value=actual.querySelector('input.wave-formula') as HTMLInputElement;expect(value.value).toBe('2');fireEvent.change(value,{target:{value:'3'}});
  fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));expect((screen.getByLabelText('water 投料量') as HTMLInputElement).value).toBe('3');await act(flushHistory);expect(compileSchedule(currentHistory().config).valueAt({kind:'material_amount',material_id:'initial',species:'water'},0,0)).toBe(3);
  expect(currentHistory().config.materials[0].inputs[0].amount).toBe(1);
 });
 it('keeps an unused blank base quantity through code transport and requires it again after coverage is removed',async()=>{
  const c={...structuredClone(cfg),schedule:defaultSchedule()};c.materials[0].inputs[0].amount=NaN;c.schedule.parameters.push({id:'actual-water',target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:2}});
  localStorage.setItem(key,JSON.stringify(encodeDraft(c)));await openCode();expect(calls('code_render').at(-1).config.materials[0].inputs[0].amount).toEqual({easyreaktoro_empty_number:true});
  custom=(action,p)=>{if(action!=='code_parse')return undefined;const parsed=JSON.parse(p.document.cells.find((cell:any)=>cell.id==='conditions').source);parsed.materials[0].inputs[0].amount=null;return {valid:true,config:parsed,errors:[]};};
  fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));fireEvent.click(screen.getByRole('button',{name:'移除此条件'}));
  const before=calls('code_render').length;fireEvent.click(screen.getByRole('button',{name:'代码'}));await screen.findByText(/数值尚未填完整/);expect(calls('code_render')).toHaveLength(before);expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true');await act(flushHistory);expect(currentHistory().config.materials[0].inputs[0].amount).toEqual({easyreaktoro_empty_number:true});
 });
 it('loads a complete worker-saved file with an unused null base and exports it again without filling the base',async()=>{
  const source=structuredClone(scheduledEmptyBase),saltTarget={kind:'material_amount' as const,material_id:'initial',species:'NaCl(aq)'};
  custom=(action)=>action==='load_settings'?source:action==='catalog'?{items:source.config.species.map(name=>({...items[0],name,is_water:name==='H2O(aq)'}))}:undefined;
  render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await waitFor(()=>expect((screen.getByRole('button',{name:'载入设置'}) as HTMLButtonElement).disabled).toBe(false));
  mocks.open.mockResolvedValue('/test/Scheduled dose with empty base/simulation.ersim.json');fireEvent.click(screen.getByRole('button',{name:'载入设置'}));await screen.findByText(/已从设置文件新建独立模拟/);await act(flushHistory);
  let restored=currentHistory();expect(restored.config.name).toBe(source.config.name);expect(restored.config.materials[0].inputs[1].amount).toEqual({easyreaktoro_empty_number:true});expect(compileSchedule(readConfig(restored.config,{allowDraft:true})).valueAt(saltTarget,0,0)).toBe(.2);
  expect(restored.code_editor.document.cells.find((cell:any)=>cell.id==='materials').source).toBe(source.code_editor.document.cells.find(cell=>cell.id==='materials')!.source);
  fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));expect((screen.getByLabelText('NaCl(aq) 投料量') as HTMLInputElement).value).toBe('0.2');expect((screen.getByLabelText('NaCl(aq) 投料量') as HTMLInputElement).disabled).toBe(true);
  mocks.save.mockResolvedValue('/test/roundtrip.ersim.json');fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await waitFor(()=>expect(calls('save_settings')).toHaveLength(1));expect(calls('save_settings')[0].config.materials[0].inputs[1].amount).toEqual({easyreaktoro_empty_number:true});expect(calls('save_settings')[0].config.schedule).toEqual(source.config.schedule);expect(calls('save_settings')[0].config.reaction_stages).toEqual(source.config.reaction_stages);expect(calls('start')).toHaveLength(0);
  expect(source.config.materials[0].inputs[1].amount).toBeNull();expect(source.code_editor.document.cells.find(cell=>cell.id==='materials')!.source).toContain('None');
 });
 it('exports and reloads an unfinished UI quantity as a draft while keeping execution blocked',async()=>{
  render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await screen.findByRole('button',{name:'参与平衡 water'});fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));fireEvent.change(screen.getByLabelText('water 投料量'),{target:{value:''}});
  mocks.save.mockResolvedValue('/test/unfinished.ersim.json');fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await waitFor(()=>expect(calls('save_settings')).toHaveLength(1));const saved=calls('save_settings')[0];expect(saved.config.materials[0].inputs[0].amount).toEqual({easyreaktoro_empty_number:true});
  custom=action=>action==='load_settings'?saved:undefined;mocks.open.mockResolvedValue('/test/unfinished.ersim.json');fireEvent.click(screen.getByRole('button',{name:'载入设置'}));await screen.findByText(/已从设置文件新建独立模拟/);fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));expect((screen.getByLabelText('water 投料量') as HTMLInputElement).value).toBe('');fireEvent.click(screen.getByRole('button',{name:'代码'}));await screen.findByText(/数值尚未填完整/);expect(calls('start')).toHaveLength(0);expect(calls('code_render')).toHaveLength(0);
 });
 it('keeps invalid source on switching, blocks stale runs, and saves the raw edit with Shift Cmd S',async()=>{
  const view=await openCode();edit('unfinished [');fireEvent.click(screen.getByRole('button',{name:'图形'}));await screen.findByText(/代码尚未同步/);
  expect(screen.getByRole('button',{name:'代码'}).getAttribute('aria-pressed')).toBe('true');expect(calls('start')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'检查并运行代码'}));await waitFor(()=>expect(calls('code_parse')).toHaveLength(2));expect(mocks.open).not.toHaveBeenCalled();
  mocks.save.mockResolvedValue('/test/saved.ersim.json');fireEvent.keyDown(window,{key:'s',metaKey:true,shiftKey:true});await waitFor(()=>expect(calls('save_settings')).toHaveLength(1));
  expect(calls('save_settings')[0].code_editor.document.cells[2].source).toBe('unfinished [');expect(calls('save_settings')[0].config).toEqual(readConfig(cfg));
  await act(flushHistory);view.unmount();render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await screen.findByLabelText('conditions source');expect((screen.getByLabelText('conditions source') as HTMLTextAreaElement).value).toBe('unfinished [');
 });
 it('ignores code synchronization replies from a previous database',async()=>{
  const view=await openCode();let finish:any;custom=a=>a==='code_parse'?new Promise(resolve=>finish=resolve):undefined;edit({...cfg,cycles:9});fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(finish).toBeTruthy());
  view.rerender(<Simulation summary={{...summary,handle_id:'new',path:'/test/new-db.rtdb'}} runtime={runtime} onDatabases={()=>{}}/>);await screen.findByRole('button',{name:'参与平衡 water'});
  await act(async()=>finish({valid:true,config:{...cfg,cycles:9},errors:[]}));await waitFor(()=>expect([...historyDocuments.values()].find(d=>d.database.path==='/test/new-db.rtdb')?.config.cycles).toBe(1));expect(screen.queryByText(/代码尚未同步/)).toBeNull();
 });
 it('loading a UI-saved configuration cannot reapply an older code snapshot',async()=>{
  await openCode();fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));
  fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));fireEvent.change(conditionInput('温度'),{target:{value:'205'}});
  mocks.save.mockResolvedValue('/test/saved.ersim.json');fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await waitFor(()=>expect(calls('save_settings')).toHaveLength(1));
  const saved=calls('save_settings')[0];expect(actualConditions(saved.config).temperature_c).toBe(205);expect(saved.code_editor.mode).toBe('ui');
  custom=a=>a==='load_settings'?saved:undefined;mocks.open.mockResolvedValue('/test/saved.ersim.json');fireEvent.click(screen.getByRole('button',{name:'载入设置'}));await screen.findByText(/已从设置文件新建独立模拟/);
  expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true');fireEvent.click(screen.getByRole('button',{name:'代码'}));await waitFor(()=>expect(actualConditions(calls('code_render').at(-1).config).temperature_c).toBe(205));
 });
 it('retains custom execution when parameters are edited in UI and sends it to validation and run',async()=>{
  await openCode();fireEvent.change(screen.getByLabelText('process source'),{target:{value:'def custom_process(): pass'}});
  expect(screen.getByText(/已修改求解代码/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));
  fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));fireEvent.change(conditionInput('温度'),{target:{value:'120'}});
  mocks.open.mockResolvedValue('/test/output');fireEvent.click(screen.getByRole('button',{name:'运行自定义代码'}));await waitFor(()=>expect(calls('start')).toHaveLength(1));
  for(const action of ['validate','start']){const sent=calls(action)[0];expect(actualConditions(sent.config).temperature_c).toBe(120);expect(sent.code_editor.document.cells.find((c:any)=>c.id==='process').source).toBe('def custom_process(): pass');expect(sent.code_editor.mode).toBe('ui');}
 });
 it('an invalid custom program started from UI returns to its code instead of opening a save dialog',async()=>{
  await openCode();fireEvent.change(screen.getByLabelText('process source'),{target:{value:'if :'}});
  custom=(action,p)=>action==='code_parse' && !p.parameters_only?{valid:false,errors:[{cell_id:'process',line:1,message:'invalid syntax'}]}:undefined;
  fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));
  fireEvent.click(screen.getByRole('button',{name:'运行自定义代码'}));await screen.findByText(/代码尚未同步/);
  expect(screen.getByRole('button',{name:'代码'}).getAttribute('aria-pressed')).toBe('true');expect(mocks.open).not.toHaveBeenCalled();expect(calls('start')).toHaveLength(0);
  expect((screen.getByLabelText('process source') as HTMLTextAreaElement).value).toBe('if :');
 });
 it('syntax checks never claim to execute the program and save keeps custom source',async()=>{
  await openCode();fireEvent.change(screen.getByLabelText('equilibrium source'),{target:{value:'solver.solve(changed_conditions)'}});
  mocks.save.mockResolvedValue('/test/custom.ersim.json');fireEvent.click(screen.getByRole('button',{name:'保存设置'}));await waitFor(()=>expect(calls('save_settings')).toHaveLength(1));
  expect(calls('start')).toHaveLength(0);expect(calls('save_settings')[0].code_editor.document.cells.find((c:any)=>c.id==='equilibrium').source).toBe('solver.solve(changed_conditions)');
 });
 it('can recover a discarded edit without losing later UI values unless it is applied',async()=>{
  await openCode();edit('unfinished [');fireEvent.click(screen.getByRole('button',{name:'放弃代码'}));expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));fireEvent.change(conditionInput('温度'),{target:{value:'195'}});fireEvent.click(screen.getByRole('button',{name:'恢复上次代码'}));
  expect((screen.getByLabelText('conditions source') as HTMLTextAreaElement).value).toBe('unfinished [');await act(flushHistory);expect(actualConditions(currentHistory().config).temperature_c).toBe(195);
 });
});


describe('restoring shipped solver modules',()=>{
 function Harness({storageKey='restore-case'}:{storageKey?:string}){
  const [config,setConfig]=useState<Config>(structuredClone(cfg));
  const code=useSimulationCode(config,setConfig,storageKey,true,()=>{});
  return <div><output data-testid="restored-editor">{JSON.stringify(code.snapshot(),(_,v)=>typeof v==='number'&&!Number.isFinite(v)?'UNFINISHED_NUMBER':v)}</output><output data-testid="restored-processing">{String(code.processing)}</output><button disabled={code.processing} onClick={()=>code.showUI()}>同步参数</button><button disabled={code.processing} onClick={()=>{void code.resolveConfig().catch(()=>{});}}>运行前同步</button></div>;
 }
 function savedEditor(){
  const document=documentFor(cfg),standard=document.cells.find(c=>c.id==='collect')!,customCell=document.cells.find(c=>c.id==='process')!;
  standard.source='# old shipped solver';standard.baseline_source=standard.source;
  customCell.source='# my custom solver';
  document.cells.find(c=>c.id==='conditions')!.source='# my unfinished parameters\npoints = [';
  return {version:1 as const,mode:'code' as const,document,config:structuredClone(cfg),dirty:true};
 }
 it('upgrades old v2 defaults while retaining unfinished parameters, custom logic and numeric drafts',async()=>{
  const editor=savedEditor();editor.config.points[0].temperature_c=NaN;
  localStorage.setItem('restore-case:code',JSON.stringify(encodeDraft(editor)));
  render(<Harness/>);
  await waitFor(()=>{const value=JSON.parse(screen.getByTestId('restored-editor').textContent!);expect(value.document.cells.find((c:any)=>c.id==='collect').source).toBe('# preserved comment');});
  const value=JSON.parse(screen.getByTestId('restored-editor').textContent!);
  expect(value.document.cells.find((c:any)=>c.id==='conditions').source).toBe('# my unfinished parameters\npoints = [');
  expect(value.document.cells.find((c:any)=>c.id==='process').source).toBe('# my custom solver');
  expect(value.config.points[0].temperature_c).toBe('UNFINISHED_NUMBER');expect(value.dirty).toBe(true);expect(value.mode).toBe('code');
  expect(calls('code_parse')).toHaveLength(0);expect(calls('start')).toHaveLength(0);
  expect(calls('code_render')[0].config.points[0].temperature_c).toBe(0);
 });
 it('retries a failed module refresh before parsing or running old visible source',async()=>{
  const editor=savedEditor();editor.document.cells.find(c=>c.id==='conditions')!.source=JSON.stringify(cfg);editor.dirty=false;
  localStorage.setItem('restore-case:code',JSON.stringify(editor));
  let attempted=0;custom=action=>action==='code_render'&&attempted++===0?Promise.reject(new Error('temporary connection failure')):undefined;
  render(<Harness/>);await waitFor(()=>expect(calls('code_render')).toHaveLength(1));
  await waitFor(()=>expect(screen.getByTestId('restored-processing').textContent).toBe('false'));
  fireEvent.click(screen.getByRole('button',{name:'运行前同步'}));
  await waitFor(()=>expect(calls('code_parse')).toHaveLength(1));
  expect(calls('code_parse')[0].document.cells.find((c:any)=>c.id==='collect').source).toBe('# preserved comment');
  expect(JSON.parse(screen.getByTestId('restored-editor').textContent!).document.cells.find((c:any)=>c.id==='collect').source).toBe('# preserved comment');
 });
 it('ignores a restored solver reply after switching to a different simulation',async()=>{
  localStorage.setItem('restore-case:code',JSON.stringify(savedEditor()));
  let finish:any;custom=(action,p)=>action==='code_render'?new Promise(resolve=>finish=()=>resolve(documentFor(p.config))):undefined;
  const view=render(<Harness/>);await waitFor(()=>expect(finish).toBeTruthy());
  view.rerender(<Harness storageKey="other-case"/>);
  await act(async()=>finish());
  expect(screen.getByTestId('restored-editor').textContent).toBe('');
  expect(localStorage.getItem('other-case:code')).toBeNull();
 });
});

it('transports and restores an unfinished inactive point without blocking active loop code',async()=>{
 const c={...structuredClone(cfg),loops:{base:{temperature_c:25,pressure_bar:1},inner:{mode:'repeat' as const,count:1},outer:{mode:'repeat' as const,count:1}}};c.points[0].temperature_c=NaN;
 localStorage.setItem(key,JSON.stringify(encodeDraft(c)));await openCode();
 expect(calls('code_render').at(-1).config.points[0].temperature_c).toEqual({easyreaktoro_empty_number:true});expect(actualConditions(calls('code_render').at(-1).config).temperature_c).toBe(25);
 fireEvent.click(screen.getByRole('button',{name:'图形'}));await waitFor(()=>expect(screen.getByRole('button',{name:'图形'}).getAttribute('aria-pressed')).toBe('true'));
 fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));expect((conditionInput('温度') as HTMLInputElement).value).toBe('25');await act(flushHistory);
 expect(currentHistory().config.points[0].temperature_c).toEqual({easyreaktoro_empty_number:true});expect(actualConditions(currentHistory().config).temperature_c).toBe(25);
});

it('exports the actual stop-driven grid while keeping a blank local condition outside a shorter round',async()=>{
 const c={...structuredClone(cfg),schedule:{...defaultSchedule(),positions:1,rounds:1,stop:{first:'i = 3',later:'i = 1',rounds:'N = 1'},overrides:[{id:'retained-hole',point:true,rounds:{start:2,end:2},positions:{start:4,end:4},parameters:[{id:'hole-t',target:{kind:'temperature' as const},value:{mode:'fixed' as const,value:NaN}}]}]}};
 localStorage.setItem(key,JSON.stringify(encodeDraft(c)));await openCode();
 const sent=readConfig(calls('code_render').at(-1).config,{allowDraft:true});expect(compileSchedule(sent).lengths).toEqual([4,2]);expect(Number.isNaN((sent.schedule!.overrides.find(o=>o.id==='retained-hole')!.parameters[0].value as {value:number}).value)).toBe(true);
});


it('keeps an unfinished unused stage through code switching in unequal rounds',async()=>{
 const c:Config={...structuredClone(cfg),schedule:{...defaultSchedule(),stop:{first:'i = 0',later:'i = 2',rounds:'N = 1'}},reaction_stages:{first_start:[],first_following:[],later_start:[],later_following:[]}};
 c.reaction_stages!.first_following=[{...c.routes[0],id:'retained-unused',fraction:NaN}];
 c.schedule!.parameters.push({id:'unused-amount',target:{kind:'route_fraction',route_id:'retained-unused',field:'fraction'},value:{mode:'relative',along:'path',start:NaN,step:NaN,other_step:0}});
 localStorage.setItem(key,JSON.stringify(encodeDraft(c)));await openCode();
 const sent=readConfig(calls('code_render').at(-1).config,{allowDraft:true});expect(compileSchedule(sent).lengths).toEqual([1,3]);expect(Number.isNaN(sent.reaction_stages!.first_following[0].fraction)).toBe(true);
});
