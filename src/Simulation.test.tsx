// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {historyDocuments,trashedHistoryDocuments,resultHistoryEntries,mockHistory,currentHistory,flushHistory} from './test-history';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Simulation from './Simulation';
import {SimulationConditions} from './SimulationConditions';
import {compileSchedule} from './simulation-schedule';
import {ActivityEquations,MODEL_NAMES,SimulationActivity} from './SimulationActivity';
import {DEFAULT_CONFIG,basicAqueousSpecies,sortSpecies,filterSpecies,linearRange,readConfig,SimSpecies} from './simulation-types';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn(),save:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:mocks.open,save:mocks.save}));
const water:SimSpecies={name:'water',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null};
const sodium:SimSpecies={...water,name:'sodium',formula:'Na+',charge:1,elements:['Na'],is_water:false};
const chloride:SimSpecies={...water,name:'chloride',formula:'Cl-',charge:-1,elements:['Cl'],is_water:false};
const carbon:SimSpecies={...water,name:'carbon dioxide',formula:'CO2',elements:['C','O'],is_water:false};
const items=[water,sodium,chloride,carbon];
const summary={handle_id:'db',kind:'rtdb',path:'/test/sim.rtdb',embedded_name:'sim',dirty:false};
const runtime={available:true,version:'2.13.0'};
const runConfig={...structuredClone(DEFAULT_CONFIG),name:'loaded',species:['water'],materials:[{id:'initial',name:'初始物质',inputs:[{species:'water',amount:1,unit:'kg' as const}]}],activity_model:'ideal' as const};
let handler:(action:string,payload:any)=>any;
beforeEach(()=>{const values=new Map<string,string>();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),clear:()=>values.clear()}});vi.clearAllMocks();historyDocuments.clear();trashedHistoryDocuments.clear();resultHistoryEntries.clear();handler=(action)=>action==='catalog'?{items}:action==='validate'?{total:1}:{};mocks.invoke.mockImplementation((command,{payload})=>Promise.resolve().then(()=>command==='simulation_history'?mockHistory(payload):handler(payload.action,payload)));});
afterEach(cleanup);
const start=()=>screen.getByRole('button',{name:/运行 .* 个平衡点/});
async function loaded(){const key='easyreaktoro.simulation.v2:/test/sim.rtdb';if(localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify(DEFAULT_CONFIG));const result=render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await waitFor(()=>expect((screen.getByRole('button',{name:'参与平衡 water'}) as HTMLButtonElement).disabled).toBe(false));return result;}
async function selectWater(){await loaded();fireEvent.click(screen.getByRole('button',{name:'参与平衡 water'}));fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));fireEvent.click(screen.getByRole('button',{name:'添加投料 water'}));}

