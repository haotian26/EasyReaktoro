import {JSDOM} from 'jsdom';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {embeddedExplorer} from './explorer-shell';
const windows:any[]=[];
function setup(embedded=true,sourceHTML?:string){
 const html=sourceHTML??embeddedExplorer('shell-test');
 const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://local.test'}),w:any=dom.window;
 windows.push(w);const parent=embedded?{postMessage:vi.fn()}:w;Object.defineProperty(w,'parent',{value:parent});
 w.ResizeObserver=class{observe(){} disconnect(){}};
 w.matchMedia=()=>({matches:false,addEventListener:vi.fn()});w.HTMLElement.prototype.scrollIntoView=vi.fn();
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)![1];
 vm.runInContext(script+';globalThis.qa={install:p=>install(p),readFiles,installHost:p=>{installingHost=true;try{install(p);}finally{installingHost=false;}},state:()=>state,panels:()=>panels,model:()=>model,specs:()=>plotSpecs,appearance:applyAppearance,download:(b,n)=>download(b,n)};',dom.getInternalVMContext());
 return {w,parent,qa:w.qa,dom,send:(message:any)=>w.dispatchEvent(new w.MessageEvent('message',{source:parent,data:{channel:'shell-test',...message}}))};
}
const payload={format:'result-explorer-1',name:'Test run',key_columns:['id'],summary:{columns:['id','temperature_c','pressure_bar','pH'],rows:[[1,25,100,7],[2,25,50,6.8]]},species_tables:[{columns:['id','species','phase_type','amount_mol'],rows:[[1,'Na+','aqueous',.1],[2,'Na+','aqueous',.2]]}],view:{charts:[{id:'chart-1',selectedStates:['state:pH']}],bookmarks:[0],reference:0}};
afterEach(()=>{windows.splice(0).forEach(w=>w.close());vi.useRealTimers();});
describe('workspace save coverage',()=>{
 it('counts actual loaded states rather than selected species, plotted points or claimed page sizes',async()=>{
  const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
  const data={...payload,view:undefined,metadata:{expected_points:100,completed_points:999,preview_cycle:2}};
  send({type:'load',runKey:'large',datasetKey:'page-2',revision:1,sourcePointCount:12,point_count:500,data:gzipSync(JSON.stringify(data)).toString('base64')});
  await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded')).toBe(true));
  expect(w.document.getElementById('workspace-range').textContent).toBe('已载入 2 / 12 点');
  expect(w.document.getElementById('save-workspace').title).toContain('10 点未载入');
  expect(w.document.getElementById('save-workspace').title).toContain('原计划 100 点');
  expect(qa.state().charts[0].selectedSpecies).toEqual([]);expect(qa.state().charts[0].selectedStates).toEqual([]);
  qa.state().charts[0].selectedStates=['state:pH'];qa.state().zoom=[50,50];
  w.document.getElementById('next-point').click();
  expect(w.document.getElementById('workspace-range').textContent).toBe('已载入 2 / 12 点');
  send({type:'load',runKey:'large',datasetKey:'page-3',revision:2,sourcePointCount:15,data:gzipSync(JSON.stringify({...data,summary:{...data.summary,rows:[data.summary.rows[0]]},species_tables:[]})).toString('base64')});
  await vi.waitFor(()=>expect(w.document.getElementById('workspace-range').textContent).toBe('已载入 1 / 15 点'));
  qa.install({...payload,name:'Unrelated CSV'});
  expect(w.document.getElementById('workspace-range').textContent).toBe('已载入 2 点 · 总数未知');
 });
 it('saves all loaded rows and preserves partial coverage after reopening an HTML workspace',async()=>{
  const {w,qa,parent,send}=setup();
  qa.install({...payload,metadata:{expected_points:20,workspace_scope:{version:1,loaded_points:2,source_points:12}}});
  qa.state().zoom=[50,50];w.document.getElementById('next-point').click();
  w.document.getElementById('save-workspace').click();
  await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='download')).toBe(true));
  const message=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='download')![0],html=Buffer.from(message.data,'base64').toString();
  const saved=await qa.readFiles([{name:'subset.html',size:html.length,lastModified:0,text:async()=>html}]);
  expect(saved.summary.rows).toHaveLength(2);expect(saved.metadata.workspace_scope).toEqual({version:1,loaded_points:2,source_points:12,planned_points:20});
  send({type:'download-result',id:message.id,ok:true});
  await vi.waitFor(()=>expect(w.document.getElementById('toast').textContent).toContain('已载入 2 / 12 点'));
  const standalone=setup(false,html);
  await vi.waitFor(()=>expect(standalone.w.document.getElementById('workspace-range').textContent).toBe('已载入 2 / 12 点'));
  standalone.w.document.getElementById('save-workspace').click();
  expect(standalone.w.document.getElementById('workspace-range-detail').textContent).toContain('10 点未载入');
  standalone.w.document.getElementById('save-dialog').close();
  select(standalone.w,'language','en');expect(standalone.w.document.getElementById('workspace-range').textContent).toBe('Loaded 2 / 12 points');
 });
 it('distinguishes completed data from planned points in stopped runs and older complete standalone results',()=>{
  const {w,qa}=setup(false);
  qa.install({...payload,metadata:{expected_points:10,workspace_scope:{version:1,loaded_points:2,source_points:2}}});
  expect(w.document.getElementById('workspace-range').textContent).toBe('全部 2 点');
  expect(w.document.getElementById('save-workspace').title).toContain('原计划 10 点');
  qa.install({...payload,metadata:{expected_points:2,contains_all_planned_points:true}});
  expect(w.document.getElementById('workspace-range').textContent).toBe('全部 2 点');
  expect(w.document.getElementById('save-workspace').title).not.toContain('原计划');
  qa.install({...payload,metadata:{expected_points:10,completed_points:2,contains_all_planned_points:false}});
  expect(w.document.getElementById('workspace-range').textContent).toBe('已载入 2 点 · 总数未知');
 });
 it('keeps an unknown original total unknown across saving instead of relabelling a table as a complete run',async()=>{
  const {w,qa,parent,send}=setup();qa.install({...payload,metadata:undefined});
  w.document.getElementById('save-workspace').click();
  await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='download')).toBe(true));
  const message=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='download')![0],html=Buffer.from(message.data,'base64').toString();
  const saved=await qa.readFiles([{name:'imported.html',size:html.length,lastModified:0,text:async()=>html}]);send({type:'download-result',id:message.id,ok:true});
  qa.install(saved);expect(w.document.getElementById('workspace-range').textContent).toBe('已载入 2 点 · 总数未知');
  expect(saved.metadata.workspace_scope.source_points).toBeNull();
 });
 it('does not trust invalid or stale coverage metadata over the actual table',()=>{
  const {w,qa}=setup();
  for(const scope of [null,[],{version:1,loaded_points:2,source_points:'12'},{version:1,loaded_points:2,source_points:1},{version:1,loaded_points:200,source_points:200},{version:2,loaded_points:2,source_points:12}]){
   qa.install({...payload,metadata:{workspace_scope:scope,expected_points:1,contains_all_planned_points:true}});
   expect(w.document.getElementById('workspace-range').textContent).toBe('已载入 2 点 · 总数未知');
   expect(w.document.getElementById('save-workspace').title).not.toMatch(/NaN|undefined|原计划/);
  }
 });
});

