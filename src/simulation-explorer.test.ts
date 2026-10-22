// @vitest-environment jsdom
// Exercise the actual bundled parser and message adapter without a browser.
import explorerHTML from '../bridge/easyreaktoro_runtime/result_explorer.html?raw';
import vm from 'node:vm';
import {describe,expect,it,vi} from 'vitest';
import {SimulationResults,embeddedExplorer} from './SimulationResults';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {createElement} from 'react';
import {simulationCall} from './simulation-api';
vi.mock('./simulation-api',()=>({simulationCall:vi.fn(),simulationError:(error:any)=>String(error)}));

describe('result explorer integration',()=>{
  it('joins repeated conditions by run index without fragmenting paths',()=>{
    const html=explorerHTML;
    const parser=html.slice(html.indexOf('"use strict";'),html.indexOf('// View state only;'));
    const context=vm.createContext({document:{documentElement:{lang:'zh-CN'}}});
    vm.runInContext(parser+';globalThis.build=buildModel;',context);
    const model=context.build({format:'result-explorer-1',key_columns:['run_index'],dimension_columns:[],summary:{columns:['run_index','pass','step','temperature_c','pressure_bar','pH'],rows:[[0,1,1,25,100,7],[1,1,2,25,50,6.8],[2,2,1,25,100,7.1],[3,2,2,25,50,7]]},species_tables:[{columns:['run_index','species','phase_type','amount_mol'],rows:[[0,'Na+','aqueous',.1],[1,'Na+','aqueous',.2],[2,'Na+','aqueous',.3],[3,'Na+','aqueous',.4]]}]});
    expect(model.points).toHaveLength(4);expect(model.linked).toBe(4);expect(model.axes).toContain('pressure_bar');expect(model.dims).not.toContain('run_index');expect(model.statuses.some((x:any)=>x.key==='run_index')).toBe(false);expect([...model.species[0].measures.amount_mol]).toEqual([.1,.2,.3,.4]);
  });
  it('rejects obsolete decompressions and clears old results before a new run',async()=>{
    const html=embeddedExplorer('test'),adapter=html.slice(html.indexOf('const hostChannel'),html.indexOf('\n</script>',html.indexOf('const hostChannel')));
    const parent={postMessage:vi.fn()},handlers:any[]=[];const pending:((text:string)=>void)[]=[];
    const node={textContent:'',style:{setProperty:vi.fn()},classList:{add:vi.fn()},querySelector:()=>null,setAttribute:vi.fn(),append:vi.fn()};
    const context:any=vm.createContext({parent,window:{addEventListener:(_name:string,fn:any)=>handlers.push(fn)},
      document:{addEventListener:vi.fn(),createElement:()=>node,querySelector:(query:string)=>query==='dialog[open]'?null:node,querySelectorAll:()=>[],body:{setAttribute:vi.fn(),removeAttribute:vi.fn(),classList:{contains:()=>false}}},
      renderPlots:vi.fn(),renderBookmarks:vi.fn(),updatePoint:vi.fn(),$:()=>node,L:(zh:string)=>zh,buildShell:vi.fn(),download:vi.fn(),stop:vi.fn(),cancelPointer:vi.fn(),
      restoreView:vi.fn(),language:'zh',initialState:()=>({}),boot:async()=>{},model:null,state:null,rawPayload:null,slice:[],plotSpecs:[],hovering:null,
      Uint8Array,atob,Blob:class{stream(){return {pipeThrough:()=>null};}},DecompressionStream:class{},
      Response:class{text(){return new Promise<string>(resolve=>pending.push(resolve));}},copy:structuredClone});
    const installMock=vi.fn((payload:any)=>{context.model={...payload,points:[]};context.state={index:0,bookmarks:[]};});context.install=installMock;
    vm.runInContext(adapter,context);context.buildShell=vi.fn();
    const send=(data:any)=>handlers[0]({source:parent,data:{channel:'test',data:'AA==',...data}});
    const old=send({type:'load',revision:1,datasetKey:'old'}),current=send({type:'load',revision:2,datasetKey:'new'});
    pending[1]('{"name":"new"}');await current;pending[0]('{"name":"old"}');await old;
    expect(installMock).toHaveBeenCalledTimes(1);expect(context.model.name).toBe('new');
    const inflight=send({type:'load',revision:3,datasetKey:'new'});await send({type:'clear',revision:4});
    expect(context.model).toBeNull();pending[2]('{"name":"stale"}');await inflight;expect(context.model).toBeNull();
    expect(installMock).toHaveBeenCalledTimes(1);
  });
});


