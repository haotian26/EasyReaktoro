// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SIMULATION_DEFAULTS,RESULT_DEFAULTS} from './workbench-preferences';
import {DEFAULT_CONFIG} from './simulation-types';
import App, {HomePage, DatabaseLibrary, NewDatabase, ImportDialog, ExportDialog, SpeciesEditor, ModelParameterTable, normalizePreferences, DependencyReport} from './AppV3';

const mocks = vi.hoisted(() => ({invoke:vi.fn(),open:vi.fn(),save:vi.fn(),destroy:vi.fn(),onClose:vi.fn(),closeListener:null as any}));
vi.mock('@tauri-apps/api/core',() => ({invoke:mocks.invoke}));
vi.mock('@tauri-apps/api/event',() => ({listen:async()=>()=>{}}));
vi.mock('@tauri-apps/plugin-dialog',() => ({open:mocks.open,save:mocks.save}));
vi.mock('@tauri-apps/api/window',() => ({getCurrentWindow:() => ({onCloseRequested:mocks.onClose,destroy:mocks.destroy})}));
const runtime={available:true,status:'ready' as const,version:'2.13.0',python:'/test/env/bin/python'};
const preferences={simulation:SIMULATION_DEFAULTS,results:RESULT_DEFAULTS,language:'zh-CN',theme:'dark' as const,density:'comfortable' as const,startup:'home' as const,recent_databases:[{path:'/test/lab.rtdb',name:'lab',opened_at:''}]};
const summary={handle_id:'local',kind:'rtdb' as const,path:'/test/lab.rtdb',embedded_name:'lab',read_only:false,dirty:true,species_count:2,element_count:1,native_exportable_count:0};
const rows=[{id:'a',name:'A',formula:'H2',state:'Aqueous',model:'extended-maier-kelley',charge:0,elements:['H']},{id:'b',name:'B',formula:'H',state:'Aqueous',model:'extended-maier-kelley',charge:0,elements:['H']}];
let handler:(cmd:string,args:any)=>any;
beforeEach(() => {
  vi.clearAllMocks(); mocks.closeListener=null;
  mocks.onClose.mockImplementation(async (callback) => {mocks.closeListener=callback;return () => {};});
  handler=(cmd,args) => {
    switch(cmd) {
      case 'settings_load':return preferences;
      case 'settings_save':return {success:true};
      case 'paths_exist':return args.paths.map((path:string) => ({path,exists:true}));
      case 'runtime_probe':return runtime;
      case 'catalog_list':return {entries:[]};
      case 'rtdb_open':return {summary};
      case 'rtdb_list_info':return {items:args.paths.map((path:string)=>({path,status:'ready',species_count:52,element_count:9}))};
      case 'species_page':return {items:rows,total:2,states:['Aqueous'],models:['extended-maier-kelley']};
      case 'species_details':return {...rows.find(x=>x.name===args.name),model:{type:'extended-maier-kelley'},composition:{H:1}};
      case 'rtdb_save':return {success:true,summary:{...summary,dirty:false}};
      case 'database_close':return {closed:true};
      case 'database_summary':return {summary};
      default:return {};
    }
  };
  mocks.invoke.mockImplementation((cmd,args) => Promise.resolve().then(()=>handler(cmd,args)));
});
afterEach(cleanup);
async function openCurrent() {
  render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:/lab \/test\/lab.rtdb/}));
  await screen.findByRole('heading',{name:'lab'});
  await screen.findByRole('button',{name:/A H.*水溶液/});
}