describe('adapted explorer shell',()=>{
 it('uses result preferences for new data and restores the explicit layout of saved workspaces',()=>{
  const {qa,send}=setup();send({type:'preferences',preferences:{x_direction:'desc',layout:'grid',playback_ms:250,inspector:'hide',library:false}});
  qa.install({...payload,view:undefined});expect(qa.state()).toMatchObject({xDirection:'desc',layout:'two',speed:250});expect(qa.panels()).toMatchObject({inspector:false,library:false});
  qa.install({...payload,view:{...payload.view,xDirection:'asc',layout:'stack',speed:1200,panels:{inspector:true,library:true}}});expect(qa.state()).toMatchObject({xDirection:'asc',layout:'stack',speed:1200});expect(qa.panels()).toMatchObject({inspector:true,library:true});
 });
 it('presents sources as readable facts and safely renders imported names',()=>{
  const {w,qa}=setup();qa.install({...payload,sources:[null,7,'summary.csv',{name:'<img src=x onerror=alert(1)>',size:2048},{name:'unknown.csv',size:-10}],metadata:{database:{name:'Lab water',runtime_version:'2.13.0'},config:{activity_model:'ideal',cycles:2,gas_model:{bad:true}},schema_version:1,ion_size_audit:[null,{species:'Na+',a_angstrom:4,source:'Reference A'}],warnings:[null,{bad:true},'Check the source range.']}});
  w.document.getElementById('source-button').click();const source=w.document.getElementById('source-info');
  expect(source.textContent).toContain('Lab water');expect(source.textContent).toContain('理想模型');expect(source.textContent).toContain('4 Å');
  expect(source.textContent).not.toMatch(/联合键|Metadata|schema_version/);expect(source.querySelector('pre')).toBeNull();expect(source.querySelector('img')).toBeNull();
  expect(source.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(source.textContent).toContain('summary.csv');expect(source.textContent).toContain('2.0 KB');expect(source.textContent).toContain('Check the source range.');
  expect(source.textContent).not.toMatch(/\[object Object\]|NaN|-[0-9.]+ KB/);expect(w.document.getElementById('source-dialog').open).toBe(true);
 });
 it('opens fields for the chosen empty figure without selecting data or losing existing plots',()=>{
  const {w,qa}=setup();qa.install({...payload,view:{...payload.view,charts:[{id:'chart-1',selectedStates:['state:pH']},{id:'chart-2',selectedStates:[],selectedSpecies:[]}]}});
  w.document.getElementById('focus-charts').click();
  const buttons=[...w.document.querySelectorAll('[data-figure="chart-2"] .empty-field-actions button')] as any[];
  expect(buttons.map(b=>b.textContent)).toEqual(['选择物种','选择系统状态']);buttons[1].click();
  expect(qa.panels().library).toBe(true);expect(qa.state().activeChart).toBe('chart-2');
  expect(qa.state().charts[1].tab).toBe('states');expect(qa.state().charts[1].selectedStates).toEqual([]);
  expect(qa.state().charts[0].selectedStates).toEqual(['state:pH']);expect(qa.state().bookmarks).toEqual([0]);
  expect(w.document.activeElement.id).toBe('search');
 });
 it('keeps chart choices and stable point annotations across preview pages and refreshes',async()=>{
  const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
  const page=(ids:number[])=>({format:'result-explorer-1',name:'Paged run',key_columns:['run_index'],summary:{columns:['run_index','pressure_bar','pH'],rows:ids.map(i=>[i,100-i,7+i/100])},species_tables:[]});
  let revision=0;
  const load=async(key:string,p:any)=>{const current=++revision;send({type:'load',runKey:'run-a',datasetKey:key,revision:current,data:gzipSync(JSON.stringify(p)).toString('base64')});await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded' && m.revision===current)).toBe(true));};
  await load('page-1',page([10,11]));qa.state().charts[0].selectedStates=['state:pH'];qa.state().charts[0].title='pH profile';qa.state().bookmarks=[1];qa.state().reference=1;
  await load('page-1',page([10,11]));expect(qa.state().charts[0].title).toBe('pH profile');expect(qa.state().reference).toBe(1);
  await load('page-1',page([11,10]));expect(qa.state().reference).toBe(0);expect(qa.state().bookmarks).toEqual([0]);
  await load('page-2',page([20,21]));expect(qa.state().charts[0].selectedStates).toEqual(['state:pH']);expect(qa.state().bookmarks).toEqual([]);expect(qa.state().reference).toBeNull();
  expect(parent.postMessage.mock.calls.at(-1)![0]).toMatchObject({offscreenBookmarks:1,offscreenReference:true});
  qa.state().bookmarks=[0];qa.state().charts[0].title='Edited on page 2';
  await load('page-1',page([11,10]));expect(qa.state().charts[0].title).toBe('Edited on page 2');expect(qa.state().bookmarks).toEqual([0]);expect(qa.state().reference).toBe(0);
  qa.state().bookmarks=[];qa.state().reference=null;
  await load('page-2',page([20,21]));expect(qa.state().bookmarks).toEqual([0]);
  await load('page-1',page([11,10]));expect(qa.state().bookmarks).toEqual([]);expect(qa.state().reference).toBeNull();
 });
 it('returns home without losing data, selections, bookmarks, position or panel widths',()=>{
  const {w,qa}=setup();qa.install(payload);
  w.document.querySelector('[data-side="library"]').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  const before=JSON.stringify(qa.state()),model=qa.model();
  w.document.getElementById('results-home').click();
  expect(w.document.querySelector('.workspace').hidden).toBe(true);expect(w.document.querySelector('.results-onboarding').hidden).toBe(false);
  expect(w.document.getElementById('resume-results').textContent).toContain('Test run');
  w.document.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  expect(JSON.stringify(qa.state())).toBe(before);
  w.document.getElementById('resume-results').click();
  expect(w.document.querySelector('.workspace').hidden).toBe(false);expect(w.document.querySelector('.results-onboarding').hidden).toBe(true);
  expect(qa.model()).toBe(model);expect(JSON.stringify(qa.state())).toBe(before);
 });
 it('cancels an import back to home and keeps the current workspace after a rejected replacement',()=>{
  const {w,qa}=setup();qa.install(payload);w.document.getElementById('results-home').click();
  w.document.getElementById('import-empty').click();const dialog=w.document.getElementById('import-dialog');expect(dialog.open).toBe(true);
  dialog.querySelector('.close-dialog').click();expect(dialog.open).toBe(false);expect(w.document.querySelector('.results-onboarding').hidden).toBe(false);
  expect(()=>qa.install({format:'invalid',name:'bad'})).toThrow();expect(w.document.querySelector('.results-onboarding').hidden).toBe(false);
  w.document.getElementById('resume-results').click();expect(qa.model().points.length).toBe(2);expect(qa.state().charts[0].selectedStates).toEqual(['state:pH']);
 });
 it('keeps home visible during run updates and opens the chart on a newly imported dataset',()=>{
  const {w,qa}=setup();qa.installHost(payload);expect(w.document.querySelector('.workspace').hidden).toBe(false);
  w.document.getElementById('results-home').click();qa.installHost({...payload,name:'Updated run'});
  expect(w.document.querySelector('.results-onboarding').hidden).toBe(false);expect(w.document.getElementById('resume-results').textContent).toContain('Updated run');
  qa.install({...payload,name:'Imported workspace'});expect(w.document.querySelector('.workspace').hidden).toBe(false);expect(w.document.querySelector('.results-onboarding').hidden).toBe(true);
 });
 it('preserves data and view while focusing charts, resizing and changing theme',()=>{
  const {w,qa}=setup();qa.install(payload);const initial=qa.state();
  w.document.getElementById('focus-charts').click();expect(w.document.querySelector('.library').hidden).toBe(true);expect(w.document.querySelector('.inspector').hidden).toBe(true);
  w.document.getElementById('focus-charts').click();expect(w.document.querySelector('.library').hidden).toBe(false);
  const pointBefore=qa.state().index,separator=w.document.querySelector('[data-side="library"]');separator.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));expect(qa.state().panels.libraryWidth).toBe(250);expect(qa.state().index).toBe(pointBefore);
  qa.appearance('dark');expect(w.document.documentElement.dataset.theme).toBe('dark');expect(qa.state().bookmarks).toEqual(initial.bookmarks);expect(qa.model().points.length).toBe(2);expect(qa.state().charts[0].selectedStates).toEqual(['state:pH']);
 });
 it('restores panel settings and does not replace valid data on a rejected import',()=>{
  const {qa,parent}=setup();qa.install({...payload,view:{...payload.view,panels:{library:false,inspector:true,libraryWidth:200,inspectorWidth:900}}});
  expect(qa.panels().library).toBe(false);expect(qa.panels().inspectorWidth).toBe(380);const count=parent.postMessage.mock.calls.length;
  expect(()=>qa.install({format:'invalid',name:'bad'})).toThrow();expect(qa.model().points.length).toBe(2);expect(parent.postMessage.mock.calls.length).toBe(count);
 });
 it('acknowledges a native save cancellation without claiming success',async()=>{
  const {qa,w,parent,send}=setup();const pending=qa.download(new w.Blob(['export'],{type:'text/plain'}),'export.csv');
  await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='download')).toBe(true));
  const message=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='download')![0];send({type:'download-result',id:message.id,ok:false});expect(await pending).toBe(false);
 });
});

