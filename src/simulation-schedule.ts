import {t} from './i18n';
import {evaluateExpression,parseExpression} from './reaction-expression';
import {atScheduleInput,ScheduleInputError,type ScheduleDiagnostic} from './schedule-diagnostics';
import {constraintActiveAt,constraintDefinitionsIssue} from './equilibrium-constraints';
import type {Config,Point} from './simulation-types';
import {activeRouteEntries,stageAt,reactionSourceIssue} from './reaction-stages';
import {pointConditions,saturationPressure} from './process-layout';
import {loopValues,routeId,routeTargetBindings,targetDescription,targetKey,type LoopTarget} from './simulation-loops';

export type IndexScope={start:number;end?:number;step?:number};
export type ParameterProfile=
 | {mode:'fixed';value:number}
 | {mode:'linear';start:number;path_step:number;round_step:number}
 | {mode:'list';along:'path'|'round';values:number[]}
 | {mode:'relative';along:'path'|'round';start:number;step:number;other_step:number}
 | {mode:'expression';expression:string}
 | {mode:'water_saturation'};
export type ParameterSetting={id:string;target:LoopTarget;value:ParameterProfile};
export type ScheduleOverride={id:string;name?:string;rounds:IndexScope;positions:IndexScope;parameters:ParameterSetting[]};
export type StopRules={first?:string;later?:string;rounds?:string};
export type Schedule={stop?:StopRules;version:1;positions:number;rounds:number;parameters:ParameterSetting[];overrides:ScheduleOverride[]};
export type CompiledSchedule={lengths:number[];active:(inner:number,outer:number)=>boolean;runIndex:(inner:number,outer:number)=>number;counts:{inner:number;outer:number;total:number};point:(innerIndex:number,outerIndex:number)=>Point;valueAt:(target:LoopTarget,innerIndex:number,outerIndex:number,fallback?:number)=>number;hasSetting:(target:LoopTarget,innerIndex?:number,outerIndex?:number)=>boolean};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const num=(v:unknown):v is number=>typeof v==='number';
const numberText=(v:number)=>Number.isFinite(v)?Number(v.toPrecision(7)).toString():'—';
const fixed=(value:number):ParameterProfile=>({mode:'fixed',value});
function check(ok:unknown,message:string|(()=>string)):asserts ok{if(!ok)throw new Error(typeof message==='function'?message():message);}
// Decimal user inputs should not become a tiny negative amount at a nominal zero.
// Evaluate sums of products in base 10, then round once to the engine's float value.
export function decimalSum(...terms:[number,number][]):number{
 if(terms.some(([v,f])=>!Number.isFinite(v)||!Number.isInteger(f)))return NaN;
 const parts=terms.map(([v,f])=>{const [mantissa,exponent='0']=v.toString().split('e'),digits=mantissa.replace('.',''),places=mantissa.includes('.')?mantissa.length-mantissa.indexOf('.')-1:0;return {n:BigInt(digits)*BigInt(f),exponent:Number(exponent)-places};});
 const exponent=Math.min(...parts.map(p=>p.exponent));
 const sum=parts.reduce((sum,p)=>sum+p.n*10n**BigInt(p.exponent-exponent),0n);return Number(`${sum}e${exponent}`);
}
export function defaultSchedule(point?:Partial<Point>):Schedule{return {version:1,positions:1,rounds:1,parameters:[{id:'temperature',target:{kind:'temperature'},value:fixed(point?.temperature_c??250)},{id:'pressure',target:{kind:'pressure'},value:point?.pressure_mode==='water_saturation'?{mode:'water_saturation'}:fixed(point?.pressure_bar??700)}],overrides:[]};}
export function scheduleCounts(schedule:Schedule){const inner=schedule.positions,outer=schedule.rounds;return {inner,outer,total:inner*outer};}
export function scheduleScopeIndices(scope:IndexScope,count:number):number[]{
 check(object(scope)&&Number.isInteger(scope.start)&&scope.start>=1&&scope.start<=10000,()=>t('起始轮次或位置须为 1–10,000 的整数。',"The first round or position must be an integer from 1 to 10,000."));
 check(scope.end===undefined||Number.isInteger(scope.end)&&scope.end>=scope.start&&scope.end<=10000,()=>t('结束轮次或位置须不小于起点，且不超过 10,000。',"The last round or position must be at least the first, and no greater than 10,000."));
 check(scope.step===undefined||Number.isInteger(scope.step)&&scope.step>=1&&scope.step<=10000,()=>t('选择间隔须为 1–10,000 的整数。',"Select every 1 to 10,000 positions or rounds, using a whole number."));
 const end=Math.min(scope.end??count,count);return end<scope.start?[]:Array.from({length:Math.floor((end-scope.start)/(scope.step??1))+1},(_,i)=>scope.start+i*(scope.step??1));
}
function targetShape(t:any):t is LoopTarget{
 if(!object(t))return false;
 if(['temperature','pressure'].includes(t.kind))return Object.keys(t).length===1;
 if(t.kind==='equilibrium_constraint')return typeof t.constraint_id==='string'&&!!t.constraint_id;
 if(t.kind==='material_amount')return typeof t.material_id==='string'&&!!t.material_id&&typeof t.species==='string'&&!!t.species;
 if(t.kind==='route_fraction'){const binding=(b:any)=>object(b)&&typeof b.route_id==='string'&&!!b.route_id&&['fraction','fallback_fraction'].includes(b.field);return binding(t)&&(t.bindings===undefined||Array.isArray(t.bindings)&&t.bindings.length>0&&t.bindings.length<=120&&t.bindings.every(binding));}
 return false;
}
function profileShape(p:any):p is ParameterProfile{
 if(!object(p))return false;
 if(p.mode==='expression')return typeof p.expression==='string'&&p.expression.length<=2000;
 if(p.mode==='fixed')return num(p.value);
 if(p.mode==='linear')return [p.start,p.path_step,p.round_step].every(num);
 if(p.mode==='list')return ['path','round'].includes(p.along)&&Array.isArray(p.values)&&p.values.length<=10000&&p.values.every(num);
 if(p.mode==='relative')return ['path','round'].includes(p.along)&&[p.start,p.step,p.other_step].every(num);
 return p.mode==='water_saturation';
}
export function validateScheduleShape(value:any):value is Schedule{
 const setting=(p:any)=>object(p)&&typeof p.id==='string'&&!!p.id&&targetShape(p.target)&&profileShape(p.value);
 const scope=(s:any)=>object(s)&&num(s.start)&&(s.end===undefined||num(s.end))&&(s.step===undefined||num(s.step));
 return object(value)&&(value.stop===undefined||object(value.stop)&&Object.entries(value.stop).every(([k,v])=>['first','later','rounds'].includes(k)&&typeof v==='string'&&v.length<=2000))&&value.version===1&&num(value.positions)&&num(value.rounds)&&Array.isArray(value.parameters)&&value.parameters.length<=1000&&value.parameters.every(setting)&&Array.isArray(value.overrides)&&value.overrides.length<=10000&&value.overrides.every((o:any)=>object(o)&&typeof o.id==='string'&&!!o.id&&(o.name===undefined||typeof o.name==='string')&&scope(o.rounds)&&scope(o.positions)&&Array.isArray(o.parameters)&&o.parameters.length<=1000&&o.parameters.every(setting));
}
function atomicTargets(target:LoopTarget):LoopTarget[]{return target.kind==='route_fraction'?routeTargetBindings(target).map(b=>({kind:'route_fraction',...b})):[target];}
function targetBase(target:LoopTarget,config:Config):number{
 if(target.kind==='temperature')return config.points[0]?.temperature_c??250;
 if(target.kind==='pressure')return config.points[0]?.pressure_bar??700;
 return targetDescription(target,config).value;
}
function profileSeed(value:ParameterProfile,fallback:number){return value.mode==='fixed'?value.value:value.mode==='linear'||value.mode==='relative'?value.start:value.mode==='list'?value.values[0]??fallback:fallback;}
export function scheduleTargets(config:Config){
 const targets:{target:LoopTarget;group:string}[]=[{target:{kind:'temperature'},group:t('反应条件',"Reaction conditions")},{target:{kind:'pressure'},group:t('反应条件',"Reaction conditions")},...(config.equilibrium_constraints||[]).map(c=>({target:{kind:'equilibrium_constraint' as const,constraint_id:c.id},group:t('平衡目标','Equilibrium targets')})),...config.materials.flatMap(m=>m.inputs.map(r=>({target:{kind:'material_amount' as const,material_id:m.id,species:r.species},group:t('Composition 每份含量',"Composition content per portion")}))),...activeRouteEntries(config).flatMap(({route,index})=>[{target:{kind:'route_fraction' as const,route_id:routeId(route,index),field:'fraction' as const},group:route.source==='material'?t('Composition 加入份数',"Composition portions added"):t('反应后物料取用比例',"Fraction of reacted material transferred")},...(!config.reaction_stages&&route.source!=='material'&&route.fallback==='material'?[{target:{kind:'route_fraction' as const,route_id:routeId(route,index),field:'fallback_fraction' as const},group:t('首次 composition 份数',"Initial composition portions")}]:[])])];
 return targets.filter((x,i,a)=>a.findIndex(t=>targetKey(t.target)===targetKey(x.target))===i).map(({target,group})=>{const d=targetDescription(target,config),s=config.schedule?.parameters.find(s=>targetKey(s.target)===targetKey(target));return {target,group,...d,value:s?profileSeed(s.value,d.value):d.value};});
}
export function scheduleChanged(config:Config,target:LoopTarget){const schedule=config.schedule;if(!schedule)return false;const keys=new Set(atomicTargets(target).map(targetKey));return [...schedule.parameters,...schedule.overrides.flatMap(o=>o.parameters)].some(p=>atomicTargets(p.target).some(t=>keys.has(targetKey(t))));}