it('updates completed round options during live preview without changing the chosen round',async()=>{
 const call=vi.mocked(simulationCall);call.mockReset();
 call.mockResolvedValueOnce({choose_cycle:true,cycles:[1]}).mockResolvedValueOnce({cycles:[1],point_count:1,data:'AA==',page_count:1,points_per_page:100,cycle_points:1}).mockResolvedValue({cycles:[1,2],point_count:1,data:'AA==',page_count:1,points_per_page:100,cycle_points:1});
 const job:any={job_id:'live-rounds',status:'running',completed:1,total:4,elapsed_seconds:1,name:'Live rounds',output_path:'/example/result',message:'Running'};
 const props={job,visible:true,onError:vi.fn(),onNotice:vi.fn()};
 const view=render(createElement(SimulationResults,props));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]);
  act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'ready'}}));});
  await waitFor(()=>expect(call).toHaveBeenCalledTimes(2),{timeout:2000});
  const round=view.getByLabelText('结果预览轮次') as HTMLSelectElement;expect(round.value).toBe('1');expect([...round.options].map(v=>v.value)).toEqual(['1']);
  view.rerender(createElement(SimulationResults,{...props,job:{...job,completed:2}}));
  await waitFor(()=>expect([...round.options].map(v=>v.value)).toEqual(['1','2']),{timeout:2000});
  expect(round.value).toBe('1');expect(call).toHaveBeenLastCalledWith('explorer',{job_id:'live-rounds',cycle:1,page:undefined});
 }finally{cleanup();}
});

it('reopens a workspace through the native file reader and records it only after the parser acknowledges success',async()=>{
 const call=vi.mocked(simulationCall);call.mockReset();call.mockResolvedValue({files:[{path:'/saved/view.html',name:'view.html',text:'inert payload',size:13,last_modified:0}]});
 const onWorkspaceRecorded=vi.fn(),onWorkspaceRequestDone=vi.fn(),onError=vi.fn();
 const props={job:null,visible:true,onError,onNotice:vi.fn(),onWorkspaceRecorded,onWorkspaceRequestDone,workspaceRequest:{id:7,path:'/saved/view.html'}};
 const view=render(createElement(SimulationResults,props));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]);const posted=vi.spyOn(frame.contentWindow!,'postMessage');
  act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'ready'}}));});
  await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'open-workspace',requestId:7,files:expect.any(Array)}),'*'));
  const messages=posted.mock.calls.map(([message])=>message),begin=messages.findIndex(m=>m.type==='begin-workspace'&&m.requestId===7);expect(begin).toBeGreaterThanOrEqual(0);expect(begin).toBeLessThan(messages.findIndex(m=>m.type==='open-workspace'&&m.requestId===7));
  expect(call).toHaveBeenCalledWith('read_result_files',{paths:['/saved/view.html']});expect(onWorkspaceRecorded).not.toHaveBeenCalled();
  act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'workspace-opened',requestId:6,path:'/saved/stale.html',name:'Stale'}}));});expect(onWorkspaceRecorded).not.toHaveBeenCalled();
  act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'workspace-opened',requestId:7,path:'/saved/view.html',name:'pH comparison'}}));});
  expect(onWorkspaceRecorded).toHaveBeenCalledWith('/saved/view.html','pH comparison',true);expect(onWorkspaceRequestDone).toHaveBeenCalledTimes(1);expect(onError).not.toHaveBeenCalled();
 }finally{cleanup();}
});
it('does not send a stale file read after the user selects a different workspace',async()=>{
 const call=vi.mocked(simulationCall);call.mockReset();let oldRead:(v:any)=>void=()=>{};call.mockImplementationOnce(()=>new Promise(resolve=>{oldRead=resolve;}));call.mockResolvedValue({files:[{path:'/new.html',name:'new.html',text:'new',size:3,last_modified:0}]});
 const props={job:null,visible:true,onError:vi.fn(),onNotice:vi.fn(),workspaceRequest:{id:1,path:'/old.html'}};const view=render(createElement(SimulationResults,props));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]);const posted=vi.spyOn(frame.contentWindow!,'postMessage');
  act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'ready'}}));});await waitFor(()=>expect(call).toHaveBeenCalledTimes(1));
  view.rerender(createElement(SimulationResults,{...props,workspaceRequest:{id:2,path:'/new.html'}}));
  expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'begin-workspace',requestId:2}),'*');
  await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'open-workspace',requestId:2}),'*'));
  await act(async()=>oldRead({files:[{path:'/old.html',name:'old.html',text:'old'}]}));
  expect(posted.mock.calls.some(([message])=>message.type==='open-workspace'&&message.requestId===1)).toBe(false);
 }finally{cleanup();}
});