describe('equilibrium workbench',()=>{
 it('restores the saved result belonging to the selected simulation',async()=>{
  await loaded();fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'With results'}});await act(flushHistory);const first=currentHistory();
  fireEvent.click(screen.getByRole('button',{name:'新建模拟'}));await screen.findByText(/已新建模拟/);historyDocuments.set(first.id,{...first,last_result:'/saved/first-run'});
  handler=(action,payload)=>action==='open_run'?{job_id:'old-result',output_path:payload.path,status:'completed',completed:0,total:1}:{};
  fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));await waitFor(()=>expect(screen.getAllByRole('button',{name:'查看结果'}).length).toBe(2));fireEvent.click(screen.getByRole('button',{name:/^With results/}));
  await waitFor(()=>expect(mocks.invoke.mock.calls.some(([,a])=>a.payload.action==='open_run'&&a.payload.path==='/saved/first-run')).toBe(true));
  expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe('With results');
 });
 it('creates a separate simulation and restores the previous name, feed and blank input from history',async()=>{
  await selectWater();fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'First experiment'}});
  fireEvent.change(screen.getByLabelText('water 投料量'),{target:{value:''}});await act(flushHistory);
  const first=currentHistory().id;fireEvent.click(screen.getByRole('button',{name:'新建模拟'}));
  await waitFor(()=>expect(historyDocuments.size).toBe(2));await screen.findByText(/已新建模拟/);
  expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe(DEFAULT_CONFIG.name);
  fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));fireEvent.click(screen.getByRole('button',{name:/^First experiment/}));
  await waitFor(()=>expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe('First experiment'));
  fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));expect((screen.getByLabelText('water 投料量') as HTMLInputElement).value).toBe('');
  expect(historyDocuments.get(first).config.materials[0].inputs[0].amount).toEqual({easyreaktoro_empty_number:true});
 });
 it('does not replace current edits when their automatic save fails before a new simulation',async()=>{
  await loaded();fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Keep this edit'}});
  const previous=mocks.invoke.getMockImplementation()!;mocks.invoke.mockImplementation((command,args)=>command==='simulation_history'&&args.payload.action==='write'?Promise.reject('磁盘不可写'):previous(command,args));
  fireEvent.click(screen.getByRole('button',{name:'新建模拟'}));await screen.findByText('磁盘不可写');
  expect(historyDocuments.size).toBe(1);expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe('Keep this edit');
  mocks.invoke.mockImplementation(previous);await act(flushHistory);expect(currentHistory().config.name).toBe('Keep this edit');
 });
 it('periodic filters distinguish subset, any and all',()=>{expect(filterSpecies(items,'','',['H','O'],'only',false,new Set()).map(x=>x.name)).toEqual(['water']);expect(filterSpecies(items,'','',['O'],'any',false,new Set()).map(x=>x.name)).toEqual(['water','carbon dioxide']);expect(filterSpecies(items,'','',['H','O'],'all',false,new Set()).map(x=>x.name)).toEqual(['water']);});
 it('migrates saved workflows while preserving the rock partition and live draft',()=>{
  const old={...DEFAULT_CONFIG,schema_version:1,mode:'repeated_flushing',passes:3,solid_distribution:'total_evenly',inputs:runConfig.materials[0].inputs,points:[{label:'a',temperature_c:100,pressure_bar:300},{label:'b',temperature_c:100,pressure_bar:200}]};
  const c=readConfig(old);expect(c.cycles).toBe(3);expect(c.routes[1].source).toBe('previous_cycle');expect(c.routes[1].fallback_fraction).toBe(.5);expect(c.materials[0].inputs).toEqual(old.inputs);expect('mode' in c).toBe(false);
 });
 it('rejects damaged settings and bounds generated points',()=>{expect(linearRange(700,150,-200)).toEqual([700,500,300,150]);expect(()=>linearRange(700,150,5)).toThrow();expect(()=>linearRange(0,1e10,.01)).toThrow();for(const change of [{schema_version:99},{ion_size_overrides:null},{cycles:NaN},{allow_non_nacl:'false'}])expect(()=>readConfig({...DEFAULT_CONFIG,...change})).toThrow();});
 it('species tiles toggle independently of initial materials and preserve filter state across tabs',async()=>{
  await loaded();fireEvent.change(screen.getByLabelText('搜索系统 species'),{target:{value:'water'}});fireEvent.click(screen.getByRole('button',{name:'参与平衡 water'}));expect(screen.getByRole('button',{name:'参与平衡 water'}).getAttribute('aria-pressed')).toBe('true');fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));expect(screen.queryByLabelText('water 投料量')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'添加投料 water'}));expect((screen.getByLabelText('water 投料量') as HTMLInputElement).value).toBe('1');fireEvent.click(screen.getByRole('button',{name:'移除投料 water'}));fireEvent.click(screen.getByRole('tab',{name:/系统 species/}));expect((screen.getByLabelText('搜索系统 species') as HTMLInputElement).value).toBe('water');expect(screen.getByRole('button',{name:'参与平衡 water'}).getAttribute('aria-pressed')).toBe('true');
 });
 it('undoing a species removal preserves later temperature, model and recipe changes',async()=>{
  await selectWater();fireEvent.click(screen.getByRole('tab',{name:/系统 species/}));fireEvent.click(screen.getByRole('button',{name:'参与平衡 water'}));
  fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));fireEvent.change(screen.getByLabelText('first_start 温度'),{target:{value:'180'}});
  fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));fireEvent.change(screen.getByLabelText('Composition 名称'),{target:{value:'Changed recipe'}});
  fireEvent.click(screen.getByRole('tab',{name:/系统 species/}));fireEvent.click(screen.getByRole('button',{name:'撤销移除'}));
  await act(flushHistory);const c=currentHistory().config;expect(compileSchedule(c).point(0,0).temperature_c).toBe(180);expect(c.materials[0].name).toBe('Changed recipe');expect(c.materials[0].inputs[0].amount).toBe(1);expect(c.species).toEqual(['water']);
 });
 it('ignores malformed recent-run preferences without breaking the simulation page',async()=>{localStorage.setItem('easyreaktoro.simulation.runs','{"path":"bad"}');await loaded();expect(screen.getByRole('button',{name:'参与平衡 water'})).toBeTruthy();});
 it('does not remove a referenced output point through the point generator',()=>{
  const c=structuredClone(DEFAULT_CONFIG);c.points.push({...c.points[0],id:'p2'});c.routes[0]={...c.routes[0],source:'output',point_id:'p2',lag:1};
  const patch=vi.fn(),onError=vi.fn();render(<SimulationConditions config={c} patch={patch} items={items} disabled={false} onError={onError}/>);
  fireEvent.click(screen.getByRole('button',{name:'批量生成路线'}));fireEvent.change(screen.getByLabelText('位置数（含两端）'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'生成基础路线'}));
  expect(patch).not.toHaveBeenCalled();expect(onError.mock.calls[0][0]).toContain('仍被物料来源引用');
 });
 it('can remove unavailable saved species and clears a removed explicit water identity',async()=>{
  const c={...runConfig,species:['water','missing'],water_species:'water'};const key='easyreaktoro.simulation.v2:/test/sim.rtdb';localStorage.setItem(key,JSON.stringify(c));
  await loaded();fireEvent.click(screen.getByRole('button',{name:'移除全部不可用 species'}));await act(flushHistory);expect(currentHistory().config.species).toEqual(['water']);
  fireEvent.click(screen.getByRole('button',{name:'参与平衡 water'}));await act(flushHistory);expect(currentHistory().config.water_species).toBeUndefined();
 });
 it('element selection filters without adding equilibrium species',async()=>{await loaded();fireEvent.click(screen.getByRole('button',{name:'元素周期表'}));fireEvent.click(screen.getByRole('button',{name:'加入 H / O'}));fireEvent.click(screen.getByRole('button',{name:/查看 1 个匹配 species/}));expect(screen.queryByRole('button',{name:'参与平衡 sodium'})).toBeNull();expect(screen.getByRole('button',{name:'参与平衡 water'}).getAttribute('aria-pressed')).toBe('false');fireEvent.click(screen.getByRole('button',{name:'选中筛选结果'}));expect(screen.getByRole('button',{name:'参与平衡 water'}).getAttribute('aria-pressed')).toBe('true');});
 it('requires a chosen save location before creating a worker and prevents duplicate starts',async()=>{
  let finish:any;handler=(a)=>a==='catalog'?{items}:a==='validate'?{total:1}:a==='start'?new Promise(resolve=>finish=resolve):{};mocks.open.mockResolvedValue('/test/results');await selectWater();const button=start();fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(finish).toBeTruthy());const starts=mocks.invoke.mock.calls.filter(([,a])=>a.payload.action==='start');expect(starts).toHaveLength(1);expect(starts[0][1].payload.directory).toBe('/test/results');expect(starts[0][1].payload.config.materials[0].inputs[0].species).toBe('water');await act(async()=>finish({job_id:'job',status:'running',completed:0,total:1,message:'working',output_path:'/test/results/run',elapsed_seconds:0}));expect(screen.getByRole('button',{name:'停止计算'})).toBeTruthy();
 });
 it('cancelling the save dialog never starts a worker or creates fake results',async()=>{mocks.open.mockResolvedValue(null);await selectWater();fireEvent.click(start());await waitFor(()=>expect(mocks.open).toHaveBeenCalled());expect(mocks.invoke.mock.calls.some(([,a])=>a.payload.action==='start')).toBe(false);});
 it('preserves an unfinished numeric edit as a blank in history',async()=>{await selectWater();fireEvent.change(screen.getByLabelText('water 投料量'),{target:{value:''}});await act(flushHistory);expect(currentHistory().config.materials[0].inputs[0].amount).toEqual({easyreaktoro_empty_number:true});});
 it('shows a real backend failure',async()=>{handler=a=>a==='catalog'?{items}:a==='validate'?Promise.reject(JSON.stringify({diagnostic:'净电荷不平衡'})):{};await selectWater();fireEvent.click(start());await screen.findByText('净电荷不平衡');expect(mocks.open).not.toHaveBeenCalled();});
 it('ignores a late catalog response from the previous database',async()=>{let old:any;handler=(a,p)=>a==='catalog'?(p.handle_id==='db'?new Promise(resolve=>old=resolve):{items:[sodium]}):{};const view=render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await waitFor(()=>expect(old).toBeTruthy());view.rerender(<Simulation summary={{...summary,handle_id:'new',path:'/test/new.rtdb'}} runtime={runtime} onDatabases={()=>{}}/>);await screen.findByRole('button',{name:'参与平衡 sodium'});await act(async()=>old({items:[water]}));expect(screen.queryByRole('button',{name:'参与平衡 water'})).toBeNull();});
 it('edits material sources independently from the loop variable',()=>{const patch=vi.fn();const config={...structuredClone(DEFAULT_CONFIG),cycles:3};render(<SimulationConditions config={config} patch={patch} items={items} disabled={false} onError={vi.fn()}/>);fireEvent.change(screen.getByLabelText('模拟结束条件'),{target:{value:'N=3'}});expect(compileSchedule({...config,...patch.mock.calls.at(-1)?.[0]}).counts.outer).toBe(4);fireEvent.change(screen.getByLabelText('later_start 物料 1 来源'),{target:{value:'previous_cycle'}});expect(patch.mock.calls.at(-1)?.[0].reaction_stages.later_start[0].source).toBe('previous_cycle');expect(patch.mock.calls.at(-1)?.[0].schedule.positions).toBe(1);});
 it('renders every activity model as mathematical notation with no raw TeX error',()=>{for(const model of Object.keys(MODEL_NAMES)){const view=render(<ActivityEquations model={model as any}/>);expect(view.container.querySelectorAll('math').length).toBeGreaterThan(0);expect(view.container.querySelector('.katex-error')).toBeNull();view.unmount();}});
});

 it('clears only unfinished inactive ion edits and retains valid saved parameters',()=>{
  const patch=vi.fn();const valid={a_angstrom:4,source:'Reference',reason:'Use recorded value'};
  const c={...runConfig,species:['water','sodium','chloride'],ion_size_overrides:{sodium:{a_angstrom:NaN,source:'',reason:''},chloride:valid}};
  render(<SimulationActivity config={c} items={items} patch={patch} disabled={false} phreeqcAvailable={false}/>);
  fireEvent.click(screen.getByRole('button',{name:'清除未完成的尺寸编辑'}));
  expect(patch).toHaveBeenCalledWith({ion_size_overrides:{chloride:valid}});expect(c.activity_model).toBe('ideal');
 });

