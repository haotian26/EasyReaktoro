import {t} from './i18n';
import {loopCounts,loopIssue} from './simulation-loops';
import {pointConditions} from './process-layout';
import {materialBaseUsage} from './material-base-usage';
import {Config,DatabaseSummary,SimSpecies} from './simulation-types';
import {stageKeys,stageInfo,stageAt,toStageConfig} from './reaction-stages';
import {compileSchedule,scheduleCounts,scheduleIssue,type CompiledSchedule} from './simulation-schedule';
import {evaluatedRecipeInputs,recipeInputs} from './ReactionStageEditor';

export type SetupStep={id:string;title:string;detail:string;issue?:string};
const hasText=(value:unknown)=>typeof value==='string' && !!value.trim();
export function unfinishedIonOverrides(config:Config){
  return Object.entries(config.ion_size_overrides).filter(([,p])=>!p || !Number.isFinite(p.a_angstrom) || p.a_angstrom<1e-9 || !hasText(p.source) || !hasText(p.reason)).map(([name])=>name);
}
/** Editing guidance only. Scientific and process validation belongs to the runtime. */
export function ionSizeGaps(config:Config,items:SimSpecies[]){
  return items.filter(s=>config.species.includes(s.name) && s.phase==='aqueous' && s.charge!==0).flatMap(s=>{
    const override=config.ion_size_overrides[s.name],value=override || s.ion_size;
    let reason='';
    if(!value || !Number.isFinite(value.a_angstrom) || value.a_angstrom<1e-9)reason=t('缺少有效的离子尺寸',"A valid ion-size parameter is missing");
    else if(override && (!hasText(value.source) || !hasText(value.reason)))reason=t('本次指定值需填写来源和理由',"Enter a source and reason for this override");
    else if(!hasText(value.source) && !(hasText(value.reason) && config.allow_recorded_assignments))reason=t('缺少文献来源，或尚未允许已有赋值',"A reference is missing, or recorded assignments are not enabled");
    else if(!override && value.is_default && !config.allow_database_defaults)reason=t('尚未允许数据库默认值',"Database defaults are not enabled");
    return reason?[{name:s.name,reason}]:[];
  });
}
export function setupSteps(config:Config,items:SimSpecies[],summary:DatabaseSummary):SetupStep[]{
  const selected=new Set(config.species),chosen=items.filter(s=>selected.has(s.name));
  const unavailable=config.species.filter(n=>!chosen.some(s=>s.name===n && !s.disabled));
  const aqueous=chosen.some(s=>s.phase==='aqueous'),waters=chosen.filter(s=>s.is_water);
  const rows=config.materials.flatMap(m=>m.inputs);let filled=config.materials.filter(m=>m.inputs.some(r=>Number.isFinite(r.amount) && r.amount>0));
  let plan:CompiledSchedule|undefined,effective=config;
  try{if(config.schedule){effective=toStageConfig(config);plan=compileSchedule(effective);}}catch{}
  const counts=config.schedule?scheduleCounts(config.schedule):loopCounts(config),total=counts.total;
  if(plan&&effective.reaction_stages){
   const candidates=Object.fromEntries(stageKeys.map(key=>[key,effective.reaction_stages![key].filter(route=>route.source==='material'&&(route.fraction>0||plan!.hasSetting({kind:'route_fraction',route_id:route.id!,field:'fraction'}))&&recipeInputs(effective,route,items).some(row=>row.amount>0||plan!.hasSetting({kind:'material_amount',material_id:route.material_id,species:row.species})))]));
   const possible=new Set(Object.values(candidates).flat().map(route=>route.material_id)),used=new Set<string>();
   for(let oi=0;oi<counts.outer&&used.size<possible.size;oi++)for(let ii=0;ii<counts.inner&&used.size<possible.size;ii++){const key=stageAt(ii,oi);for(const route of candidates[key])if(!used.has(route.material_id)&&evaluatedRecipeInputs(effective,route,key,items,[ii,oi],plan).some(row=>Number.isFinite(row.amount)&&row.amount>0))used.add(route.material_id);}
   filled=config.materials.filter(material=>used.has(material.id));
  }
  let invalidInput='';
  invalidInputs:for(const material of config.materials)for(const row of material.inputs){
   if(Number.isFinite(row.amount)&&row.amount>=0)continue;
   const usage=materialBaseUsage(effective,{kind:'material_amount',material_id:material.id,species:row.species},items,plan);
   if(Number.isNaN(row.amount)&&usage.known&&!usage.baseRequired)continue;
   invalidInput=t(`${material.name} · ${row.species} 的投料数量${usage.firstBase?`在第 ${usage.firstBase[1]+1} 轮 · 位置 ${usage.firstBase[0]+1}`:''}尚未有效填写`,`Enter a valid input amount for ${material.name} · ${row.species}${usage.firstBase?` at round ${usage.firstBase[1]+1} · position ${usage.firstBase[0]+1}`:''}`);break invalidInputs;
  }
  const emptyStage=effective.reaction_stages&&stageKeys.find(key=>!(key.endsWith('following')&&counts.inner===1||key.startsWith('later')&&counts.outer===1)&&!effective.reaction_stages![key].length);
  const conditionIssue=config.schedule?scheduleIssue(effective):config.loops?loopIssue(config):undefined;
  const validPoints=config.schedule||config.loops?!conditionIssue:config.points.length>0 && Number.isInteger(config.cycles) && config.cycles>=1 && total<=20000 && config.points.every(p=>{
    const overrides=(p.round_conditions||[]).filter(r=>r.round>=1&&r.round<=config.cycles),defined=new Set(overrides.map(r=>r.round));
    let first=1,last=config.cycles;while(first<=last&&defined.has(first))first++;while(last>=first&&defined.has(last))last--;
    const rounds=new Set([...overrides.map(r=>r.round),...(first<=last?[first,last]:[])]);
    return [...rounds].every(c=>{const v=pointConditions(p,c);return Number.isFinite(v.temperature)&&Number.isFinite(v.pressure)&&v.temperature>-273.15&&v.pressure>0;});
  });
  const gaps=config.activity_model==='nacl_edh' && aqueous?ionSizeGaps(config,items):[];
  const unfinished=unfinishedIonOverrides(config);
  const phreeqcUnavailable=aqueous && config.activity_model==='phreeqc' && (summary.kind!=='official' || summary.group!=='PHREEQC' || /pitzer|sit/i.test(summary.embedded_name || ''));
  return [
    {id:'species',title:t('系统 species',"System species"),detail:t(`${selected.size} 个可能出现的 species`,`${selected.size} species available at equilibrium`),issue:!selected.size?t('选择参与平衡的 species',"Select the species allowed at equilibrium"):unavailable.length?t(`${unavailable.length} 个所选 species 不可用`,`${unavailable.length} selected species are unavailable`):aqueous && waters.length!==1?t('水相需选一个水溶剂 species',"Select one water solvent species for the aqueous phase"):undefined},
    {id:'materials',title:t('初始物质',"Initial composition"),detail:t(`${filled.length} / ${config.materials.length} 份 composition ${config.schedule?'实际投料':'有投料'}`,`${filled.length} / ${config.materials.length} compositions ${config.schedule?'used in the reaction':'with input amounts'}`),issue:invalidInput?invalidInput:rows.some(r=>!selected.has(r.species))?t('投料中有未选入体系的 species',"An input species is missing from the system selection"):!filled.length?t('填写初始投料及其数量',"Enter the initial composition and amounts"):undefined},
    {id:'conditions',title:t('计算流程',"Reaction workflow"),detail:t(`${Number.isFinite(counts.inner)?counts.inner:'—'} 个路径位置 · ${Number.isFinite(counts.outer)?counts.outer:'—'} 轮反应`,`${Number.isFinite(counts.inner)?counts.inner:'—'} path positions · ${Number.isFinite(counts.outer)?counts.outer:'—'} reaction rounds`),issue:emptyStage?t(`为${stageInfo[emptyStage].title}加入反应物`,`Add reactants for ${stageInfo[emptyStage].title}`):!validPoints?(conditionIssue||t('检查温压、轮数及独立轮次设置',"Check temperature, pressure, round counts and individual round settings")):undefined},
    {id:'activity',title:t('活度模型',"Activity model"),detail:aqueous?({nacl_edh:'Extended Debye–Hückel',phreeqc:'PHREEQC',hkf:'HKF',davies:'Davies',ideal:t('理想水溶液',"Ideal aqueous solution")}[config.activity_model]):t('当前体系无水相',"No aqueous phase in the system"),issue:phreeqcUnavailable?t('当前数据库不支持此 PHREEQC 活度选项',"This database does not support the selected PHREEQC activity model"):gaps.length?t(`${gaps.length} 个离子尺寸或来源待设置`,`${gaps.length} ion-size parameters or sources need to be set`):unfinished.length?t('离子尺寸仍有未完成的编辑',"Some ion-size edits are incomplete"):undefined},
  ];
}