/** Preserve old meanings at the boundary; the new editor never writes one-variable loops. */
export function migrateSchedule(config:Config):Schedule|null{
 if(config.schedule)return config.schedule;
 const old=config.loops;
 if(old){
  try{
   const path=loopValues(old.inner),rounds=loopValues(old.outer),schedule=defaultSchedule(old.base);schedule.positions=path.length;schedule.rounds=rounds.length;
   const numericPressure:ParameterSetting={id:'pressure',target:{kind:'pressure'},value:fixed(old.base.pressure_bar)};
   for(const name of ['outer','inner'] as const){const axis=old[name];if(axis.mode==='repeat')continue;const values=name==='inner'?path:rounds,setting:ParameterSetting={id:`legacy-${name}`,target:structuredClone(axis.target),value:{mode:'list',along:name==='inner'?'path':'round',values:[...values]}};
    if(axis.target.kind==='pressure'){numericPressure.value=setting.value;if(old.base.pressure_mode==='water_saturation')continue;}
    schedule.parameters=schedule.parameters.filter(p=>targetKey(p.target)!==targetKey(setting.target));schedule.parameters.push(setting);
   }
   for(const row of old.round_conditions||[]){let value:ParameterProfile;
    if(row.pressure_mode==='water_saturation')value={mode:'water_saturation'};
    else if(row.pressure_bar!==undefined)value=fixed(row.pressure_bar);
    else if(numericPressure.value.mode==='list'&&numericPressure.value.along==='round')value=fixed(numericPressure.value.values[row.round-1]??NaN);
    else value=structuredClone(numericPressure.value);
    schedule.overrides.push({id:`legacy-round-${row.round}`,rounds:{start:row.round,end:row.round},positions:{start:1},parameters:[{id:`legacy-round-${row.round}-pressure`,target:{kind:'pressure'},value}]});
   }
   return schedule;
  }catch{return null;}
 }
 if(!config.points.length||(!config.reaction_stages&&config.points.some(p=>p.routes!==undefined))||activeRouteEntries(config).some(({route})=>route.source==='output'))return null;
 const schedule=defaultSchedule(config.points[0]);schedule.positions=config.points.length;schedule.rounds=config.cycles;
 const baseline=(values:number[],increments:number[]):ParameterProfile|null=>{
  if(values.every(v=>v===values[0])&&increments.every(v=>v===increments[0]))return increments[0]===0?fixed(values[0]):{mode:'linear',start:values[0],path_step:0,round_step:increments[0]};
  if(increments.every(v=>v===0))return {mode:'list',along:'path',values};return null;
 };
 const temperature=baseline(config.points.map(p=>p.temperature_c),config.points.map(p=>p.temperature_increment_c??0));
 const modes=config.points.map(p=>p.pressure_mode??'fixed'),pressure=modes.every(m=>m===modes[0])?(modes[0]==='water_saturation'?{mode:'water_saturation'} as ParameterProfile:baseline(config.points.map(p=>p.pressure_bar),config.points.map(p=>p.pressure_increment_bar??0))):null;
 if(temperature&&pressure&&config.points.every(p=>!p.round_conditions?.length)){schedule.parameters=[{id:'temperature',target:{kind:'temperature'},value:temperature},{id:'pressure',target:{kind:'pressure'},value:pressure}];return schedule;}
 config.points.forEach((point,ii)=>{
  const conditions=[...(point.round_conditions??[])].sort((a,b)=>a.round-b.round);
  const segment=(start:number,end?:number,condition?:NonNullable<Point['round_conditions']>[number])=>{
   if(start>10000||end!==undefined&&start>end)return;
   const id=`legacy-position-${ii+1}-round-${start}`;
   const t:ParameterProfile=condition?fixed(condition.temperature_c):{mode:'linear',start:decimalSum([point.temperature_c,1],[point.temperature_increment_c??0,start-1]),path_step:0,round_step:point.temperature_increment_c??0};
   const mode=condition?(condition.pressure_mode??'fixed'):(point.pressure_mode??'fixed');
   const p:ParameterProfile=mode==='water_saturation'?{mode:'water_saturation'}:condition?fixed(condition.pressure_bar):{mode:'linear',start:decimalSum([point.pressure_bar,1],[point.pressure_increment_bar??0,start-1]),path_step:0,round_step:point.pressure_increment_bar??0};
   schedule.overrides.push({id,rounds:{start,...(end===undefined?{}:{end})},positions:{start:ii+1,end:ii+1},parameters:[{id:id+'-temperature',target:{kind:'temperature'},value:t},{id:id+'-pressure',target:{kind:'pressure'},value:p}]});
  };
  let previous=1;for(const row of conditions){segment(previous,row.round-1);segment(row.round,row.round,row);previous=row.round+1;}segment(previous);
 });
 return schedule;
}

