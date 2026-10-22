import {t} from './i18n';
import {newId,type Config,type ReactionStageKey} from './simulation-types';
import {compileSchedule,decimalSum,migrateSchedule,type IndexScope,type ParameterProfile,type ParameterSetting,type Schedule,type ScheduleOverride} from './simulation-schedule';

export type ConditionTarget={kind:'temperature'}|{kind:'pressure'};
export type SimpleStageProfile=Extract<ParameterProfile,{mode:'fixed'|'relative'|'water_saturation'|'expression'}>;
export type StageConditionScope={rounds:IndexScope;positions:IndexScope};
export type StageCondition={
  scope:StageConditionScope;
  profile:SimpleStageProfile|null;
  /** Original definition, never relabel a linear sequence as relative continuation. */
  rawProfile:ParameterProfile|null;
  actualValue:number|null;
  complex:boolean;
  active:boolean;
  settingId?:string;
  overrideId?:string;
  settingIds:string[];
  issue?:string;
};

export function stageConditionScope(stage:ReactionStageKey):StageConditionScope{
  return {
    rounds:stage.startsWith('first_')?{start:1,end:1}:{start:2},
    positions:stage.endsWith('_start')?{start:1,end:1}:{start:2},
  };
}

const sameScope=(a:IndexScope,b:IndexScope)=>a.start===b.start&&a.end===b.end&&(a.step??1)===(b.step??1);
const sameArea=(a:StageConditionScope,b:StageConditionScope)=>sameScope(a.rounds,b.rounds)&&sameScope(a.positions,b.positions);
const matching=(setting:ParameterSetting,target:ConditionTarget)=>setting.target.kind===target.kind;
const size=(scope:IndexScope)=>Math.max(0,Math.floor(((scope.end??10000)-scope.start)/(scope.step??1))+1);
const completeScope=(scope:IndexScope)=>Number.isInteger(scope.start)&&scope.start>=1&&scope.start<=10000
  &&(scope.end===undefined||Number.isInteger(scope.end)&&scope.end>=scope.start&&scope.end<=10000)
  &&(scope.step===undefined||Number.isInteger(scope.step)&&scope.step>=1&&scope.step<=10000);
const completeArea=(area:StageConditionScope)=>completeScope(area.rounds)&&completeScope(area.positions);

/** Split only at the stage boundary (index 1 / index >= 2), retaining the arithmetic progression. */
function splitScope(scope:IndexScope):{first?:IndexScope;following?:IndexScope}{
  if(scope.start>1)return {following:scope};
  const first={...scope,end:1},start=scope.start+(scope.step??1);
  return {first,...(start<=(scope.end??10000)?{following:{...scope,start}}:{})};
}
function partition(area:StageConditionScope):{stage:ReactionStageKey;scope:StageConditionScope}[]{
  if(!completeArea(area))return [];
  const rounds=splitScope(area.rounds),positions=splitScope(area.positions);
  const result:{stage:ReactionStageKey;scope:StageConditionScope}[]=[];
  for(const [round,rs] of Object.entries(rounds))for(const [position,ps] of Object.entries(positions)){
    if(rs&&ps)result.push({stage:`${round==='first'?'first':'later'}_${position==='first'?'start':'following'}` as ReactionStageKey,scope:{rounds:rs,positions:ps}});
  }
  return result;
}
function intersection(area:StageConditionScope,stage:ReactionStageKey){
  return partition(area).find(part=>part.stage===stage)?.scope;
}
function covers(part:StageConditionScope,whole:StageConditionScope){
  return size(part.rounds)===size(whole.rounds)&&size(part.positions)===size(whole.positions);
}
function possiblyIntersects(area:StageConditionScope,stage:ReactionStageKey){
  const round=stage.startsWith('first_')?'first':'following',position=stage.endsWith('_start')?'first':'following';
  return (!completeScope(area.rounds)||!!splitScope(area.rounds)[round])
    &&(!completeScope(area.positions)||!!splitScope(area.positions)[position]);
}
const incompleteRangeMessage=()=>t('请先补全此条件已有的轮次与位置范围，再修改整类反应位置。','Complete the existing round and position ranges for this condition before editing an entire reaction stage.');

function simplified(profile:ParameterProfile,stage:ReactionStageKey):SimpleStageProfile|null{
  if(profile.mode==='linear'||profile.mode==='list')return null;
  if(profile.mode!=='relative')return profile;
  const initializes=profile.along==='path'?stage.endsWith('_start'):stage.startsWith('first_');
  if(!initializes)return profile;
  // Relative profiles initialize from the GLOBAL other coordinate. A varying
  // initialization is an absolute sequence, not a previous-result recurrence.
  if(stage==='first_start'||profile.other_step===0)return {mode:'fixed',value:profile.start};
  return null;
}

