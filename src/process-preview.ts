import {t} from './i18n';
import {Config,fmt,PHASE_LABELS,Route} from './simulation-types';

export const phaseName=(r:Route)=>r.phase==='all'?t('全部物料',"All material"):r.phase==='species'?t(`${r.species?.length || 0} 个指定物种`,`${r.species?.length || 0} selected species`):PHASE_LABELS[r.phase];
export const activeInCycle=(r:Route,cycle:number)=>r.when==='always' || (r.when==='first_cycle'?cycle===1:cycle>1);
export function sourcePoint(config:Config,r:Route,index:number,cycle:number){
  if(r.source==='material')return null;
  const sourceIndex=r.source==='previous_point'?index-1:r.source==='previous_cycle'?index:config.points.findIndex(p=>p.id===r.point_id);
  if(r.source==='output' && sourceIndex<0)return {index:-1,cycle,valid:false};
  const sourceCycle=cycle-(r.source==='previous_cycle'?1:r.source==='output'?(r.lag || 0):0);
  return sourceIndex<0 || sourceCycle<1?null:{index:sourceIndex,cycle:sourceCycle,valid:sourceCycle<cycle || sourceIndex<index};
}
export function previewPoint(config:Config,index:number,cycle:number){
  const point=config.points[index];if(!point)return {inputs:[],outputs:[]};
  const material=(r:Route)=>config.materials.find(m=>m.id===r.material_id)?.name || t('缺失的配方',"Missing composition");
  const inputs=(point.routes || config.routes).map((r,i)=>{
    const active=activeInCycle(r,cycle),origin=sourcePoint(config,r,index,cycle);
    let text='',problem=false;
    if(!active)text=t('本轮不加入',"Not added in this round");
    else if(r.source==='material')text=t(`${material(r)} × ${fmt(r.fraction)} 份`,`${material(r)} × ${fmt(r.fraction)} portions`);
    else if(origin){text=t(`第 ${origin.cycle} 轮 · ${config.points[origin.index]?.label || t('缺失的点',"Missing position")} → ${fmt(r.fraction*100)}%`,`Round ${origin.cycle} · ${config.points[origin.index]?.label || t('缺失的点',"Missing position")} → ${fmt(r.fraction*100)}%`);problem=!origin.valid;}
    else if(r.fallback==='material')text=t(`首次补入：${material(r)} × ${fmt(r.fallback_fraction)} 份`,`Initial addition: ${material(r)} × ${fmt(r.fallback_fraction)} portions`);
    else if(r.fallback==='none')text=t('还没有来源输出，本次不加入',"Source result not yet available; no addition at this reaction");
    else {text=t('没有来源输出，将报错停止',"Source result unavailable; calculation will stop");problem=true;}
    return {key:i,phase:phaseName(r),text,problem,inactive:!active};
  });
  const outputs:{key:string;phase:string;text:string}[]=[];
  for(const destinationCycle of [cycle,cycle+1]){
    if(destinationCycle>config.cycles)continue;
    config.points.forEach((p,j)=>{if(destinationCycle===cycle && j<=index)return;(p.routes || config.routes).forEach((r,k)=>{
      if(!activeInCycle(r,destinationCycle) || r.source==='material' || !r.fraction)return;
      const source=sourcePoint(config,r,j,destinationCycle);
      if(source?.index===index && source.cycle===cycle)outputs.push({key:`${destinationCycle}:${j}:${k}`,phase:phaseName(r),text:t(`${fmt(r.fraction*100)}% → 第 ${destinationCycle} 轮 · ${p.label}`,`${fmt(r.fraction*100)}% → round ${destinationCycle} · ${p.label}`)});
    });});
  }
  return {inputs,outputs};
}
