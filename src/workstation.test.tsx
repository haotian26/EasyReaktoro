// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {historyDocuments,mockHistory,currentHistory,flushHistory} from './test-history';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Simulation from './Simulation';
import {SimulationResults} from './SimulationResults';
import {HelpTip} from './HelpTip';
import {DEFAULT_CONFIG,SimSpecies,basicAqueousSpecies,makeRoute,sortSpecies} from './simulation-types';
import {previewPoint} from './process-preview';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn(),save:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:mocks.open,save:mocks.save}));
const water:SimSpecies={name:'solvent',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null,common_rank:0};
const proton={...water,name:'proton',formula:'H+',charge:1,is_water:false,common_rank:1};
const hydroxide={...water,name:'hydroxide',formula:'OH-',charge:-1,is_water:false,common_rank:2};
const extra={...water,name:'aaa',formula:'Na+',charge:1,is_water:false,common_rank:3};
const summary={handle_id:'db',kind:'rtdb',path:'/test/workstation.rtdb',dirty:false};
const runtime={available:true};const key='easyreaktoro.simulation.v2:/test/workstation.rtdb';
beforeEach(()=>{const data=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});vi.clearAllMocks();historyDocuments.clear();mocks.invoke.mockImplementation(async(command,args)=>command==='simulation_history'?mockHistory(args.payload):args.payload.action==='catalog'?{items:[extra,hydroxide,water,proton]}:{});});
afterEach(cleanup);
describe('usable workstation',()=>{
 it('does not claim a saved draft before a database workspace is ready',()=>{
  render(<Simulation summary={null} runtime={runtime} onDatabases={()=>{}}/>);expect(screen.queryByText('草稿已保存')).toBeNull();
 });
 it('connects the last setup tab to the independent results page',async()=>{
  const changeView=vi.fn();render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}} view="simulation" onViewChange={changeView}/>);
  await screen.findByRole('button',{name:'参与平衡 solvent'});fireEvent.click(screen.getByRole('tab',{name:/活度模型/}));
  fireEvent.click(screen.getByRole('button',{name:'查看结果'}));expect(changeView).toHaveBeenCalledWith('results');expect(screen.getAllByRole('tab')).toHaveLength(4);
 });
 it('reveals the actual saved run folder and reports a missing-folder error',async()=>{
  mocks.invoke.mockRejectedValueOnce('path does not exist');const onError=vi.fn();
  render(<SimulationResults job={{job_id:'run',name:'Saved run',status:'completed',stage:'completed',total:1,completed:1,elapsed_seconds:1,message:'已完成',output_path:'/saved/results/run'}} visible={true} onError={onError} onNotice={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'保存位置'}));
  await waitFor(()=>expect(onError).toHaveBeenCalledWith('path does not exist'));expect(mocks.invoke).toHaveBeenCalledWith('reveal_path',{path:'/saved/results/run'});
 });
 it('defaults a new aqueous draft to three unique basic species without setting feed amounts',async()=>{
  render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);
  await waitFor(()=>expect(currentHistory()?.config.species).toEqual(['solvent','proton','hydroxide']));
  expect(currentHistory().config.materials[0].inputs).toEqual([]);
 });
 it('preserves an intentionally empty existing draft',async()=>{
  localStorage.setItem(key,JSON.stringify(DEFAULT_CONFIG));render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);
  await screen.findByRole('button',{name:'参与平衡 solvent'});expect(JSON.parse(localStorage.getItem(key)!).species).toEqual([]);
 });
 it('does not choose among competing hydroxide datasets or water solvents',()=>{
  expect(basicAqueousSpecies([water,proton,hydroxide,{...hydroxide,name:'second-OH'}])).toEqual(['solvent','proton']);
  expect(basicAqueousSpecies([water,{...water,name:'second-water'},proton,hydroxide])).toEqual([]);
 });
 it('sorts common ions without changing input order or choosing an unavailable record',()=>{
  const source=[extra,{...proton,name:'blocked',disabled:true},hydroxide,water,proton];
  expect(sortSpecies(source).map(s=>s.name)).toEqual(['solvent','proton','hydroxide','aaa','blocked']);expect(source[0].name).toBe('aaa');
  expect(sortSpecies(source,'name')[0].name).toBe('aaa');
  expect(sortSpecies(source,'chemical').map(s=>s.name)).toEqual(['solvent','proton','hydroxide','aaa','blocked']);
 });
 it('uses the top command slot and exposes a separate results view without simulation chrome',async()=>{
  const toolbar=document.createElement('div');document.body.append(toolbar);
  const view=render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}} view="simulation" toolbar={toolbar}/>);
  await screen.findByRole('button',{name:'参与平衡 solvent'});expect(toolbar.querySelector('[aria-label="模拟名称"]')).toBeTruthy();
  view.rerender(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}} view="results" toolbar={toolbar}/>);
  expect(screen.queryByRole('tab',{name:/系统 species/})).toBeNull();expect(screen.queryByRole('button',{name:/运行 .* 个平衡点/})).toBeNull();expect(screen.getByRole('button',{name:'打开已保存结果'})).toBeTruthy();
  view.unmount();toolbar.remove();
 });
 it('context help works on keyboard focus and closes with Escape',()=>{
  render(<HelpTip label="循环">走完整张点表一次。</HelpTip>);const trigger=screen.getByRole('button',{name:'循环帮助'});fireEvent.mouseEnter(trigger);fireEvent.focus(trigger);fireEvent.click(trigger);expect(screen.getByRole('tooltip').textContent).toContain('走完整张点表');fireEvent.keyDown(window,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();
 });
 it('shows actual initialization, previous point and previous cycle at the chosen point',()=>{
  const c=structuredClone(DEFAULT_CONFIG);c.cycles=2;c.points=[{id:'p1',label:'A',temperature_c:100,pressure_bar:100},{id:'p2',label:'B',temperature_c:80,pressure_bar:80}];c.routes=[makeRoute('aqueous','previous_point'),makeRoute('mineral','previous_cycle')];
  const first=previewPoint(c,0,1);expect(first.inputs.every(x=>x.text.startsWith('首次补入'))).toBe(true);expect(first.outputs.map(x=>x.text)).toEqual(['100% → 第 1 轮 · B','100% → 第 2 轮 · A']);
  const next=previewPoint(c,1,2);expect(next.inputs.map(x=>x.text)).toEqual(['第 2 轮 · A → 100%','第 1 轮 · B → 100%']);
 });
 it('keeps zero-recycle initialization separate and marks invalid output references',()=>{
  const c=structuredClone(DEFAULT_CONFIG);c.cycles=2;c.routes=[{...makeRoute('all','previous_cycle'),fraction:0,fallback_fraction:2}];expect(previewPoint(c,0,1).inputs[0].text).toContain('× 2 份');expect(previewPoint(c,0,2).inputs[0].text).toContain('0%');
  c.routes=[{...makeRoute('all','output'),point_id:'missing',lag:1}];expect(previewPoint(c,0,1).inputs[0].problem).toBe(true);
 });
});

