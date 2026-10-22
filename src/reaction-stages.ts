import {t} from './i18n';
import type {ScheduleDiagnostic} from './schedule-diagnostics';
import type {Config,ReactionStageKey,ReactionStages,Route} from './simulation-types';
import type {Loop,LoopTarget,RouteBinding} from './simulation-loops';
import {mapScheduleTargets,remapRouteTarget} from './schedule-references';

export const stageKeys:ReactionStageKey[]=['first_start','first_following','later_start','later_following'];
export const stageInfo:Record<ReactionStageKey,{title:string;row:string;column:string}>={
  first_start:{get title(){return t('首次起点',"First reaction");},get row(){return t('第 1 轮',"Round 1");},get column(){return t('起点',"Start");}},
  first_following:{get title(){return t('首轮后续位置',"Following positions in round 1");},get row(){return t('第 1 轮',"Round 1");},get column(){return t('其余位置',"Following positions");}},
  later_start:{get title(){return t('后续轮起点',"Start of later rounds");},get row(){return t('第 2 轮起',"Round 2 onward");},get column(){return t('起点',"Start");}},
  later_following:{get title(){return t('后续轮其余位置',"Following positions in later rounds");},get row(){return t('第 2 轮起',"Round 2 onward");},get column(){return t('其余位置',"Following positions");}},
};
export function stageAt(ii:number,oi:number):ReactionStageKey{return oi===0?(ii===0?'first_start':'first_following'):(ii===0?'later_start':'later_following');}
export function activeRouteEntries(config:Config):{stage?:ReactionStageKey;route:Route;index:number}[]{
  return config.reaction_stages?stageKeys.flatMap(stage=>config.reaction_stages![stage].map((route,index)=>({stage,route,index}))):config.routes.map((route,index)=>({route,index}));
}
/** Only material dependencies: shared by the current schedule and legacy axes. */
export function reactionSourceDiagnostic(config:Config,counts:{inner:number;outer:number}):ScheduleDiagnostic|undefined{
 for(const {route,index,stage} of activeRouteEntries(config)){
  if(stage&&(stage.endsWith('_following')&&counts.inner===1||stage.startsWith('later_')&&counts.outer===1))continue;
  const location=stage?t(`${stageInfo[stage].title}的第 ${index+1} 项物料`,`${stageInfo[stage].title} · input ${index+1}`):t(`来源 ${index+1}`,`Source ${index+1}`);
  const issue=(message:string,field:'source'|'position'|'round'='source'):ScheduleDiagnostic=>({message,location:{kind:'source',routeId:route.id||`route-${index+1}`,field,inner:stage?.endsWith('_following')?1:0,outer:stage?.startsWith('later_')?1:0}});
  if(route.source==='material'&&!config.materials.some(m=>m.id===route.material_id))return issue(t(`${location}的 Composition 已不存在，请重新选择。`,`${location} uses a composition that no longer exists. Choose a composition again.`));
  if(stage&&route.source==='previous_point'&&stage.endsWith('_start'))return issue(t(`${location}没有前一步结果，请改选实际加入的 composition 或有效来源。`,`${location} has no previous reaction. Choose a composition or an available result.`));
  if(stage&&stage.startsWith('first_')&&(route.source==='previous_cycle'||route.source==='output'&&route.lag===1))return issue(t(`${location}没有上一轮结果，请改选实际加入的 composition 或有效来源。`,`${location} has no previous round. Choose a composition or an available result.`),route.source==='output'?'round':'source');
  if(route.source!=='output')continue;
  if(!/^loop-([1-9][0-9]*)$/.test(route.point_id||''))return issue(t(`${location}的来源不属于当前反应路径，请重新选择来源位置。`,`${location} refers to a source outside this reaction path. Choose a source position again.`),'position');
  const source=Number(route.point_id!.slice(5));
  if(source>counts.inner)return issue(t(`${location}指向的位置已超出反应路径范围，请调整来源。`,`${location} refers to a position outside the reaction path. Adjust the source.`),'position');
  if(stage&&route.lag===0&&(stage.endsWith('_start')||source>=2))return issue(t(`${location}引用的本轮结果尚未完成，请选择已完成的位置。`,`${location} refers to a result that has not yet been calculated in this round. Choose an earlier position.`),stage.endsWith('_start')?'round':'position');
 }
}
export function reactionSourceIssue(config:Config,counts:{inner:number;outer:number}):string|undefined{return reactionSourceDiagnostic(config,counts)?.message;}
/** Keep imported identities stable across the UI and Python runtime; never reassign explicit IDs. */
export function normalizeStageRoutes(config:Config):Config{
  const stages=config.reaction_stages;if(!stages)return config;
  const used=new Set<string>();let missing=false;
  for(const stage of stageKeys){
    if(!Array.isArray(stages[stage]))throw new Error(t('反应物组成设置不完整。',"The reactant composition is incomplete."));
    for(const route of stages[stage]){
      if(!route||typeof route!=='object')throw new Error(t('反应物组成设置不完整。',"The reactant composition is incomplete."));
      if(route.when!=='always')throw new Error(t('各处组成应在该类位置每次反应时使用；请分别设置四处组成，不要在同一物料项中附加轮次条件。',"Set the composition separately for each reaction stage. Each input must apply whenever that stage is used."));
      if(Object.prototype.hasOwnProperty.call(route,'id')){
        if(typeof route.id!=='string'||!route.id.trim())throw new Error(t('物料记录的标识无效，请检查模拟设置文件。',"Invalid material record ID. Check the simulation settings file."));
        if(used.has(route.id))throw new Error(t('各反应位置存在重复的物料记录，请保留独立的物料项。',"Duplicate material records occur across reaction stages. Keep a separate input record for each stage."));
        used.add(route.id);
      }else missing=true;
    }
  }
  if(!missing)return config;
  const next={...stages};
  for(const stage of stageKeys)next[stage]=stages[stage].map((route,index)=>{
    if(Object.prototype.hasOwnProperty.call(route,'id'))return route;
    const base=`${stage}-route-${index+1}`;let id=base,suffix=1;
    while(used.has(id))id=`${base}-${suffix++}`;
    used.add(id);return {...route,id};
  });
  return {...config,reaction_stages:next};
}
const bindingKey=(route_id:string,field:RouteBinding['field'])=>JSON.stringify([route_id,field]);
/** Expand shared rules into their actual inputs at each reaction position. Original settings remain intact. */
export function toStageConfig(config:Config):Config{
  if(config.reaction_stages)return normalizeStageRoutes(config);
  if(!config.loops&&!config.schedule&&config.points.some(p=>p.routes!==undefined))throw new Error(t('此模拟为不同位置分别设置了组成，请继续使用原逐步路线。',"This simulation defines a separate composition at each position. Continue using its step-by-step path."));
  const stages:ReactionStages={first_start:[],first_following:[],later_start:[],later_following:[]};
  const mapping=new Map<string,RouteBinding[]>();
  const remember=(oldId:string,oldField:RouteBinding['field'],route:Route)=>{
    const key=bindingKey(oldId,oldField),entries=mapping.get(key)||[];
    entries.push({route_id:route.id!,field:'fraction'});mapping.set(key,entries);
  };
  for(const stage of stageKeys){
    const first=stage.startsWith('first_'),start=stage.endsWith('_start');
    config.routes.forEach((old,index)=>{
      if(old.when==='first_cycle'&&!first||old.when==='after_first_cycle'&&first)return;
      const oldId=old.id||`route-${index+1}`;
      const missing=old.source==='previous_point'&&start||old.source==='previous_cycle'&&first||old.source==='output'&&old.lag===1&&first;
      if(missing&&old.fallback==='none')return;
      const route:Route={...old,id:`${stage}-${oldId}`,when:'always',...(old.species?{species:[...old.species]}:{})};
      if(missing&&old.fallback==='material'){
        route.source='material';route.fraction=old.fallback_fraction;
        remember(oldId,'fallback_fraction',route);
      }else remember(oldId,'fraction',route);
      stages[stage].push(route);
    });
  }
  const migrateTarget=(target:LoopTarget):LoopTarget=>remapRouteTarget(target,mapping);
  const migrateLoop=(loop:Loop):Loop=>loop.mode==='repeat'?loop:{...loop,target:migrateTarget(loop.target)};
  return normalizeStageRoutes({...config,reaction_stages:stages,...(config.schedule?{schedule:mapScheduleTargets(config.schedule,migrateTarget)}:{}),...(config.loops?{loops:{...config.loops,inner:migrateLoop(config.loops.inner),outer:migrateLoop(config.loops.outer)}}:{})});
}