it('sends the saved result total from the matching preview response, not the plan or current page size',async()=>{
 const call=vi.mocked(simulationCall);call.mockReset();call.mockResolvedValue({point_count:2,data:'AA==',page_count:3,points_per_page:2,cycle_points:6,status:{completed:13,total:100}});
 const job:any={job_id:'coverage-run',status:'completed',completed:12,total:100,elapsed_seconds:1,name:'Coverage',output_path:'/example/result',message:'Complete'};
 const view=render(createElement(SimulationResults,{job,visible:true,onError:vi.fn(),onNotice:vi.fn()}));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]),posted=vi.spyOn(frame.contentWindow!,'postMessage');
  act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'ready'}}));});
  await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load',sourcePointCount:13,runKey:'coverage-run'}),'*'));
 }finally{cleanup();}
});


it('avoids duplicate round and position quantities while preserving saved aliases and distinct imported data',()=>{
 const parser=explorerHTML.slice(explorerHTML.indexOf('"use strict";'),explorerHTML.indexOf('// View state only;'));
 const context=vm.createContext({document:{documentElement:{lang:'en'}}});vm.runInContext(parser+';globalThis.build=buildModel;',context);
 const payload:any={format:'result-explorer-1',key_columns:['run_index'],summary:{columns:['run_index','pass','step','inner_index','outer_index','pH'],rows:[[0,1,1,1,1,7],[1,1,2,2,1,6.8],[2,2,1,1,2,7.1]]},species_tables:[]};
 const ordinary=context.build(payload);expect(ordinary.coordinateAxes).toEqual(expect.arrayContaining(['pass','step']));expect(ordinary.statuses.map((s:any)=>s.key)).toEqual(['pH']);
 const saved=context.build({...payload,view:{axis:'state:inner_index',charts:[{selectedStates:['state:outer_index']}]}});expect(saved.byAxis.has('state:inner_index')).toBe(true);expect(saved.byState.has('state:outer_index')).toBe(true);
 const imported=structuredClone(payload);imported.summary.rows[1][3]=20;expect(context.build(imported).byState.has('state:inner_index')).toBe(true);
});

it('labels every round in overlays, including the current round',()=>{
 const source=explorerHTML.slice(explorerHTML.indexOf('function seriesPaths('),explorerHTML.indexOf('function renderPlots('));
 const groups=[{indices:[0,1],fixed:{pass:1}},{indices:[2,3],fixed:{pass:2}},{indices:[4,5],fixed:{pass:3}}];
 const context:any=vm.createContext({shownPaths:()=>groups,allPaths:groups,slice:groups[1].indices,state:{plotScope:'all'},matchingPins:()=>[],fixedKeys:()=>['pass'],same:(a:any,b:any)=>a===b,pathName:(f:any)=>'Round '+f.pass,L:(_z:string,en:string)=>en,dashes:['','4 2','2 2']});
 vm.runInContext(source+';globalThis.paths=seriesPaths;',context);const paths=context.paths([{id:'Calcite',dash:''}]);expect(paths.map((p:any)=>p.pathLabel)).toEqual(['Round 1','Current · Round 2','Round 3']);expect(paths.every((p:any)=>p.showPathLabel)).toBe(true);expect(new Set(paths.map((p:any)=>p.curveId)).size).toBe(3);
 context.shownPaths=()=>[groups[1]];expect(context.paths([{id:'Calcite',dash:''}])[0].showPathLabel).toBe(false);
});