const comparisonPayload=()=>({format:'result-explorer-1',name:'pH comparison',key_columns:['run_index'],summary:{columns:['run_index','cycle','step','temperature_c','pressure_bar','pH'],rows:[1,2].flatMap(c=>[0,1,2,3].map(i=>[(c-1)*4+i,c,i+1,25+i*10,100-i*10,[7,8,7,6][i]+(c-1)*.1]))},species_tables:[{columns:['run_index','species','phase_type','amount_mol','activity'],rows:[...Array(8)].flatMap((_,i)=>[[i,'Na+','aqueous',[.1,.3,.2,.4][i%4]+Math.floor(i/4),[.01,.03,.02,.04][i%4]],[i,'Ca+2','aqueous',10+i,.5+i/10]]).reverse()}],view:{charts:[{id:'chart-1',selectedSpecies:['species:["aqueous","Na+"]'],measure:'amount_mol'}]}});
describe('adversarial result identity and missing-data boundaries',()=>{
 const file=(name:string,text:string)=>({name,text:async()=>text,size:text.length,lastModified:0});
 it('automatically joins minimal exported tables by run_index despite repeated conditions and reversed species rows',async()=>{
  const {qa}=setup();const imported=await qa.readFiles([
   file('summary.csv','run_index,pass,step,temperature_c,pressure_bar,pH\n51,2,1,25,100,7.51\n52,2,2,25,100,7.52'),
   file('aqueous.csv','run_index,species,phase_type,amount_mol\n52,Na+,aqueous,1052\n51,Na+,aqueous,1051')]);
  qa.install(imported);expect([...qa.model().species[0].measures.amount_mol]).toEqual([1051,1052]);
  expect(qa.model().statuses.some((s:any)=>s.key==='run_index')).toBe(false);
 });
 it('keeps repeated run_index values isolated by scenario and still honors explicit custom matching columns',async()=>{
  const {qa,w}=setup();const files=[
   file('summary.csv','scenario,run_index,state_id,pH\nA,0,a,7.1\nB,0,b,8.2'),
   file('aqueous.csv','scenario,run_index,state_id,species,phase_type,amount_mol\nB,0,b,Na+,aqueous,202\nA,0,a,Na+,aqueous,101')];
  qa.install(await qa.readFiles(files));expect([...qa.model().species[0].measures.amount_mol]).toEqual([101,202]);
  w.document.getElementById('custom-keys').value='state_id';qa.install(await qa.readFiles(files));expect(qa.model().identities).toEqual([['state_id']]);
 });
 it('does not turn shared path coordinates into species quantities when reopening the full CSV tables',async()=>{
  const {qa}=setup();qa.install(await qa.readFiles([
   file('summary.csv','run_index,pass,step,inner_index,outer_index,inner_value,pH\n0,1,1,1,1,0.1,7\n1,1,2,2,1,0.2,8'),
   file('aqueous.csv','run_index,pass,step,inner_index,outer_index,inner_value,species,phase_type,amount_mol\n0,1,1,1,1,0.1,Na+,aqueous,101\n1,1,2,2,1,0.2,Na+,aqueous,102')
  ]));
  expect([...qa.model().species[0].axisMeasures]).toEqual(['amount_mol']);expect(qa.model().byState.has('state:inner_value')).toBe(true);
 });
 it('rejects transferred input quantities instead of presenting them as equilibrium species amounts',async()=>{
  const {qa}=setup();qa.install(payload);
  await expect(qa.readFiles([
   file('summary.csv','run_index,pass,step,pH\n0,1,1,7\n1,1,2,6'),
   file('transfers.csv','run_index,pass,step,rule,source,fraction,species,amount_mol\n0,1,1,1,material,1,Na+,91\n1,1,2,1,previous_point,0.5,Na+,92')
  ])).rejects.toThrow(/转移|transfer/i);
  expect(qa.model().points[0].pH).toBe(7);
  expect(()=>qa.install({...payload,species_tables:[{columns:['id','rule','source','fraction','species','amount_mol'],rows:[[1,1,'material',1,'Na+',91],[2,1,'previous_point',.5,'Na+',92]]}]})).toThrow(/转移|transfer/i);
 });
 it('retains user-defined species quantities with all-missing values in a saved workspace',()=>{
  const {qa,w}=setup();const axis='x:'+JSON.stringify(['species:["aqueous","Na+"]','custom_x']);
  qa.install({...payload,species_tables:[{columns:['id','species','phase_type','custom_x','custom_y'],rows:[[1,'Na+','aqueous',null,null],[2,'Na+','aqueous',null,null]]}],view:{axis,charts:[{id:'chart-1',selectedSpecies:['species:["aqueous","Na+"]'],measure:'custom_y'}]}});
  expect(qa.state().axis).toBe(axis);expect(qa.state().charts[0].measure).toBe('custom_y');expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(0);
 });
 it('keeps a missing pH X axis and custom Y quantity on an entire preview page, then restores real values',async()=>{
  const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
  const page=(id:number,missing=false)=>({format:'result-explorer-1',name:'Missing slice',key_columns:['run_index'],summary:{columns:['run_index','pass','step','pressure_bar','pH','custom_signal'],rows:[[id,1,1,100,missing?null:7.1,missing?null:1000+id],[id+1,1,2,90,missing?null:7.2,missing?null:1001+id]]},species_tables:[]});
  let revision=0;const load=async(id:number,missing=false)=>{const current=++revision;send({type:'load',runKey:'same-run',datasetKey:'page-'+id,revision:current,data:gzipSync(JSON.stringify(page(id,missing))).toString('base64')});await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded'&&m.revision===current)).toBe(true));};
  await load(10);select(w,'x-axis','state:pH');qa.state().charts[0].selectedStates=['state:custom_signal'];
  await load(20,true);expect(qa.state().axis).toBe('state:pH');expect(qa.state().charts[0].selectedStates).toEqual(['state:custom_signal']);expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(0);expect(w.document.getElementById('values').textContent).toContain('缺少横轴');
  await load(10);expect(qa.state().axis).toBe('state:pH');expect([...qa.specs()[0].paths[0].values]).toEqual([1010,1011]);
 });
 it('does not substitute another X quantity when a selected species activity is entirely missing on a page',async()=>{
  const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
  const page=(missing:boolean)=>{const p:any=comparisonPayload();p.species_tables[0].rows.forEach((r:any[])=>{if(r[1]==='Na+')r[4]=missing?null:100+Number(r[0]);});return p;};
  let revision=0;const load=async(missing:boolean)=>{const current=++revision;send({type:'load',runKey:'species-run',datasetKey:String(missing),revision:current,data:gzipSync(JSON.stringify(page(missing))).toString('base64')});await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded'&&m.revision===current)).toBe(true));};
  await load(false);select(w,'x-axis','species:["aqueous","Na+"]');select(w,'x-measure','activity');const axis=qa.state().axis;
  await load(true);expect(qa.state().axis).toBe(axis);expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(0);
  await load(false);expect(qa.state().axis).toBe(axis);expect(qa.specs()[0].paths[0].indices.map((i:number)=>qa.model().byAxis.get(axis).values[i])).toEqual([100,101,102,103]);
 });
});
function select(w:any,id:string,value:string){const el=w.document.getElementById(id);el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));}
describe('result X quantities',()=>{
 it('pairs pH with species at the same saved state and keeps reversals and repeated X values',()=>{
  const {w,qa}=setup();qa.install(comparisonPayload());select(w,'x-axis','state:pH');
  let snap=w.ResultExplorer.getSnapshot();expect(snap.state.pathAxis).toBe('step');expect(snap.slice).toEqual([0,1,2,3]);
  expect(snap.xValues.map((p:any)=>p.value)).toEqual([7,8,7,6]);
  const circles=[...w.document.querySelectorAll('[data-sample]')] as any[];expect(circles.map(c=>Number(c.dataset.sample))).toEqual([0,1,2,3]);
  expect(circles[0].getAttribute('cx')).toBe(circles[2].getAttribute('cx'));expect(circles[0].getAttribute('cy')).not.toBe(circles[2].getAttribute('cy'));
  expect(w.document.querySelector('.plot-note')?.textContent || '').not.toContain('重复');expect(snap.changeCount).toBe(3);
  select(w,'x-direction','desc');w.document.getElementById('next-point').click();snap=w.ResultExplorer.getSnapshot();
  expect(snap.activeId).toBe(1);expect(snap.series[0].value).toBe(.3);expect(snap.xValues.map((p:any)=>p.value)).toEqual([7,8,7,6]);
  expect(w.document.getElementById('reference-label').textContent).toContain('采样顺序');
 });
 it('selects the correct state by both coordinates when repeated pH values overlap in X',()=>{
  const {w,qa}=setup();qa.install(comparisonPayload());select(w,'x-axis','state:pH');
  const svg=w.document.querySelector('svg.chart'),hit=svg.querySelector('.hit-area'),circle=svg.querySelector('[data-sample="2"]');
  const vb=svg.getAttribute('viewBox').split(' ').map(Number);svg.getBoundingClientRect=()=>({x:0,y:0,width:vb[2],height:vb[3]});
  hit.dispatchEvent(new w.MouseEvent('click',{bubbles:true,clientX:Number(circle.getAttribute('cx')),clientY:Number(circle.getAttribute('cy'))}));
  expect(w.ResultExplorer.getSnapshot().activeId).toBe(2);expect(w.ResultExplorer.getSnapshot().series[0].value).toBe(.2);
  w.document.getElementById('bookmark-point').click();expect(qa.state().bookmarks).toEqual([2]);
  select(w,'x-axis','pressure_bar');w.document.querySelector('[data-bookmark="2"]').click();expect(w.ResultExplorer.getSnapshot().activeId).toBe(2);
 });
 it('uses the chosen species quantity on X and keeps missing X values as gaps',()=>{
  const {w,qa}=setup(),p=comparisonPayload();p.species_tables[0].rows.find(r=>r[0]===2 && r[1]==='Ca+2')![3]=null as any;
  qa.install(p);select(w,'x-axis','species:["aqueous","Ca+2"]');
  let snap=w.ResultExplorer.getSnapshot();expect(snap.xValues.map((v:any)=>v.value)).toEqual([10,11,null,13]);expect(snap.changeCount).toBe(1);
  expect(w.document.querySelector('[data-curve]')).toBeNull();
  const marks=w.document.querySelector('[data-mark-mode]');marks.value='path';marks.dispatchEvent(new w.Event('change',{bubbles:true}));
  const curve=w.document.querySelector('[data-curve]');expect((curve.getAttribute('d').match(/M/g)||[]).length).toBe(2);
  expect(w.document.querySelector('[data-sample="2"]')).toBeNull();expect(w.document.querySelector('svg.chart').innerHTML).not.toContain('NaN');
  select(w,'x-measure','activity');snap=w.ResultExplorer.getSnapshot();expect(snap.xValues.map((v:any)=>v.value)).toEqual([.5,.6,.7,.8]);
  expect(w.document.querySelector('svg.chart').textContent).toContain('Ca+2 · 活度');
  const input=w.document.getElementById('x-search');input.value='pH';input.dispatchEvent(new w.Event('input',{bubbles:true}));
  expect([...w.document.getElementById('x-axis').options].map((o:any)=>o.value)).toEqual(['state:pH','species:["aqueous","Ca+2"]']);
 });
 it('preserves sample position across rounds and saves/restores X quantities, sequences and pinned paths',async()=>{
  const {w,qa,parent,send}=setup();qa.install(comparisonPayload());select(w,'x-axis','state:pH');
  w.document.getElementById('next-point').click();w.document.getElementById('next-point').click();w.document.getElementById('pin-path').click();
  const cycle=w.document.querySelector('[data-fixed="cycle"]');cycle.value='2';cycle.dispatchEvent(new w.Event('change',{bubbles:true}));
  expect(w.ResultExplorer.getSnapshot().activeId).toBe(6);expect(w.ResultExplorer.getSnapshot().series[0].value).toBe(1.2);
  w.document.getElementById('bookmark-point').click();select(w,'x-direction','desc');
  w.document.getElementById('save-workspace').click();await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='download')).toBe(true));
  const download=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='download')![0];send({type:'download-result',id:download.id,ok:true});
  const saved=Buffer.from(download.data,'base64').toString(),encoded=saved.match(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/)![1],restored=JSON.parse(encoded);
  qa.install(restored);const snap=w.ResultExplorer.getSnapshot();expect(snap.state).toMatchObject({axis:'state:pH',pathAxis:'step',xDirection:'desc',fixed:{cycle:'2'},bookmarks:[6]});
  expect(snap.activeId).toBe(6);expect(snap.state.pins[0]).toMatchObject({axis:'state:pH',pathAxis:'step',fixed:{cycle:1}});
  expect(w.document.querySelectorAll('[data-curve]')).toHaveLength(0);expect(w.document.querySelectorAll('.series-layer')).toHaveLength(2);expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(8);
 });
 it('includes the X species quantity in exported CSV even when it is not selected on Y',async()=>{
  const {w,qa,parent,send}=setup();qa.install(comparisonPayload());select(w,'x-axis','species:["aqueous","Ca+2"]');
  w.document.getElementById('export-csv').click();await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='download')).toBe(true));
  const download=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='download')![0];send({type:'download-result',id:download.id,ok:true});
  const table=w.ResultExplorer.parseCSV(Buffer.from(download.data,'base64').toString());
  expect(table.columns).toContain('Ca+2 [aqueous] / amount_mol');const xi=table.columns.indexOf('Ca+2 [aqueous] / amount_mol'),yi=table.columns.indexOf('Na+ [aqueous] / amount_mol');
  expect(table.rows.map((r:any)=>[Number(r[xi]),Number(r[yi])])).toEqual([[10,.1],[11,.3],[12,.2],[13,.4]]);
 });
 it('follows the app language even when a saved workspace was English',()=>{
  const {w,qa,send}=setup();qa.install({...comparisonPayload(),view:{language:'en'}});
  expect(w.document.getElementById('language')).toBeNull();expect(w.ResultExplorer.getSnapshot().language).toBe('zh');
  expect(w.document.getElementById('x-axis').getAttribute('aria-label')).toBe('横轴指标');
  send({type:'appearance',theme:'dark',language:'en-US'});expect(w.ResultExplorer.getSnapshot().language).toBe('en');
  expect(w.document.getElementById('language')).toBeNull();expect(w.document.getElementById('x-axis').getAttribute('aria-label')).toBe('X-axis quantity');
  qa.install({...comparisonPayload(),view:{language:'zh'}});expect(w.ResultExplorer.getSnapshot().language).toBe('en');
 });
});

