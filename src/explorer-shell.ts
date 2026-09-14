import explorerHTML from '../bridge/easyreaktoro_runtime/result_explorer.html?raw';
import workstationCSS from './explorer-app.css?raw';

/** One data engine with an application shell, rather than a second nested application. */
export function embeddedExplorer(channel:string,appLanguage="zh-CN"){
 const adapter=String.raw`
const hostChannel = ${JSON.stringify(channel)};
const embedded=parent!==window;
let hostLanguage=${JSON.stringify(appLanguage)}.startsWith('en')?'en':'zh';
if(embedded)language=hostLanguage;
const originalRestoreView=restoreView;
restoreView=v=>{originalRestoreView(v);if(embedded){language=hostLanguage;state.language=hostLanguage;}};
document.body.setAttribute('data-easyreaktoro',embedded?'embedded':'standalone');
const notifyHost=message=>{if(embedded)parent.postMessage({channel:hostChannel,...message},'*');};
let resultDefaults={x_direction:'asc',layout:'stack',playback_ms:600,inspector:'auto',library:true};
const originalInitialState=initialState;initialState=()=>({...originalInitialState(),xDirection:resultDefaults.x_direction,layout:resultDefaults.layout==='grid'?'two':'stack',speed:resultDefaults.playback_ms});
let latestRevision=-1,datasetKey='',installingHost=false,externalMode=false,focusPanels=null,deferredLoad=null;
let runKey='',savedReference=null,referenceWasVisible=false;
const savedBookmarks=new Set();
const pointIdentity=p=>p && p.run_index!==undefined?String(p.run_index):null;
function preservedRunView(payload,sameSlice=false){
 const view=copy(state),oldKeys=model.points.map(pointIdentity);
 for(const key of oldKeys)if(key!==null)savedBookmarks.delete(key);
 for(const index of state.bookmarks){const key=oldKeys[index];if(key!=null)savedBookmarks.add(key);}
 if(state.reference!==null)savedReference=oldKeys[state.reference]??null;
 else if(referenceWasVisible)savedReference=null;
 const column=payload.summary?.columns?.indexOf('run_index'),lookup=new Map();
 if(column>=0 && Array.isArray(payload.summary.rows))payload.summary.rows.forEach((row,i)=>lookup.set(String(row[column]),i));
 view.bookmarks=[...savedBookmarks].filter(key=>lookup.has(key)).map(key=>lookup.get(key));
 view.reference=savedReference!==null && lookup.has(savedReference)?lookup.get(savedReference):null;
 // The table may grow or reorder; interval endpoints follow the saved state identities.
 if(view.interval){const a=lookup.get(oldKeys[view.interval.a]),b=lookup.get(oldKeys[view.interval.b]);view.interval=a===undefined||b===undefined?null:{a,b};}
 // Slice-local cursor/interval positions must never identify another physical point.
 if(!sameSlice){view.index=0;view.interval=null;view.zoom=null;}
 return view;
}
let homeVisible=true,homeViewport=null;
let panels={library:true,inspector:window.innerWidth>=1180,libraryWidth:230,inspectorWidth:250,priority:'library'};
const pendingDownloads=new Map();let downloadSerial=0,nativeResultFiles=[],workspaceSerial=0;
function syncHome(){
 const show=homeVisible || !model;
 const home=document.querySelector('.results-onboarding'),top=document.querySelector('.topbar'),workspace=document.querySelector('.workspace');
 if(home)home.hidden=!show;if(top)top.hidden=show;if(workspace)workspace.hidden=show;
}
function showResultsHome(){endHeldNavigation();
 stop();cancelPointer();homeViewport=captureViewport();homeVisible=true;syncHome();
 $('resume-results')?.focus();
}
function resumeResults(){
 if(!model)return;homeVisible=false;syncHome();syncPanels();
 if(homeViewport)restoreViewport(homeViewport);$('results-home')?.focus();
}
function panelLayout(){
 const layout={...panels},available=Math.max(165,window.innerWidth-565);
 if(layout.library&&layout.inspector&&layout.libraryWidth+layout.inspectorWidth+10>available){layout[panels.priority==='inspector'?'library':'inspector']=false;}
 for(const side of ['library','inspector'])layout[side+'Width']=Math.min(panels[side+'Width'],available);
 return layout;
}
function syncPanels(){
 if(state)state.panels={...panels};
 const workspace=document.querySelector('.workspace');if(!workspace)return;const layout=panelLayout();
 for(const side of ['library','inspector']){
  const pane=document.querySelector('.'+side),handle=document.querySelector('.pane-resizer[data-side='+side+']');
  if(pane)pane.hidden=!layout[side];if(handle){handle.hidden=!layout[side];handle.setAttribute('aria-valuenow',String(layout[side+'Width']));}
  workspace.style.setProperty('--'+side+'-width',layout[side]?layout[side+'Width']+'px':'0px');
  workspace.style.setProperty('--'+side+'-handle',layout[side]?'5px':'0px');
  if($('toggle-'+side))$('toggle-'+side).setAttribute('aria-pressed',String(layout[side]));
 }
 if($('focus-charts')){$('focus-charts').setAttribute('aria-pressed',String(!!focusPanels));$('focus-charts').disabled=!model||(!focusPanels&&!layout.library&&!layout.inspector);}
 if(model){renderPlots();updatePoint();}
}
function setPanelWidth(side,value){panels[side+'Width']=Math.max(165,Math.min(380,value));syncPanels();}
function applyAppearance(theme){
 document.documentElement.dataset.theme=['light','dark','system'].includes(theme)?theme:'system';
 if($('theme-select'))$('theme-select').value=document.documentElement.dataset.theme;
 if(model){renderPlots();updatePoint();}
}
const originalBuildShell=buildShell;
buildShell=()=>{
 originalBuildShell();
 if(embedded){
  $('language')?.remove();
  const input=$('result-files'),choose=document.createElement('button');input.hidden=true;
  choose.type='button';choose.id='choose-result-files';choose.style.cssText='max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:left';choose.textContent=L('选择结果文件…','Choose result files…');choose.onclick=()=>notifyHost({type:'choose-result-files'});input.after(choose);
  document.querySelector('label[for="result-files"]').textContent=L('CSV / CSV.GZ / JSON / HTML，可多选配套表格','CSV / CSV.GZ / JSON / HTML; select related tables together');
 }
 document.title=L('结果','Results');
 const top=document.querySelector('.topbar'),workspace=document.querySelector('.workspace');
 const make=(id,label,path)=>{const b=document.createElement('button');b.id=id;b.className='panel-toggle';b.title=label;b.setAttribute('aria-label',label);b.innerHTML='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">'+path+'</svg><span>'+label+'</span>';return b;};
 const left=make('toggle-library',L('物种与指标','Species and metrics'),'<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M8 3v14"/>');
 const right=make('toggle-inspector',L('采样点面板','Point inspector'),'<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M12 3v14"/>');
 const focus=make('focus-charts',L('专注图表','Focus charts'),'<path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/>');
 left.onclick=()=>{focusPanels=null;panels.library=!panelLayout().library;panels.priority='library';syncPanels();};right.onclick=()=>{focusPanels=null;panels.inspector=!panelLayout().inspector;panels.priority='inspector';syncPanels();};
 focus.onclick=()=>{if(focusPanels){panels={...panels,...focusPanels};focusPanels=null;}else{focusPanels={library:panels.library,inspector:panels.inspector};panels.library=false;panels.inspector=false;}syncPanels();};
 const home=make('results-home',L('结果首页','Results home'),'<path d="m9 4-6 6 6 6M3 10h14"/>');home.setAttribute('aria-label',L('返回结果首页','Back to results home'));home.title=L('返回入口，保留当前数据和图表','Return to the start page, keeping data and figures');home.onclick=showResultsHome;
 top.prepend(home,left);top.append(focus,right);
 const theme=document.createElement('select');theme.id='theme-select';theme.setAttribute('aria-label',L('显示主题','Theme'));theme.innerHTML=option('system',L('跟随系统','System'))+option('light',L('浅色','Light'))+option('dark',L('深色','Dark'));theme.value=document.documentElement.dataset.theme || 'system';theme.onchange=()=>applyAppearance(theme.value);top.append(theme);
 $('open-results').textContent=L('导入','Import');$('open-results').setAttribute('aria-label',L('导入表格或工作区','Import tables or a workspace'));
 $('open-results').title=L('导入配套 CSV、JSON 或保存的 HTML 工作区；不会更改当前模拟设置','Import CSV, JSON or HTML; simulation settings are unchanged');
 for(const side of ['library','inspector']){
  const separator=document.createElement('div');separator.className='pane-resizer';separator.dataset.side=side;separator.tabIndex=0;separator.setAttribute('role','separator');separator.setAttribute('aria-orientation','vertical');separator.setAttribute('aria-label',L('调整'+(side==='library'?'物种与指标':'采样点')+'面板宽度','Resize '+side+' panel'));separator.setAttribute('aria-valuemin','165');separator.setAttribute('aria-valuemax','380');separator.setAttribute('aria-valuenow',String(panels[side+'Width']));
  separator.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home'].includes(e.key)){e.preventDefault();setPanelWidth(side,e.key==='Home'?(side==='library'?230:250):panelLayout()[side+'Width']+(e.key==='ArrowRight'?1:-1)*(side==='library'?20:-20));separator.setAttribute('aria-valuenow',String(panels[side+'Width']));}};
  separator.onpointerdown=e=>{e.preventDefault();separator.setPointerCapture(e.pointerId);const origin=e.clientX,width=panelLayout()[side+'Width'];separator.onpointermove=ev=>{setPanelWidth(side,width+(ev.clientX-origin)*(side==='library'?1:-1));separator.setAttribute('aria-valuenow',String(panels[side+'Width']));};separator.onpointerup=separator.onpointercancel=()=>{separator.onpointermove=null;};};workspace.append(separator);
 }
 const scrubber=document.querySelector('.scrubber'),browse=document.createElement('div');browse.className='browse-line';
 const browseLabel=document.createElement('span');browseLabel.className='note';browseLabel.id='browse-track-label';browseLabel.textContent=L('轮次 / 条件','Round / condition');
 const controls=document.createElement('div');controls.className='browse-controls';controls.append($('browse-axis'),$('play'));
 browse.append(browseLabel,$('previous-condition'),$('browse-slider'),$('next-condition'),$('browse-position'),controls);
 const pointTrack=document.querySelector('.point-track'),extra=document.querySelector('.scan-tools'),hint=document.querySelector('.key-hint'),options=document.createElement('details');options.className='playback-options';options.innerHTML='<summary>'+L('播放设置 ⓘ','Playback ⓘ')+'</summary><div></div>';options.lastChild.append(extra,hint);
 const pointValue=document.createElement('div');pointValue.className='point-value';pointValue.append($('position-label'),$('position-index'));pointTrack.append(pointValue,options);
 scrubber.replaceChildren(browse,pointTrack);
 const welcome=document.createElement('section');welcome.className='results-onboarding';
 welcome.innerHTML='<h2>'+L('查看计算结果','View calculation results')+'</h2><p>'+L('打开 EasyReaktoro 保存的结果，或导入已有数据。图表、参考点和书签可一起保存为工作区。','Open saved EasyReaktoro results or import existing data. Save figures, reference points and bookmarks together as a workspace.')+'</p>'+(model?'<button id="resume-results" class="resume-results"><span>'+L('继续查看','Continue viewing')+' →</span><strong>'+esc(rawPayload?.name || L('当前结果','Current results'))+'</strong><small>'+model.points.length.toLocaleString()+L(' 个状态点 · ',' points · ')+model.species.length.toLocaleString()+L(' 个物种 · 保留当前图表与位置',' species · figures and position retained')+'</small></button>':'')+'<div class="entry-actions">'+(embedded?'<button id="open-run-empty"><strong>'+L('打开已保存结果','Open saved results')+'</strong><small>'+L('选择 EasyReaktoro 计算生成的整个结果文件夹','Choose the result folder created by EasyReaktoro')+'</small></button>':'')+'<button id="import-empty"><strong>'+L('导入表格 / 工作区','Import tables / workspace')+'</strong><small>CSV · CSV.GZ · JSON · HTML</small></button></div>';
 workspace.after(welcome);$('import-empty').onclick=()=>showDialog('import-dialog');if($('open-run-empty'))$('open-run-empty').onclick=()=>notifyHost({type:'open-run'});if($('resume-results'))$('resume-results').onclick=resumeResults;
 left.disabled=right.disabled=focus.disabled=!model;
 syncPanels();syncHome();
};
// An empty figure remains actionable even when the field panel was hidden.
const originalRenderPlots=renderPlots;
renderPlots=()=>{
 originalRenderPlots();
 if(!model)return;
 for(const empty of document.querySelectorAll('.figure .lanes .empty')){
  const id=empty.closest('.figure').dataset.figure;
  const actions=document.createElement('div');actions.className='empty-field-actions';
  for(const [tab,label] of [['species',L('选择物种','Choose species')],['states',L('选择系统状态','Choose system state')]]){
   const button=document.createElement('button');button.textContent=label;
   button.disabled=tab==='species'?!model.species.length:!model.statuses.length;
   if(button.disabled)button.title=L('当前数据没有此类指标','This dataset has no numeric fields in this category');
   button.onclick=e=>{e.stopPropagation();selectChart(id);chart().tab=tab;focusPanels=null;panels.library=true;renderLibrary();syncPanels();$('search').focus();};
   actions.append(button);
  }
  empty.append(actions);
 }
};
const originalInstall=install;
install=payload=>{
 const oldPanels={...panels},keepHome=installingHost && !!model && homeVisible,keepView=installingHost&&!!model;
 const viewport=keepView?captureViewport():null,previousFocus=focusPanels,active=keepView?document.activeElement:null;
 const editor=active&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName)&&active.id?{id:active.id,value:active.value,start:active.selectionStart,end:active.selectionEnd}:null;
 const openControls=keepView?[...document.querySelectorAll('.playback-options[open]')].map(e=>e.className):[];
 if(!payload.view?.panels)panels={...panels,library:resultDefaults.library,inspector:resultDefaults.inspector==='show'||resultDefaults.inspector==='auto'&&window.innerWidth>=1180};
 if(payload.view?.panels){const p=payload.view.panels;if(['library','inspector'].includes(p.priority))panels.priority=p.priority;for(const side of ['library','inspector']){if(typeof p[side]==='boolean')panels[side]=p[side];if(Number.isFinite(p[side+'Width']))panels[side+'Width']=Math.max(165,Math.min(380,p[side+'Width']));}}
 try{originalInstall(payload);}catch(e){panels=oldPanels;throw e;}
 homeVisible=keepHome;if(!keepHome)homeViewport=null;focusPanels=keepView?previousFocus:null;syncHome();syncPanels();
 if(viewport)restoreViewport(viewport);
 for(const name of openControls){const node=document.getElementsByClassName(name)[0];if(node)node.open=true;}
 if(editor){const field=$(editor.id);if(field&&!field.disabled){if(editor.id==='x-search'){field.value=editor.value;renderXAxisOptions();}field.focus({preventScroll:true});if(typeof field.setSelectionRange==='function'&&Number.isInteger(editor.start))field.setSelectionRange(editor.start,editor.end);}}
 if(!installingHost){externalMode=true;latestRevision++;notifyHost({type:'external-dataset',name:String(payload.name || '')});}
};
function requestWorkspaceSave(){if(!model || document.querySelector('dialog[open]'))return;if(embedded){$('workspace-filename').value=safeName(rawPayload?.name || 'Workspace for Reaktoro','html');saveWorkspace();}else showDialog('save-dialog');}
// Native save is a single dialog and acknowledges cancellation/errors before showing success.
if(embedded){
 download=async(blob,name)=>{
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
  const id=++downloadSerial;return new Promise((resolve,reject)=>{pendingDownloads.set(id,{resolve,reject});notifyHost({type:'download',id,name,data});});
 };
 document.addEventListener('click',async e=>{
  if(e.target.closest('#import-confirm')){
   e.preventDefault();e.stopImmediatePropagation();const button=$('import-confirm');button.disabled=true;$('import-status').textContent=L('正在读取并核对计算点…','Reading and matching calculation points…');
   try{await installNativeFiles(nativeResultFiles);}catch(error){$('import-status').textContent=error.message;}finally{if($('import-confirm'))$('import-confirm').disabled=false;}return;
  }
  if(e.target.closest('#save-workspace')){e.preventDefault();e.stopImmediatePropagation();requestWorkspaceSave();}},true);
}
document.addEventListener('keydown',e=>{if((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase()==='s'){e.preventDefault();e.stopImmediatePropagation();requestWorkspaceSave();}},true);
async function installNativeFiles(files,requestId){
 const serial=++workspaceSerial;
 const payload=await readFiles(files.map(file=>({name:file.name,size:file.size,lastModified:file.last_modified,text:async()=>file.text})));
 if(serial!==workspaceSerial)return;
 const savedWorkspace=files.length===1&&/\.html?$/i.test(files[0].name)?files[0]:null;
 install(payload);nativeResultFiles=[];
 notifyHost({type:'workspace-opened',requestId,path:savedWorkspace?.path,name:String(payload.name||savedWorkspace?.name||''),kind:savedWorkspace?'workspace':'tables'});
 toast(L('已打开新结果；源文件未修改。','Opened results; source files unchanged.'));
}
async function receiveHostMessage(event){
 if(!embedded || event.source!==parent || event.data?.channel!==hostChannel)return;
 const message=event.data;
 if(message.type==='appearance'){
  if(typeof message.language==='string'){
   const next=message.language.startsWith('en')?'en':'zh';
   if(next!==hostLanguage){const viewport=captureViewport();stop();cancelPointer();clearTimeout(toastTimer);$('toast')?.classList.add('hide');hostLanguage=next;language=next;if(state)state.language=next;buildShell();if(model)render(false);restoreViewport(viewport);}
  }
  applyAppearance(message.theme);return;
 }
 if(message.type==='preferences'){const p=message.preferences||{};resultDefaults={x_direction:p.x_direction==='desc'?'desc':'asc',layout:p.layout==='grid'?'grid':'stack',playback_ms:[250,600,1200].includes(p.playback_ms)?p.playback_ms:600,inspector:['auto','show','hide'].includes(p.inspector)?p.inspector:'auto',library:p.library!==false};return;}
 if(message.type==='pause'){stop();return;}
 if(message.type==='begin-workspace'){workspaceSerial++;return;}
 if(message.type==='result-files-error'){if($('import-status'))$('import-status').textContent=message.message;return;}
 if(message.type==='selected-result-files'){nativeResultFiles=message.files||[];if($('choose-result-files'))$('choose-result-files').textContent=nativeResultFiles.length?nativeResultFiles.map(file=>file.name).join(' · '):L('选择结果文件…','Choose result files…');return;}
 if(message.type==='open-workspace'){
  try{await installNativeFiles(message.files||[],message.requestId);}catch(error){notifyHost({type:'workspace-error',requestId:message.requestId,message:error.message});}return;
 }
 if(message.type==='save-workspace'){requestWorkspaceSave();return;}
 if(message.type==='download-result'){const pending=pendingDownloads.get(message.id);if(pending){pendingDownloads.delete(message.id);message.error?pending.reject(new Error(message.error)):pending.resolve(message.ok);}return;}
 if(!['load','clear'].includes(message.type) || !Number.isFinite(message.revision) || message.revision<latestRevision)return;
 if(message.type==='load' && externalMode)return;
 latestRevision=message.revision;
 if(message.type==='clear'){
  workspaceSerial++;nativeResultFiles=[];externalMode=false;deferredLoad=null;homeVisible=true;homeViewport=null;stop();cancelPointer();model=null;state=null;rawPayload=null;datasetKey='';runKey='';savedBookmarks.clear();savedReference=null;referenceWasVisible=false;slice=[];plotSpecs=[];hovering=null;buildShell();return;
 }
 try{
  if(document.querySelector('dialog[open]')){deferredLoad=message;notifyHost({type:'deferred',revision:message.revision});return;}
  const bytes=Uint8Array.from(atob(message.data),c=>c.charCodeAt(0));
  const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  if(message.revision!==latestRevision || externalMode)return;
  if(document.querySelector('dialog[open]')){deferredLoad=message;notifyHost({type:'deferred',revision:message.revision});return;}
  const payload=JSON.parse(text),nextRun=message.runKey || message.datasetKey;
  if(Number.isSafeInteger(message.sourcePointCount)&&Array.isArray(payload.summary?.rows)&&message.sourcePointCount>=payload.summary.rows.length){payload.metadata={...(object(payload.metadata)?payload.metadata:{}),workspace_scope:{version:1,loaded_points:payload.summary.rows.length,source_points:message.sourcePointCount}};}
  const cursorKey=model&&runKey===nextRun&&datasetKey===message.datasetKey?pointIdentity(model.points[slice[state.index]]):null;
  if(model && runKey===nextRun)payload.view=preservedRunView(payload,datasetKey===message.datasetKey);
  else{savedBookmarks.clear();savedReference=null;referenceWasVisible=false;}
  installingHost=true;try{install(payload);}finally{installingHost=false;}
  if(cursorKey!==null){const index=slice.findIndex(id=>pointIdentity(model.points[id])===cursorKey);if(index>=0){state.index=index;updatePoint();}}
  runKey=nextRun;datasetKey=message.datasetKey;referenceWasVisible=state.reference!==null;
  $('loading').classList.add('hide');notifyHost({type:'loaded',revision:message.revision,offscreenBookmarks:Math.max(0,savedBookmarks.size-state.bookmarks.length),offscreenReference:savedReference!==null && !referenceWasVisible});
 }catch(e){if(message.revision===latestRevision)notifyHost({type:'error',message:e.message,revision:message.revision});}
}
window.addEventListener('message',receiveHostMessage);
document.addEventListener('close',()=>{
 if(deferredLoad&&!document.querySelector('dialog[open]')){const message=deferredLoad;deferredLoad=null;receiveHostMessage({source:parent,data:message});}
},true);
let panelResizeTimer;window.addEventListener('resize',()=>{clearTimeout(panelResizeTimer);panelResizeTimer=setTimeout(syncPanels,120);});
if(window.matchMedia)window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(document.documentElement.dataset.theme==='system' || !document.documentElement.dataset.theme)applyAppearance('system');});
boot().then(()=>notifyHost({type:'ready'}));
`;
 return explorerHTML.replace('\nboot();',adapter).replace('</head>',`<style>${workstationCSS}</style></head>`);
}