it('manual saving keeps edits reversible and requires a decision when creating another simulation',async()=>{
 const view=await loaded();view.rerender(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}} autoSave={false}/>);
 const original=currentHistory().config.name;fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Manual edit'}});
 await new Promise(r=>setTimeout(r,450));expect(currentHistory().config.name).toBe(original);
 fireEvent.click(screen.getByRole('button',{name:'撤销模拟修改'}));expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe(original);
 fireEvent.click(screen.getByRole('button',{name:'重做模拟修改'}));expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe('Manual edit');
 fireEvent.click(screen.getByRole('button',{name:'新建模拟'}));await screen.findByRole('alertdialog',{name:'保存当前模拟的修改？'});fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());expect(historyDocuments.size).toBe(1);
 fireEvent.keyDown(window,{key:'s',metaKey:true});await waitFor(()=>expect(currentHistory().config.name).toBe('Manual edit'));expect(mocks.save).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Discard me'}});fireEvent.click(screen.getByRole('button',{name:'新建模拟'}));await screen.findByRole('alertdialog');fireEvent.click(screen.getByRole('button',{name:'不保存并继续'}));await screen.findByText(/已新建模拟/);
 expect([...historyDocuments.values()].some(d=>d.config.name==='Manual edit')).toBe(true);expect([...historyDocuments.values()].some(d=>d.config.name==='Discard me')).toBe(false);
});
it('deletes the active simulation without recreating it and restores its saved contents',async()=>{
 await loaded();fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Restore this one'}});await act(flushHistory);const id=currentHistory().id;
 fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));const remove=screen.getByRole('button',{name:'移到最近删除'});remove.focus();fireEvent.click(remove);await waitFor(()=>expect(historyDocuments.has(id)).toBe(false));await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('button',{name:'关闭模拟历史'})));
 await new Promise(r=>setTimeout(r,450));expect(historyDocuments.has(id)).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'最近删除'}));await screen.findByRole('button',{name:'恢复模拟'});fireEvent.click(screen.getByRole('button',{name:'恢复模拟'}));await waitFor(()=>expect(historyDocuments.get(id)?.config.name).toBe('Restore this one'));
});
it('undo remains available after saving and reverting a blank numeric field is lossless',async()=>{
 const view=await loaded();view.rerender(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}} autoSave={false}/>);fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));
 fireEvent.change(screen.getByLabelText('first_start 温度'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'保存当前模拟'}));await waitFor(()=>expect(currentHistory().config.schedule.overrides.find((o:any)=>o.rounds.start===1&&o.positions.start===1).parameters.find((p:any)=>p.target.kind==='temperature').value).toEqual({mode:'expression',expression:''}));
 fireEvent.click(screen.getByRole('button',{name:'撤销模拟修改'}));expect((screen.getByLabelText('first_start 温度') as HTMLInputElement).value).toBe('250');fireEvent.click(screen.getByRole('button',{name:'重做模拟修改'}));expect((screen.getByLabelText('first_start 温度') as HTMLInputElement).value).toBe('');
});

