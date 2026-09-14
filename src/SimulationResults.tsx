import {t as tr,useLanguage,translateMessage} from './i18n';
import {useEffect,useMemo,useRef,useState} from 'react';
import {open,save} from '@tauri-apps/plugin-dialog';
import {invoke} from '@tauri-apps/api/core';
import {Check,ChevronDown,FolderOpen,LoaderCircle,RefreshCw,ArrowLeft,Info} from 'lucide-react';
import {fmt,JobStatus,Result} from './simulation-types';
import {simulationCall,simulationError} from './simulation-api';
import {embeddedExplorer} from './explorer-shell';
import {ResultPreferences,RESULT_DEFAULTS} from './workbench-preferences';
export {embeddedExplorer} from './explorer-shell';
type WorkspaceRequest={id:number;path:string};
export function SimulationResults({openRequest=0,workspaceRequest,onWorkspaceRecorded,onWorkspaceRequestDone,onExternalSource,job,onError,visible,onNotice,theme='system',onOpenRun,onSimulation,onResultsHome,preferences=RESULT_DEFAULTS}:{openRequest?:number;workspaceRequest?:WorkspaceRequest|null;onWorkspaceRecorded?:(path:string,name:string,opened:boolean)=>void;onWorkspaceRequestDone?:()=>void;onExternalSource?:(source:{name:string;path?:string}|null)=>void;preferences?:ResultPreferences;job:JobStatus|null;onError:(s:string)=>void;visible:boolean;onNotice:(s:string)=>void;theme?:'light'|'dark'|'system';onOpenRun?:()=>void;onSimulation?:()=>void;onResultsHome?:()=>void}){
 useLanguage();
  const [external,setExternal]=useState(false);
  const [offscreen,setOffscreen]=useState({bookmarks:0,reference:false});
  const frame=useRef<HTMLIFrameElement>(null),seq=useRef(0);
  const [ready,setReady]=useState(false),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0),[page,setPage]=useState(''),[pageCount,setPageCount]=useState(1),[perPage,setPerPage]=useState(0),[previewPoints,setPreviewPoints]=useState(0),[cycle,setCycle]=useState(''),[cycles,setCycles]=useState<number[]>([]),[audit,setAudit]=useState<Result|null>(null),[showAudit,setShowAudit]=useState(false);
  const channel=useMemo(()=>`easyreaktoro-${Math.random().toString(36).slice(2)}`,[]),srcDoc=useMemo(()=>embeddedExplorer(channel,document.documentElement.lang || 'zh-CN'),[channel]);
  const handlers=useRef({onError,onNotice,onOpenRun,onWorkspaceRecorded,onWorkspaceRequestDone,onExternalSource});handlers.current={onError,onNotice,onOpenRun,onWorkspaceRecorded,onWorkspaceRequestDone,onExternalSource};
  const workspaceRequestRef=useRef(workspaceRequest);workspaceRequestRef.current=workspaceRequest;
  const preferencesRef=useRef(preferences);preferencesRef.current=preferences;
  const downloadLock=useRef(false);
  useEffect(()=>{
    const receive=async(e:MessageEvent)=>{
      if(e.source!==frame.current?.contentWindow || e.data?.channel!==channel)return;
      if(e.data.type==='ready'){setReady(true);return;}
      if(e.data.type==='external-dataset'){handlers.current.onExternalSource?.({name:e.data.name||tr('导入的结果',"Imported results")});seq.current++;setExternal(true);setLoading(false);setShowAudit(false);setOffscreen({bookmarks:0,reference:false});return;}
      if(e.data.type==='choose-result-files'){
        if(downloadLock.current)return;downloadLock.current=true;
        try{const paths=await open({title:tr('选择结果表格或图表工作区',"Choose result tables or a chart workspace"),multiple:true,filters:[{name:tr('结果文件',"Result files"),extensions:['csv','gz','json','html','htm']}]});if(!paths)return;
          const result=await simulationCall('read_result_files',{paths:Array.isArray(paths)?paths:[paths]});frame.current?.contentWindow?.postMessage({channel,type:'selected-result-files',files:result.files},'*');
        }catch(error){frame.current?.contentWindow?.postMessage({channel,type:'result-files-error',message:simulationError(error)},'*');}finally{downloadLock.current=false;}return;
      }
      if(e.data.type==='workspace-opened'||e.data.type==='workspace-error'){
        if(e.data.requestId!==undefined&&e.data.requestId!==workspaceRequestRef.current?.id)return;
        setLoading(false);
        if(e.data.type==='workspace-error')handlers.current.onError(e.data.message);
        else if(e.data.path)handlers.current.onWorkspaceRecorded?.(e.data.path,e.data.name||e.data.path.split(/[\\/]/).at(-1),true);
        if(e.data.requestId!==undefined)handlers.current.onWorkspaceRequestDone?.();return;
      }
      if(e.data.type==='open-run'){handlers.current.onOpenRun?.();return;}
      if(e.data.revision!==undefined && e.data.revision!==seq.current)return;
      if(e.data.type==='error'){setLoading(false);handlers.current.onError(e.data.message);return;}
      if(e.data.type==='deferred'){setLoading(false);return;}
      if(e.data.type==='loaded'){setLoading(false);setOffscreen({bookmarks:e.data.offscreenBookmarks || 0,reference:!!e.data.offscreenReference});return;}
      if(e.data.type==='download'){
        const reply=(value:any)=>frame.current?.contentWindow?.postMessage({channel,type:'download-result',id:e.data.id,...value},'*');
        if(downloadLock.current){reply({ok:false});return;}
        downloadLock.current=true;
        try{
          const name=String(e.data.name || 'result.svg').replace(/[\\/]/g,'_');
          const ext=name.split('.').pop() || 'svg';
          const path=await save({title:ext==='html'?tr('保存结果工作区',"Save result workspace"):tr('导出结果文件',"Export result file"),defaultPath:(preferencesRef.current.export_directory?preferencesRef.current.export_directory.replace(/\/$/,'')+'/':'')+name,filters:[{name:tr('结果文件',"Result files"),extensions:[ext]}]});
          if(!path){reply({ok:false});return;}
          const result=await simulationCall('save_artifact',{path,data:e.data.data});
          if(result.success!==true)throw new Error(tr('无法确认文件是否已保存，请检查保存位置后重试。',"The file could not be confirmed as saved. Check the location and try again."));
          // CSV and workspace exports show their own acknowledged success toast.
          if(!['csv','html'].includes(ext.toLowerCase()))handlers.current.onNotice(tr(`已保存：${result.output_path}`,`Saved: ${result.output_path}`));
          if(ext.toLowerCase()==='html')handlers.current.onWorkspaceRecorded?.(result.output_path||path,name.replace(/\.html?$/i,''),false);
          reply({ok:true});
        }catch(error){reply({error:simulationError(error)});handlers.current.onError(simulationError(error));}finally{downloadLock.current=false;}
      }
    };
    window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
  },[channel]);
  useEffect(()=>{
    if(!ready)return;
    const appearance=()=>frame.current?.contentWindow?.postMessage({channel,type:'appearance',theme,language:document.documentElement.lang || 'zh-CN'},'*');
    appearance();const observer=new MutationObserver(appearance);observer.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
    frame.current?.contentWindow?.postMessage({channel,type:'preferences',preferences},'*');
    return()=>observer.disconnect();
  },[theme,preferences,ready,channel]);
  useEffect(()=>{
    if(!visible || !ready)return;
    const keydown=(e:KeyboardEvent)=>{if((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase()==='s'){e.preventDefault();frame.current?.contentWindow?.postMessage({channel,type:'save-workspace'},'*');}};
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  },[visible,ready,channel]);
  useEffect(()=>{if(!visible)frame.current?.contentWindow?.postMessage({channel,type:'pause'},'*');},[visible,channel]);
  useEffect(()=>{setExternal(false);setOffscreen({bookmarks:0,reference:false});setCycle('');setCycles([]);setPage('');setPageCount(1);setAudit(null);setLoading(false);frame.current?.contentWindow?.postMessage({channel,type:'clear',revision:++seq.current},'*');},[job?.job_id,openRequest,ready,channel]);
  useEffect(()=>{
    if(!ready||!workspaceRequest)return;let disposed=false;const request=workspaceRequest;setLoading(true);
    // Cancel an older parser/decompression immediately, including when this
    // native file read is slow or fails before it reaches the iframe.
    frame.current?.contentWindow?.postMessage({channel,type:'begin-workspace',requestId:request.id},'*');
    void simulationCall('read_result_files',{paths:[request.path]}).then(result=>{if(!disposed)frame.current?.contentWindow?.postMessage({channel,type:'open-workspace',requestId:request.id,files:result.files},'*');}).catch(error=>{if(!disposed){setLoading(false);handlers.current.onError(simulationError(error));handlers.current.onWorkspaceRequestDone?.();}});
    return()=>{disposed=true;};
  },[workspaceRequest?.id,ready,channel]);
  useEffect(()=>{
    const revision=++seq.current;
    if(!ready || !job?.completed || !visible || external)return;
    const id=job.job_id;
    let disposed=false;
    const timer=setTimeout(async()=>{
      setLoading(true);
      try{
        const result=await simulationCall('explorer',{job_id:id,cycle:cycle?Number(cycle):undefined,page:page?Number(page):undefined});
        if(disposed || seq.current!==revision)return;
        if(Array.isArray(result.cycles)&&cycle)setCycles(result.cycles);
        if(result.choose_cycle){setCycles(result.cycles);setCycle(current=>result.cycles.includes(Number(current))?current:String(result.cycles[result.cycles.length-1]));setLoading(false);return;}
        if(result.choose_page){setPageCount(result.page_count);setPreviewPoints(result.cycle_points);setPerPage(result.points_per_page);setPage(String(result.page_count));setLoading(false);return;}
        setPageCount(result.page_count || 1);setPreviewPoints(result.cycle_points || 0);setPerPage(result.points_per_page || 0);
        if(!result.point_count){setLoading(false);return;}
        frame.current?.contentWindow?.postMessage({channel,type:'load',data:result.data,sourcePointCount:result.status?.completed ?? job.completed,runKey:id,datasetKey:`${id}:${cycle}:${page}`,revision},'*');
      }catch(error){if(!disposed){setLoading(false);handlers.current.onError(simulationError(error));}}
    },job.status==='running'?300:0);
    return()=>{disposed=true;clearTimeout(timer);};
  },[job?.job_id,job?.completed,job?.status,openRequest,ready,refresh,cycle,page,visible,channel,external]);
  useEffect(()=>{let disposed=false;if(showAudit && job)simulationCall<Result>('result',{job_id:job.job_id}).then(r=>{if(!disposed)setAudit(r);}).catch(e=>handlers.current.onError(simulationError(e)));return()=>{disposed=true;};},[showAudit,job?.job_id,job?.status,job?.completed]);
  const revealResults=async()=>{if(!job?.output_path)return;try{await invoke('reveal_path',{path:job.output_path});}catch(e){handlers.current.onError(simulationError(e));}};
  const reloadRun=()=>{if(external){handlers.current.onExternalSource?.(null);setExternal(false);setOffscreen({bookmarks:0,reference:false});frame.current?.contentWindow?.postMessage({channel,type:'clear',revision:++seq.current},'*');}setRefresh(v=>v+1);};
  return <div className="sim-results-page">{external && job && <div className="sim-import-context"><span>{tr("当前为独立导入的数据","Showing independently imported data")}{job.status==='running'?tr('；模拟仍在后台计算',"; the simulation is still running in the background"):''}</span><button className="text-btn" onClick={reloadRun}>{tr("返回","Return to ")}{job.name || tr('计算结果',"Calculation results")}</button></div>}{job && !external && <><div className={`sim-runbar ${job?.status || ''}`}><div className="sim-run-summary">{job?.status==='running'?<LoaderCircle size={17} className="sim-spin"/>:job?.status==='completed'?<Check size={17}/>:<FolderOpen size={17}/>}{!job.completed && <strong title={job.name}>{job.name || tr('计算结果',"Calculation results")}</strong>}<span>{tr(`${job.completed} / ${job.total} 点 · ${fmt(job.elapsed_seconds,3)} s`,`${job.completed} / ${job.total} points · ${fmt(job.elapsed_seconds,3)} s`)}</span>{job.execution?.mode==='custom' && <span className="sim-custom-run">{tr("自定义 Python","Custom Python")}</span>}{job && <small>{translateMessage(job.message||'')}</small>}</div><div className="sim-inline">{cycles.length>0 && <label className="sim-field">{tr("预览轮次","Preview round")}<select aria-label={tr("结果预览轮次","Result preview round")} value={cycle} onChange={e=>{setCycle(e.target.value);setPage('');setPageCount(1);}}>{cycles.map(c=><option key={c} value={c}>{c}</option>)}</select></label>}{pageCount>1 && <label className="sim-field">{tr("点段","Point range")}<select aria-label={tr("结果预览点段","Result preview point range")} value={page} onChange={e=>setPage(e.target.value)}>{Array.from({length:pageCount},(_,i)=><option key={i+1} value={i+1}>{i*perPage+1}–{Math.min(previewPoints,(i+1)*perPage)}</option>)}</select></label>}<button className="text-btn" disabled={!job.output_path} title={tr(`在 Finder 中显示：${job.output_path || ''}`,`Show in Finder: ${job.output_path || ''}`)} onClick={revealResults}><FolderOpen size={14}/>{tr("保存位置","Saved location")}</button><button className="sim-icon-btn" aria-label={tr("刷新结果预览","Refresh result preview")} disabled={!job?.completed || loading} onClick={reloadRun}><RefreshCw size={15}/></button><button className="text-btn" disabled={!job} onClick={()=>setShowAudit(!showAudit)}>{tr("运行记录","Run details")}<ChevronDown size={14}/></button></div></div>
    {job?.status==='running' && <div className="sim-progress"><i style={{width:`${100*job.completed/job.total}%`}}/></div>}
    {showAudit && job?.output_path && <div className="sim-result-path" title={job.output_path}>{tr("已保存至 ","Saved to ")}<span>{job.output_path}</span></div>}
    {job?.diagnostic && <div className="sim-run-diagnostic" role="alert">{simulationError(job.diagnostic)}</div>}
    {cycles.length>0 && <div className="sim-help">{tr("结果较大，按轮次与点段载入。此处另存的工作区和图表只包含当前载入部分；计算目录中的 CSV 和结果页面保留全部完成点。","Large results are loaded by round and point range. Workspaces and charts saved here contain only the loaded part. The calculation folder retains all completed points in its CSV files and result page.")}</div>}
    {(offscreen.bookmarks>0 || offscreen.reference) && <div className="sim-help" role="status">{offscreen.bookmarks>0?tr(`${offscreen.bookmarks} 个书签在其他轮次或点段中。`,`${offscreen.bookmarks} bookmarks are in other rounds or point ranges. `):''}{offscreen.reference?tr('参考点在其他轮次或点段中，当前不显示相对该点的差值。',"The reference point is in another round or point range, so differences from it are not shown here. "):''}{tr("切回相应轮次或点段后可继续使用。","Load the corresponding round or point range to use them again.")}</div>}
    {showAudit && audit && <div className="sim-audit-panel"><div className="sim-inline"><strong>{tr("数据库：","Database: ")}{audit.metadata.database?.name || job?.source?.name}</strong><span>{tr("最大逐点误差 ","Maximum point balance error ")}{fmt(Math.max(0,...audit.summary.map(s=>s.max_component_balance_error_mol)))} mol</span></div><p>{job?.execution?.mode==='custom'?tr('本次运行使用自定义求解代码；此处展示代码输出的守恒记录，请核对修改后的约束与计算逻辑。',"This run uses custom solver code. These are the balance records produced by that code; check them against your modified constraints and calculation logic."):tr('累计账：所有外部投料 = 尚未转移的输出库存。停止或失败时，只有完整通过守恒检查的点进入结果。',"Cumulative balance: all external input equals the output inventory not yet transferred. After a stop or failure, results include only complete points that passed the balance checks.")}</p>{(audit.metadata.warnings || []).map(w=><p key={w}>{translateMessage(w)}</p>)}<div className="sim-table-wrap"><table className="sim-table"><thead><tr><th>{tr("组分","Component")}</th><th>{tr("累计输入 / mol","Cumulative input / mol")}</th><th>{tr("未转移库存 / mol","Untransferred inventory / mol")}</th><th>{tr("误差 / mol","Error / mol")}</th></tr></thead><tbody>{audit.metadata.process_balance.map((r:any)=><tr key={r.component}><td>{r.component}</td><td>{fmt(r.input_mol)}</td><td>{fmt(r.inventory_mol)}</td><td>{fmt(r.error_mol)}</td></tr>)}</tbody></table></div><small>{tr("精确配方、传递比例、活度参数、计算所用的数据库及逐点物料记录保存在本次结果文件夹。","The calculation folder contains the exact compositions, transfer fractions, activity parameters, database information and material records for each point.")}</small></div>}
    </>}<div className="sim-explorer-container"><iframe ref={frame} title={tr("结果","Results")} srcDoc={srcDoc} sandbox="allow-scripts allow-downloads" style={job && !job.completed && !external?{visibility:'hidden'}:undefined}/>{job && !job.completed && !external && <div className="sim-result-wait" role="status">{job.status==='running'?<LoaderCircle className="sim-spin" size={27}/>:<Info size={27}/>}<h2>{job.status==='running'?tr('正在计算第一个平衡点',"Calculating the first equilibrium point"):job.status==='failed'?tr('本次计算未产生有效结果',"This run produced no valid results"):tr('尚无已完成的平衡点',"No completed equilibrium points yet")}</h2><p>{job.status==='running'?tr('完成后会在这里显示数据。结果正保存到所选文件夹，可以切换页面查看当前设置。',"Data will appear here when a point is complete. Results are being saved to the chosen folder; you can switch pages to review the settings."):tr('已有设置仍然保留。查看上方运行信息，返回模拟调整后可重新运行。',"Your settings are retained. Review the run information above, then return to the simulation to adjust and run again.")}</p>{onSimulation && <button className="secondary" onClick={onSimulation}><ArrowLeft size={15}/>{tr("返回模拟","Back to simulation")}</button>}{job.status!=='running' && onResultsHome && <button className="text-btn" onClick={onResultsHome}>{tr("返回结果首页，打开其他数据","Results home · open other data")}</button>}</div>}{loading && <div className="sim-preview-loading"><LoaderCircle size={14} className="sim-spin"/>{tr("正在载入保存的结果…","Loading saved results…")}</div>}</div>
  </div>;
}