describe('recovering the actual Reaktoro connection',()=>{
 it('checks a healthy connection without replacing the process or closing an unsaved database',async()=>{
  const original=handler;handler=(cmd,args)=>cmd==='runtime_discover'?{entries:[runtime]}:original(cmd,args);
  await openCurrent();fireEvent.click(screen.getByRole('button',{name:'设置'}));fireEvent.click(screen.getByRole('button',{name:'Reaktoro 环境'}));
  fireEvent.click(screen.getByRole('button',{name:'检查并重新连接'}));await screen.findByText('Reaktoro 2.13.0 连接正常。');
  expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='runtime_probe')).toHaveLength(2);
  expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==='runtime_select'||cmd==='database_close')).toBe(false);expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'数据库'}));await screen.findByRole('heading',{name:'lab'});expect(screen.getByText('未保存')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'保存'}));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('rtdb_save',{handleId:'local'}));
 });
 it('reconnects a failed process and allows reopening without asking to save a dead database',async()=>{
  await openCurrent();const original=handler;handler=(cmd,args)=>cmd==='runtime_probe'?{...runtime,reconnected:true}:cmd==='runtime_discover'?{entries:[runtime]}:cmd==='rtdb_open'?{summary:{...summary,handle_id:'reopened',dirty:false}}:original(cmd,args);
  act(()=>window.dispatchEvent(new CustomEvent('easyreaktoro:connection-lost',{detail:'BRIDGE_UNRESPONSIVE'})));
  fireEvent.click(screen.getByRole('button',{name:'设置'}));fireEvent.click(screen.getByRole('button',{name:'Reaktoro 环境'}));expect(screen.getByText('未连接')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'检查并重新连接'}));await screen.findByText('已重新连接。请重新打开数据库；连接中断前未保存的数据库修改已无法恢复。');
  expect(screen.queryByRole('alertdialog')).toBeNull();expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==='rtdb_save'||cmd==='database_close')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'数据库'}));fireEvent.click(await screen.findByRole('button',{name:/lab.*52 个 species/}));await screen.findByRole('heading',{name:'lab'});
  await waitFor(()=>expect(mocks.invoke.mock.calls.some(([cmd,args])=>cmd==='species_page'&&args.handleId==='reopened')).toBe(true));expect(screen.queryByText('未保存')).toBeNull();
 });
 it('keeps a later connection failure visible instead of replacing it with the earlier successful probe',async()=>{
  const original=handler;let failed=false;handler=(cmd,args)=>cmd==='catalog_list'&&failed?Promise.reject(new Error('BRIDGE_UNRESPONSIVE')):cmd==='runtime_discover'?{entries:[runtime]}:original(cmd,args);
  render(<App/>);await screen.findByText('Reaktoro 2.13.0 已连接');failed=true;
  fireEvent.click(screen.getByRole('button',{name:'设置'}));fireEvent.click(screen.getByRole('button',{name:'Reaktoro 环境'}));fireEvent.click(screen.getByRole('button',{name:'检查并重新连接'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('runtime_discover',{}));expect(screen.getByText('未连接')).toBeTruthy();expect(screen.queryByText('Reaktoro 2.13.0 连接正常。')).toBeNull();expect(screen.getByRole('alert').textContent).toContain('系统数据库目录加载失败');
 });
 it('does not report connected merely because another usable environment was discovered',async()=>{
  const original=handler;let failed=false;handler=(cmd,args)=>cmd==='runtime_probe'&&failed?{status:'error',available:false,diagnostic:'connection unavailable'}:cmd==='runtime_discover'?{entries:[runtime]}:original(cmd,args);
  render(<App/>);await screen.findByText('Reaktoro 2.13.0 已连接');failed=true;
  fireEvent.click(screen.getByRole('button',{name:'设置'}));fireEvent.click(screen.getByRole('button',{name:'Reaktoro 环境'}));fireEvent.click(screen.getByRole('button',{name:'检查并重新连接'}));
  await screen.findByText('发现 1 个可用环境，请选择要连接的环境。');expect(screen.getByText('未连接')).toBeTruthy();expect(screen.queryByText('已连接')).toBeNull();
 });
});
describe('workflow regressions',() => {
  it('continues the last selected simulation instead of the most recently modified one',async()=>{
    const base=handler;Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(key:string)=>key==='easyreaktoro.simulation.active'?'selected':null,setItem:()=>{},removeItem:()=>{}}});
    const entries=[{id:'newer',database:{kind:'rtdb',path:'/newer.rtdb',name:'Newer'}},{id:'selected',database:{kind:'rtdb',path:'/selected.rtdb',name:'Selected'}}];
    handler=(cmd,args)=>cmd==='settings_load'?{...preferences,startup:'simulation'}:cmd==='simulation_history'?(args.payload.action==='list'?{entries,directory:'/test',unreadable:0}:args.payload.action==='read'?{version:1,id:'selected',database:entries[1].database,updated_at:'2026-09-08',config:DEFAULT_CONFIG}:{success:true}):base(cmd,args);
    render(<App/>);await waitFor(()=>expect(mocks.invoke.mock.calls.some(([cmd,args])=>cmd==='rtdb_open'&&args.path==='/selected.rtdb')).toBe(true));
    expect(mocks.invoke.mock.calls.some(([cmd,args])=>cmd==='rtdb_open'&&args.path==='/newer.rtdb')).toBe(false);
  });
  it('offers visible discard confirmation for a changed species and preserves it when continuing',async()=>{
    handler=cmd=>cmd==='model_definitions'?{items:[{id:'extended-maier-kelley',label:'Extended Maier–Kelley',creatable:true,states:[],parameters:[]}]}:{items:[]};
    const onClose=vi.fn(),onExit=vi.fn();let requestExit:()=>void=()=>{};
    render(<SpeciesEditor handleId='local' existing={null} onClose={onClose} onSaved={async()=>{}} onExit={onExit} registerExit={fn=>{if(fn)requestExit=fn;}}/>);
    await screen.findByRole('option',{name:'Extended Maier–Kelley'});fireEvent.change(screen.getByLabelText('species 名称'),{target:{value:'Unfinished species'}});
    fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(screen.getByRole('alertdialog').textContent).toContain('尚未保存');
    fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));expect(onClose).not.toHaveBeenCalled();expect((screen.getByLabelText('species 名称') as HTMLInputElement).value).toBe('Unfinished species');
    act(()=>requestExit());expect(screen.getByRole('alertdialog').textContent).toContain('确定退出');fireEvent.click(screen.getByRole('button',{name:'放弃修改并退出'}));expect(onExit).toHaveBeenCalledOnce();
  });
  it('custom model details use registry labels and units',()=>{
    render(<ModelParameterTable value={{G298:-1000}} definition={{parameters:[{name:'G298',label:'G°(298.15 K)',unit:'J/mol'}]} as any}/>);
    expect(screen.getByText('G°(298.15 K)')).toBeTruthy();expect(screen.getByText('J/mol')).toBeTruthy();
  });
  it('dependency errors explain ambiguity and show the complete path',()=>{
    render(<DependencyReport issues={[{code:'AMBIGUOUS_DEPENDENCY',chain:['Target','Base'],candidates:['Base / A','Base / B']}]} />);
    expect(screen.getByText('同名 species 来源不明确')).toBeTruthy();expect(screen.getByText('Target → Base')).toBeTruthy();expect(screen.queryByText('AMBIGUOUS_DEPENDENCY')).toBeNull();
  });
  it('keyboard search and save act on the current workspace',async()=>{
    await openCurrent();fireEvent.keyDown(window,{key:'f',metaKey:true});expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'搜索 species'}));
    fireEvent.keyDown(window,{key:'s',metaKey:true});await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('rtdb_save',{handleId:'local'}));await screen.findByText('数据库已保存');
  });
  it('uses the command bar, exposes optional filters and navigates species from search',async()=>{
    await openCurrent();await screen.findByRole('button',{name:/^A H/});
    expect(document.querySelector('.workspace-header')).toBeNull();expect(document.querySelector('.db-info-strip')).toBeNull();
    expect(document.querySelector('.commandbar-slot .database-commandbar')).toBeTruthy();
    expect(screen.queryByRole('combobox',{name:'筛选相态'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'筛选 species'}));expect(screen.getByRole('combobox',{name:'筛选相态'})).toBeTruthy();
    const input=screen.getByRole('textbox',{name:'搜索 species'});fireEvent.keyDown(input,{key:'ArrowDown'});
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('species_details',{handleId:'local',speciesId:'b',name:'B'}));
    fireEvent.keyDown(input,{key:'Enter'});expect(document.activeElement?.classList.contains('species-row')).toBe(true);
  });
  it('quick theme switching persists the preference just like the settings page',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'切换浅色或深色'}));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('settings_save',{settings:expect.objectContaining({theme:'light'})}));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('normalizes corrupted settings without keeping invalid fields',()=>{
    expect(normalizePreferences(null).recent_databases).toEqual([]);
    const prefs=normalizePreferences({theme:'ultraviolet',density:9,runtime_path:{bad:true},recent_databases:[null,{path:5},{path:'/test/X.rtdb'}],default_database:{kind:'rtdb',path:5}});
    expect(prefs.theme).toBe('system');expect(prefs.runtime_path).toBeUndefined();expect(prefs.recent_databases).toHaveLength(1);expect(prefs.default_database).toBeUndefined();
  });
  it('recent path check failure does not prevent runtime startup',async()=>{
    const old=handler;handler=(cmd,args)=>{if(cmd==='paths_exist')throw new Error('temporary I/O');return old(cmd,args);};
    render(<App/>);await screen.findByText('Reaktoro 2.13.0 已连接');expect(screen.getByRole('alert').textContent).toContain('最近文件暂时无法检查');
    fireEvent.click(screen.getByRole('button',{name:'关闭提示'}));expect(screen.queryByRole('alert')).toBeNull();
  });
  it('rapid save clicks issue only one write and prevent native exit while pending',async()=>{
    const old=handler;let finish:any;handler=(cmd,args)=>cmd==='rtdb_save'?new Promise(resolve=>finish=resolve):old(cmd,args);
    await openCurrent();const button=screen.getByRole('button',{name:'保存'});fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(finish).toBeTruthy());
    const event={preventDefault:vi.fn()};await act(()=>mocks.closeListener(event));expect(event.preventDefault).toHaveBeenCalled();
    await act(async()=>finish({success:true,summary:{...summary,dirty:false}}));expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='rtdb_save')).toHaveLength(1);
  });
  it('element search, enter, clearing and form navigation do not create phantom edits',async()=>{
    handler=(cmd)=>cmd==='model_definitions'?{items:[{id:'extended-maier-kelley',label:'Extended Maier–Kelley',creatable:true,states:[],parameters:[]}]}:{items:[]};
    const onClose=vi.fn();render(<SpeciesEditor handleId='local' existing={null} onClose={onClose} onSaved={async()=>{}}/>);await screen.findByRole('option',{name:'Extended Maier–Kelley'});
    fireEvent.click(screen.getByRole('button',{name:'选择组成元素'}));const query=screen.getByRole('textbox',{name:'查找元素'});fireEvent.change(query,{target:{value:'氧'}});expect(screen.getByText('1 个匹配')).toBeTruthy();
    fireEvent.keyDown(query,{key:'Enter'});expect(screen.getByRole('button',{name:'O 氧'}).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(query,{key:'Enter'});fireEvent.click(screen.getByRole('button',{name:'清除搜索'}));fireEvent.click(screen.getByRole('button',{name:'使用这些元素'}));
    const scroll=vi.fn();Object.defineProperty(document.getElementById('editor-references'),'scrollIntoView',{value:scroll,configurable:true});fireEvent.click(screen.getByRole('button',{name:'文献与备注'}));expect(scroll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(onClose).toHaveBeenCalled();expect(screen.queryByText(/确定放弃吗/)).toBeNull();
  });
  it('confirmed import exposes dirty summary before returning to the workspace',async()=>{
    mocks.open.mockResolvedValue('/test/import.yaml');const done=vi.fn();
    handler=(cmd)=>cmd==='import_preview'?{items:[{name:'X',formula:'H',fingerprint:'f'}],can_commit:true,missing_dependencies:[],cycles:[],issues:[],rename_decisions:[],reused_count:0,source_revision:'r'}:cmd==='import_commit'?{success:true,summary}:{};
    render(<ImportDialog summary={summary} onClose={()=>{}} onDone={done}/>);fireEvent.click(screen.getByRole('button',{name:'Reaktoro YAML'}));await screen.findByText('X');
    fireEvent.click(screen.getByRole('button',{name:'检查所选 species'}));await waitFor(()=>expect((screen.getByRole('button',{name:'导入所选记录'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'导入所选记录'}));await waitFor(()=>expect(done).toHaveBeenCalledWith(summary));
  });
  it('metadata-only import can be selected and does not require a new species',async()=>{
    mocks.open.mockResolvedValue('/test/metadata.rtdb');const done=vi.fn();
    handler=(cmd)=>cmd==='import_preview'?{items:[{name:'X',formula:'H',fingerprint:'meta',merge_kind:'metadata',merge_fields:['文献'],range_conflict:false}],new_count:0,update_count:1,can_commit:true,missing_dependencies:[],cycles:[],issues:[],rename_decisions:[],reused_count:1,source_revision:'r'}:cmd==='import_commit'?{success:true,summary}:{};
    render(<ImportDialog summary={summary} onClose={()=>{}} onDone={done}/>);fireEvent.click(screen.getByRole('button',{name:'其他 .rtdb'}));await screen.findByText('补充信息 · 文献');
    expect((screen.getByRole('button',{name:'导入所选记录'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'清除选择'}));expect((screen.getByRole('button',{name:'导入所选记录'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'全选'}));fireEvent.click(screen.getByRole('button',{name:'导入所选记录'}));await waitFor(()=>expect(done).toHaveBeenCalledWith(summary));
  });
  it('a false save result cannot close a dirty database',async()=>{
    const old=handler;handler=(cmd,args)=>cmd==='rtdb_save'?{success:false,summary:{...summary,dirty:false}}:old(cmd,args);
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'操作'}));fireEvent.click(screen.getByRole('button',{name:'关闭数据库'}));fireEvent.click(screen.getByRole('button',{name:'保存并关闭'}));
    await screen.findByText(/保存失败/);expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='database_close')).toHaveLength(0);
  });
  it('closing the element chooser discards unapplied filters',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'元素周期表'}));
    fireEvent.click(screen.getByRole('button',{name:'H 氢'}));fireEvent.click(screen.getByRole('button',{name:'关闭对话框'}));
    fireEvent.click(screen.getByRole('button',{name:'元素周期表'}));expect(screen.getByRole('button',{name:'H 氢'}).getAttribute('aria-pressed')).toBe('false');
  });
  it('editing only notes preserves activity parameters for other models',async()=>{
    const onSaved=vi.fn();const item={id:'x',name:'X',formula:'Na+',composition:{Na:1},charge:1,state:'Aqueous',model:{type:'reaktoro-native'},activity_parameters:{model:'sit',epsilon:0.25},references:[],notes:'',valid_tp:{},dependencies:[],reaction:{}};
    handler=(cmd)=>cmd==='model_definitions'?{items:[{id:'reaktoro-native',label:'Reaktoro native',creatable:false,states:[],parameters:[]}]}:{items:[]};
    render(<SpeciesEditor handleId='local' existing={item} onClose={()=>{}} onSaved={onSaved}/>);
    await screen.findByRole('option',{name:'Reaktoro native'});fireEvent.change(screen.getByLabelText('备注（可选）'),{target:{value:'notes only'}});fireEvent.click(screen.getByRole('button',{name:'保存 species'}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalled());expect(onSaved.mock.calls[0][0].activity_parameters).toEqual(item.activity_parameters);
  });
  it('converted source editing preserves full nested equations and references',async()=>{
    const onSaved=vi.fn();const item={id:'x',name:'X',formula:'H2O',composition:{H:2,O:1},charge:0,state:'Aqueous',model:{type:'converted-standard-state',version:'1',kind:'piecewise-cp',parameters:{Param:[-1000,10,2],Cp:[30,0],nEqu:1},reference_evaluators:{W:'water-hgk-reference-v1'}},activity_parameters:{},references:[{raw:'Example reference'}],notes:'',valid_tp:{},dependencies:['W'],reaction:{reactants:{W:1}}};
    handler=(cmd)=>cmd==='model_definitions'?{items:[{id:'converted-standard-state',label:'转换标准态模型',creatable:false,states:[],parameters:[]}]}:{items:[]};
    render(<SpeciesEditor handleId='local' existing={item} onClose={()=>{}} onSaved={onSaved}/>);
    await screen.findByRole('option',{name:'转换标准态模型'});
    expect(screen.getByLabelText(/^化学式/).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('备注（可选）'),{target:{value:'note'}});
    fireEvent.click(screen.getByRole('button',{name:'保存 species'}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalled());
    const saved=onSaved.mock.calls[0][0];expect(saved.model).toEqual({...item.model,calibration:undefined});
    expect(saved.reaction).toEqual(item.reaction);expect(saved.dependencies).toEqual(item.dependencies);expect(saved.references).toEqual(item.references);
  });
  it('a late refresh cannot reopen a closed database',async()=>{
    const old=handler;let resolveRefresh:any;handler=(cmd,args)=>cmd==='rtdb_open'?{summary:{...summary,dirty:false}}:cmd==='database_summary'?new Promise(resolve=>resolveRefresh=resolve):old(cmd,args);
    await openCurrent();act(()=>window.dispatchEvent(new Event('easyreaktoro:species-mutated')));await waitFor(()=>expect(resolveRefresh).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:'操作'}));fireEvent.click(screen.getByRole('button',{name:'关闭数据库'}));await screen.findByRole('heading',{name:'数据库'});
    await act(async()=>resolveRefresh({summary}));expect(screen.queryByRole('heading',{name:'lab'})).toBeNull();
  });
  it('native model parameter sequences render as readable table fields',()=>{
    render(<ModelParameterTable value={[{PhreeqcLgK:{A1:-17.117999999999999,Pr:101325}},null]}/>);
    expect(screen.getByRole('table')).toBeTruthy();expect(screen.getByText('-17.118')).toBeTruthy();expect(screen.getByText('101325')).toBeTruthy();
  });
  it('home recent passes the actual path instead of opening a chooser',() => {
    const open=vi.fn();render(<HomePage runtime={runtime} prefs={preferences} summary={null} candidates={[]} discovering={false} onOpen={open} onContinue={()=>{}} onManage={()=>{}} onDiscover={()=>{}} onChoose={()=>{}} onChooseFolder={()=>{}} onCandidate={()=>{}} onSimulation={()=>{}} onResults={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:/lab \/test\/lab.rtdb/}));expect(open).toHaveBeenCalledWith('/test/lab.rtdb');
    fireEvent.click(screen.getByRole('button',{name:/打开 .rtdb/}));expect(open).toHaveBeenLastCalledWith();
    expect(screen.queryByRole('button',{name:/进入数据库/})).toBeNull();
  });
  it('opening recent through the app does not show the file chooser',async()=>{
    await openCurrent();expect(mocks.open).not.toHaveBeenCalled();expect(mocks.invoke).toHaveBeenCalledWith('rtdb_open',{path:'/test/lab.rtdb'});
  });
  it('managing databases retains the dirty workspace',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'主页'}));
    fireEvent.click(screen.getByRole('button',{name:/数据库与 species 管理.*按名称/}));
    fireEvent.click(screen.getByRole('button',{name:'数据库'}));
    await screen.findByRole('heading',{name:'lab'});expect(screen.getByText('未保存')).toBeTruthy();
    expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='database_close')).toHaveLength(0);
  });
  it('save failure never closes a dirty database',async()=>{
    await openCurrent();const original=handler;handler=(cmd,args)=>{if(cmd==='rtdb_save')throw new Error('disk full');return original(cmd,args);};
    fireEvent.click(screen.getByRole('button',{name:'操作'}));fireEvent.click(screen.getByRole('button',{name:'关闭数据库'}));
    fireEvent.click(screen.getByRole('button',{name:'保存并关闭'}));
    await screen.findByText(/保存失败/);expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='database_close')).toHaveLength(0);
  });
  it('save-and-close completes once without reopening the stale dirty prompt',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'操作'}));fireEvent.click(screen.getByRole('button',{name:'关闭数据库'}));
    fireEvent.click(screen.getByRole('button',{name:'保存并关闭'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='database_close')).toHaveLength(1);
  });
  it('native window close asks before discarding dirty data',async()=>{
    await openCurrent();const event={preventDefault:vi.fn()};await act(()=>mocks.closeListener(event));
    expect(event.preventDefault).toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(mocks.destroy).not.toHaveBeenCalled();
  });
  it('late species details cannot replace the current selection',async()=>{
    await openCurrent();let resolveA:any;const original=handler;
    handler=(cmd,args)=>cmd==='species_details' && args.name==='A' ? new Promise(resolve=>{resolveA=resolve;}) : original(cmd,args);
    fireEvent.click(screen.getByRole('button',{name:/A H.*水溶液/}));await waitFor(()=>expect(resolveA).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:/B H 水溶液/}));await screen.findByRole('heading',{name:'B'});
    await act(async()=>resolveA({name:'LATE_A',formula:'H2'}));expect(screen.queryByText('LATE_A')).toBeNull();
  });
  it('invalid T/P does not call the evaluator and formula is typeset in overview',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:/A H.*水溶液/}));await waitFor(()=>expect((screen.getByRole('button',{name:'编辑'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('试算温度 (°C)'),{target:{value:'-274'}});fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));
    await screen.findByText(/高于 −273.15 °C/);expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_evaluate')).toHaveLength(0);
    expect(document.querySelectorAll('.detail-card sub').length).toBeGreaterThan(0);
  });
  it('defaults database trials to Celsius and bar while sending Kelvin and Pascal to the evaluator',async()=>{
    const original=handler;handler=(cmd,args)=>cmd==='species_evaluate'?{properties:{G0:-1234.56789123},units:{G0:'J/mol'}}:original(cmd,args);
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:/A H.*水溶液/}));await waitFor(()=>expect((screen.getByRole('button',{name:'编辑'}) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('试算温度 (°C)') as HTMLInputElement).value).toBe('25');expect((screen.getByLabelText('试算压力 (bar)') as HTMLInputElement).value).toBe('1');fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));await screen.findByText('-1234.5679');expect(mocks.invoke).toHaveBeenCalledWith('species_evaluate',{handleId:'local',name:'A',speciesId:'a',temperatureK:298.15,pressurePa:100000});
    fireEvent.change(screen.getByLabelText('试算温度单位'),{target:{value:'K'}});fireEvent.change(screen.getByLabelText('试算压力单位'),{target:{value:'Pa'}});expect((screen.getByLabelText('试算温度 (K)') as HTMLInputElement).value).toBe('298.15');expect((screen.getByLabelText('试算压力 (Pa)') as HTMLInputElement).value).toBe('100000');expect(screen.getByText('-1234.5679')).toBeTruthy();expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_evaluate')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('试算压力单位'),{target:{value:'MPa'}});fireEvent.change(screen.getByLabelText('试算压力 (MPa)'),{target:{value:'25'}});expect(screen.queryByText('-1234.5679')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('species_evaluate',{handleId:'local',name:'A',speciesId:'a',temperatureK:298.15,pressurePa:25000000}));
  });
  it('never interprets empty or malformed trial input as zero while allowing zero Celsius',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:/A H.*水溶液/}));await waitFor(()=>expect((screen.getByRole('button',{name:'编辑'}) as HTMLButtonElement).disabled).toBe(false));
    for(const value of ['', ' ', 'broken', '1e']){fireEvent.change(screen.getByLabelText('试算温度 (°C)'),{target:{value}});fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_evaluate')).toHaveLength(0);expect((screen.getByLabelText('试算温度 (°C)') as HTMLInputElement).value).toBe(value);}
    fireEvent.change(screen.getByLabelText('试算温度 (°C)'),{target:{value:'0'}});fireEvent.change(screen.getByLabelText('试算压力 (bar)'),{target:{value:''}});fireEvent.change(screen.getByLabelText('试算压力单位'),{target:{value:'Pa'}});expect((screen.getByLabelText('试算压力 (Pa)') as HTMLInputElement).value).toBe('');fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_evaluate')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('试算压力 (Pa)'),{target:{value:'100000'}});fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('species_evaluate',{handleId:'local',name:'A',speciesId:'a',temperatureK:273.15,pressurePa:100000}));
  });
  it('checks recorded range boundaries in SI while explaining them in the chosen trial units',async()=>{
    const original=handler;handler=(cmd,args)=>cmd==='species_details'?{...original(cmd,args),valid_tp:{temperature_K:[273.15,373.15],pressure_Pa:[100000,10000000]}}:original(cmd,args);
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:/A H.*水溶液/}));await waitFor(()=>expect((screen.getByRole('button',{name:'编辑'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('试算温度 (°C)'),{target:{value:'100'}});fireEvent.change(screen.getByLabelText('试算压力单位'),{target:{value:'MPa'}});fireEvent.change(screen.getByLabelText('试算压力 (MPa)'),{target:{value:'10'}});fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('species_evaluate',{handleId:'local',name:'A',speciesId:'a',temperatureK:373.15,pressurePa:10000000}));
    fireEvent.change(screen.getByLabelText('试算温度 (°C)'),{target:{value:'101'}});fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));await screen.findByText(/有效范围：0–100 °C/);expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_evaluate')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('试算温度 (°C)'),{target:{value:'100'}});fireEvent.change(screen.getByLabelText('试算压力 (MPa)'),{target:{value:'11'}});fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));await screen.findByText(/有效范围：0.1–10 MPa/);expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_evaluate')).toHaveLength(1);
  });
  it('presents readable precision in details and retains the complete original numeric value',async()=>{
    const mass=0.018015279999999998,original=handler;handler=(cmd,args)=>cmd==='species_details'?{...original(cmd,args),molar_mass_kg_mol:mass}:original(cmd,args);const copy=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}});
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:/A H.*水溶液/}));const trigger=await screen.findByLabelText('查看完整数值 0.01801528');fireEvent.click(trigger);expect(screen.getByText(String(mass))).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'复制完整数值 '+String(mass)}));await screen.findByText('已复制');expect(copy).toHaveBeenCalledWith(String(mass));expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_upsert'||cmd==='species_save')).toHaveLength(0);
  });
  it('default path is checked even if it is absent from recents',async()=>{
    const original=handler;handler=(cmd,args)=>cmd==='settings_load'?{...preferences,recent_databases:[],default_database:{kind:'rtdb',path:'/test/default.rtdb'}}:original(cmd,args);
    render(<App/>);await screen.findByText('Reaktoro 2.13.0 已连接');expect(mocks.invoke).toHaveBeenCalledWith('paths_exist',{paths:['/test/default.rtdb']});
  });
  it('new database reports backend errors inline',async()=>{
    mocks.save.mockResolvedValue('/test/exists.rtdb');handler=()=>{throw new Error('目标文件已存在');};
    render(<NewDatabase onClose={()=>{}} onCreated={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'选择…'}));await waitFor(()=>expect((screen.getByRole('button',{name:'创建'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'创建'}));await screen.findByRole('alert');expect(screen.getByText(/目标文件已存在/)).toBeTruthy();
  });
  it('cancelled chooser is not reported as a failed create',async()=>{
    mocks.save.mockResolvedValue(null);render(<NewDatabase onClose={()=>{}} onCreated={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'选择…'}));
    await waitFor(()=>expect(mocks.save).toHaveBeenCalled());expect(screen.queryByRole('alert')).toBeNull();
  });
  it('import parse errors stay visible instead of being swallowed',async()=>{
    mocks.open.mockResolvedValue('/test/bad.yaml');handler=()=>{throw new Error('YAML 结构无效');};render(<ImportDialog summary={summary} onClose={()=>{}} onDone={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'Reaktoro YAML'}));await screen.findByText(/YAML 结构无效/);expect((screen.getByRole('button',{name:'导入所选记录'})as HTMLButtonElement).disabled).toBe(true);
  });
  it('export validates user grid before opening a save panel',async()=>{
    render(<ExportDialog summary={summary} onClose={()=>{}} onDone={()=>{}}/>);
    fireEvent.change(screen.getByLabelText('温度点数'),{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'选择位置并导出'}));
    await screen.findByRole('alert');expect(mocks.save).not.toHaveBeenCalled();
  });
  it('all enabled periodic-table buttons toggle real element state',async()=>{
    handler=(cmd)=>cmd==='model_definitions'?{items:[{id:'extended-maier-kelley',label:'Extended Maier–Kelley',creatable:true,states:[],parameters:[]}]}:{items:[]};
    render(<SpeciesEditor handleId='local' existing={null} onClose={()=>{}} onSaved={async()=>{}}/>);
    await screen.findByRole('option',{name:'Extended Maier–Kelley'});
    fireEvent.click(screen.getByRole('button',{name:'选择组成元素'}));const buttons=[...document.querySelectorAll<HTMLButtonElement>('.periodic-grid button')];expect(buttons).toHaveLength(118);
    for(const button of buttons){fireEvent.click(button);expect(button.classList.contains('selected')).toBe(true);fireEvent.click(button);expect(button.classList.contains('selected')).toBe(false);}
  });
});

