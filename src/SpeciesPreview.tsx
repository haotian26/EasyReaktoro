import {t as tr,useLanguage,translateMessage} from './i18n';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {invoke} from '@tauri-apps/api/core';
import {ChemicalFormula} from './chemistry';
import {fmt,PHASE_LABELS,SimSpecies} from './simulation-types';
import './species-preview.css';
const names:Record<string,string>={get 'reaktoro-native'(){return tr("Reaktoro 数据", "Reaktoro data");},'modified-ryzhenko-bryzgalin':'Modified Ryzhenko–Bryzgalin','extended-maier-kelley':'Extended Maier–Kelley','akinfiev-diamond':'Akinfiev–Diamond',get 'converted-standard-state'(){return tr("数据库热力学模型", "Database thermodynamic model");},get StandardThermoModel(){return tr("数据库标准态", "Database standard state");},VantHoff:'van’t Hoff',HollandPowell:'Holland–Powell',get WaterHKF(){return tr("HKF（水）", "HKF (water)");},hkf:'HKF'};
// SI units declared by Reaktoro StandardThermoModelParamsHKF.
const hkf:Record<string,{label:string;unit:string}>={Gf:{label:'G°f',unit:'J/mol'},Hf:{label:'H°f',unit:'J/mol'},Sr:{label:'S°r',unit:'J/(mol·K)'},a1:{label:'a₁',unit:'J/(mol·Pa)'},a2:{label:'a₂',unit:'J/mol'},a3:{label:'a₃',unit:'J·K/(mol·Pa)'},a4:{label:'a₄',unit:'J·K/mol'},c1:{label:'c₁',unit:'J/(mol·K)'},c2:{label:'c₂',unit:'J·K/mol'},wref:{label:'ωref',unit:'J/mol'},get charge(){return {label:tr("电荷", "Charge"),unit:''};},get Tmax(){return {label:tr("最高温度", "Maximum temperature"),unit:'K'};}};
type PreviewCache=Map<string,Promise<any>>;
export const createSpeciesPreviewCache=():PreviewCache=>new Map();
export const speciesPreviewKey=(handleId:string,item:SimSpecies)=>JSON.stringify([handleId,item.id||null,item.name]);
function readDetails(cache:PreviewCache,key:string,handleId:string,item:SimSpecies){
  const pending=cache.get(key);if(pending)return pending;
  const request=invoke('species_details',{handleId,speciesId:item.id||null,name:item.name});
  // Cache only within this mounted grid and database. Failed reads can be retried.
  cache.set(key,request);if(cache.size>100)cache.delete(cache.keys().next().value!);
  void request.catch(()=>{if(cache.get(key)===request)cache.delete(key);});
  return request;
}
export function SpeciesPreview({item,handleId,rect,id,cache}:{item:SimSpecies;handleId:string;rect:{left:number;right:number;top:number;bottom:number};id:string;cache:PreviewCache}){
 const language=useLanguage();
 const key=speciesPreviewKey(handleId,item),card=useRef<HTMLElement>(null);
 const [response,setResponse]=useState<{key:string;details?:any;failed?:boolean}|null>(null),[position,setPosition]=useState({left:12,top:12});
 const details=response?.key===key?response.details:null,failed=response?.key===key&&response.failed;
 useEffect(()=>{let disposed=false;readDetails(cache,key,handleId,item).then(details=>{if(!disposed)setResponse({key,details});}).catch(()=>{if(!disposed)setResponse({key,failed:true});});return()=>{disposed=true;};},[cache,key,handleId,item.id,item.name]);
 useLayoutEffect(()=>{
   const width=card.current?.getBoundingClientRect().width||312,height=card.current?.getBoundingClientRect().height||240;
   const left=Math.max(12,Math.min((rect.left+rect.right-width)/2,window.innerWidth-width-12));
   const top=rect.top>=height+20?rect.top-height-8:Math.max(12,Math.min(rect.bottom+8,window.innerHeight-height-12));
   setPosition(previous=>previous.left===left&&previous.top===top?previous:{left,top});
 },[rect,details,failed,language]);
 const model=details?.model?.native_type||((details?.model_parameters?.HKF)?'HKF':details?.model_definition?.label)||details?.model?.type;
 const rows:{key:string;value:unknown}[]=[];
 const collect=(value:any,path:string[])=>{
   if(value===undefined||value===null||path.length>8)return;
   // Reaktoro serializes an omitted optional HKF Tmax as zero. It is not a
   // declared applicability limit; other zero-valued coefficients remain real.
   if(path.at(-1)==='Tmax'&&value===0&&(path.includes('HKF')||String(model).toLowerCase()==='hkf'))return;
   if(typeof value==='object')Object.entries(value).forEach(([k,v])=>collect(v,[...path,k]));else rows.push({key:path.join(' / '),value});
 };
 if(details)collect(details.model_parameters||details.model?.parameters,[]);
 const reference=details?.references?.[0];
 const referenceText=typeof reference==='string'?reference:reference&&(reference.citation||reference.text||[reference.authors,reference.year,reference.title,reference.journal,reference.doi].filter(Boolean).join(' · '));
 const displayed=rows.slice(0,6);
 return createPortal(<aside ref={card} className="species-peek" role="tooltip" id={id} style={{...position,pointerEvents:'none'}}>
   <div className="species-peek-title"><strong>{item.name}</strong><span><ChemicalFormula value={item.formula}/> · {item.phase?PHASE_LABELS[item.phase]:item.state} {tr("· 电荷 ", "· Charge ")}{item.charge>0?'+':''}{item.charge}</span></div>
   {item.disabled&&<p>{translateMessage(item.reason||'')}</p>}
   {details?<><div className="species-peek-model">{names[model]||translateMessage(model||'')||tr("热力学模型未注明", "Thermodynamic model not specified")}</div>
     {displayed.length>0&&<dl className="species-peek-values">{displayed.map(r=>{const param=details.model_definition?.parameters?.find((x:any)=>x.name===r.key)||((r.key.startsWith('HKF / ')||String(model).toLowerCase()==='hkf')?hkf[r.key.split(' / ').at(-1)!]:undefined);return <div key={r.key}><dt>{translateMessage(param?.label||r.key.split(' / ').at(-1)||'')}{param?.unit&&<small>{param.unit}</small>}</dt><dd>{typeof r.value==='number'?Number(r.value.toPrecision(7)).toString():String(r.value)}</dd></div>;})}</dl>}
     {details.valid_tp&&<p className="species-peek-range">{details.valid_tp.temperature_K&&<>T {details.valid_tp.temperature_K.map((n:number)=>fmt(n-273.15)).join('–')} °C</>}{details.valid_tp.temperature_K&&details.valid_tp.pressure_Pa&&' · '}{details.valid_tp.pressure_Pa&&<>P {details.valid_tp.pressure_Pa.map((n:number)=>fmt(n/1e5)).join('–')} bar</>}</p>}
     {item.ion_size&&<p>{tr("离子尺寸 aᵢ ", "Ion size aᵢ ")}<strong>{fmt(item.ion_size.a_angstrom)} Å</strong></p>}
     {referenceText&&<p className="species-peek-reference">{referenceText}</p>}
     {rows.length>displayed.length&&<div className="species-peek-more">{tr("另有 ", "Another ")}{rows.length-displayed.length} {tr("项参数，可在数据库查看", "parameters are available in the database")}</div>}
   </>:<p className="species-peek-loading">{failed?tr("参数暂时无法读取", "Parameters are temporarily unavailable"):tr("正在读取热力学参数…", "Loading thermodynamic parameters…")}</p>}
 </aside>,document.body);
}
