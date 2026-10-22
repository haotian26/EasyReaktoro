import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {invoke} from '@tauri-apps/api/core';
import {save as saveDialog} from '@tauri-apps/plugin-dialog';
import {Archive, Check, FolderOpen, History, RotateCcw, Trash2, X} from 'lucide-react';
import {t, translateMessage, useLanguage} from './i18n';
import {userMessage} from './user-messages';
import './database-versions.css';



type Version = {id:string; name:string; saved_at:string; database_modified_at:string; species_count:number; element_count:number; bytes:number; path:string};
type Preferences = {enabled:boolean; keep:number};
type Listing = {entries:Version[]; unavailable:number; settings:Preferences; directory:string};
type Preview = {entry:Version; current_available:boolean; changes:{added:string[]; removed:string[]; changed:{name:string; previous_name:string; fields:string[]}[]}; records:{name:string; formula:string; state:string}[]; metadata_changed:Record<string,unknown>};
type Props = {handleId:string; databaseName:string; onClose:()=>void; onRestored?:(path:string)=>void};
const formatBytes = (bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/(1024*1024)).toFixed(1)} MB`;

export function DatabaseVersions({handleId,databaseName,onClose,onRestored}:Props){
 const language=useLanguage();
 const [listing,setListing]=useState<Listing|null>(null),[preview,setPreview]=useState<Preview|null>(null);
 const [preferences,setPreferences]=useState<Preferences>({enabled:true,keep:10}),[keepText,setKeepText]=useState('10');
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[previewLoading,setPreviewLoading]=useState(false),[error,setError]=useState<unknown>(''),[notice,setNotice]=useState('');
 const [selection,setSelection]=useState(''),[deleting,setDeleting]=useState(''),[restored,setRestored]=useState(''),[search,setSearch]=useState('');
 const close=useRef<HTMLButtonElement>(null),requestId=useRef(0);
 const call=<T,>(payload:Record<string,unknown>)=>invoke<T>('rtdb_versions',{handleId,payload});
 const versionDate=(entry:Version)=>entry.database_modified_at||entry.saved_at;
 const date=(value:string)=>{const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleString(language==='en'?'en-AU':'zh-CN'):'—';};
 useEffect(()=>{
  let live=true;const previous=document.activeElement as HTMLElement|null;close.current?.focus();setLoading(true);
  call<Listing>({action:'list'}).then(value=>{if(live){setListing(value);setPreferences(value.settings);setKeepText(String(value.settings.keep));}}).catch(cause=>{if(live)setError(cause);}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;requestId.current++;if(previous?.isConnected)previous.focus();};
 },[handleId]);
 async function show(version:Version){
  const id=++requestId.current;setSelection(version.id);setPreview(null);setPreviewLoading(true);setDeleting('');setError('');setNotice('');setRestored('');setSearch('');
  try{const value=await call<Preview>({action:'preview',version_id:version.id});if(id===requestId.current)setPreview(value);}catch(cause){if(id===requestId.current)setError(cause);}finally{if(id===requestId.current)setPreviewLoading(false);}
 }
 async function savePreferences(){
  const keep=Number(keepText);
  if(!Number.isInteger(keep)||keep<1||keep>100){setError(t('保留份数需为 1 至 100 的整数。','Enter a whole number from 1 to 100.'));return;}
  setBusy(true);setError('');setNotice('');
  try{const value=await call<{settings:Preferences}>({action:'settings',settings:{enabled:preferences.enabled,keep}});setPreferences(value.settings);setKeepText(String(value.settings.keep));if(listing)setListing({...listing,settings:value.settings});else setListing(await call<Listing>({action:"list"}));setNotice(t('历史版本设置已保存。','Version history preferences saved.'));}catch(cause){setError(cause);}finally{setBusy(false);}
 }
 async function restore(){
  if(!preview)return;setBusy(true);setError('');setNotice('');
  try{
   const path=await saveDialog({title:t('恢复为新的数据库','Restore as a new database'),defaultPath:`${databaseName.replace(/[\\/:]/g,'_')}-${t('恢复副本','restored')}.rtdb`,filters:[{name:'EasyReaktoro',extensions:['rtdb']}]});
   if(!path)return;
   const value=await call<{path:string}>({action:'restore',version_id:preview.entry.id,path});setRestored(value.path);setNotice(t('副本已保存，当前数据库未被替换。','The restored copy is saved. Your current database was not replaced.'));
  }catch(cause){setError(cause);}finally{setBusy(false);}
 }
 async function remove(){
  if(!deleting)return;setBusy(true);setError('');
  try{const value=await call<Listing>({action:'delete',version_id:deleting});requestId.current++;setListing(value);setPreview(null);setSelection('');setDeleting('');setNotice(t('已删除该历史版本。','The saved version was deleted.'));}catch(cause){setError(cause);}finally{setBusy(false);}
 }
 const errorMessage=error?userMessage(error):'';
 const settingsChanged=!listing||preferences.enabled!==listing.settings.enabled||keepText!==String(listing.settings.keep);
 const rows=(preview?.records||[]).filter(row=>(row.name+' '+row.formula).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
 const fieldLabel=(field:string)=>({name:t('名称','Name'),formula:'Formula',composition:'Composition',charge:t('电荷','Charge'),state:t('相态','Phase'),model:t('热力学参数','Thermodynamic parameters'),references:t('参考文献','References'),notes:t('备注','Notes'),valid_tp:t('温压范围','Temperature / pressure range'),activity_parameters:t('活度参数','Activity parameters'),reaction:t('形成反应','Formation reaction'),dependencies:t('引用 species','Referenced species'),provenance:t('来源','Source'),tags:t('标签','Tags'),disabled:t('状态','Status')}[field]||field);
 return createPortal(<div className="db-versions-backdrop" onClick={onClose}><section className="db-versions" role="dialog" aria-modal="true" aria-label={t('数据库历史版本','Database version history')} onClick={event=>event.stopPropagation()} onKeyDown={event=>{
  if(event.key==='Escape'){event.stopPropagation();onClose();}
  if(event.key==='Tab'){const nodes=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')].filter(node=>node.getClientRects().length);if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus();}}
 }}>
  <header className="db-versions-header"><History size={23}/><div><h2>{t('历史版本','Version history')}</h2><p>{databaseName}</p></div><button ref={close} aria-label={t('关闭历史版本','Close version history')} onClick={onClose}><X size={19}/></button></header>
  <p className="db-versions-intro">{listing?.settings.enabled===false?t('已关闭自动保留历史版本。现有版本仍可查看和恢复，可在下方设置中重新开启。','Automatic version retention is off. Existing versions can still be reviewed and restored. You can turn retention on below.'):t('保存数据库的修改时，保留此前已保存的版本。未保存的编辑不会进入历史。','When you save database changes, the previously saved version is retained. Unsaved edits are not included.')}</p>
  {(errorMessage||notice)&&<div className={'db-versions-message'+(errorMessage?' error':'')} role={errorMessage?'alert':'status'}>{errorMessage||translateMessage(notice)}{restored&&!errorMessage&&<div className="db-versions-restored"><span>{restored}</span><button onClick={()=>invoke('reveal_path',{path:restored}).catch(cause=>setError(cause))}><FolderOpen size={14}/>{t('显示文件','Show file')}</button>{onRestored&&<button onClick={()=>onRestored(restored)}>{t('打开副本','Open restored copy')}</button>}</div>}</div>}
  <div className="db-versions-body"><nav className="db-versions-list" aria-label={t('已保存的版本','Saved versions')}>
   <div className="db-versions-list-heading">{t('较新 → 较早','Newest first')}<span>{listing?.entries.length??0}</span></div>
   {loading?<p className="db-versions-empty">{t('正在读取…','Loading…')}</p>:listing?.entries.length?listing.entries.map(entry=><button key={entry.id} className={selection===entry.id?'selected':''} aria-pressed={selection===entry.id} disabled={busy} onClick={()=>void show(entry)}><strong>{date(versionDate(entry))}</strong><span>{entry.name}</span><small>{entry.species_count.toLocaleString()} species · {entry.element_count} {t('元素','elements')} · {formatBytes(entry.bytes)}</small></button>):<p className="db-versions-empty"><Archive size={25}/>{t('还没有历史版本','No saved versions yet')}<small>{t('下一次保存有改动的数据库时，会在这里保留之前的版本。','The previous version will appear here when you next save a changed database.')}</small></p>}
   {!!listing?.unavailable&&<p className="db-versions-warning">{t(`${listing.unavailable} 份记录的文件缺失或已改变，未进行自动清理。`,`${listing.unavailable} version files are missing or changed. They have not been automatically removed.`)}<button onClick={()=>invoke('reveal_path',{path:listing.directory}).catch(cause=>setError(cause))}><FolderOpen size={13}/>{t('查看保存位置','Show history location')}</button></p>}
  </nav><div className="db-versions-preview">
   {!preview?<div className="db-versions-empty"><History size={30}/>{previewLoading?t('正在读取所选版本…','Loading the selected version…'):t('选择一个版本查看内容与变化。','Select a version to review its contents and changes.')}</div>:<>
    <div className="db-versions-preview-title"><div><h3>{t('版本内容','Version contents')}</h3><p>{date(versionDate(preview.entry))}</p></div><button className="primary" disabled={busy} onClick={()=>void restore()}><RotateCcw size={15}/>{t('恢复为副本…','Restore a copy…')}</button></div>
    <details className="db-versions-changes" open><summary>{t('与当前已保存数据库比较','Compared with the currently saved database')}</summary><p>{t('以下为这个历史版本保存之后发生的变化，不包含当前未保存的编辑。','Changes made since this version was saved, excluding your current unsaved edits.')}</p>
     {!preview.current_available?<p>{t('原文件已移除，仍可查看或恢复这个版本。','The original file was removed. You can still review or restore this version.')}</p>:<>
      <div className="db-versions-counts"><span>+ {preview.changes.added.length} {t('新增','added')}</span><span>− {preview.changes.removed.length} {t('移除','removed')}</span><span>~ {preview.changes.changed.length} {t('修改','changed')}</span></div>
      <div className="db-versions-diff">{preview.changes.added.map(name=><div key={'+'+name}><span>+</span><strong>{name}</strong></div>)}{preview.changes.removed.map(name=><div key={'-'+name}><span>−</span><strong>{name}</strong></div>)}{preview.changes.changed.map((row,index)=><div key={index}><span>~</span><strong>{row.previous_name===row.name?row.name:`${row.previous_name} → ${row.name}`}</strong><small>{row.fields.map(fieldLabel).join(' · ')}</small></div>)}</div>
      {!!Object.keys(preview.metadata_changed).length&&<p>{t('数据库信息也有变化。','Database information has also changed.')}</p>}
     </>}
    </details>
    <label className="db-versions-search"><span>{t('此版本中的 species','Species in this version')}</span><input value={search} onChange={event=>setSearch(event.target.value)} placeholder={t('搜索名称或化学式…','Search name or formula…')}/></label>
    <div className="db-versions-records" tabIndex={0}><table><thead><tr><th>Species</th><th>Formula</th><th>{t('相态','Phase')}</th></tr></thead><tbody>{rows.slice(0,200).map((row,index)=><tr key={index}><td>{row.name}</td><td>{row.formula}</td><td>{row.state}</td></tr>)}</tbody></table>{rows.length>200&&<p>{t(`显示前 200 / ${rows.length} 项，可搜索定位 species。`,`Showing 200 of ${rows.length} records. Search to locate a species.`)}</p>}{!rows.length&&<p>{t('没有匹配的 species。','No matching species.')}</p>}</div>
    <div className="db-versions-file-actions"><button onClick={()=>invoke('reveal_path',{path:preview.entry.path}).catch(cause=>setError(cause))}><FolderOpen size={14}/>{t('显示备份文件','Show version file')}</button><button disabled={busy} onClick={()=>setDeleting(preview.entry.id)}><Trash2 size={14}/>{t('删除此版本…','Delete this version…')}</button></div>
    {deleting&&<div className="db-versions-delete" role="alert"><p>{t('确定永久删除这个历史版本？当前数据库和其他版本不会改变。','Permanently delete this saved version? The current database and other versions will remain unchanged.')}</p><div><button disabled={busy} onClick={()=>setDeleting('')}>{t('取消','Cancel')}</button><button disabled={busy} className="danger" onClick={()=>void remove()}>{t('永久删除','Delete permanently')}</button></div></div>}
   </>}
  </div></div>
  <footer className="db-versions-settings"><details><summary>{t('历史版本设置','Version history preferences')}</summary><p>{t('适用于所有个人数据库。关闭后仍保留现有历史；调整份数后，下次保存有改动的数据库时清理其较早版本。','Applies to all personal databases. Turning this off keeps existing versions. A new retention count takes effect when you next save a changed database.')}</p><div><label className="db-versions-toggle"><input type="checkbox" disabled={busy||loading} checked={preferences.enabled} onChange={event=>setPreferences({...preferences,enabled:event.target.checked})}/>{t('保存修改时保留上一版本','Keep the previous version when saving changes')}</label><label>{t('每个数据库保留','Versions per database')}<input type="number" disabled={busy||loading} min="1" max="100" value={keepText} onChange={event=>setKeepText(event.target.value)}/></label><button disabled={busy||loading||!settingsChanged} onClick={()=>void savePreferences()}><Check size={14}/>{t('保存设置','Save preferences')}</button></div></details></footer>
 </section></div>,document.body);
}