it('resolves a bookmark to its round and page before focusing its stable result ID',async()=>{
 const call=vi.mocked(simulationCall);call.mockReset();call.mockImplementation(async(action)=>action==='locate_point'?{cycle:3,page:2,run_index:17}:{cycles:[1,2,3],point_count:2,data:'AA==',page_count:3,points_per_page:2,cycle_points:6});
 const props={job:{job_id:'bookmark-run',status:'completed',completed:18,total:18,elapsed_seconds:1} as any,visible:true,onError:vi.fn(),onNotice:vi.fn()};const view=render(createElement(SimulationResults,props));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]),posted=vi.spyOn(frame.contentWindow!,'postMessage');
  const send=(message:any)=>act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,...message}}));});
  send({type:'ready'});await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load'}),'*'));
  send({type:'locate-point',runKey:'bookmark-run',runIndex:'17',navigationId:1});
  await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load',focusRunIndex:'17',navigationId:1,datasetKey:'bookmark-run:3:2'}),'*'));
  expect(call).toHaveBeenCalledWith('locate_point',{job_id:'bookmark-run',run_index:17});expect((view.getByLabelText('结果预览轮次') as HTMLSelectElement).value).toBe('3');expect((view.getByLabelText('结果预览点段') as HTMLSelectElement).value).toBe('2');expect(props.onError).not.toHaveBeenCalled();
 }finally{cleanup();}
});

it('ignores earlier bookmark lookups after another bookmark, manual navigation or a different result',async()=>{
 const call=vi.mocked(simulationCall);call.mockReset();const lookups=new Map<number,(value:any)=>void>();
 call.mockImplementation((action,args:any)=>action==='locate_point'?new Promise(resolve=>lookups.set(args.run_index,resolve)):Promise.resolve({cycles:[1,2,3],point_count:1,data:'AA==',page_count:3,points_per_page:1,cycle_points:3}));
 const props={job:{job_id:'run-a',status:'completed',completed:9,total:9,elapsed_seconds:1} as any,visible:true,onError:vi.fn(),onNotice:vi.fn()};const view=render(createElement(SimulationResults,props));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]),posted=vi.spyOn(frame.contentWindow!,'postMessage');
  const send=(message:any)=>act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,...message}}));});
  send({type:'ready'});await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load'}),'*'));
  send({type:'locate-point',runKey:'run-a',runIndex:'1',navigationId:1});send({type:'locate-point',runKey:'run-a',runIndex:'8',navigationId:1});
  await act(async()=>lookups.get(8)!({cycle:3,page:3,run_index:8}));await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load',focusRunIndex:'8'}),'*'));
  await act(async()=>lookups.get(1)!({cycle:1,page:2,run_index:1}));expect(posted.mock.calls.some(([m]:any)=>m.focusRunIndex==='1')).toBe(false);
  send({type:'locate-point',runKey:'run-a',runIndex:'4',navigationId:1});
  const round=view.getByLabelText('结果预览轮次') as HTMLSelectElement;act(()=>{round.value='2';round.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async()=>lookups.get(4)!({cycle:2,page:2,run_index:4}));expect(posted.mock.calls.some(([m]:any)=>m.focusRunIndex==='4')).toBe(false);
  send({type:'locate-point',runKey:'run-a',runIndex:'7',navigationId:1});view.rerender(createElement(SimulationResults,{...props,job:{...props.job,job_id:'run-b'}}));
  await act(async()=>lookups.get(7)!({cycle:3,page:2,run_index:7}));await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load',runKey:'run-b'}),'*'));expect(posted.mock.calls.some(([m]:any)=>m.focusRunIndex==='7')).toBe(false);
  send({type:'locate-point',runKey:'run-a',runIndex:'5',navigationId:1});expect(lookups.has(5)).toBe(false);
 }finally{cleanup();}
});