it('retains language selection in a standalone workspace',()=>{
 const {w,qa}=setup(false);qa.install({...comparisonPayload(),view:{language:'en'}});
 expect(w.document.getElementById('language')).not.toBeNull();expect(w.ResultExplorer.getSnapshot().language).toBe('en');
 select(w,'language','zh');expect(w.ResultExplorer.getSnapshot().language).toBe('zh');expect(w.document.getElementById('x-axis').getAttribute('aria-label')).toBe('横轴指标');
});


describe('live result browsing continuity',()=>{
 it('keeps the physical cursor, interval endpoints, scroll and search focus as data grows and reorders',async()=>{
  const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
  const page=(ids:number[])=>({format:'result-explorer-1',name:'Live run',key_columns:['run_index'],summary:{columns:['run_index','pressure_bar','pH'],rows:ids.map(i=>[i,100-i,7+i/100])},species_tables:[]});
  let revision=0;const load=async(ids:number[])=>{const current=++revision;send({type:'load',runKey:'run-a',datasetKey:'same-page',revision:current,data:gzipSync(JSON.stringify(page(ids))).toString('base64')});await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded'&&m.revision===current)).toBe(true));};
  await load([10,11]);expect(w.ResultExplorer.getSnapshot().activePoint.run_index).toBe(11);qa.state().interval={a:0,b:1};
  const search=w.document.getElementById('search');search.value='test';search.dispatchEvent(new w.Event('input',{bubbles:true}));search.focus();search.setSelectionRange(2,3);
  w.document.getElementById('chart-scroll').scrollTop=120;w.document.getElementById('library-list').scrollTop=50;w.document.querySelector('.figure-settings').open=true;
  await load([11,10,12]);const snap=w.ResultExplorer.getSnapshot();expect(snap.activePoint.run_index).toBe(11);expect(snap.state.interval).toEqual({a:1,b:0});
  expect(w.document.getElementById('chart-scroll').scrollTop).toBe(120);expect(w.document.getElementById('library-list').scrollTop).toBe(50);
  expect(w.document.activeElement.id).toBe('search');expect(w.document.activeElement.value).toBe('test');expect(w.document.activeElement.selectionStart).toBe(2);expect(w.document.activeElement.selectionEnd).toBe(3);expect(w.document.querySelector('.figure-settings').open).toBe(true);
  const xSearch=w.document.getElementById('x-search');xSearch.value='pH';xSearch.dispatchEvent(new w.Event('input',{bubbles:true}));xSearch.focus();xSearch.setSelectionRange(1,2);await load([11,10,12,13]);expect(w.document.activeElement.id).toBe('x-search');expect(w.document.activeElement.value).toBe('pH');expect(w.document.activeElement.selectionStart).toBe(1);
  w.document.getElementById('focus-charts').click();await load([11,10,12,13,14]);expect(w.document.getElementById('focus-charts').getAttribute('aria-pressed')).toBe('true');
  w.document.getElementById('focus-charts').click();expect(w.document.querySelector('.library').hidden).toBe(false);
 });
 it('does not interrupt open dialogs and loads only the latest deferred update after closing',async()=>{
  const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
  const load=(revision:number,name:string)=>send({type:'load',runKey:'run-a',datasetKey:'same-page',revision,data:gzipSync(JSON.stringify({...payload,name})).toString('base64')});
  load(1,'Before');await vi.waitFor(()=>expect(qa.model()?.points.length).toBe(2));
  w.document.getElementById('source-button').click();const dialog=w.document.getElementById('source-dialog');expect(dialog.open).toBe(true);
  load(2,'Intermediate');load(3,'Latest');expect(dialog.open).toBe(true);expect(w.document.getElementById('dataset-name').textContent).toBe('Before');
  expect(parent.postMessage.mock.calls.filter(([m]:any)=>m.type==='deferred').map(([m]:any)=>m.revision)).toEqual([2,3]);
  dialog.close();await vi.waitFor(()=>expect(w.document.getElementById('dataset-name').textContent).toBe('Latest'));
  expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded'&&m.revision===2)).toBe(false);
 });
 it('discards queued run updates when an independent workspace is imported',async()=>{
  const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
  const load=(revision:number,name:string)=>send({type:'load',runKey:'run-a',datasetKey:'same-page',revision,data:gzipSync(JSON.stringify({...payload,name})).toString('base64')});
  load(1,'Run');await vi.waitFor(()=>expect(qa.model()?.points.length).toBe(2));w.document.getElementById('open-results').click();
  load(2,'Updated run');qa.install({...payload,name:'My imported workspace'});w.document.dispatchEvent(new w.Event('close'));
  await new Promise(resolve=>setTimeout(resolve,30));expect(w.document.getElementById('dataset-name').textContent).toBe('My imported workspace');
  expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded'&&m.revision===2)).toBe(false);
 });
 it('shows one side panel at narrow widths without losing the saved widths or access to either panel',async()=>{
  const {w,qa}=setup();Object.defineProperty(w,'innerWidth',{value:700,writable:true});qa.install({...payload,view:{...payload.view,panels:{library:true,inspector:true,libraryWidth:380,inspectorWidth:380}}});
  expect(w.document.querySelector('.library').hidden).toBe(false);expect(w.document.querySelector('.inspector').hidden).toBe(true);expect(qa.state().panels.libraryWidth).toBe(380);
  const width=parseFloat(w.document.querySelector('.workspace').style.getPropertyValue('--library-width'));expect(width).toBeGreaterThanOrEqual(165);expect(w.innerWidth-width).toBeGreaterThanOrEqual(500);
  w.document.getElementById('toggle-inspector').click();expect(w.document.querySelector('.inspector').hidden).toBe(false);expect(w.document.querySelector('.library').hidden).toBe(true);
  w.innerWidth=974;w.dispatchEvent(new w.Event('resize'));await vi.waitFor(()=>expect(w.document.querySelector('.library').hidden).toBe(true));expect(w.document.querySelector('.inspector').hidden).toBe(false);
  w.innerWidth=1400;w.dispatchEvent(new w.Event('resize'));await vi.waitFor(()=>expect(w.document.querySelector('.library').hidden).toBe(false));
  expect(w.document.querySelector('.inspector').hidden).toBe(false);expect(qa.state().panels).toMatchObject({libraryWidth:380,inspectorWidth:380});
 });
});


it('keeps each figure’s display controls together and changes only that figure while restoring existing workspace values',()=>{
 const {w,qa}=setup();const p={...payload,view:{charts:[{id:'chart-1',selectedSpecies:['species:["aqueous","Na+"]'],selectedStates:['state:pH'],measure:'amount_mol',displayMode:'separate',rangeMode:'detail',scaleScope:'path'},{id:'chart-2',selectedStates:['state:pH'],displayMode:'overlay',rangeMode:'context',scaleScope:'global'}],activeChart:'chart-2'}};
 qa.install(p);expect(w.document.querySelector('.chart-display-options')).toBeNull();expect(w.document.getElementById('display-mode')).toBeNull();expect(w.document.getElementById('range-mode')).toBeNull();
 expect(w.document.querySelector('[data-figure="chart-1"] [data-display-mode]').closest('.figure-settings')).not.toBeNull();
 expect(w.document.querySelector('[data-figure="chart-1"] [data-display-mode]').value).toBe('separate');expect(w.document.querySelector('[data-figure="chart-1"] [data-range-mode]').value).toBe('detail');
 expect(w.document.querySelectorAll('[data-figure="chart-1"] .lane')).toHaveLength(2);
 const display=w.document.querySelector('[data-display-mode="chart-1"]');display.value='overlay';display.dispatchEvent(new w.Event('change',{bubbles:true}));
 expect(w.document.querySelectorAll('[data-figure="chart-1"] .lane')).toHaveLength(1);expect(qa.state().activeChart).toBe('chart-2');
 const range=w.document.querySelector('[data-range-mode="chart-2"]');range.value='detail';range.dispatchEvent(new w.Event('change',{bubbles:true}));
 expect(qa.state().charts[0]).toMatchObject({displayMode:'overlay',rangeMode:'detail',scaleScope:'path'});expect(qa.state().charts[1]).toMatchObject({rangeMode:'detail',scaleScope:'global'});
 expect(w.ResultExplorer.getSnapshot().yDomains.find((a:any)=>a.chartId==='chart-2').range[0]).toBeGreaterThan(0);
 const view=JSON.parse(JSON.stringify(qa.state()));qa.install({...p,view});expect(qa.state().charts.map((c:any)=>[c.displayMode,c.rangeMode,c.scaleScope])).toEqual([['overlay','detail','path'],['overlay','detail','global']]);
});

it('cancels an old workspace decompression as soon as another history entry starts loading',async()=>{
 const {w,qa,parent,send}=setup();qa.install({...payload,name:'Currently open'});w.Blob=Blob;w.DecompressionStream=DecompressionStream;
 let finish:(text:string)=>void=()=>{};w.Response=class{text(){return new Promise<string>(resolve=>{finish=resolve;});}};
 send({type:'open-workspace',requestId:1,files:[{path:'/old.html',name:'old.html',size:1,last_modified:0,text:'<script id="payload" data-encoding="gzip-base64">AA==</script>'}]});
 await new Promise(resolve=>setTimeout(resolve,0));
 // The newly requested file may be slow or fail before open-workspace is sent.
 send({type:'begin-workspace',requestId:2});finish(JSON.stringify({...payload,name:'Obsolete history entry'}));
 await new Promise(resolve=>setTimeout(resolve,10));
 expect(w.document.getElementById('dataset-name').textContent).toBe('Currently open');
 expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='workspace-opened'&&m.requestId===1)).toBe(false);
});

