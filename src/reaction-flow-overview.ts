import type {DiagramMaterialStages, DiagramStage, DiagramMaterialTerm} from './LoopDiagram';
import {flowInputs, type FlowCoordinate, type FlowInput} from './reaction-flow-model';

export type FlowPoint={temperature_c:number;pressure_bar:number;pressure_mode?:string};
export type FlowRange={min:number;max:number};
export type FlowOverviewInput={term:DiagramMaterialTerm;source:FlowInput['source'];amount:FlowRange;count:number;example:FlowCoordinate;from?:FlowCoordinate;differentSources:boolean;missing?:FlowCoordinate};
export type FlowOverviewStage={key:DiagramStage;count:number;first:FlowCoordinate;last:FlowCoordinate;temperature:FlowRange;pressure:FlowRange;saturation:number;inputs:FlowOverviewInput[]};
export type FlowOverview={stages:Partial<Record<DiagramStage,FlowOverviewStage>>;total:number;lengths:number[]};
export type FlowAnnotation={id:string;label:string;detail:string;at?:FlowCoordinate};
export const flowStage=({inner,outer}:FlowCoordinate):DiagramStage=>outer===0?(inner===0?'first_start':'first_following'):(inner===0?'later_start':'later_following');
const range=():FlowRange=>({min:Infinity,max:-Infinity});
function include(range:FlowRange,value:number){if(Number.isFinite(value)){range.min=Math.min(range.min,value);range.max=Math.max(range.max,value);}}

/** Aggregate every actual destination, not a sample of endpoints. Memory grows
 * with input rules and round count, not the number of equilibrium nodes. Numeric
 * ranges describe variation, never imply that conditions or transfers are fixed. */
export function flowOverview(positions:number,rounds:number,materials:DiagramMaterialStages,point:(i:number,o:number)=>FlowPoint,active:(i:number,o:number)=>boolean):FlowOverview{
 const stages:FlowOverview['stages']={},lengths:number[]=[];
 let total=0;
 for(let outer=0;outer<rounds;outer++){
  let length=0;
  for(let inner=0;inner<positions;inner++){
   if(!active(inner,outer))continue;
   const at={inner,outer},key=flowStage(at),value=point(inner,outer);
   const stage=stages[key]??(stages[key]={key,count:0,first:at,last:at,temperature:range(),pressure:range(),saturation:0,inputs:[]});
   total++;length++;stage.count++;stage.last=at;include(stage.temperature,value.temperature_c);
   if(value.pressure_mode==='water_saturation')stage.saturation++;else include(stage.pressure,value.pressure_bar);
   const inputs=flowInputs(materials,at,positions,rounds,active).flatMap(g=>g.inputs);
   for(const input of inputs){
    let summary=stage.inputs.find(s=>s.term===input.term&&s.source===input.source);
    if(!summary){summary={term:input.term,source:input.source,amount:range(),count:0,example:at,from:input.from,differentSources:false,missing:stage.count>1?stage.first:undefined};stage.inputs.push(summary);}
    summary.count++;include(summary.amount,input.amount);
    if(summary.from?.inner!==input.from?.inner||summary.from?.outer!==input.from?.outer)summary.differentSources=true;
   }
   for(const summary of stage.inputs)if(!summary.missing&&!inputs.some(input=>input.term===summary.term&&input.source===summary.source))summary.missing=at;
  }
  lengths.push(length);
 }
 return {stages,total,lengths};
}

/** A local expansion is always a real contiguous neighbourhood, not a sampled
 * path with false direct edges over skipped reactions. */
export function flowWindow(count:number,selected:number,size=3){const start=Math.max(0,Math.min(count-size,selected-Math.floor(size/2)));return {start,end:Math.min(count,start+size)};}