/** Read a symbolic projection; never infer a constant rule from a small current grid. */
export function stageCondition(config:Config,stage:ReactionStageKey,kind:ConditionTarget['kind']):StageCondition{
  const scope=stageConditionScope(stage),schedule=migrateSchedule(config),target={kind} as ConditionTarget;
  const result:StageCondition={scope,profile:null,rawProfile:null,actualValue:null,complex:true,active:false,settingIds:[]};
  if(!schedule){result.issue=t('这份模拟需要保留原逐步路线。','This simulation needs its original step-by-step path.');return result;}
  result.active=Number.isInteger(schedule.positions)&&Number.isInteger(schedule.rounds)&&scope.positions.start<=schedule.positions&&scope.rounds.start<=schedule.rounds;
  const general=schedule.parameters.filter(s=>matching(s,target)).map(setting=>({setting,overrideId:undefined as string|undefined}));
  const incomplete=schedule.overrides.filter(o=>!completeArea(o)&&possiblyIntersects(o,stage)&&o.parameters.some(s=>matching(s,target)));
  const locals=schedule.overrides.flatMap(override=>{
    const part=intersection(override,stage);
    return part?override.parameters.filter(s=>matching(s,target)).map(setting=>({setting,overrideId:override.id,whole:covers(part,scope)})):[];
  });
  // Multiple partial definitions remain an advanced edit even if today's
  // values happen to coincide. Future extents and user intent must survive.
  const sources=locals.length===1&&locals[0].whole?locals:locals.length?[...general,...locals]:general;
  result.settingIds=[...sources.map(source=>source.setting.id),...incomplete.flatMap(o=>o.parameters.filter(s=>matching(s,target)).map(s=>s.id))];
  // A partial local rule also has an implicit base outside its range. It is
  // not a whole-stage rule merely because the general setting is unfinished.
  const partialWithFallback=general.length===0&&locals.length>0&&!(locals.length===1&&locals[0].whole);
  if(sources.length===1&&!partialWithFallback&&!incomplete.length){
    const {setting,overrideId}=sources[0];
    result.rawProfile=setting.value;
    result.settingId=setting.id;
    result.overrideId=overrideId;
    const profile=simplified(setting.value,stage);
    if(profile){result.profile=profile;result.complex=false;}
  }
  if(!sources.length&&!incomplete.length){
    result.profile=kind==='pressure'&&config.points[0]?.pressure_mode==='water_saturation'?{mode:'water_saturation'}:
      {mode:'fixed',value:kind==='temperature'?(config.points[0]?.temperature_c??250):(config.points[0]?.pressure_bar??700)};
    result.complex=false;
  }
  if(incomplete.length)result.issue=incompleteRangeMessage();
  if(result.active){
    try{
      const point=compileSchedule(config,schedule).point(scope.positions.start-1,scope.rounds.start-1);
      result.actualValue=kind==='temperature'?point.temperature_c:point.pressure_bar;
    }catch(error){result.issue=error instanceof Error?error.message:t('请补全反应条件。','Complete the reaction conditions.');}
  }
  return result;
}

function shifted(profile:ParameterProfile,from:StageConditionScope,to:StageConditionScope):ParameterProfile{
  const path=(to.positions.start-from.positions.start)/(from.positions.step??1),round=(to.rounds.start-from.rounds.start)/(from.rounds.step??1);
  if(profile.mode==='linear')return {...profile,start:decimalSum([profile.start,1],[profile.path_step,path],[profile.round_step,round])};
  if(profile.mode==='list')return {...profile,values:profile.values.slice(profile.along==='path'?path:round)};
  // Relative references are global neighbours, so their seed is NOT shifted.
  return profile;
}

/** Replace just this stage's T or P; all other targets retain their original objects and identities. */
export function setStageCondition(schedule:Schedule,stage:ReactionStageKey,target:ConditionTarget,profile:ParameterProfile):Schedule{
  if(schedule.overrides.some(o=>o.parameters.some(s=>matching(s,target))&&!completeArea(o)&&possiblyIntersects(o,stage)))throw new Error(incompleteRangeMessage());
  const scope=stageConditionScope(stage);
  const exact=schedule.overrides.find(o=>sameArea(o,scope)&&o.parameters.some(s=>matching(s,target)));
  const used=new Set([...schedule.parameters.map(s=>s.id),...schedule.overrides.flatMap(o=>[o.id,...o.parameters.map(s=>s.id)])]);
  const id=()=>{let next=newId();while(used.has(next))next=newId();used.add(next);return next;};
  const overrides:ScheduleOverride[]=[];
  for(const original of schedule.overrides){
    const selected=original.parameters.filter(s=>matching(s,target));
    if(!selected.length||!intersection(original,stage)){overrides.push(original);continue;}
    if(original===exact){
      overrides.push({...original,parameters:original.parameters.map(s=>matching(s,target)?{...s,value:structuredClone(profile)}:s)});
      continue;
    }
    const untouched=original.parameters.filter(s=>!matching(s,target));
    if(untouched.length)overrides.push({...original,parameters:untouched});
    let first=true;
    for(const part of partition(original)){
      if(part.stage===stage)continue;
      overrides.push({...original,...part.scope,id:first&&!untouched.length?original.id:id(),parameters:selected.map(s=>({
        ...s,id:first?s.id:id(),value:shifted(s.value,original,part.scope),
      }))});
      first=false;
    }
  }
  if(!exact)overrides.push({id:id(),...scope,parameters:[{id:id(),target:{...target},value:structuredClone(profile)}]});
  return {...schedule,overrides};
}