describe('first-use navigation and searchable catalog',()=>{
  it('returns to simulation after choosing a database for that purpose',async()=>{
    render(<App/>);await screen.findByText('Reaktoro 2.13.0 已连接');
    fireEvent.click(screen.getByRole('button',{name:/构建平衡计算/}));
    await screen.findByText('为模拟选择数据库 · 打开后继续设置化学体系');
    fireEvent.click(screen.getByRole('button',{name:/lab.*打开数据库/}));
    await screen.findByRole('tab',{name:/系统 species/});expect(screen.queryByRole('heading',{name:'lab'})).toBeNull();
  });
  it('clears the selection intent when leaving the database picker',async()=>{
    render(<App/>);await screen.findByText('Reaktoro 2.13.0 已连接');
    fireEvent.click(screen.getByRole('button',{name:/构建平衡计算/}));await screen.findByText('为模拟选择数据库 · 打开后继续设置化学体系');
    fireEvent.click(screen.getByRole('button',{name:'主页'}));fireEvent.click(screen.getByRole('button',{name:/lab \/test\/lab.rtdb/}));
    await screen.findByRole('heading',{name:'lab'});expect(screen.queryByRole('tab',{name:/系统 species/})).toBeNull();
  });
  it('keeps independent results accessible without a connected runtime',()=>{
    const results=vi.fn();render(<HomePage runtime={{status:'unconfigured',available:false}} prefs={preferences} summary={null} candidates={[]} discovering={false} onOpen={()=>{}} onContinue={()=>{}} onManage={()=>{}} onDiscover={()=>{}} onChoose={()=>{}} onChooseFolder={()=>{}} onCandidate={()=>{}} onSimulation={()=>{}} onResults={results}/>);
    fireEvent.click(screen.getByRole('button',{name:/查看与比较结果/}));expect(results).toHaveBeenCalledOnce();
  });
  it('separates personal and system databases and searches within each space',async()=>{
    const open=vi.fn();const catalog=[{id:'s',group:'SUPCRT',embedded_name:'supcrtbl',species_count:700,element_count:70},{id:'p',group:'PHREEQC',embedded_name:'phreeqc.dat',species_count:300,element_count:30}];
    render(<DatabaseLibrary runtime={runtime} catalog={catalog as any} catalogState="ready" recents={preferences.recent_databases} defaultDb={{kind:'rtdb',path:'/test/lab.rtdb'}} onOpenOfficial={open} onOpenLocal={()=>{}} onNew={()=>{}} onCompose={()=>{}} onCancelIntent={()=>{}} onRuntime={()=>{}} onRetry={()=>{}}/>);
    expect(screen.getAllByRole('button',{name:/lab.*打开数据库/})).toHaveLength(1);
    expect(screen.queryByRole('button',{name:/supcrtbl.*打开数据库/})).toBeNull();
    await screen.findByRole('button',{name:/lab.*52 个 species.*9 个元素/});
    fireEvent.click(screen.getByRole('tab',{name:/系统数据库/}));
    expect(screen.queryByRole('button',{name:/lab.*打开数据库/})).toBeNull();
    fireEvent.change(screen.getByRole('textbox',{name:'搜索数据库'}),{target:{value:'SUPCRT supcrtbl'}});
    expect(screen.queryByRole('button',{name:/phreeqc.dat.*打开数据库/})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:/supcrtbl.*打开数据库/}));expect(open).toHaveBeenCalledWith(catalog[0]);
    fireEvent.click(screen.getByRole('tab',{name:/我的数据库 1/}));expect(screen.getByText('没有匹配的数据库')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'清除搜索'}));expect(screen.getByRole('button',{name:/lab.*打开数据库/})).toBeTruthy();expect(screen.queryByRole('button',{name:/phreeqc.dat.*打开数据库/})).toBeNull();
  });
  it('offers a working retry when the native catalog cannot be read',()=>{
    const retry=vi.fn();render(<DatabaseLibrary runtime={runtime} catalog={[]} catalogState="error" recents={[]} onOpenOfficial={()=>{}} onOpenLocal={()=>{}} onNew={()=>{}} onCompose={()=>{}} onCancelIntent={()=>{}} onRuntime={()=>{}} onRetry={retry}/>);
    fireEvent.click(screen.getByRole('button',{name:'重新加载'}));expect(retry).toHaveBeenCalledOnce();expect(screen.getByRole('alert').textContent).toContain('读取失败');
  });
  it('distinguishes an empty database from unreadable counts and refreshes the saved file',async()=>{
    let count=0;handler=cmd=>cmd==='rtdb_list_info'?{items:[{path:'/test/empty.rtdb',status:'ready',species_count:count,element_count:count?2:0},{path:'/test/broken.rtdb',status:'error',message:'文件无法读取'}]}:{};
    render(<DatabaseLibrary runtime={runtime} catalog={[]} catalogState="ready" recents={[{path:'/test/empty.rtdb',name:'empty',opened_at:''},{path:'/test/broken.rtdb',name:'broken',opened_at:''}]} onOpenOfficial={()=>{}} onOpenLocal={()=>{}} onNew={()=>{}} onCompose={()=>{}} onCancelIntent={()=>{}} onRuntime={()=>{}} onRetry={()=>{}}/>);
    await screen.findByRole('button',{name:/empty.*0 个 species.*0 个元素/});expect(screen.getByText('文件无法读取')).toBeTruthy();
    expect(within(screen.getByRole('button',{name:/broken.*打开数据库/})).getAllByText('—')).toHaveLength(2);
    count=7;fireEvent.click(screen.getByRole('button',{name:'刷新数据库数量'}));await screen.findByRole('button',{name:/empty.*7 个 species.*2 个元素/});
    expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='rtdb_list_info')).toHaveLength(2);
  });
  it('shows current unsaved counts without discarding the open database',async()=>{
    const view=render(<DatabaseLibrary runtime={runtime} catalog={[]} catalogState="ready" recents={preferences.recent_databases} currentSummary={{...summary,species_count:6,element_count:3}} onOpenOfficial={()=>{}} onOpenLocal={()=>{}} onNew={()=>{}} onCompose={()=>{}} onCancelIntent={()=>{}} onRuntime={()=>{}} onRetry={()=>{}}/>);
    await screen.findByRole('button',{name:/lab.*6 个 species.*3 个元素/});expect(screen.getByText('未保存')).toBeTruthy();
    expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==='database_close')).toBe(false);view.unmount();
  });
});

