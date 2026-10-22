import {t} from './i18n';
import {compileSchedule,scheduleIssue} from './simulation-schedule';
import type {Config,Point,Route} from './simulation-types';
import {activeRouteEntries,stageInfo} from './reaction-stages';
import {saturationPressure} from './process-layout';

export type RouteBinding={route_id:string;field:'fraction'|'fallback_fraction'};
export type LoopTarget = {kind:'equilibrium_constraint';constraint_id:string} | {kind:'temperature'} | {kind:'pressure'} | {kind:'material_amount';material_id:string;species:string} | ({kind:'route_fraction';bindings?:RouteBinding[]}&RouteBinding);
export type Loop = {mode:'repeat';count:number} | {mode:'range';target:LoopTarget;start:number;end:number;step:number} | {mode:'list';target:LoopTarget;values:number[]};
export type LoopRoundConditions={round:number;pressure_mode:'fixed'|'water_saturation';pressure_bar?:number};
export type LoopDefinition = {round_conditions?:LoopRoundConditions[];base:{temperature_c:number;pressure_bar:number;pressure_mode?:'fixed'|'water_saturation'};inner:Loop;outer:Loop};
export type LoopAxis = 'inner'|'outer';
export function defaultLoops(point?:Partial<Point>):LoopDefinition{return {base:{temperature_c:point?.temperature_c??250,pressure_bar:point?.pressure_bar??700,pressure_mode:point?.pressure_mode||'fixed'},inner:{mode:'repeat',count:1},outer:{mode:'repeat',count:1}};}
export const routeId=(route:Route,index:number)=>route.id||`route-${index+1}`;
export function routeTargetBindings(target:Extract<LoopTarget,{kind:'route_fraction'}>):RouteBinding[]{return target.bindings===undefined?[{route_id:target.route_id,field:target.field}]:Array.isArray(target.bindings)?target.bindings:[];}
const bindingKey=(binding:RouteBinding)=>JSON.stringify(['route_fraction',binding?.route_id,binding?.field]);
export function targetKey(target:LoopTarget):string{
  if(target.kind==='equilibrium_constraint')return JSON.stringify([target.kind,target.constraint_id]);
  if(target.kind==='material_amount')return JSON.stringify([target.kind,target.material_id,target.species]);
  if(target.kind!=='route_fraction')return target.kind;
  const keys=routeTargetBindings(target).map(bindingKey).sort();return keys.length===1?keys[0]:JSON.stringify([target.kind,keys]);
}
export function targetsOverlap(a:LoopTarget,b:LoopTarget):boolean{
  if(a.kind==='route_fraction'&&b.kind==='route_fraction'){const keys=new Set(routeTargetBindings(a).map(bindingKey));return routeTargetBindings(b).some(binding=>keys.has(bindingKey(binding)));}
  return targetKey(a)===targetKey(b);
}
function bindingRoutes(target:Extract<LoopTarget,{kind:'route_fraction'}>,config:Config){
  const entries=activeRouteEntries(config);
  return routeTargetBindings(target).map(binding=>({binding,matches:entries.filter(({route,index})=>routeId(route,index)===binding?.route_id)}));
}
export function loopValues(loop:Loop):number[]{
  if(loop.mode==='repeat'){
    if(!Number.isInteger(loop.count)||loop.count<1||loop.count>10000)throw new Error(t('重复次数须为 1–10,000 的整数。',"Enter a whole number of repetitions from 1 to 10,000."));
    return Array.from({length:loop.count},(_,i)=>i+1);
  }
  if(loop.mode==='list'){
    if(!loop.values.length||loop.values.length>10000||loop.values.some(v=>!Number.isFinite(v)))throw new Error(t('请填写 1–10,000 个有效数值。',"Enter between 1 and 10,000 valid values."));
    return [...loop.values];
  }
  const {start,end,step}=loop;
  if(![start,end,step].every(Number.isFinite)||step===0||(end-start)*step<0)throw new Error(t('步长不能为 0，正负方向须能从起点走向终点。',"The increment must be nonzero and move toward the ending value."));
  const ratio=(end-start)/step;
  if(!Number.isFinite(ratio)||ratio>10000)throw new Error(t('路径位置数或总轮数最多 10,000 次。',"A path or series of rounds can contain at most 10,000 reactions."));
  const count=Math.floor(ratio+1e-10)+1;
  if(count>10000)throw new Error(t('路径位置数或总轮数最多 10,000 次。',"A path or series of rounds can contain at most 10,000 reactions."));
  return Array.from({length:count},(_,i)=>{const value=start+i*step;return i>0&&Math.abs(value-end)<=Math.abs(step)*1e-10?end:i===0?start:Number(value.toPrecision(14));});
}
export function loopRoundConditions(definition:LoopDefinition,outerCount:number):Map<number,LoopRoundConditions>{
 const rows=definition.round_conditions;if(rows===undefined)return new Map();
 if(!Array.isArray(rows)||rows.length>10000)throw new Error(t('各轮压力设置须为列表，最多 10,000 轮。',"Round pressure settings must be a list of at most 10,000 rounds."));
 const result=new Map<number,LoopRoundConditions>();
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['round','pressure_mode','pressure_bar'].includes(k)))throw new Error(t('各轮压力需包含轮次和压力方式，可另填压力值。',"Each pressure setting needs a round number and pressure mode, with an optional pressure value."));
  if(!Number.isInteger(row.round)||row.round<1||row.round>10000)throw new Error(t('指定轮次须为 1–10,000 之间的整数。',"The round number must be an integer from 1 to 10,000."));
  if(result.has(row.round))throw new Error(t(`第 ${row.round} 轮的压力设置重复，请保留一项。`,`Round ${row.round} has duplicate pressure settings. Keep one setting.`));
  if(!['fixed','water_saturation'].includes(row.pressure_mode))throw new Error(t(`第 ${row.round} 轮请选择指定压力或纯水饱和蒸汽压。`,`Choose a fixed pressure or pure-water saturation pressure for round ${row.round}.`));
  if(row.pressure_bar!==undefined&&(typeof row.pressure_bar!=='number'||row.round<=outerCount&&!Number.isFinite(row.pressure_bar)))throw new Error(t(`第 ${row.round} 轮压力须为有效数值。`,`Enter a valid pressure for round ${row.round}.`));
  result.set(row.round,row);
 }
 return result;
}
function conditionPoint(definition:LoopDefinition,inner:number[],outer:number[],overrides:Map<number,LoopRoundConditions>,ii:number,oi:number):Point{
 if(!Number.isInteger(ii)||!Number.isInteger(oi)||ii<0||oi<0||ii>=inner.length||oi>=outer.length)throw new Error(t('所选路径位置或轮次超出当前范围。',"The selected path position or round is outside the current range."));
 const point:Point={id:`loop-${ii+1}`,label:t(`路径位置 ${ii+1}`,`Path position ${ii+1}`),...definition.base};
 for(const [name,index,values] of [['outer',oi,outer],['inner',ii,inner]] as const){const axis=definition[name];if(axis.mode!=='repeat'&&axis.target.kind==='temperature')point.temperature_c=values[index];if(axis.mode!=='repeat'&&axis.target.kind==='pressure')point.pressure_bar=values[index];}
 const override=overrides.get(oi+1);
 if(override){point.pressure_mode=override.pressure_mode;if(override.pressure_mode==='fixed'&&override.pressure_bar!==undefined)point.pressure_bar=override.pressure_bar;}
 point.pressure_mode=point.pressure_mode||'fixed';
 if(point.pressure_mode==='water_saturation')point.pressure_bar=saturationPressure(point.temperature_c);
 return point;
}
/** Actual conditions after both variables and the selected round's pressure override. Indices are zero based. */
export function loopPoint(definition:LoopDefinition,innerIndex:number,outerIndex=0):Point{
 const inner=loopValues(definition.inner),outer=loopValues(definition.outer);
 return conditionPoint(definition,inner,outer,loopRoundConditions(definition,outer.length),innerIndex,outerIndex);
}