it('keeps the current plot after a missing bookmark and ignores errors after closing results',async()=>{
 const call=vi.mocked(simulationCall);call.mockReset();let rejectLookup:(error:Error)=>void=()=>{};
 call.mockImplementation(action=>action==='locate_point'?new Promise((_resolve,reject)=>{rejectLookup=reject;}):Promise.resolve({point_count:1,data:'AA=='}));
 const props={job:{job_id:'run-a',status:'completed',completed:1,total:1,elapsed_seconds:1} as any,visible:true,onError:vi.fn(),onNotice:vi.fn()};const view=render(createElement(SimulationResults,props));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]),posted=vi.spyOn(frame.contentWindow!,'postMessage');
  const send=(message:any)=>act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,...message}}));});
  send({type:'ready'});await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load'}),'*'));posted.mockClear();
  send({type:'locate-point',runKey:'run-a',runIndex:'3',navigationId:1});await act(async()=>rejectLookup(new Error('The bookmarked point is not present in the saved results.')));
  expect(props.onError).toHaveBeenCalledTimes(1);expect(posted.mock.calls.some(([m]:any)=>m.type==='clear'||m.type==='load')).toBe(false);expect((view.getByRole('button',{name:'刷新结果预览'}) as HTMLButtonElement).disabled).toBe(false);
  send({type:'locate-point',runKey:'run-a',runIndex:'4',navigationId:1});view.unmount();await act(async()=>rejectLookup(new Error('Late lookup failure')));expect(props.onError).toHaveBeenCalledTimes(1);
 }finally{cleanup();}
});


it.each(['locating','loading','load-error'])('returning home cancels a bookmark while %s and keeps the displayed round and page',async phase=>{
 const call=vi.mocked(simulationCall);call.mockReset();let resolvePending:(value:any)=>void=()=>{},rejectPending:(error:Error)=>void=()=>{};
 const slice={cycles:[1,2,3],point_count:1,data:'AA==',page_count:2,points_per_page:1,cycle_points:2};
 call.mockImplementation((action,args:any)=>{
  if(action==='locate_point')return phase==='locating'?new Promise(resolve=>{resolvePending=resolve;}):Promise.resolve({cycle:2,page:1,run_index:4});
  if(args.cycle===2)return new Promise((resolve,reject)=>{resolvePending=resolve;rejectPending=reject;});
  return Promise.resolve(!args.cycle?{choose_cycle:true,cycles:[1,2,3]}:!args.page?{choose_page:true,page_count:2,points_per_page:1,cycle_points:2}:slice);
 });
 const props={job:{job_id:'run-a',status:'completed',completed:6,total:6,elapsed_seconds:1} as any,visible:true,onError:vi.fn(),onNotice:vi.fn()};const view=render(createElement(SimulationResults,props));
 try{
  const frame=view.getByTitle('结果') as HTMLIFrameElement,channel=JSON.parse(frame.srcdoc.match(/const hostChannel = ("[^";]+");/)![1]),posted=vi.spyOn(frame.contentWindow!,'postMessage');
  const send=(message:any)=>act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,...message}}));});
  send({type:'ready'});await waitFor(()=>expect(posted).toHaveBeenCalledWith(expect.objectContaining({type:'load',datasetKey:'run-a:3:2'}),'*'));
  const first=posted.mock.calls.find(([m]:any)=>m.type==='load')![0] as any;send({type:'loaded',revision:first.revision});posted.mockClear();
  send({type:'locate-point',runKey:'run-a',runIndex:'4',navigationId:1});
  if(phase!=='locating')await waitFor(()=>expect(call).toHaveBeenCalledWith('explorer',expect.objectContaining({cycle:2,page:1})));
  send({type:'cancel-navigation',runKey:'run-a',datasetKey:'run-a:3:2'});
  await act(async()=>{if(phase==='load-error')rejectPending(new Error('Cancelled page failed'));else resolvePending(phase==='locating'?{cycle:2,page:1,run_index:4}:slice);});
  expect((view.getByLabelText('结果预览轮次') as HTMLSelectElement).value).toBe('3');expect((view.getByLabelText('结果预览点段') as HTMLSelectElement).value).toBe('2');expect(props.onError).not.toHaveBeenCalled();
  expect(posted.mock.calls.some(([m]:any)=>m.focusRunIndex!==undefined||m.type==='clear')).toBe(false);
 }finally{cleanup();}
});