it('honors cancelling a pending simulation save before closing the app',async()=>{
 await openCurrent();const flush=vi.fn(async()=>false);(window as any).__easyreaktoroFlushSimulation=flush;
 const event={preventDefault:vi.fn()};await act(async()=>mocks.closeListener(event));expect(flush).toHaveBeenCalled();expect(event.preventDefault).toHaveBeenCalled();expect(mocks.destroy).not.toHaveBeenCalled();
 delete (window as any).__easyreaktoroFlushSimulation;
});
it('keeps application settings focused on the application rather than detailed model and plot defaults',async()=>{
 render(<App/>);await screen.findByText('Reaktoro 2.13.0 已连接');fireEvent.click(screen.getByRole('button',{name:'设置'}));
 expect(screen.getByLabelText('自动保存模拟')).toBeTruthy();expect(screen.queryByLabelText('新模拟默认温度')).toBeNull();expect(screen.queryByLabelText('结果多图默认布局')).toBeNull();
 const tabs=document.querySelector('.settings-layout nav')!;expect(tabs.textContent).toBe('常规数据库与文件Reaktoro 环境关于');
});

describe('database reading and editing recovery',()=>{
 it('never presents old species as the result of a failed search and retries the same query in place',async()=>{
  const original=handler;let fail=true;const found={...rows[1],id:'found',name:'Found',fingerprint:'new'};
  handler=(cmd,args)=>cmd==='species_page'&&args.query==='target'?(fail?Promise.reject(Error('temporary connection failure')):{items:[found],total:1,states:['Aqueous'],models:['extended-maier-kelley']}):cmd==='species_details'&&args.name==='Found'?{...found,model:{type:'extended-maier-kelley'},composition:{H:1}}:original(cmd,args);
  await openCurrent();fireEvent.change(screen.getByLabelText('搜索 species'),{target:{value:'target'}});await screen.findByText('species 列表未能更新');
  expect(screen.queryByRole('button',{name:/^A H/})).toBeNull();expect(screen.queryByRole('button',{name:/^B H/})).toBeNull();expect((screen.getByLabelText('搜索 species') as HTMLInputElement).value).toBe('target');
  fail=false;fireEvent.click(screen.getByRole('button',{name:'重新读取 species'}));await screen.findByRole('button',{name:/^Found H/});expect(screen.queryByText('species 列表未能更新')).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==='species_page'&&args.query==='target')).toHaveLength(2);
 });
 it('shows a local detail retry without claiming that unloaded metadata is absent',async()=>{
  const original=handler;let fail=true;handler=(cmd,args)=>cmd==='species_details'&&args.name==='B'?(fail?Promise.reject(Error('temporary detail failure')):{...rows[1],model:{type:'extended-maier-kelley'},references:['Recovered citation'],composition:{H:1}}):original(cmd,args);
  await openCurrent();fireEvent.click(screen.getByRole('button',{name:/^B H/}));await screen.findByText('详情暂时无法显示');expect(screen.queryByText('尚无参考文献。可查阅该数据库的说明文件或原始文献。')).toBeNull();
  fail=false;fireEvent.click(screen.getByRole('button',{name:'重新读取详情'}));await waitFor(()=>expect(screen.queryByText('详情暂时无法显示')).toBeNull());fireEvent.click(screen.getByRole('button',{name:'来源与参考文献'}));await screen.findByText('Recovered citation');
 });
 it('reloads a selected record after its fingerprint changes while retaining the inspector tab',async()=>{
  const original=handler;let revision=1;
  handler=(cmd,args)=>cmd==='species_page'?{items:rows.map(x=>({...x,fingerprint:'revision-'+revision})),total:2,states:['Aqueous'],models:['extended-maier-kelley']}:cmd==='species_details'?{...rows.find(x=>x.name===args.name),model:{type:'extended-maier-kelley'},composition:{H:1},references:['Reference version '+revision]}:original(cmd,args);
  await openCurrent();fireEvent.click(screen.getByRole('button',{name:'来源与参考文献'}));await screen.findByText('Reference version 1');
  revision=2;act(()=>window.dispatchEvent(new Event('easyreaktoro:species-mutated')));await screen.findByText('Reference version 2');expect(screen.queryByText('Reference version 1')).toBeNull();expect(screen.getByRole('heading',{name:'A'})).toBeTruthy();
 });
 it('preserves plain-text references through a notes edit and permits deliberate citation edits without character objects',async()=>{
  const onSaved=vi.fn();const item={id:'x',name:'X',formula:'H',composition:{H:1},charge:0,state:'Aqueous',model:{type:'reaktoro-native'},activity_parameters:{},references:['Original plain-text reference'],notes:'',valid_tp:{},dependencies:[],reaction:{}};
  handler=cmd=>cmd==='model_definitions'?{items:[{id:'reaktoro-native',label:'Reaktoro 数据',creatable:false,states:[],parameters:[]}]}:{items:[]};
  render(<SpeciesEditor handleId="local" existing={item} onClose={()=>{}} onSaved={onSaved}/>);await screen.findByRole('option',{name:'Reaktoro 数据'});
  expect((screen.getByLabelText('完整引用') as HTMLTextAreaElement).value).toBe(item.references[0]);fireEvent.change(screen.getByLabelText('备注（可选）'),{target:{value:'Notes only'}});fireEvent.click(screen.getByRole('button',{name:'保存 species'}));await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(1));expect(onSaved.mock.calls[0][0].references).toEqual(item.references);
  fireEvent.change(screen.getByLabelText('完整引用'),{target:{value:'Corrected reference'}});fireEvent.click(screen.getByRole('button',{name:'保存 species'}));await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(2));expect(onSaved.mock.calls[1][0].references).toEqual([{raw:'Corrected reference'}]);
 });
 it('restores each model’s typed parameters when switching back during one editing session',async()=>{
  const onSaved=vi.fn();const item={id:'x',name:'X',formula:'H',composition:{H:1},charge:0,state:'Aqueous',model:{type:'extended-maier-kelley',parameters:{G298:-1000},units:{G298:'J/mol'}},activity_parameters:{},references:[],notes:'',valid_tp:{},dependencies:[],reaction:{}};
  handler=cmd=>cmd==='model_definitions'?{items:[{id:'extended-maier-kelley',label:'Extended Maier–Kelley',creatable:true,states:[],parameters:[{name:'G298',label:'Reference Gibbs energy',unit:'J/mol',required:true}]},{id:'akinfiev-diamond',label:'Akinfiev–Diamond',creatable:true,states:['Aqueous'],parameters:[{name:'xi',label:'Hydration parameter',unit:'1',required:true}]}]}:{items:[]};
  render(<SpeciesEditor handleId="local" existing={item} onClose={()=>{}} onSaved={onSaved}/>);await screen.findByRole('option',{name:'Extended Maier–Kelley'});fireEvent.change(screen.getByLabelText(/Reference Gibbs energy/),{target:{value:'-1234'}});
  fireEvent.change(screen.getByLabelText('模型'),{target:{value:'akinfiev-diamond'}});fireEvent.change(screen.getByLabelText(/Hydration parameter/),{target:{value:'.7'}});fireEvent.change(screen.getByLabelText('模型'),{target:{value:'extended-maier-kelley'}});
  expect((screen.getByLabelText(/Reference Gibbs energy/) as HTMLInputElement).value).toBe('-1234');fireEvent.change(screen.getByLabelText('模型'),{target:{value:'akinfiev-diamond'}});expect((screen.getByLabelText(/Hydration parameter/) as HTMLInputElement).value).toBe('.7');
  fireEvent.change(screen.getByLabelText('模型'),{target:{value:'extended-maier-kelley'}});fireEvent.click(screen.getByRole('button',{name:'保存 species'}));await waitFor(()=>expect(onSaved).toHaveBeenCalled());expect(onSaved.mock.calls[0][0].model).toMatchObject({type:'extended-maier-kelley',parameters:{G298:-1234},units:item.model.units});
 });
 it('uses a recognizable PHREEQC log K label in the list and inspector',async()=>{
  const original=handler;handler=(cmd,args)=>cmd==='species_page'?{items:[{...rows[0],model:'PhreeqcLgK'}],total:1,states:['Aqueous'],models:['PhreeqcLgK']}:cmd==='species_details'?{...rows[0],model:{type:'reaktoro-native',native_type:'PhreeqcLgK'},composition:{H:1}}:original(cmd,args);
  await openCurrent();expect(screen.getAllByText('PHREEQC log K').length).toBeGreaterThanOrEqual(2);expect(screen.queryByText('PhreeqcLgK')).toBeNull();
 });
});

 it('keeps the current species query when database changes trigger a refresh',async()=>{
  const original=handler;handler=(cmd,args)=>cmd==='species_page'?{items:rows,total:2,states:['Aqueous'],models:['extended-maier-kelley']}:original(cmd,args);
  await openCurrent();fireEvent.change(screen.getByLabelText('搜索 species'),{target:{value:'current query'}});await waitFor(()=>expect(mocks.invoke.mock.calls.some(([cmd,args])=>cmd==='species_page'&&args.query==='current query')).toBe(true));
  const count=mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_page').length;act(()=>window.dispatchEvent(new Event('easyreaktoro:species-mutated')));await waitFor(()=>expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_page').length).toBe(count+1));
  expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_page').at(-1)?.[1].query).toBe('current query');expect((screen.getByLabelText('搜索 species') as HTMLInputElement).value).toBe('current query');
 });