export function loopCounts(config:Config){
  if(config.schedule){try{return compileSchedule(config).counts;}catch{return {inner:config.schedule.positions,outer:config.schedule.rounds,total:config.schedule.positions*config.schedule.rounds};}}
  if(!config.loops)return {inner:config.points.length,outer:config.cycles,total:config.points.length*config.cycles};
  try{const inner=loopValues(config.loops.inner).length,outer=loopValues(config.loops.outer).length;return {inner,outer,total:inner*outer};}
  catch{return {inner:NaN,outer:NaN,total:NaN};}
}
export function targetDescription(target:LoopTarget,config:Config):{label:string;unit:string;quantityKind:'temperature'|'pressure'|'amount'|'portions'|'fraction'|'ph'|'fugacity';value:number;available:boolean}{
  if(target.kind==='equilibrium_constraint'){const row=config.equilibrium_constraints?.find(c=>c.id===target.constraint_id);return {label:row?.kind==='ph'?`pH${row.titrant?' · '+row.titrant:''}`:row?.kind==='fugacity'?t(`${row.species||'未选择气体'} 逸度`,`${row.species||'Select gas'} fugacity`):t('已移除的平衡目标','Removed equilibrium target'),quantityKind:row?.kind==='ph'?'ph':'fugacity',unit:row?.kind==='ph'?'':'bar',value:row?.value??NaN,available:!!row};}
  if(target.kind==='temperature')return {label:t('温度',"Temperature"),quantityKind:'temperature',unit:'°C',value:config.loops?.base.temperature_c??config.points[0]?.temperature_c??25,available:true};
  if(target.kind==='pressure')return {label:t('压力',"Pressure"),quantityKind:'pressure',unit:'bar',value:config.loops?.base.pressure_bar??config.points[0]?.pressure_bar??1,available:true};
  if(target.kind==='material_amount'){
    const material=config.materials.find(m=>m.id===target.material_id),rows=material?.inputs.filter(r=>r.species===target.species)||[],row=rows[0];
    return {label:t(`${material?.name||'已移除的配方'} · ${target.species} 每份含量`,`${material?.name||t('已移除的配方','Removed composition')} · ${target.species} per portion`),quantityKind:'amount',unit:row?.unit||'',value:row?.amount??0,available:rows.length===1};
  }
  const entries=bindingRoutes(target,config),first=entries[0],entry=first?.matches[0],route=entry?.route,field=first?.binding?.field;
  const usesRecipe=field==='fallback_fraction'||route?.source==='material';
  const location=entry?.stage?stageInfo[entry.stage].title:t(`来源 ${entry?entry.index+1:'已移除'}`,`Source ${entry?entry.index+1:t('已移除','removed')}`);
  const recipe=config.materials.find(m=>m.id===route?.material_id)?.name;
  const name=route?.source==='material'&&recipe?` · ${recipe}`:'';
  const available=!!entries.length&&first.binding?.route_id===target.route_id&&field===target.field&&new Set(entries.map(({binding})=>bindingKey(binding))).size===entries.length&&entries.every(({binding,matches})=>!!binding&&typeof binding.route_id==='string'&&['fraction','fallback_fraction'].includes(binding.field)&&matches.length===1&&(!config.reaction_stages||binding.field!=='fallback_fraction')&&(binding.field!=='fallback_fraction'||matches[0].route.source!=='material'&&matches[0].route.fallback==='material'));
  return {label:t(`${location}${name} · ${usesRecipe?'配方份数':'取用比例'}${entries.length>1?`（共 ${entries.length} 处）`:''}`,`${location}${name} · ${usesRecipe?'composition portions':'fraction transferred'}${entries.length>1?` (${entries.length} locations)`:''}`),quantityKind:usesRecipe?'portions':'fraction',unit:usesRecipe?t('份','portions'):t('比例','fraction'),value:route?.[field]??1,available};
}
export function controlledBy(definition:LoopDefinition,target:LoopTarget){return (['inner','outer'] as const).find(axis=>definition[axis].mode!=='repeat'&&targetsOverlap((definition[axis] as Exclude<Loop,{mode:'repeat'}>).target,target));}
export function loopIssue(config:Config,definition=config.loops):string|undefined{
 if(config.schedule)return scheduleIssue(config);
  if(!definition)return undefined;
  try{
    const inner=loopValues(definition.inner),outer=loopValues(definition.outer),overrides=loopRoundConditions(definition,outer.length);
    for(const {route:r,index:i,stage} of activeRouteEntries(config)){
      if(stage&&(stage.endsWith('_following')&&inner.length===1||stage.startsWith('later_')&&outer.length===1))continue;
      const location=stage?t(`${stageInfo[stage].title}的第 ${i+1} 项物料`,`${stageInfo[stage].title} · input ${i+1}`):t(`来源 ${i+1}`,`Source ${i+1}`);
      if(stage&&r.source==='previous_point'&&stage.endsWith('_start'))return t(`${location}没有前一步结果，请改选实际加入的配方或有效来源。`,`${location} has no previous reaction. Choose a composition or an available result.`);
      if(stage&&stage.startsWith('first_')&&(r.source==='previous_cycle'||r.source==='output'&&r.lag===1))return t(`${location}没有上一轮结果，请改选实际加入的配方或有效来源。`,`${location} has no previous round. Choose a composition or an available result.`);
      if(r.source==='output'){
        if(!new RegExp('^loop-([1-9][0-9]*)$').test(r.point_id||''))return t(`${location}的步骤不属于当前反应路径，请重新选择来源步骤。`,`${location} refers to a position outside this reaction path. Choose a source position again.`);
        const source=Number(r.point_id!.slice(5));
        if(source>inner.length)return t(`${location}指向的步骤已超出反应路径范围，请调整来源。`,`${location} refers to a position outside the reaction path. Adjust the source.`);
        if(stage&&r.lag===0&&(stage.endsWith('_start')||source>=2))return t(`${location}引用的本轮结果尚未完成，请选择已完成的位置。`,`${location} refers to a result that has not yet been calculated in this round. Choose an earlier position.`);
      }
    }
    if(inner.length*outer.length>20000)return t('本次计算超过 20,000 个平衡点，请减少位置数或轮数。',"This simulation exceeds 20,000 equilibrium points. Reduce the number of positions or rounds.");
    if(definition.inner.mode!=='repeat'&&definition.outer.mode!=='repeat'&&targetsOverlap(definition.inner.target,definition.outer.target))return t('路径变化和轮次变化不能同时设定同一个量，请调整其中一项。',"The path and round series cannot both control the same parameter. Adjust one of them.");
    for(const axis of ['inner','outer'] as const){
      const loop=definition[axis];if(loop.mode==='repeat')continue;
      if(config.reaction_stages&&loop.target.kind==='route_fraction'&&routeTargetBindings(loop.target).some(b=>b.field==='fallback_fraction'))return t('各处组成已分别设置，请把变化量改为实际加入的配方份数或物料取用比例。',"Compositions are set separately at each stage. Vary the number of composition portions or the fraction of material transferred.");
      const desc=targetDescription(loop.target,config),values=axis==='inner'?inner:outer;
      if(!desc.available)return t(`${axis==='inner'?'反应路径':'反应轮次'}所选的投料或物料来源已移除，或投料行重复，请重新选择。`,`The ${axis==='inner'?'reaction path':'reaction rounds'} refers to a removed input or a duplicate input row. Choose the parameter again.`);
      if(loop.target.kind==='temperature'&&values.some(v=>v<=-273.15))return t('温度须高于绝对零度。',"Temperature must be above absolute zero.");
      if(loop.target.kind==='pressure'&&!outer.some((_,i)=>{const row=overrides.get(i+1);return (row?.pressure_mode||definition.base.pressure_mode||'fixed')==='fixed'&&row?.pressure_bar===undefined;}))return t('各轮均使用饱和蒸汽压或另定压力，当前压力变化没有生效；请调整轮次压力设置或移除压力变化。',"Every round uses saturation pressure or a separate pressure setting, so this pressure series has no effect. Adjust the round settings or remove the series.");
      if(['material_amount','route_fraction'].includes(loop.target.kind)&&values.some(v=>v<0))return t('投料量或比例不能为负数。',"Input amounts and fractions cannot be negative.");
      if(loop.target.kind==='route_fraction'){
        const inherited=bindingRoutes(loop.target,config).some(({binding,matches})=>binding.field==='fraction'&&matches[0]?.route.source!=='material');
        if(inherited&&values.some(v=>v>1))return t('取用已有结果的比例须在 0–1 之间。',"The fraction taken from an existing result must be between 0 and 1.");
      }
    }
    for(let oi=0;oi<outer.length;oi++)for(let ii=0;ii<inner.length;ii++){
      const point=conditionPoint(definition,inner,outer,overrides,ii,oi),location=t(`第 ${oi+1} 轮 · 位置 ${ii+1}`,`Round ${oi+1} · position ${ii+1}`);
      if(!Number.isFinite(point.temperature_c)||point.temperature_c<=-273.15)return t(`${location}温度须高于绝对零度。`,`${location}: temperature must be above absolute zero.`);
      if(point.pressure_mode==='water_saturation'&&(point.temperature_c<0.01||point.temperature_c>=373.946))return t(`${location}饱和蒸汽压温度须在 0.01 °C 至临界温度 373.946 °C 之间。`,`${location}: saturation pressure requires a temperature from 0.01 °C to below the critical temperature of 373.946 °C.`);
      if(!Number.isFinite(point.pressure_bar)||point.pressure_bar<=0)return t(`${location}请填写大于 0 bar 的压力。`,`${location}: enter a pressure greater than 0 bar.`);
    }
  }catch(e){return e instanceof Error?e.message:t('请补全反应路径设置。',"Complete the reaction path settings.");}
}
/** Lossless inference only: explicit per-point routes and round exceptions remain editable in the original form. */
export function inferLoops(config:Config):LoopDefinition|null{
  if(config.loops)return config.loops;
  const points=config.points,first=points[0];if(!first||points.some(p=>(!config.reaction_stages&&p.routes)||p.round_conditions?.length)||activeRouteEntries(config).some(({route})=>route.source==='output'))return null;
  const definition=defaultLoops(first),ts=points.map(p=>p.temperature_c),ps=points.map(p=>p.pressure_bar);
  if(points.some(p=>(p.pressure_mode||'fixed')!==(first.pressure_mode||'fixed')))return null;
  const varyingT=new Set(ts).size>1,varyingP=new Set(ps).size>1;
  if(varyingT&&varyingP)return null;
  const sequence=(target:LoopTarget,values:number[]):Loop=>{
    const step=values.length>1?values[1]-values[0]:0;
    if(step!==0){const candidate:Loop={mode:'range',target,start:values[0],end:values.at(-1)!,step};try{const restored=loopValues(candidate);if(restored.length===values.length&&restored.every((v,i)=>v===values[i]))return candidate;}catch{}}
    return {mode:'list',target,values};
  };
  definition.inner=varyingT?sequence({kind:'temperature'},ts):varyingP?sequence({kind:'pressure'},ps):{mode:'repeat',count:points.length};
  const dt=first.temperature_increment_c||0,dp=first.pressure_increment_bar||0;
  if(points.some(p=>(p.temperature_increment_c||0)!==dt||(p.pressure_increment_bar||0)!==dp)||dt&&dp)return null;
  if((dt&&varyingT)||(dp&&varyingP))return null;
  definition.outer=dt?sequence({kind:'temperature'},Array.from({length:config.cycles},(_,i)=>first.temperature_c+i*dt)):dp?sequence({kind:'pressure'},Array.from({length:config.cycles},(_,i)=>first.pressure_bar+i*dp)):{mode:'repeat',count:config.cycles};
  return definition;
}
export function loopPoints(config:Config):Point[]{
 if(!config.loops)return config.points;
 try{
  const definition=config.loops,inner=loopValues(definition.inner),outer=loopValues(definition.outer);
  if(inner.length*outer.length>20000)return [];
  const overrides=loopRoundConditions(definition,outer.length);
  return inner.map((_,ii)=>{
   const point=conditionPoint(definition,inner,outer,overrides,ii,0),rounds:NonNullable<Point['round_conditions']>=[];
   for(let oi=1;oi<outer.length;oi++){
    const actual=conditionPoint(definition,inner,outer,overrides,ii,oi);
    if(actual.temperature_c!==point.temperature_c||actual.pressure_bar!==point.pressure_bar||actual.pressure_mode!==point.pressure_mode)rounds.push({round:oi+1,temperature_c:actual.temperature_c,pressure_bar:actual.pressure_bar,pressure_mode:actual.pressure_mode});
   }
   return {...point,...(rounds.length?{round_conditions:rounds}:{})};
  });
 }catch{return [];}
}