it('copies the saved checkpoint when unsaved changes are discarded before duplicating',async()=>{
 const view=await loaded();view.rerender(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}} autoSave={false}/>);
 const name=currentHistory().config.name;fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Do not copy this'}});
 fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));fireEvent.click(screen.getByRole('button',{name:'复制当前'}));await screen.findByRole('alertdialog');fireEvent.click(screen.getByRole('button',{name:'不保存并继续'}));
 await screen.findByText(/已复制为独立模拟/);expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe(name+' · 副本');expect([...historyDocuments.values()].some(d=>d.config.name.includes('Do not copy'))).toBe(false);
});

it('permanently deletes only the confirmed history, locking cancellation while the write is pending',async()=>{
 await loaded();fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Delete permanently'}});await act(flushHistory);const id=currentHistory().id;
 fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));fireEvent.click(screen.getByRole('button',{name:'永久删除…'}));
 let dialog=screen.getByRole('alertdialog',{name:'永久删除这份模拟？'});fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));expect(historyDocuments.has(id)).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'永久删除…'}));let release:()=>void=()=>{};const original=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation((command,args)=>command==='simulation_history'&&args.payload.action==='delete'?new Promise(resolve=>{release=()=>resolve(mockHistory(args.payload));}):original(command,args));
 fireEvent.click(screen.getByRole('button',{name:'永久删除'}));await waitFor(()=>expect(mocks.invoke.mock.calls.some(([,a])=>a.payload.action==='delete')).toBe(true));
 dialog=screen.getByRole('alertdialog');expect((within(dialog).getByRole('button',{name:'取消'}) as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>release());await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());await act(flushHistory);expect(historyDocuments.has(id)).toBe(false);
 expect(mocks.invoke.mock.calls.filter(([,a])=>a.payload.action==='delete').map(([,a])=>a.payload.id)).toEqual([id]);
});
it('does not claim to save before database and history have finished loading',async()=>{
 handler=()=>new Promise(()=>{});render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);
 fireEvent.keyDown(window,{key:'s',metaKey:true});expect(screen.queryByText('模拟已保存。')).toBeNull();expect(mocks.invoke.mock.calls.some(([,a])=>a.payload.action==='write')).toBe(false);
});