describe('home simulation access',()=>{
 const latest={id:'newer-sim',name:'Newer modified simulation',database:{kind:'rtdb' as const,path:'/test/newer.rtdb',name:'newer'},updated_at:'2026-09-08T10:00:00Z',species_count:0,point_count:1};
 const selected={...latest,id:'selected-sim',name:'Last selected simulation',database:{kind:'rtdb' as const,path:'/test/selected.rtdb',name:'selected'},updated_at:'2026-09-08T09:00:00Z'};
 function provideHistory(active:string|null='selected-sim'){
  const original=handler,stored=new Map<string,string>();if(active)stored.set('easyreaktoro.simulation.active',active);
  Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(key:string)=>stored.get(key)||null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)}});
  handler=(cmd,args)=>{
   if(cmd==='simulation_history'){
    const p=args.payload;
    if(p.action==='list')return {entries:[latest,selected],directory:'/test/Simulations',unreadable:0};
    if(p.action==='read'){const entry=[latest,selected].find(x=>x.id===p.id)!;return {version:1,id:entry.id,database:entry.database,updated_at:entry.updated_at,config:{...structuredClone(DEFAULT_CONFIG),name:entry.name}};}
    if(p.action==='write')return {success:true,path:'/test/Simulations/'+p.document.id+'.json'};
   }
   if(cmd==='rtdb_open')return {summary:{...summary,handle_id:'resume-db',path:args.path,embedded_name:args.path.includes('selected')?'selected':'newer',dirty:false}};
   if(cmd==='simulation_call'&&args.payload.action==='catalog')return {items:[]};
   return original(cmd,args);
  };
  return stored;
 }
 it('resumes the last selected simulation from home by opening its database without a chooser',async()=>{
  provideHistory();render(<App/>);const resume=await screen.findByRole('button',{name:/继续上次模拟.*Last selected simulation/});expect(screen.queryByRole('tab',{name:/系统 species/})).toBeNull();
  fireEvent.click(resume);await waitFor(()=>expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe('Last selected simulation'));
  expect(mocks.invoke.mock.calls.some(([cmd,args])=>cmd==='rtdb_open'&&args.path==='/test/selected.rtdb')).toBe(true);expect(mocks.invoke.mock.calls.some(([cmd,args])=>cmd==='rtdb_open'&&args.path==='/test/newer.rtdb')).toBe(false);expect(mocks.open).not.toHaveBeenCalled();expect(screen.queryByText('为模拟选择数据库 · 打开后继续设置化学体系')).toBeNull();expect(screen.getByRole('button',{name:'新建模拟'})).toBeTruthy();
 });
 it('opens simulation history before any database is selected and restores the chosen entry',async()=>{
  provideHistory();render(<App/>);fireEvent.click(await screen.findByRole('button',{name:'模拟历史'}));const panel=await screen.findByRole('dialog',{name:'模拟历史'});
  expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==='rtdb_open'||cmd==='database_open')).toBe(false);
  fireEvent.click(within(panel).getByRole('button',{name:/Last selected simulation.*selected/}));await waitFor(()=>expect((screen.getByLabelText('模拟名称') as HTMLInputElement).value).toBe('Last selected simulation'));expect(screen.queryByRole('dialog',{name:'模拟历史'})).toBeNull();
 });
 it('falls back to the latest saved simulation when the old selection was deleted without changing startup behavior',async()=>{
  provideHistory('no-longer-present');render(<App/>);await screen.findByRole('button',{name:/继续上次模拟.*Newer modified simulation/});
  expect(screen.getByRole('heading',{name:'从热力学数据，到反应与结果'})).toBeTruthy();expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==='rtdb_open'||cmd==='database_open')).toBe(false);expect(mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==='settings_save'&&args.settings.startup!=='home')).toHaveLength(0);
 });
});