it('opens a saved workspace from its native path using the inert parser and restores its figures and bookmarks',async()=>{
 const {w,parent,qa,send}=setup();qa.install({...payload,name:'Current run'});
 const html='<html><script>window.executedImportedCode=true</script><script id="payload" type="application/json">'+JSON.stringify({...payload,name:'pH comparison',view:{...payload.view,xAxis:'state:pH',xDirection:'desc'}})+'</script></html>';
 send({type:'open-workspace',requestId:41,files:[{path:'/saved/pH.html',name:'pH.html',text:html,size:html.length,last_modified:0}]});
 await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='workspace-opened'&&m.path==='/saved/pH.html')).toBe(true));
 expect(w.executedImportedCode).toBeUndefined();expect(qa.state().bookmarks).toEqual([0]);expect(qa.state().reference).toBe(0);expect(qa.state().charts[0].selectedStates).toEqual(['state:pH']);
 expect(parent.postMessage.mock.calls.find(([m]:any)=>m.type==='workspace-opened')[0]).toMatchObject({requestId:41,path:'/saved/pH.html',kind:'workspace',name:'pH comparison'});
 w.document.getElementById('results-home').click();expect(w.document.querySelector('.results-onboarding').hidden).toBe(false);
 w.document.getElementById('resume-results').click();expect(qa.state().bookmarks).toEqual([0]);expect(w.document.querySelector('.workspace').hidden).toBe(false);
 send({type:'open-workspace',requestId:42,files:[{path:'/bad.html',name:'bad.html',text:'not a workspace',size:15,last_modified:0}]});
 await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='workspace-error'&&m.requestId===42)).toBe(true));
 expect(w.document.getElementById('dataset-name').textContent).toBe('pH comparison');
});
it('imports native CSV tables with the existing join rules and reports only HTML workspaces as history candidates',async()=>{
 const {w,parent,qa,send}=setup();w.document.getElementById('import-empty').click();w.document.getElementById('choose-result-files').click();
 expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'choose-result-files'}),'*');
 send({type:'selected-result-files',files:[{path:'/data/summary.csv',name:'summary.csv',text:'run_index,pH\n0,7\n1,6.5',size:27,last_modified:0},{path:'/data/species.csv.gz',name:'species.csv',text:'run_index,species,phase_type,amount_mol\n0,Na+,aqueous,0.1\n1,Na+,aqueous,0.2',size:70,last_modified:0}]});
 w.document.getElementById('custom-keys').value='run_index';w.document.getElementById('import-confirm').click();await vi.waitFor(()=>{const error=w.document.getElementById('import-status')?.textContent;if(error&&!error.startsWith('正在'))throw new Error(error);expect(qa.model()?.points.length).toBe(2);});
 const message=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='workspace-opened')![0];expect(message.kind).toBe('tables');expect(message.path).toBeUndefined();
 expect([...qa.model().species[0].measures.amount_mol]).toEqual([.1,.2]);
});