type ScopedSetting={setting:ParameterSetting;path:number[];rounds:number[];pathOrdinal:Map<number,number>;roundOrdinal:Map<number,number>;scopeName:string;overrideId?:string};
const caches=new WeakMap<Config,WeakMap<Schedule,CompiledSchedule>>();
export function compileSchedule(config:Config,schedule=config.schedule):CompiledSchedule{
 check(schedule&&validateScheduleShape(schedule),()=>t('反应条件设置不完整，请补全当前编辑。',"Complete the reaction conditions before continuing."));
 const existing=caches.get(config)?.get(schedule);if(existing)return existing;
 const counts=scheduleCounts(schedule);check([counts.inner,counts.outer].every(n=>Number.isInteger(n)&&n>=1&&n<=10000),()=>t('路径位置数和反应轮数须为 1–10,000 的整数。',"Enter a whole number from 1 to 10,000 for path positions and reaction rounds."));check(!!schedule.stop||counts.total<=20000,()=>t('本次计算超过 20,000 个平衡点，请减少位置数或轮数。',"This simulation exceeds 20,000 equilibrium points. Reduce the number of positions or rounds."));
 const constraintIssue=constraintDefinitionsIssue(config);check(!constraintIssue,()=>constraintIssue!);
 const stopValue=(expression:string,variable:(name:string)=>number)=>{
  const parsed=parseExpression(expression);check('operator'in parsed.node&&['<','>','<=','>=','=','==','!=','<>'].includes(parsed.node.operator),()=>t('结束条件需要比较，例如 i = 3 或 P < 150。','Use a comparison to end the calculation, for example i = 3 or P < 150.'));
  return evaluateExpression(parsed,variable)!==0;
 };
 const completionRule=schedule.stop?.rounds;
 if(completionRule!==undefined)atScheduleInput({kind:'stop',rule:'rounds'},()=>{let n=0;for(;n<10000;n++)if(stopValue(completionRule,name=>{check(name==='N',()=>t('总轮数的结束条件只使用 N。','The simulation completion condition can only use N.'));return n;}))break;check(n<10000,()=>t('结束条件在 10,000 轮内未达到。','The completion condition is not reached within 10,000 rounds.'));counts.outer=n+1;});
 const hasPathStop=schedule.stop?.first!==undefined||schedule.stop?.later!==undefined;
 if(hasPathStop)counts.inner=10000;
 const lengths:number[]=[];
 const allPath=Array.from({length:counts.inner},(_,i)=>i+1),allRounds=Array.from({length:counts.outer},(_,i)=>i+1);
 const general=new Map<string,ScopedSetting>(),local=new Map<string,ScopedSetting[]>(),targets=new Map<string,LoopTarget>(),ids=new Set<string>();
 const add=(setting:ParameterSetting,path:number[],rounds:number[],scopeName:string,isGeneral:boolean,overrideId?:string)=>atScheduleInput({kind:'parameter',target:setting.target,settingId:setting.id,overrideId,inner:(path[0]??1)-1,outer:(rounds[0]??1)-1},()=>{
  check(!ids.has(setting.id),()=>t(`参数设置编号重复：${setting.id}。`,`Duplicate parameter setting ID: ${setting.id}.`));ids.add(setting.id);
  const scoped={setting,path,rounds,pathOrdinal:new Map(path.map((v,i)=>[v,i])),roundOrdinal:new Map(rounds.map((v,i)=>[v,i])),scopeName,overrideId};
  const atoms=atomicTargets(setting.target),keys=atoms.map(targetKey);check(new Set(keys).size===keys.length,()=>t('同一参数设置重复引用了物料来源。',"This parameter setting refers to the same material source more than once."));
  if(setting.target.kind==='route_fraction'){const first=routeTargetBindings(setting.target)[0];check(first?.route_id===setting.target.route_id&&first?.field===setting.target.field,()=>t('物料用量设置的主来源与引用不一致。',"The main source of the material amount setting does not match its references."));}
  for(const target of atoms){const key=targetKey(target);targets.set(key,target);
   if(path.length&&rounds.length){const available=target.kind==='temperature'||target.kind==='pressure'||targetDescription(target,config).available;check(available,()=>t(`${scopeName}中的参数已移除，请重新选择或删除该项。`,`A parameter in ${scopeName} has been removed. Choose another parameter or remove the setting.`));}
   if(isGeneral){check(!general.has(key),()=>t('通常设置中同一个参数出现了多次，请保留一项。',"A parameter appears more than once in the general settings. Keep one setting."));general.set(key,scoped);}
   else {const rows=local.get(key)||[];check(!rows.some(other=>path.some(v=>other.pathOrdinal.has(v))&&rounds.some(v=>other.roundOrdinal.has(v))),()=>t(`${scopeName}与另一处单独设置重复修改同一个参数，请调整范围。`,`${scopeName} overlaps another setting for the same parameter. Adjust the affected positions or rounds.`));rows.push(scoped);local.set(key,rows);}
  }
 });
 schedule.parameters.forEach(p=>add(p,allPath,allRounds,t('通常设置',"General settings"),true));
 check(general.has('temperature')&&general.has('pressure'),()=>t('通常设置中需要温度和压力。',"Temperature and pressure are required in the general settings."));
 const scopedIndices=(o:ScheduleOverride,axis:'positions'|'rounds',count:number)=>{const scope=o[axis],field=!Number.isInteger(scope.start)||scope.start<1||scope.start>10000?'start':scope.end!==undefined&&(!Number.isInteger(scope.end)||scope.end<scope.start||scope.end>10000)?'end':'step';return atScheduleInput({kind:'scope',overrideId:o.id,axis,field},()=>scheduleScopeIndices(scope,count));};
 const groupIds=new Set<string>();for(const [index,o] of schedule.overrides.entries()){check(!groupIds.has(o.id),()=>t('单独设置的编号重复。',"Duplicate individual setting ID."));groupIds.add(o.id);const path=scopedIndices(o,'positions',counts.inner),rounds=scopedIndices(o,'rounds',counts.outer);o.parameters.forEach(p=>add(p,path,rounds,o.name||t(`第 ${index+1} 处单独设置`,`Individual setting ${index+1}`),false,o.id));}
 const at=(key:string,ii:number,oi:number)=>local.get(key)?.find(s=>s.pathOrdinal.has(ii+1)&&s.roundOrdinal.has(oi+1))||general.get(key);
 const tables=new Map<string,Float64Array>(),pressureModes=new Set<string>();
 const scalars=new Map<string,number>(),evaluating=new Set<string>();
 const scalar=(target:LoopTarget,ii:number,oi:number):number=>{
  check(ii>=0&&oi>=0&&(lengths[oi]===undefined||ii<lengths[oi]),()=>t('所引用的轮次在此位置之前已结束，该位置不存在。请为新增位置填写条件或用量。','The referenced round ended before this position. Specify conditions or amounts for the new position.'));
  const key=targetKey(target),cacheKey=`${key}@${oi}:${ii}`;
  if(scalars.has(cacheKey))return scalars.get(cacheKey)!;
  check(!evaluating.has(cacheKey),()=>t('公式相互引用，无法确定计算顺序。','Expressions refer to each other in a cycle.'));
  evaluating.add(cacheKey);
  const selected=at(key,ii,oi);
  try{
   const profile=selected?.setting.value;let value=targetBase(target,config);
   if(profile){const pi=selected!.pathOrdinal.get(ii+1)!,ri=selected!.roundOrdinal.get(oi+1)!;
    if(profile.mode==='fixed')value=profile.value;
    if(profile.mode==='linear')value=decimalSum([profile.start,1],[profile.path_step,pi],[profile.round_step,ri]);
    if(profile.mode==='list')value=profile.values[profile.along==='path'?pi:ri];
    if(profile.mode==='relative'){const previous=profile.along==='path'?ii>0:oi>0;value=previous?decimalSum([scalar(target,ii-(profile.along==='path'?1:0),oi-(profile.along==='round'?1:0)),1],[profile.step,1]):decimalSum([profile.start,1],[profile.other_step,profile.along==='path'?oi:ii]);}
    if(profile.mode==='water_saturation'){check(target.kind==='pressure',()=>t('饱和蒸汽压只能用于压力。','Saturation pressure can only be used for pressure.'));value=saturationPressure(scalar({kind:'temperature'},ii,oi));pressureModes.add(`${oi}:${ii}`);}
    if(profile.mode==='expression'&&!(target.kind==='route_fraction'&&activeRouteEntries(config).some(e=>e.route.id===target.route_id&&e.stage&&e.stage!==stageAt(ii,oi)))){
     const previous=(kind:'temperature'|'pressure',above=false)=>{const x=above?ii:ii>0?ii-1:ii,y=above?oi-1:ii>0?oi:oi-1;check(y>=0,()=>t('第一步没有前次温压，请填写初始数值。','The first step has no previous conditions. Enter an initial value.'));check(lengths[y]===undefined||x<lengths[y],()=>t('上一轮在此位置之前已结束，无法引用这里的温压。','The previous round ended before this position; its conditions are unavailable.'));return scalar({kind},x,y);};
     value=evaluateExpression(parseExpression(profile.expression),name=>{
      if(name==='i')return ii;if(name==='N')return oi;
      if(name==='T')return target.kind==='temperature'?previous('temperature'):scalar({kind:'temperature'},ii,oi);
      if(name==='P')return target.kind==='temperature'||target.kind==='pressure'?previous('pressure'):scalar({kind:'pressure'},ii,oi);
      if(name==='Tr')return previous('temperature',true);if(name==='Pr')return previous('pressure',true);
      if(name==='Xr'){check(oi>0,()=>t('首轮没有上一轮用量。','The first round has no previous-round amount.'));return scalar(target,ii,oi-1);}
      if(name==='X'){check(ii>0||oi>0,()=>t('第一步没有前次用量，请填写初始数值。','The first step has no previous amount. Enter an initial value.'));return scalar(target,ii>0?ii-1:ii,ii>0?oi:oi-1);}
      throw new Error(t(`未知变量 ${name}。`,`Unknown variable: ${name}.`));
     },temperature=>{check(temperature>=0.01&&temperature<373.946,()=>t('Psat(T) 需要 0.01 ≤ T < 373.946 °C。','Psat(T) requires 0.01 ≤ T < 373.946 °C.'));return saturationPressure(temperature);});
     if(target.kind==='pressure'&&/^\s*Psat\(\s*T\s*\)\s*$/.test(profile.expression))pressureModes.add(`${oi}:${ii}`);
    }
   }
   scalars.set(cacheKey,value);return value;
  }catch(error){return atScheduleInput({kind:'parameter',target,settingId:selected?.setting.id,overrideId:selected?.overrideId,inner:ii,outer:oi},()=>{throw error;});}finally{evaluating.delete(cacheKey);}
 };
 if(hasPathStop){
  for(let oi=0;oi<counts.outer;oi++){
   const rule=schedule.stop?.[oi===0?'first':'later'];let length=0;
   for(let ii=0;ii<(rule===undefined?schedule.positions:10000);ii++){
    const temperature=scalar({kind:'temperature'},ii,oi),pressure=scalar({kind:'pressure'},ii,oi);length=ii+1;
    const invalidTarget={kind:(!Number.isFinite(temperature)||temperature<=-273.15?'temperature':'pressure') as 'temperature'|'pressure'},invalidSetting=at(invalidTarget.kind,ii,oi);
    atScheduleInput({kind:'parameter',target:invalidTarget,settingId:invalidSetting?.setting.id,overrideId:invalidSetting?.overrideId,inner:ii,outer:oi},()=>check(Number.isFinite(temperature)&&temperature>-273.15&&Number.isFinite(pressure)&&pressure>0,()=>t(`第 ${oi+1} 轮的位置 ${ii+1} 温压无效；结束条件尚未达到。`,`Invalid conditions at round ${oi+1}, position ${ii+1}, before the end condition is reached.`)));
    if(rule!==undefined&&atScheduleInput({kind:'stop',rule:oi===0?'first':'later'},()=>stopValue(rule,name=>{if(name==='T')return temperature;if(name==='P')return pressure;if(name==='i')return ii;if(name==='N')return oi;throw new Error(t(`结束条件中的变量 ${name} 无效。`,`Invalid variable in the end condition: ${name}.`));})))break;
    atScheduleInput({kind:'stop',rule:oi===0?'first':'later'},()=>check(rule===undefined||ii<9999,()=>t('结束条件在 10,000 步内未达到。','The end condition is not reached within 10,000 steps.')));
   }
   lengths.push(length);check(lengths.reduce((a,b)=>a+b,0)<=20000,()=>t('本次计算超过 20,000 个平衡点。','This simulation exceeds 20,000 equilibrium points.'));
  }
  counts.inner=Math.max(...lengths);
 }else for(let oi=0;oi<counts.outer;oi++)lengths.push(counts.inner);
 counts.total=lengths.reduce((a,b)=>a+b,0);
 check(counts.inner*counts.outer<=20000,()=>t('路径与轮次的网格超过 20,000 个位置，请缩小范围。','The path and round grid exceeds 20,000 positions. Reduce its extent.'));
 const active=(ii:number,oi:number)=>oi>=0&&oi<lengths.length&&ii>=0&&ii<lengths[oi];
 const offsets=lengths.map((_,o)=>lengths.slice(0,o).reduce((a,b)=>a+b,0));
 const table=(target:LoopTarget):Float64Array=>{
  const key=targetKey(target),old=tables.get(key);if(old)return old;
  const values=new Float64Array(counts.inner*counts.outer).fill(NaN);
  // Traverse in reaction order so recurrence depth stays bounded for long paths.
  for(let oi=0;oi<counts.outer;oi++)for(let ii=0;ii<counts.inner;ii++){
   if(!active(ii,oi))continue;
   if(target.kind==='equilibrium_constraint'){const constraint=config.equilibrium_constraints?.find(c=>c.id===target.constraint_id);if(constraint&&!constraintActiveAt(constraint,ii,oi))continue;}
   scalar({kind:'temperature'},ii,oi);scalar({kind:'pressure'},ii,oi);
   values[oi*counts.inner+ii]=scalar(target,ii,oi);
  }
  tables.set(key,values);return values;
 };
 const coordinate=(ii:number,oi:number)=>check(Number.isInteger(ii)&&Number.isInteger(oi)&&ii>=0&&oi>=0&&ii<counts.inner&&oi<counts.outer,()=>t('所选轮次或路径位置超出当前范围。',"The selected round or path position is outside the current range."));
 const compiled:CompiledSchedule={counts,lengths,active,runIndex:(ii,oi)=>offsets[oi]+ii,valueAt:(target,ii,oi,fallback)=>{coordinate(ii,oi);const atom=atomicTargets(target)[0],key=targetKey(atom);return !general.has(key)&&!local.has(key)&&fallback!==undefined?fallback:table(atom)[oi*counts.inner+ii];},point:(ii,oi)=>{coordinate(ii,oi);const temperature_c=table({kind:'temperature'})[oi*counts.inner+ii],pressure_bar=table({kind:'pressure'})[oi*counts.inner+ii];return {id:`loop-${ii+1}`,label:t(`路径位置 ${ii+1}`,`Path position ${ii+1}`),temperature_c,pressure_bar,pressure_mode:pressureModes.has(`${oi}:${ii}`)?'water_saturation':'fixed'};},hasSetting:(target,ii,oi)=>atomicTargets(target).some(t=>{const key=targetKey(t);return ii===undefined||oi===undefined?general.has(key)||(local.get(key)||[]).some(s=>s.path.length&&s.rounds.length):!!at(key,ii,oi);})};
 // Detect input errors in the actual grid. Unused local ranges remain editable drafts.
 for(const c of config.equilibrium_constraints||[])targets.set(targetKey({kind:'equilibrium_constraint',constraint_id:c.id}),{kind:'equilibrium_constraint',constraint_id:c.id});
 for(const [key,target] of targets){const values=table(target),entries=target.kind==='route_fraction'?activeRouteEntries(config).filter(e=>routeId(e.route,e.index)===target.route_id):[];
  for(let oi=0;oi<counts.outer;oi++)for(let ii=0;ii<counts.inner;ii++){
   if(!active(ii,oi))continue;
   if(target.kind==='equilibrium_constraint'){const row=config.equilibrium_constraints?.find(c=>c.id===target.constraint_id);if(!row||!constraintActiveAt(row,ii,oi))continue;}
   else if(!at(key,ii,oi))continue;
   if(target.kind==='route_fraction'&&entries.length&&entries.every(e=>e.stage&&e.stage!==stageAt(ii,oi)))continue;
   const selected=at(key,ii,oi);atScheduleInput({kind:'parameter',target,settingId:selected?.setting.id,overrideId:selected?.overrideId,inner:ii,outer:oi},()=>{
   const value=values[oi*counts.inner+ii],where=()=>t(`第 ${oi+1} 轮 · 位置 ${ii+1}`,`Round ${oi+1} · position ${ii+1}`);check(Number.isFinite(value),()=>t(`${where()}的${targetDescription(target,config).label}缺少有效数值。`,`${where()}: enter a valid value for ${targetDescription(target,config).label}.`));
   if(target.kind==='temperature')check(value>-273.15,()=>t(`${where()}温度须高于绝对零度。`,`${where()}: temperature must be above absolute zero.`));
   else if(target.kind==='pressure'){check(value>0,()=>t(`${where()}压力须大于 0 bar。`,`${where()}: pressure must be greater than 0 bar.`));if(pressureModes.has(`${oi}:${ii}`)){const temperature=table({kind:'temperature'})[oi*counts.inner+ii];check(temperature>=0.01&&temperature<373.946,()=>t(`${where()}纯水饱和蒸汽压需要 0.01–373.946 °C（不含临界温度）。`,`${where()}: pure-water saturation pressure requires 0.01–373.946 °C, excluding the critical temperature.`));}}
   else if(target.kind==='equilibrium_constraint'){const row=config.equilibrium_constraints!.find(c=>c.id===target.constraint_id)!;if(row.kind==='fugacity')check(value>0,()=>t(`${where()}气体逸度须大于 0 bar。`,`${where()}: gas fugacity must be greater than 0 bar.`));}
   else {check(value>=0,()=>t(`${where()}投料量或取用比例不能为负。`,`${where()}: input amounts and transferred fractions cannot be negative.`));if(target.kind==='route_fraction'&&target.field==='fraction'&&entries.some(e=>e.route.source!=='material'))check(value<=1,()=>t(`${where()}取用已有结果的比例不能超过 100%。`,`${where()}: no more than 100% of an existing result can be transferred.`));}
   });
  }
 }
 for(let oi=0;oi<counts.outer;oi++)for(let ii=0;ii<lengths[oi];ii++)for(const e of activeRouteEntries(config)){
  if(e.stage&&e.stage!==stageAt(ii,oi))continue;const r=e.route;
  if((r.when==='first_cycle'&&oi>0)||(r.when==='after_first_cycle'&&oi===0)||r.source==='material')continue;
  const fraction=compiled.valueAt({kind:'route_fraction',route_id:routeId(r,e.index),field:'fraction'},ii,oi,r.fraction);
  if(fraction===0)continue;
  const sourceInner=r.source==='previous_cycle'?ii:r.source==='output'?config.points.findIndex(p=>p.id===r.point_id):-1;
  const sourceOuter=r.source==='previous_cycle'?oi-1:r.source==='output'?oi-(r.lag??0):-1;
  if(sourceInner>=0&&sourceOuter>=0)atScheduleInput({kind:'source',routeId:routeId(r,e.index),inner:ii,outer:oi},()=>check(active(sourceInner,sourceOuter),()=>t(`第 ${oi+1} 轮位置 ${ii+1} 的物料来源在该位置之前已结束。`,`Round ${oi+1}, position ${ii+1}: the source round ended before the selected source position.`)));
 }
 let cache=caches.get(config);if(!cache){cache=new WeakMap();caches.set(config,cache);}cache.set(schedule,compiled);return compiled;
}
export function scheduleDiagnostic(config:Config,schedule=config.schedule):ScheduleDiagnostic|undefined{
 try{const plan=compileSchedule(config,schedule),message=reactionSourceIssue(config,plan.counts);return message?{message}:undefined;}
 catch(e){return {message:e instanceof Error?e.message:t('请补全反应条件。',"Complete the reaction conditions."),...(e instanceof ScheduleInputError?{location:e.location}:{})};}
}
export function scheduleIssue(config:Config,schedule=config.schedule):string|undefined{return scheduleDiagnostic(config,schedule)?.message;}
export function schedulePoints(config:Config,schedule=config.schedule):Point[]{try{const plan=compileSchedule(config,schedule);return Array.from({length:plan.counts.inner},(_,ii)=>{const baseRound=plan.lengths.findIndex(n=>ii<n),point=plan.point(ii,baseRound),round_conditions:NonNullable<Point['round_conditions']>=[];for(let oi=0;oi<plan.counts.outer;oi++){if(!plan.active(ii,oi))continue;const p=plan.point(ii,oi);if(p.temperature_c!==point.temperature_c||p.pressure_bar!==point.pressure_bar||p.pressure_mode!==point.pressure_mode)round_conditions.push({round:oi+1,temperature_c:p.temperature_c,pressure_bar:p.pressure_bar,pressure_mode:p.pressure_mode});}return {...point,...(round_conditions.length?{round_conditions}:{})};});}catch{return [];}}
export function scheduleSettingSummary(setting:ParameterSetting,config:Config,scopeCounts?:{positions:number;rounds:number}):string{const d=targetDescription(setting.target,config),v=setting.value,scale=d.quantityKind==='fraction'?100:1,unit=d.quantityKind==='fraction'?'%':d.unit,f=(n:number)=>`${numberText(n*scale)}${unit?` ${unit}`:''}`;if(v.mode==='expression')return v.expression;if(v.mode==='water_saturation')return t('Psat(T) · 随当前温度计算',"Psat(T) · calculated at the current temperature");if(v.mode==='fixed')return f(v.value);if(v.mode==='list')return t(`${f(v.values[0])} → ${f(v.values.at(-1)!)} · ${v.values.length} 个${v.along==='path'?'位置':'轮次'}值`,`${f(v.values[0])} → ${f(v.values.at(-1)!)} · ${v.values.length} ${v.along==='path'?'positions':'rounds'}`);if(v.mode==='relative')return `${v.along==='path'?t('前一步',"Previous reaction"):t('上一轮同位置',"Same position in the previous round")} ${v.step<0?'−':'+'} ${f(Math.abs(v.step))}`;return `${f(v.start)}${v.path_step&&(scopeCounts===undefined||scopeCounts.positions>1)?t(` · 每步 ${v.path_step>0?'+':''}${f(v.path_step)}`,` · per reaction ${v.path_step>0?'+':''}${f(v.path_step)}`):''}${v.round_step&&(scopeCounts===undefined||scopeCounts.rounds>1)?t(` · 每轮 ${v.round_step>0?'+':''}${f(v.round_step)}`,` · per round ${v.round_step>0?'+':''}${f(v.round_step)}`):''}`;}