it('retains a working environment and database after a selected Python fails to connect, and clears the error after a healthy check', async()=>{
  const base=handler;
  handler=(cmd,args)=>cmd==='rtdb_open'?{summary:{...summary,dirty:false}}:cmd==='pick_path'?'/other/bin/python':cmd==='runtime_select'?Promise.reject(new Error("ModuleNotFoundError: No module named 'reaktoro'")):cmd==='runtime_discover'?{entries:[runtime]}:base(cmd,args);
  await openCurrent();
  fireEvent.click(screen.getByRole('button',{name:'设置'}));fireEvent.click(screen.getByRole('button',{name:'Reaktoro 环境'}));
  fireEvent.click(screen.getByRole('button',{name:'选择 Python'}));
  await screen.findByText('这个 Python 中没有安装 Reaktoro');
  expect(screen.getByRole('heading',{name:'Reaktoro 2.13.0'})).toBeTruthy();
  expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==='database_close')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'数据库'}));await screen.findByRole('heading',{name:'lab'});
  fireEvent.click(screen.getByRole('button',{name:'设置'}));
  expect(screen.getByText('这个 Python 中没有安装 Reaktoro')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'检查并重新连接'}));
  await screen.findByText('Reaktoro 2.13.0 连接正常。');expect(screen.queryByText('这个 Python 中没有安装 Reaktoro')).toBeNull();
});