it('uses geological path labels for legacy workspaces while preserving actual variables, units and custom field names',()=>{
 const {w,qa}=setup();
 const data={format:'result-explorer-1',name:'路径对比',key_columns:['run_index'],summary:{columns:['run_index','pass','step','inner_index','outer_index','inner_value','outer_value','pH'],rows:[[0,1,1,1,1,.1,1,7],[1,1,2,2,1,.2,1,7.2]]},species_tables:[],metadata:{loop_axes:{inner:{mode:'list'},outer:{mode:'repeat'}},field_info:{inner_index:['内循环序号','Inner iteration',''],outer_index:['外循环序号','Outer iteration',''],step:['内循环序号','Inner iteration',''],pass:['外循环序号','Outer iteration',''],inner_value:['初始盐水 · NaCl 投料量','Initial brine · NaCl input amount','mol'],outer_value:['外循环序号','Outer iteration','']}}};
 const original=JSON.stringify(data);qa.install(data);
 expect(qa.model().fieldInfo.inner_index).toEqual(['路径位置','Path position','']);expect(qa.model().fieldInfo.outer_index).toEqual(['反应轮次','Reaction round','']);
 expect(qa.model().fieldInfo.inner_value).toEqual(['初始盐水 · NaCl 投料量','Initial brine · NaCl input amount','mol']);expect(qa.state().axis).toBe('state:inner_value');
 expect(w.document.getElementById('x-axis').selectedOptions[0].textContent).toBe('初始盐水 · NaCl 投料量 / mol');expect(JSON.stringify(data)).toBe(original);
 const custom={...data,metadata:{...data.metadata,field_info:{...data.metadata.field_info,inner_index:['剖面测点','Transect station','m']}}};qa.install(custom);
 expect(qa.model().fieldInfo.inner_index).toEqual(['剖面测点','Transect station','m']);
 const before=JSON.stringify(qa.state());w.document.getElementById('results-home').click();w.document.getElementById('resume-results').click();expect(JSON.stringify(qa.state())).toBe(before);
});

