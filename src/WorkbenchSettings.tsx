import {t as tr,useLanguage,translateMessage} from './i18n';
import {open} from '@tauri-apps/plugin-dialog';
import {useState} from 'react';
import {simulationError} from './simulation-api';
function Row({title,copy,children}:{title:string;copy:string;children:React.ReactNode}){return <div className="setting-row"><div><h3>{title}</h3><p>{copy}</p></div><div className="setting-control">{children}</div></div>;}
export function DirectorySetting({title,value,onChange}:{title:string;value?:string;onChange:(value?:string)=>void}){
 useLanguage();
 const [error,setError]=useState('');
 return <Row title={title} copy={(error&&translateMessage(error))||value||tr("未指定；保存时选择位置。", "Not set; choose a location when saving.")}><button className="secondary" onClick={async()=>{try{const path=await open({title,directory:true,multiple:false,defaultPath:value});if(typeof path==='string'){setError('');onChange(path);}}catch(e){setError(simulationError(e));}}}>{tr("选择…", "Choose…")}</button><button className="text-button" disabled={!value} onClick={()=>{setError('');onChange(undefined);}}>{tr("清除", "Clear")}</button></Row>;
}