describe('setup guidance and first-result feedback',()=>{
 it('jumps from a missing setting to the right panel and follows the next step',async()=>{
  render(<Simulation summary={summary} runtime={runtime} onDatabases={()=>{}}/>);await screen.findByRole('button',{name:'参与平衡 solvent'});
  fireEvent.click(await screen.findByRole('button',{name:'填写初始投料及其数量'}));expect(screen.getByRole('tab',{name:/初始物质/}).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'下一步：计算流程'}));expect(screen.getByRole('tab',{name:/计算流程/}).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'设置摘要'}));fireEvent.click(screen.getByRole('button',{name:/活度模型 Extended Debye/}));expect(screen.getByRole('tab',{name:/活度模型/}).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('2 个 species 的尺寸参数待设置')).toBeTruthy();
 });
 it('shows an ongoing first point instead of offering to import unrelated data',()=>{
  const back=vi.fn(),home=vi.fn();const view=render(<SimulationResults job={{job_id:'run',name:'Current calculation',status:'running',stage:'equilibrium',completed:0,total:2,message:'求解中',elapsed_seconds:1,output_path:'/saved/run'}} visible={true} onError={()=>{}} onNotice={()=>{}} onSimulation={back} onResultsHome={home}/>);
  expect(screen.getByText('正在计算第一个平衡点')).toBeTruthy();expect(screen.getByText('Current calculation')).toBeTruthy();expect((view.container.querySelector('iframe') as HTMLElement).style.visibility).toBe('hidden');
  fireEvent.click(screen.getByRole('button',{name:'返回模拟'}));expect(back).toHaveBeenCalledOnce();
  view.rerender(<SimulationResults job={{job_id:'run',name:'Current calculation',status:'failed',stage:'error',completed:0,total:2,message:'已停止',diagnostic:'Convergence error',elapsed_seconds:1,output_path:'/saved/run'}} visible={true} onError={()=>{}} onNotice={()=>{}} onSimulation={back} onResultsHome={home}/>);
  expect(screen.getByText('本次计算未产生有效结果')).toBeTruthy();expect(screen.getByRole('alert').textContent).toContain('Convergence error');
  fireEvent.click(screen.getByRole('button',{name:'返回结果首页，打开其他数据'}));expect(home).toHaveBeenCalledOnce();
 });
});