it('keeps a new result pending when an older save finishes before the result save fails',async()=>{
 mocks.open.mockResolvedValue('/test/results');await selectWater();await act(flushHistory);
 const original=mocks.invoke.getMockImplementation()!;let finishOld:(()=>void)|undefined,fail=true;
 mocks.invoke.mockImplementation((command,args)=>{
  if(command==='simulation_history'&&args.payload.action==='write'){
   if(args.payload.document.last_result&&fail)return Promise.reject('磁盘不可写');
   if(!args.payload.document.last_result)return new Promise(resolve=>{finishOld=()=>resolve(mockHistory(args.payload));});
  }
  return original(command,args);
 });
 fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Pending result'}});
 let olderSave:Promise<void>;act(()=>{olderSave=flushHistory();});await waitFor(()=>expect(finishOld).toBeTruthy());
 handler=a=>a==='start'?{job_id:'pending-result',status:'running',completed:0,total:1,output_path:'/test/results/pending',message:'running'}:a==='validate'?{total:1}:{};
 fireEvent.click(start());await screen.findByRole('button',{name:'打开已保存结果'});
 await act(async()=>{finishOld!();await olderSave!;});await screen.findByText(/计算已启动，结果会继续保存/);
 expect(currentHistory().config.name).toBe('Pending result');expect(currentHistory().last_result).toBeUndefined();
 await expect((window as any).__easyreaktoroFlushSimulation()).rejects.toBeTruthy();
 fail=false;fireEvent.click(screen.getByRole('button',{name:'重试保存'}));await screen.findByText('模拟历史已保存。');expect(currentHistory().last_result).toBe('/test/results/pending');
});
it('enters results even if history fails after launch and retry retains the result association',async()=>{
 mocks.open.mockResolvedValue('/test/results');await selectWater();await act(flushHistory);
 handler=a=>a==='start'?{job_id:'launched',status:'running',completed:0,total:1,output_path:'/test/results/loaded',message:'running'}:a==='validate'?{total:1}:{};
 const original=mocks.invoke.getMockImplementation()!;let fail=true;
 mocks.invoke.mockImplementation((command,args)=>command==='simulation_history'&&args.payload.action==='write'&&fail?Promise.reject('磁盘不可写'):original(command,args));
 fireEvent.click(start());await screen.findByText(/计算已启动，结果会继续保存/);expect(screen.getByRole('button',{name:'打开已保存结果'})).toBeTruthy();expect(screen.getByRole('button',{name:'停止计算'})).toBeTruthy();
 await expect((window as any).__easyreaktoroFlushSimulation()).rejects.toBeTruthy();expect(currentHistory().last_result).toBeUndefined();
 fail=false;fireEvent.click(screen.getByRole('button',{name:'重试保存'}));await screen.findByText('模拟历史已保存。');expect(currentHistory().last_result).toBe('/test/results/loaded');
});
it('shows deletion failure inside the confirmation and preserves the history file',async()=>{
 await loaded();await act(flushHistory);const id=currentHistory().id;fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));fireEvent.click(screen.getByRole('button',{name:'永久删除…'}));
 const original=mocks.invoke.getMockImplementation()!;mocks.invoke.mockImplementation((command,args)=>command==='simulation_history'&&args.payload.action==='delete'?Promise.reject('没有删除权限'):original(command,args));
 fireEvent.click(screen.getByRole('button',{name:'永久删除'}));await waitFor(()=>expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toContain('没有删除权限'));expect(historyDocuments.has(id)).toBe(true);
});
it('invalidates a check-passed message after the user changes conditions',async()=>{
 await selectWater();fireEvent.click(screen.getByRole('button',{name:'检查设置'}));await screen.findByText(/设置检查通过/);fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));fireEvent.change(screen.getByLabelText('first_start 压力'),{target:{value:'-1'}});expect(screen.queryByText(/设置检查通过/)).toBeNull();
});

