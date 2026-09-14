// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {setLanguage,registerMessages} from './i18n';
import App,{normalizePreferences,SpeciesEditor,NewDatabase,ImportDialog,ExportDialog,ModelParameterTable} from './AppV3';
import {PeriodicTable,ElementChooser} from './chemistry';
import {DEFAULT_TRIAL_TP,TrialConditions,readTrialTP,ReadableNumber,type TrialTP} from './database-reading';
import {DatabaseSwitcher} from './DatabaseSwitcher';

const mocks=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn(),save:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:async()=>()=>{}}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:mocks.open,save:mocks.save}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({onCloseRequested:async()=>()=>{},destroy:vi.fn()})}));
const runtime={available:true,status:'ready',version:'2.13.0',python:'/test/env/bin/python'};
const summary={handle_id:'local',kind:'rtdb',path:'/test/热液实验.rtdb',embedded_name:'热液实验',read_only:false,dirty:false,species_count:2,element_count:2,native_exportable_count:0};
const species={id:'water',name:'水的原始名称',formula:'H2O(aq)',state:'Aqueous',model:'extended-maier-kelley',charge:0,elements:['H','O']};
const definition={id:'extended-maier-kelley',label:'Extended Maier–Kelley',description:'测试模型说明',creatable:true,states:['Aqueous'],parameters:[{name:'G298',label:'测试自由能',unit:'J/mol',help:'测试参数说明',required:true}]};
let handler:(command:string,args:any)=>any;
beforeEach(()=>{
 setLanguage('zh-CN');vi.clearAllMocks();
 registerMessages({'测试模型说明':'Standard-state properties from the selected model.','测试自由能':'Reference Gibbs energy','测试参数说明':'Use the stated reference conditions.','测试后台错误':'The database could not be read.'});
 handler=(command,args)=>{
  switch(command){
   case 'settings_load':return normalizePreferences({language:'zh-CN',recent_databases:[{path:summary.path,name:'热液实验',opened_at:''}]});
   case 'settings_save':return {success:true};
   case 'paths_exist':return args.paths.map((path:string)=>({path,exists:true}));
   case 'runtime_probe':return runtime;
   case 'catalog_list':return {entries:[]};
   case 'rtdb_open':return {summary};
   case 'rtdb_list_info':return {items:args.paths.map((path:string)=>({path,status:'ready',species_count:2,element_count:2}))};
   case 'species_page':return {items:[species],total:1,states:['Aqueous'],models:['extended-maier-kelley']};
   case 'species_details':return {...species,molar_mass_kg_mol:0.018015279999999998,composition:{H:2,O:1},model:{type:'extended-maier-kelley',parameters:{G298:-1000}},notes:'测试模型说明',references:['测试模型说明']};
   case 'model_definitions':return {items:[definition]};
   case 'database_summary':return {summary};
   default:return {items:[]};
  }
 };
 mocks.invoke.mockImplementation((command,args)=>Promise.resolve().then(()=>handler(command,args)));
});
afterEach(()=>{cleanup();setLanguage('zh-CN');});

