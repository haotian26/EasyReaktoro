// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import App, {HomePage, NewDatabase, ImportDialog, ExportDialog, SpeciesEditor, ModelParameterTable, normalizePreferences, DependencyReport} from './AppV3';

const mocks = vi.hoisted(() => ({invoke:vi.fn(),open:vi.fn(),save:vi.fn(),destroy:vi.fn(),onClose:vi.fn(),closeListener:null as any}));
vi.mock('@tauri-apps/api/core',() => ({invoke:mocks.invoke}));
vi.mock('@tauri-apps/api/event',() => ({listen:async()=>()=>{}}));
vi.mock('@tauri-apps/plugin-dialog',() => ({open:mocks.open,save:mocks.save}));
vi.mock('@tauri-apps/api/window',() => ({getCurrentWindow:() => ({onCloseRequested:mocks.onClose,destroy:mocks.destroy})}));
const runtime={available:true,status:'ready' as const,version:'2.13.0',python:'/test/env/bin/python'};
const preferences={language:'zh-CN',theme:'dark' as const,density:'comfortable' as const,startup:'home' as const,recent_databases:[{path:'/test/lab.rtdb',name:'lab',opened_at:''}]};
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

describe('workflow regressions',() => {
  it('custom model details use registry labels and units',()=>{
    render(<ModelParameterTable value={{G298:-1000}} definition={{parameters:[{name:'G298',label:'G°(298.15 K)',unit:'J/mol'}]} as any}/>);
    expect(screen.getByText('G°(298.15 K)')).toBeTruthy();expect(screen.getByText('J/mol')).toBeTruthy();
  });
  it('dependency errors explain ambiguity and show the complete path',()=>{
    render(<DependencyReport issues={[{code:'AMBIGUOUS_DEPENDENCY',chain:['Target','Base'],candidates:['Base / A','Base / B']}]} />);
    expect(screen.getByText('同名物种来源不明确')).toBeTruthy();expect(screen.getByText('Target → Base')).toBeTruthy();expect(screen.queryByText('AMBIGUOUS_DEPENDENCY')).toBeNull();
  });
  it('keyboard search and save act on the current workspace',async()=>{
    await openCurrent();fireEvent.keyDown(window,{key:'f',metaKey:true});expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'搜索物种'}));
    fireEvent.keyDown(window,{key:'s',metaKey:true});await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('rtdb_save',{handleId:'local'}));await screen.findByText('数据库已保存');
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
    const query=screen.getByRole('textbox',{name:'查找元素'});fireEvent.change(query,{target:{value:'氧'}});expect(screen.getByText('1 个匹配')).toBeTruthy();
    fireEvent.keyDown(query,{key:'Enter'});expect(screen.getByRole('button',{name:'O 氧 Oxygen'}).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(query,{key:'Enter'});fireEvent.click(screen.getByRole('button',{name:'清除搜索'}));
    const scroll=vi.fn();Object.defineProperty(document.getElementById('editor-references'),'scrollIntoView',{value:scroll,configurable:true});fireEvent.click(screen.getByRole('button',{name:'文献与备注'}));expect(scroll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(onClose).toHaveBeenCalled();expect(screen.queryByText(/确定放弃吗/)).toBeNull();
  });
  it('confirmed import exposes dirty summary before returning to the workspace',async()=>{
    mocks.open.mockResolvedValue('/test/import.yaml');const done=vi.fn();
    handler=(cmd)=>cmd==='import_preview'?{items:[{name:'X',formula:'H',fingerprint:'f'}],can_commit:true,missing_dependencies:[],cycles:[],issues:[],rename_decisions:[],reused_count:0,source_revision:'r'}:cmd==='import_commit'?{success:true,summary}:{};
    render(<ImportDialog summary={summary} onClose={()=>{}} onDone={done}/>);fireEvent.click(screen.getByRole('button',{name:'Reaktoro YAML'}));await screen.findByText('X');
    fireEvent.click(screen.getByRole('button',{name:'检查所选物种'}));await waitFor(()=>expect((screen.getByRole('button',{name:'添加所选物种'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'添加所选物种'}));await waitFor(()=>expect(done).toHaveBeenCalledWith(summary));
  });
  it('a false save result cannot close a dirty database',async()=>{
    const old=handler;handler=(cmd,args)=>cmd==='rtdb_save'?{success:false,summary:{...summary,dirty:false}}:old(cmd,args);
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'操作'}));fireEvent.click(screen.getByRole('button',{name:'关闭数据库'}));fireEvent.click(screen.getByRole('button',{name:'保存并关闭'}));
    await screen.findByText(/保存失败/);expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='database_close')).toHaveLength(0);
  });
  it('closing the element chooser discards unapplied filters',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'元素周期表'}));
    fireEvent.click(screen.getByRole('button',{name:'H 氢 Hydrogen'}));fireEvent.click(screen.getByRole('button',{name:'关闭对话框'}));
    fireEvent.click(screen.getByRole('button',{name:'元素周期表'}));expect(screen.getByRole('button',{name:'H 氢 Hydrogen'}).getAttribute('aria-pressed')).toBe('false');
  });
  it('editing only notes preserves activity parameters for other models',async()=>{
    const onSaved=vi.fn();const item={id:'x',name:'X',formula:'Na+',composition:{Na:1},charge:1,state:'Aqueous',model:{type:'reaktoro-native'},activity_parameters:{model:'sit',epsilon:0.25},references:[],notes:'',valid_tp:{},dependencies:[],reaction:{}};
    handler=(cmd)=>cmd==='model_definitions'?{items:[{id:'reaktoro-native',label:'Reaktoro native',creatable:false,states:[],parameters:[]}]}:{items:[]};
    render(<SpeciesEditor handleId='local' existing={item} onClose={()=>{}} onSaved={onSaved}/>);
    await screen.findByRole('option',{name:'Reaktoro native'});fireEvent.change(screen.getByLabelText('备注（可选）'),{target:{value:'notes only'}});fireEvent.click(screen.getByRole('button',{name:'保存物种'}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalled());expect(onSaved.mock.calls[0][0].activity_parameters).toEqual(item.activity_parameters);
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
    const open=vi.fn();render(<HomePage runtime={runtime} prefs={preferences} summary={null} candidates={[]} discovering={false} onOpen={open} onContinue={()=>{}} onManage={()=>{}} onDiscover={()=>{}} onChoose={()=>{}} onChooseFolder={()=>{}} onCandidate={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:/lab \/test\/lab.rtdb/}));expect(open).toHaveBeenCalledWith('/test/lab.rtdb');
    fireEvent.click(screen.getByRole('button',{name:/打开 .rtdb/}));expect(open).toHaveBeenLastCalledWith();
    expect(screen.queryByRole('button',{name:/进入数据库/})).toBeNull();
  });
  it('opening recent through the app does not show the file chooser',async()=>{
    await openCurrent();expect(mocks.open).not.toHaveBeenCalled();expect(mocks.invoke).toHaveBeenCalledWith('rtdb_open',{path:'/test/lab.rtdb'});
  });
  it('managing databases retains the dirty workspace',async()=>{
    await openCurrent();fireEvent.click(screen.getByRole('button',{name:'主页'}));
    fireEvent.click(screen.getByRole('button',{name:/管理数据库 我的数据库/}));
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
    fireEvent.change(screen.getByLabelText('温度 (K)'),{target:{value:'-1'}});fireEvent.click(screen.getByRole('button',{name:'计算标准热力学性质'}));
    await screen.findByText(/大于 0 K/);expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==='species_evaluate')).toHaveLength(0);
    expect(document.querySelectorAll('.detail-card sub').length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getByRole('button',{name:'Reaktoro YAML'}));await screen.findByText(/YAML 结构无效/);expect((screen.getByRole('button',{name:'添加所选物种'})as HTMLButtonElement).disabled).toBe(true);
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
    const buttons=[...document.querySelectorAll<HTMLButtonElement>('.periodic-grid button')];expect(buttons).toHaveLength(118);
    for(const button of buttons){fireEvent.click(button);expect(button.classList.contains('selected')).toBe(true);fireEvent.click(button);expect(button.classList.contains('selected')).toBe(false);}
  });
});