function changeElement(w:any,selector:string,value:string){const el=w.document.querySelector(selector);el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));}
describe('result plotting and navigation usability',()=>{
 it('identifies an aqueous-only quantity without calling recorded mineral amounts missing',()=>{
  const {w,qa}=setup(),p=comparisonPayload() as any;
  p.species_tables.push({columns:['run_index','species','phase_type','amount_mol','molality','activity'],rows:[...Array(8)].map((_,i)=>[i,'Calcite','mineral',.01+i*.001,null,1])});
  p.view={charts:[{id:'chart-1',selectedSpecies:['species:["mineral","Calcite"]'],measure:'molality'}]};qa.install(p);
  expect(w.document.querySelector('.quantity-note').textContent).toContain('质量摩尔浓度仅用于水相');
  expect(w.document.querySelector('.quantity-note').textContent).toContain('物质的量');
  expect(w.document.querySelector('.lanes').textContent).not.toContain('组 X/Y 缺失');
  w.document.querySelector('[data-use-measure]').click();expect(qa.state().charts[0].measure).toBe('amount_mol');
  expect([...w.document.querySelectorAll('[data-sample]')].map((e:any)=>Number(e.dataset.sample))).toEqual([0,1,2,3]);
  expect(w.ResultExplorer.getSnapshot().series[0].value).toBe(.01);expect(w.document.querySelector('.quantity-note')).toBeNull();
 });
 it('shows an explicit current/all-round scope and picks or bookmarks each paired state across rounds',async()=>{
  const {w,qa,parent,send}=setup();qa.install(comparisonPayload());select(w,'x-axis','state:pH');
  expect(w.document.getElementById('plot-scope').textContent).toContain('全部已载入轮次');
  expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(4);select(w,'plot-scope','all');
  expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(8);expect(w.document.querySelectorAll('[data-curve]')).toHaveLength(0);
  const svg=w.document.querySelector('svg.chart'),hit=svg.querySelector('.hit-area'),point=svg.querySelector('[data-sample="6"]');
  const vb=svg.getAttribute('viewBox').split(' ').map(Number);svg.getBoundingClientRect=()=>({x:0,y:0,width:vb[2],height:vb[3]});
  hit.dispatchEvent(new w.MouseEvent('click',{bubbles:true,clientX:Number(point.getAttribute('cx')),clientY:Number(point.getAttribute('cy'))}));
  expect(w.ResultExplorer.getSnapshot().activeId).toBe(6);expect(qa.state().fixed.cycle).toBe(2);
  expect(w.ResultExplorer.getSnapshot().series[0].value).toBe(1.2);w.document.getElementById('bookmark-point').click();
  w.document.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));expect(w.ResultExplorer.getSnapshot().activeId).toBe(2);
  w.document.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));expect(w.ResultExplorer.getSnapshot().activeId).toBe(3);
  expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(8);
  w.document.querySelector('[data-bookmark="6"]').click();expect(w.ResultExplorer.getSnapshot().activeId).toBe(6);
  w.document.getElementById('export-csv').click();await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='download')).toBe(true));
  const download=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='download')[0];send({type:'download-result',id:download.id,ok:true});
  expect(w.ResultExplorer.parseCSV(Buffer.from(download.data,'base64').toString()).rows).toHaveLength(8);
  changeElement(w,'[data-mark-mode]','path');expect(w.document.querySelectorAll('[data-curve]')).toHaveLength(2);
  const state=JSON.parse(JSON.stringify(qa.state()));qa.install({...comparisonPayload(),view:state});expect(qa.state()).toMatchObject({plotScope:'all',bookmarks:[6]});expect(qa.state().charts[0].markMode).toBe('path');expect(w.document.querySelectorAll('[data-curve]')).toHaveLength(2);
 });
 it('keeps non-monotonic temperature paths and repeated coordinates in physical sample order',()=>{
  const {w,qa}=setup(),p=comparisonPayload();p.summary.rows.forEach((r,i)=>r[3]=[25,100,25,60][i%4]);qa.install(p);select(w,'x-axis','temperature_c');
  expect(w.ResultExplorer.getSnapshot().slice).toEqual([0,1,2,3]);expect(w.ResultExplorer.getSnapshot().xValues.map((x:any)=>x.value)).toEqual([25,100,25,60]);
  expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(4);select(w,'x-direction','desc');w.document.getElementById('next-point').click();
  expect(w.ResultExplorer.getSnapshot().activeId).toBe(1);expect(w.document.getElementById('reference-label').textContent).toContain('采样顺序');
 });
 it('keeps markers inside plot bounds, retains dense samples, and excludes log-invalid pairs without bridging gaps',()=>{
  const {w,qa}=setup(),p=comparisonPayload() as any;p.species_tables[0].rows.find((r:any)=>r[0]===0&&r[1]==='Na+')[3]=0;
  qa.install(p);select(w,'x-axis','state:pH');
  for(const spec of qa.specs())for(const path of spec.paths)for(const point of path.coords.values()){
   expect(point.x).toBeGreaterThan(spec.L+3);expect(point.x).toBeLessThan(spec.W-spec.R-3);expect(point.y).toBeGreaterThan(spec.T+3);expect(point.y).toBeLessThan(spec.H-spec.B-3);
  }
  changeElement(w,'[data-scale="species"]','log');expect(w.document.querySelector('[data-sample="0"]')).toBeNull();expect(w.document.getElementById('values').textContent).toContain('此值不显示在对数轴');
  select(w,'x-axis','species:["aqueous","Na+"]');select(w,'x-scale','log');expect(w.document.querySelector('[data-sample="0"]')).toBeNull();expect(w.document.getElementById('values').textContent).toContain('横轴值不大于 0');
  const saved=JSON.parse(JSON.stringify(qa.state()));qa.install({...p,view:saved});expect(qa.state().xScale).toBe('log');expect(w.document.querySelector('svg.chart').innerHTML).not.toMatch(/NaN|Infinity/);
  const dense={format:'result-explorer-1',key_columns:['run_index'],summary:{columns:['run_index','step','pH'],rows:Array.from({length:220},(_,i)=>[i,i+1,6+Math.sin(i)])},species_tables:[],view:{axis:'state:pH',charts:[{id:'chart-1',selectedStates:['state:step']} ]}};
  // step is a coordinate, so use another saved state as Y for dense correlation points.
  dense.summary.columns.push('water_activity');dense.summary.rows.forEach((r,i)=>r.push(.8+i/10000));dense.view.charts[0].selectedStates=['state:water_activity'];qa.install(dense);
  expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(220);expect(w.document.querySelector('[data-curve]')).toBeNull();
 });
 it('repeats a held arrow, stops at release or focus loss, and does not add a release click',()=>{
  vi.useFakeTimers();const {w,qa}=setup();qa.install(comparisonPayload());select(w,'x-axis','state:pH');
  const next=w.document.getElementById('next-point');next.dispatchEvent(new w.MouseEvent('pointerdown',{bubbles:true,button:0}));
  expect(w.ResultExplorer.getSnapshot().activeId).toBe(1);vi.advanceTimersByTime(360);expect(w.ResultExplorer.getSnapshot().activeId).toBe(2);
  w.document.dispatchEvent(new w.MouseEvent('pointerup',{bubbles:true}));next.click();expect(w.ResultExplorer.getSnapshot().activeId).toBe(2);
  vi.advanceTimersByTime(1000);expect(w.ResultExplorer.getSnapshot().activeId).toBe(2);
  const previous=w.document.getElementById('previous-point');previous.dispatchEvent(new w.MouseEvent('pointerdown',{bubbles:true,button:0}));expect(w.ResultExplorer.getSnapshot().activeId).toBe(1);
  w.dispatchEvent(new w.Event('blur'));vi.advanceTimersByTime(1000);expect(w.ResultExplorer.getSnapshot().activeId).toBe(1);
  previous.click();expect(w.ResultExplorer.getSnapshot().activeId).toBe(0);
 });
 it('places both slider tracks in identical grid columns with playback controls after the values',()=>{
  const {w,qa}=setup();qa.install(comparisonPayload());
  const first=[...w.document.querySelector('.browse-line').children].map((e:any)=>e.id||e.className),second=[...w.document.querySelector('.point-track').children].map((e:any)=>e.id||e.className);
  expect(first.slice(1,4)).toEqual(['previous-condition','browse-slider','next-condition']);expect(second.slice(1,4)).toEqual(['previous-point','point-slider','next-point']);
  expect(first.at(-1)).toBe('browse-controls');expect(second.at(-1)).toBe('playback-options');
 });
});


it('recovers an unusable saved log-X zoom when all sampled X values are nonpositive',()=>{
 const {w,qa}=setup(),p=comparisonPayload() as any;p.summary.rows.forEach((r:any,i:number)=>r[5]=-10+i);
 p.view={axis:'state:pH',pathAxis:'step',xScale:'log',zoom:[-10,-1],charts:[{id:'chart-1',selectedSpecies:['species:["aqueous","Na+"]'],measure:'amount_mol'}]};qa.install(p);
 expect(qa.state().zoom).toBeNull();expect(w.document.querySelector('svg.chart').innerHTML).not.toMatch(/NaN|Infinity/);expect(w.document.querySelectorAll('[data-sample]')).toHaveLength(0);
 expect(w.document.getElementById('values').textContent).toContain('横轴值不大于 0');w.document.getElementById('zoom-near').click();
 expect(qa.state().zoom).toBeNull();expect(w.document.querySelector('svg.chart').innerHTML).not.toMatch(/NaN|Infinity/);
});

it('switches host language in place with two figures, measured X, exact cursor, bookmarks, ranges and panel state intact',async()=>{
 const {w,qa,parent,send}=setup(),data=comparisonPayload();qa.install({...data,name:'水岩实验',view:{...data.view,charts:[...data.view.charts,{id:'chart-2',title:'自定义图',selectedStates:['state:pH']}],bookmarks:[1,6],reference:1}});
 select(w,'x-axis','state:pH');select(w,'plot-scope','all');w.document.getElementById('next-point').click();
 qa.state().zoom=[6.5,8.5];qa.state().interval={a:1,b:6};qa.state().charts[0].queries.species='Na';
 w.document.getElementById('chart-scroll').scrollTop=125;w.document.querySelector('.figure-settings').open=true;
 const originalModel=qa.model(),before=JSON.parse(JSON.stringify(qa.state())),active=w.ResultExplorer.getSnapshot().activeId,panels=JSON.parse(JSON.stringify(qa.panels()));
 send({type:'appearance',theme:'dark',language:'en'});
 expect(qa.model()).toBe(originalModel);expect(qa.state()).toEqual({...before,language:'en'});expect(qa.panels()).toEqual(panels);expect(w.ResultExplorer.getSnapshot().activeId).toBe(active);expect(w.document.getElementById('chart-scroll').scrollTop).toBe(125);expect(w.document.querySelector('.figure-settings').open).toBe(true);
 expect(w.document.getElementById('dataset-name').textContent).toBe('水岩实验');expect(w.document.body.textContent).toContain('自定义图');expect(w.document.getElementById('language')).toBeNull();expect(w.document.getElementById('x-axis').getAttribute('aria-label')).toBe('X-axis quantity');
 w.document.getElementById('save-workspace').click();await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='download')).toBe(true));
 const message=parent.postMessage.mock.calls.find(([m]:any)=>m.type==='download')![0],html=Buffer.from(message.data,'base64').toString();const saved=await qa.readFiles([{name:'English.html',size:html.length,lastModified:0,text:async()=>html}]);send({type:'download-result',id:message.id,ok:true});
 expect(saved.view.language).toBe('en');expect(saved.name).toBe('水岩实验');expect(saved.view.charts[1].title).toBe('自定义图');expect(saved.view.bookmarks).toEqual([1,6]);expect(saved.view.reference).toBe(1);expect(saved.view.axis).toBe('state:pH');
 const standalone=setup(false,html);await vi.waitFor(()=>expect(standalone.qa.model()?.points.length).toBe(8));expect(standalone.w.document.getElementById('language').getAttribute('aria-label')).toBe('Interface language');expect(standalone.w.ResultExplorer.getSnapshot().activeId).toBe(active);
 select(standalone.w,'language','zh');expect(standalone.qa.state().charts).toEqual(saved.view.charts);expect(standalone.qa.state().bookmarks).toEqual([1,6]);expect(standalone.w.ResultExplorer.getSnapshot().activeId).toBe(active);
});