it('normalizes and restores the chosen language',()=>{
 expect(normalizePreferences({language:'en'}).language).toBe('en');
 expect(normalizePreferences({language:'en-AU'}).language).toBe('en');
 expect(normalizePreferences({language:'zh-CN'}).language).toBe('zh-CN');
 expect(normalizePreferences({language:42}).language).toBe('zh-CN');
});
it('starts in saved English while preserving the database filename',async()=>{
 const original=handler;handler=(command,args)=>command==='settings_load'?{...original(command,args),language:'en'}:original(command,args);
 render(<App/>);
 await screen.findByText('From thermodynamic data to reactions and results');
 expect(screen.getByText('Database and species management')).toBeTruthy();
 expect(screen.getByRole('button',{name:/热液实验 \/test\/热液实验.rtdb/})).toBeTruthy();
 expect(document.documentElement.lang).toBe('en');
});
it('persists a settings language change without replacing the open database or selected species',async()=>{
 render(<App/>);
 fireEvent.click(await screen.findByRole('button',{name:/热液实验 \/test\/热液实验.rtdb/}));
 await screen.findByText('摩尔质量 (kg/mol)');
 const reads=mocks.invoke.mock.calls.filter(([command])=>command==='species_details').length;
 fireEvent.click(screen.getByRole('button',{name:'设置'}));
 fireEvent.change(screen.getByRole('combobox',{name:'界面语言'}),{target:{value:'en'}});
 await screen.findByRole('combobox',{name:'Interface language'});
 await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('settings_save',{settings:expect.objectContaining({language:'en'})}));
 fireEvent.click(screen.getByRole('button',{name:'Database'}));
 expect(await screen.findByText('Molar mass (kg/mol)')).toBeTruthy();
 expect(screen.getByRole('heading',{name:'水的原始名称'})).toBeTruthy();
 expect(mocks.invoke.mock.calls.filter(([command])=>command==='species_details')).toHaveLength(reads);
 expect(mocks.invoke.mock.calls.some(([command])=>command==='database_close')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Sources and references'}));
 expect(screen.getAllByText('测试模型说明').length).toBeGreaterThan(0);
});
it('translates an open species form without remounting or overwriting its entries',async()=>{
 const onClose=vi.fn();render(<SpeciesEditor handleId='local' existing={null} onClose={onClose} onSaved={vi.fn()}/>);
 await screen.findByRole('option',{name:'Extended Maier–Kelley'});
 const name=screen.getByLabelText('species 名称');fireEvent.change(name,{target:{value:'测试模型说明'}});
 const parameter=screen.getByLabelText(/测试自由能/);fireEvent.change(parameter,{target:{value:'-12345.678901234'}});
 act(()=>setLanguage('en'));
 expect(screen.getByLabelText('Species name')).toBe(name);expect((name as HTMLInputElement).value).toBe('测试模型说明');
 expect(screen.getByLabelText(/Reference Gibbs energy/)).toBe(parameter);expect((parameter as HTMLInputElement).value).toBe('-12345.678901234');
 expect(screen.getByText('Standard-state properties from the selected model.')).toBeTruthy();
 expect(screen.getByText('Use the stated reference conditions.')).toBeTruthy();
 expect(mocks.invoke.mock.calls.filter(([command])=>command==='model_definitions')).toHaveLength(1);
 expect(screen.getByRole('dialog').textContent).not.toMatch(/[\u3400-\u9fff]/);
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(screen.getByRole('alertdialog').textContent).toContain('Discard changes to this species?');expect(onClose).not.toHaveBeenCalled();
});
it('keeps periodic-table selections and search while switching element names',()=>{
 function Harness(){const [selected,onChange]=useState(['H']);return <PeriodicTable selected={selected} onChange={onChange}/>;}
 render(<Harness/>);const search=screen.getByRole('textbox',{name:'查找元素'});fireEvent.change(search,{target:{value:'氧'}});
 act(()=>setLanguage('en'));
 expect(screen.getByRole('textbox',{name:'Find elements'})).toBe(search);expect((search as HTMLInputElement).value).toBe('氧');
 expect(screen.getByRole('button',{name:'H Hydrogen'}).getAttribute('aria-pressed')).toBe('true');
 fireEvent.keyDown(search,{key:'Enter'});expect(screen.getByRole('button',{name:'O Oxygen'}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('button',{name:'Og Oganesson'}).getAttribute('title')).toBe('Oganesson · Og');
});
it('retains unapplied element choices in the open dialog through a language change',()=>{
 const onApply=vi.fn();render(<ElementChooser selected={['H']} onApply={onApply} onClose={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'O 氧'}));act(()=>setLanguage('en'));
 expect(screen.getByRole('dialog',{name:'Choose constituent elements'})).toBeTruthy();
 expect(onApply).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Use these elements'}));expect(onApply).toHaveBeenCalledWith(['H','O']);
});
it('preserves trial units, physical values, and complete precision across language changes',()=>{
 let latest:TrialTP=DEFAULT_TRIAL_TP;
 function Harness(){const [value,onChange]=useState({...DEFAULT_TRIAL_TP});latest=value;return <><TrialConditions value={value} onChange={onChange}/><ReadableNumber value={0.018015279999999998}/></>;}
 render(<Harness/>);const temp=screen.getByLabelText('试算温度 (°C)');fireEvent.change(temp,{target:{value:'125.25'}});fireEvent.change(screen.getByLabelText('试算压力单位'),{target:{value:'MPa'}});
 const before=readTrialTP(latest);act(()=>setLanguage('en'));
 expect(screen.getByLabelText('Trial temperature (°C)')).toBe(temp);expect(readTrialTP(latest)).toEqual(before);
 expect((screen.getByLabelText('Trial pressure unit') as HTMLSelectElement).value).toBe('MPa');
 expect(screen.getByLabelText('View full value 0.01801528')).toBeTruthy();expect(screen.getByText('0.018015279999999998')).toBeTruthy();
});
it('translates database switching controls and counts without translating user names or paths',async()=>{
 setLanguage('en');const choose=vi.fn();
 render(<DatabaseSwitcher name='热液实验' current={{kind:'rtdb',name:'热液实验',path:summary.path}} currentCounts={{species_count:2,element_count:2}} dirty={false} disabled={false} catalog={[]} recents={[{name:'热液实验',path:summary.path}]} onChoose={choose} onFile={vi.fn()} onCombine={vi.fn()} onInspect={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Switch simulation database'}));
 expect(screen.getByRole('dialog',{name:'Choose simulation database'})).toBeTruthy();expect(screen.getByText('2 species · 2 elements')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'热液实验 2 species · 2 elements'}));expect(choose).toHaveBeenCalledWith({kind:'rtdb',name:'热液实验',path:summary.path});
});
it('localizes native database save dialogs without changing chosen filenames',async()=>{
 setLanguage('en');mocks.save.mockResolvedValue('/test/原样保留.rtdb');render(<NewDatabase onClose={vi.fn()} onCreated={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Choose…'}));
 await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({title:'Save EasyReaktoro database',filters:[{name:'EasyReaktoro database',extensions:['rtdb']}]})));
 expect(await screen.findByDisplayValue('/test/原样保留.rtdb')).toBeTruthy();
});
it('provides English import and export guidance while retaining scientific identifiers and units',()=>{
 setLanguage('en');const {unmount}=render(<ImportDialog summary={summary as any} onClose={vi.fn()} onDone={vi.fn()}/>);
 expect(screen.getByRole('dialog').textContent).toContain('Source files are not modified');expect(screen.getByRole('dialog').textContent).not.toMatch(/[\u3400-\u9fff]/);unmount();
 render(<ExportDialog summary={summary as any} onClose={vi.fn()} onDone={vi.fn()}/>);
 expect(screen.getByRole('dialog').textContent).toContain('Temperature–pressure interpolation data (YAML)');
 expect(screen.getByLabelText('Minimum temperature (°C)')).toBeTruthy();expect(screen.getByLabelText('Maximum pressure (bar)')).toBeTruthy();
 expect(screen.getByRole('dialog').textContent).not.toMatch(/[\u3400-\u9fff]/);
});
it('translates registry labels without rounding or converting the model parameter itself',()=>{
 setLanguage('en');render(<ModelParameterTable value={{G298:-12345.678901234}} definition={definition as any}/>);
 expect(screen.getByText('Reference Gibbs energy')).toBeTruthy();expect(screen.getByText('J/mol')).toBeTruthy();expect(screen.getByText('-12345.678901234')).toBeTruthy();
});