it('uses the same leading history entry and reopens persisted result locations',async()=>{
 resultHistoryEntries.set('/saved/old',{kind:'run',path:'/saved/old',name:'以前的结果',opened_at:'2026-09-08T01:00:00Z',status:'completed',completed:0,total:6});
 await loaded();expect(document.querySelector('.sim-toolbar button')?.getAttribute('aria-label')).toBe('模拟历史');
 handler=(action,payload)=>action==='open_run'?{job_id:'old-result',output_path:payload.path,name:'以前的结果',status:'completed',completed:0,total:6}:{};
 fireEvent.click(screen.getByRole('button',{name:'查看结果'}));expect(document.querySelector('.sim-toolbar button')?.getAttribute('aria-label')).toBe('结果历史');
 expect(screen.queryByLabelText('最近计算结果')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'结果历史'}));
 const panel=await screen.findByRole('dialog',{name:'结果历史'});fireEvent.click(within(panel).getByRole('button',{name:'打开结果'}));
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'结果历史'})).toBeNull());
 expect(mocks.invoke.mock.calls.some(([,args])=>args.payload.action==='open_run'&&args.payload.path==='/saved/old')).toBe(true);
});
it('confirms the full trash snapshot, preserves the active simulation and newly trashed records',async()=>{
 await loaded();await act(flushHistory);const active=currentHistory();
 for(const id of ['deleted-a','deleted-b'])trashedHistoryDocuments.set(id,{...structuredClone(active),id,config:{...active.config,name:id}});
 fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));fireEvent.click(screen.getByRole('button',{name:'最近删除'}));
 await screen.findByText('deleted-a');fireEvent.change(screen.getByLabelText('搜索模拟历史'),{target:{value:'deleted-a'}});
 fireEvent.click(screen.getByRole('button',{name:'清空最近删除…'}));const confirm=screen.getByRole('alertdialog');
 expect(within(confirm).getByRole('button',{name:'删除 2 份模拟'})).toBeTruthy();
 trashedHistoryDocuments.set('newly-trashed',{...active,id:'newly-trashed'});
 fireEvent.click(within(confirm).getByRole('button',{name:'删除 2 份模拟'}));
 await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());
 expect([...trashedHistoryDocuments.keys()]).toEqual(['newly-trashed']);expect(historyDocuments.has(active.id)).toBe(true);
 const calls=mocks.invoke.mock.calls.map(([,args])=>args.payload);expect(calls.find(p=>p.action==='empty_trash').ids).toEqual(['deleted-a','deleted-b']);
 expect(calls.some(p=>p.action==='delete'||p.action==='remove_result')).toBe(false);
});