describe('equilibrium target tables',()=>{
 it('keeps target detail records out of state summaries even after renaming the CSV',async()=>{
  const {qa}=setup();qa.install(payload);
  for(const name of ['constraints.csv','renamed.csv']){
   const text='run_index,pass,step,constraint_id,target,actual,exchange_mol\n0,1,1,acid,4,4,0.1\n0,1,1,gas,0.01,0.01,0.2';
   await expect(qa.readFiles([{name,size:text.length,lastModified:0,text:async()=>text}])).rejects.toThrow(/summary.csv/);
  }
  expect(qa.model().points.length).toBe(2);
  expect(()=>qa.install({...payload,summary:{columns:['run_index','constraint_id','target'],rows:[[0,'ph',4],[0,'co2',.01]]}})).toThrow(/summary.csv/);
 });
 it('exposes per-point targets, actual values and exchanges as independently labelled X and Y fields',()=>{
  const {qa,w}=setup();const key='constraint_acid_exchange_mol';
  qa.install({...payload,summary:{columns:['id','pH',key],rows:[[1,4,.01],[2,5,.02]]},metadata:{field_info:{[key]:['HCl 净加入量','HCl net addition','mol']}}});
  select(w,'x-axis','state:'+key);expect(qa.state().axis).toBe('state:'+key);
  expect(w.document.getElementById('x-axis').textContent).toContain('HCl 净加入量');
  expect(qa.model().points[1][key]).toBe(.02);
 });
});

describe('English results without changing saved scientific data',()=>{
 it('localizes loading, known phases, provenance and system notices while retaining user labels',()=>{
  const {w,qa,send}=setup();const note='使用自定义 Python 求解逻辑；请核对修改后的模型、约束与结果。';
  const data={...payload,name:'试样 A',species_tables:[{columns:['id','species','phase_type','amount_mol','molality'],rows:[[1,'矿物甲','固相',1,null],[2,'矿物甲','固相',.9,null]]}],metadata:{runtime_version:'2.13.0',config:{cycles:2},warnings:[note,'现场备注：保留原样']}};
  const before=JSON.stringify(data);qa.install(data);w.document.getElementById('source-button').click();
  send({type:'appearance',language:'en',theme:'dark'});
  const source=w.document.getElementById('source-dialog');expect(source.open).toBe(true);expect(source.textContent).toContain('Custom Python calculation logic');expect(source.textContent).toContain('Reaction rounds');expect(source.textContent).toContain('2.13.0');expect(source.textContent).toContain('现场备注：保留原样');expect(source.textContent).not.toContain(note);
  expect(w.document.getElementById('loading-title').textContent).toBe('Loading results');expect(w.document.getElementById('loading-text').textContent).toBe('Local processing');
  source.close();w.document.getElementById('tab-species').click();expect(w.document.getElementById('library-list').textContent).toContain('Mineral');expect(w.document.getElementById('library-list').textContent).not.toContain('固相');
  expect(qa.model().species[0].phase).toBe('固相');expect(qa.model().species[0].name).toBe('矿物甲');expect(JSON.stringify(data)).toBe(before);
 });
 it('keeps an unfinished imported table structure and selected filenames when the app language changes',()=>{
  const {w,qa,send}=setup();qa.install(payload);w.document.getElementById('open-results').click();
  const file=w.document.getElementById('result-files');w.document.getElementById('custom-keys').value='run_index, 实验编号';w.document.getElementById('custom-dimensions').value='distance_m';w.document.querySelector('#import-dialog details').open=true;
  send({type:'selected-result-files',files:[{name:'我的 summary.csv',text:'',size:0}]});
  send({type:'appearance',language:'en'});
  expect(w.document.getElementById('import-dialog').open).toBe(true);expect(w.document.getElementById('import-dialog').textContent).toContain('Custom table structure');
  expect(w.document.getElementById('custom-keys').value).toBe('run_index, 实验编号');expect(w.document.getElementById('custom-dimensions').value).toBe('distance_m');expect(w.document.querySelector('#import-dialog details').open).toBe(true);expect(w.document.getElementById('result-files')).toBe(file);expect(w.document.getElementById('choose-result-files').textContent).toBe('我的 summary.csv');
  expect(qa.model().points).toHaveLength(2);
 });
 it('keeps an uncommitted figure title and focus through a language change',()=>{
  const {w,qa,send}=setup();qa.install(payload);w.document.querySelector('[data-rename]').click();
  const input=w.document.getElementById('figure-title-input');input.value='pH 与方解石';input.focus();input.setSelectionRange(3,4);
  send({type:'appearance',language:'en'});
  const restored=w.document.getElementById('figure-title-input');expect(w.document.getElementById('rename-dialog').open).toBe(true);expect(restored.value).toBe('pH 与方解石');expect(w.document.activeElement).toBe(restored);expect(restored.selectionStart).toBe(3);expect(qa.state().charts[0].title).toBe('');
  w.document.getElementById('rename-confirm').click();expect(qa.state().charts[0].title).toBe('pH 与方解石');
 });
});


it('navigates off-page bookmarks by stable IDs, preserves chart choices and removes them without reappearing',async()=>{
 const {w,qa,parent,send}=setup();w.Blob=Blob;w.Response=Response;w.DecompressionStream=DecompressionStream;
 const page=(ids:number[],round:number)=>({format:'result-explorer-1',name:'Unequal rounds',key_columns:['run_index'],summary:{columns:['run_index','pass','step','pH'],rows:ids.map((id,i)=>[id,round,i+1,7+id/100])},species_tables:[]});
 let revision=0;
 const load=async(key:string,data:any,focusRunIndex?:string,runKey='run-a')=>{const current=++revision;send({type:'load',runKey,datasetKey:key,revision:current,data:gzipSync(JSON.stringify(data)).toString('base64'),...(focusRunIndex!==undefined?{focusRunIndex}:{})});await vi.waitFor(()=>expect(parent.postMessage.mock.calls.some(([m]:any)=>m.type==='loaded'&&m.revision===current)).toBe(true));};
 await load('round-2',page([10,12],2));qa.state().bookmarks=[1];qa.state().charts[0].selectedStates=['state:pH'];qa.state().charts[0].title='Keep my plot';
 await load('round-4',page([20,21],4));
 const bookmark=w.document.querySelector('[data-run-bookmark="12"]');expect(bookmark.textContent).toBe('第 2 轮 · 位置 2');expect(w.document.getElementById('bookmark-count').textContent).toBe('1');
 bookmark.click();expect(parent.postMessage).toHaveBeenLastCalledWith({channel:'shell-test',type:'locate-point',runKey:'run-a',runIndex:'12'},'*');
 await load('round-2',page([10,12],2),'12');expect(qa.state().index).toBe(1);expect(qa.state().bookmarks).toEqual([1]);expect(qa.state().charts[0].title).toBe('Keep my plot');expect(qa.state().charts[0].selectedStates).toEqual(['state:pH']);
 await load('round-4',page([20,21],4));send({type:'appearance',language:'en',theme:'light'});expect(w.document.querySelector('[data-run-bookmark="12"]').textContent).toBe('Round 2 · position 2');
 w.document.querySelector('[data-remove-run-bookmark="12"]').click();expect(w.document.getElementById('bookmark-count').textContent).toBe('0');
 await load('round-2',page([10,12],2));expect(qa.state().bookmarks).toEqual([]);
 qa.state().bookmarks=[0];await load('other-run',page([10,12],2),undefined,'run-b');expect(qa.state().bookmarks).toEqual([]);expect(w.document.querySelector('[data-run-bookmark]')).toBeNull();
});