it('asks how to handle an existing result and carries only the confirmed overwrite token',async()=>{
 handler=(a,p)=>a==='catalog'?{items}:a==='validate'?{total:1}:a==='result_destination'?{exists:true,path:'/runs/loaded',name:'loaded',can_overwrite:true,overwrite_token:'reviewed-run'}:a==='start'?{job_id:'overwrite',status:'completed',completed:0,total:1,output_path:'/runs/loaded',elapsed_seconds:0}:{};
 mocks.open.mockResolvedValue('/runs');await selectWater();fireEvent.click(start());await screen.findByRole('alertdialog',{name:'同名结果已存在'});expect(mocks.invoke.mock.calls.some(([,a])=>a.payload.action==='start')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'覆盖结果'}));await waitFor(()=>expect(mocks.invoke.mock.calls.find(([,a])=>a.payload.action==='start')?.[1].payload.overwrite_token).toBe('reviewed-run'));
});
it('refreshes simulation history after an external file is deleted',async()=>{
 await loaded();const id=currentHistory().id;fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));await screen.findByText(`文件：${id}.json`);historyDocuments.delete(id);fireEvent.focus(window);await waitFor(()=>expect(screen.queryByText(`文件：${id}.json`)).toBeNull());
});
it('can keep externally deleted current edits as a new simulation before opening another history',async()=>{
 await loaded();fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Earlier simulation'}});await act(flushHistory);const earlier=currentHistory();fireEvent.click(screen.getByRole('button',{name:'新建模拟'}));await screen.findByText(/已新建模拟/);const removed=currentHistory().id;
 historyDocuments.delete(removed);fireEvent.focus(window);fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));await waitFor(()=>expect(screen.queryByText(`文件：${removed}.json`)).toBeNull());fireEvent.click(screen.getByRole('button',{name:'关闭模拟历史'}));
 const previous=mocks.invoke.getMockImplementation()!;mocks.invoke.mockImplementation((command,args)=>command==='simulation_history'&&args.payload.action==='write'&&args.payload.document.id===removed?Promise.reject('这份模拟文件已从本机删除'):previous(command,args));
 fireEvent.change(screen.getByLabelText('模拟名称'),{target:{value:'Keep these edits'}});fireEvent.click(screen.getByRole('button',{name:'模拟历史'}));fireEvent.click(screen.getByRole('button',{name:/^Earlier simulation/}));await screen.findByRole('alertdialog',{name:'原模拟文件已删除'});fireEvent.click(screen.getByRole('button',{name:'保留为新模拟'}));
 await waitFor(()=>expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe(earlier.config.name));expect(historyDocuments.has(removed)).toBe(false);expect([...historyDocuments.values()].some(d=>d.config.name==='Keep these edits')).toBe(true);
});

it('reopens the same result from the portal history without replacing its iframe or waiting for progress',async()=>{
 const toolbar=document.createElement('header');document.body.append(toolbar);
 const job={job_id:'same-result',output_path:'/saved/same',name:'同一份结果',status:'completed',completed:3,total:3,elapsed_seconds:1};
 resultHistoryEntries.set(job.output_path,{kind:'run',path:job.output_path,name:job.name,opened_at:'2026-09-14T00:00:00Z'});
 handler=(action)=>action==='open_run'?{...job}:action==='explorer'?{point_count:3,data:'AA==',status:job}:{};
 const view=render(<Simulation summary={null} runtime={runtime} onDatabases={()=>{}} view="results" toolbar={toolbar}/>);
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,posted=vi.spyOn(frame.contentWindow!,'postMessage');
  const channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]);
  act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'ready'}})));
  for(let attempt=0;attempt<2;attempt++){
   const history=within(toolbar).getByRole('button',{name:'结果历史'});history.focus();fireEvent.click(history);
   const panel=await screen.findByRole('dialog',{name:'结果历史'});
   // A completed iframe refresh and history refresh must not dismiss this panel.
   act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'loaded'}})));
   await waitFor(()=>expect(within(panel).getByRole('button',{name:'打开结果'})).toBeTruthy());
   expect(document.activeElement).toBe(within(panel).getByRole('button',{name:'关闭结果历史'}));
   posted.mockClear();fireEvent.click(within(panel).getByRole('button',{name:'打开结果'}));
   await waitFor(()=>expect(screen.queryByRole('dialog',{name:'结果历史'})).toBeNull());
   await waitFor(()=>expect(posted.mock.calls.some(([message])=>message.type==='load')).toBe(true));
   expect(posted.mock.calls.some(([message])=>message.type==='clear')).toBe(true);
   expect(view.getByTitle('结果')).toBe(frame);
  }
  expect(mocks.invoke.mock.calls.filter(([,args])=>args.payload.action==='explorer')).toHaveLength(2);
  fireEvent.click(within(toolbar).getByRole('button',{name:'结果历史'}));await screen.findByRole('dialog',{name:'结果历史'});
  view.rerender(<Simulation summary={null} runtime={runtime} onDatabases={()=>{}} view="results" visible={false} toolbar={toolbar}/>);
  expect(screen.queryByRole('dialog',{name:'结果历史'})).toBeNull();
  expect(view.getByTitle('结果')).toBe(frame);
 }finally{view.unmount();toolbar.remove();}
});

it('takes a backend target failure to its field and clears the error when corrected',async()=>{
 await selectWater();fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));
 fireEvent.change(screen.getByLabelText('添加指定条件'),{target:{value:'ph'}});
 fireEvent.change(screen.getByLabelText('pH 调节物质'),{target:{value:'HBr'}});
 handler=(action,payload)=>{if(action==='validate')return Promise.reject(JSON.stringify({code:'EQUILIBRIUM_CONSTRAINT',diagnostic:'pH · HBr 的交换物质包含当前体系没有的元素，请先补充允许参与平衡的 species',location:{kind:'constraint',constraintId:payload.config.equilibrium_constraints[0].id,field:'titrant'}}));return {};};
 fireEvent.click(screen.getByRole('tab',{name:/初始物质/}));fireEvent.click(screen.getByRole('button',{name:'检查设置'}));
 const locate=await screen.findByRole('button',{name:'前往修改'});fireEvent.click(locate);
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByLabelText('pH 调节物质')));
 expect(screen.getByLabelText('pH 调节物质').getAttribute('aria-invalid')).toBe('true');
 fireEvent.change(screen.getByLabelText('pH 调节物质'),{target:{value:'HCl'}});
 expect(screen.queryByRole('button',{name:'前往修改'})).toBeNull();expect(screen.getByLabelText('pH 调节物质').getAttribute('aria-invalid')).toBeNull();
});

it('offers input navigation for the current failed run and clears it after changing settings',async()=>{
 await selectWater();fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));
 fireEvent.change(screen.getByLabelText('添加指定条件'),{target:{value:'ph'}});fireEvent.change(screen.getByLabelText('pH 调节物质'),{target:{value:'HCl'}});
 mocks.open.mockResolvedValue('/results');
 handler=(action,payload)=>action==='validate'?{total:1}:action==='start'?{job_id:'failed-run',output_path:'/results/failed',status:'failed',completed:0,total:1,elapsed_seconds:1,message:'计算已停止',diagnostic:'此 pH 目标需要移除 HCl；当前仅允许加入，请改变目标或交换方式',error_location:{kind:'constraint',constraintId:payload.config.equilibrium_constraints[0].id,field:'exchange'}}:{};
 fireEvent.click(start());const locate=await screen.findByRole('button',{name:'前往修改'});fireEvent.click(locate);
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByLabelText('pH 物质交换方式')));
 fireEvent.change(screen.getByLabelText('pH 物质交换方式'),{target:{value:'both'}});
 expect(screen.queryByRole('button',{name:'前往修改',hidden:true})).toBeNull();
});

it('uses the toolbar undo history inside graphical text and number fields, while searches stay local',async()=>{
 await selectWater();const amount=screen.getByLabelText('water 投料量') as HTMLInputElement;amount.focus();
 for(const value of ['', '1','12','125'])fireEvent.change(amount,{target:{value}});
 fireEvent.keyDown(amount,{key:'z',metaKey:true});expect(amount.value).toBe('1');
 fireEvent.click(screen.getByRole('button',{name:'重做模拟修改'}));expect(amount.value).toBe('125');
 fireEvent.keyDown(amount,{key:'z',ctrlKey:true});expect(amount.value).toBe('1');
 fireEvent.keyDown(amount,{key:'z',ctrlKey:true,shiftKey:true});expect(amount.value).toBe('125');
 const search=screen.getByLabelText('搜索可投料 species');fireEvent.change(search,{target:{value:'water'}});fireEvent.keyDown(search,{key:'z',metaKey:true});expect(amount.value).toBe('125');
 fireEvent.click(screen.getByRole('tab',{name:/计算流程/}));const temperature=screen.getByLabelText('first_start 温度') as HTMLInputElement;temperature.focus();
 for(const value of ['','1','18','180'])fireEvent.change(temperature,{target:{value}});
 fireEvent.keyDown(temperature,{key:'z',metaKey:true});expect(temperature.value).toBe('250');
 fireEvent.click(screen.getByRole('button',{name:'重做模拟修改'}));expect(temperature.value).toBe('180');
 const preview=screen.getByLabelText('预览路径位置');fireEvent.keyDown(preview,{key:'z',metaKey:true});expect(temperature.value).toBe('180');
});
