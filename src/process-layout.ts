import {Config,Point,Route,makeRoute} from './simulation-types';

/** IAPWS SR1-86(1992), pressure in bar. Solver uses Reaktoro's matching formulation. */
export function saturationPressure(temperature:number){
  if(!Number.isFinite(temperature)||temperature<0.01||temperature>=373.946)return NaN;
  const t=temperature+273.15,q=1-t/647.096;
  return 220.64*Math.exp(647.096/t*(-7.85951783*q+1.84408259*q**1.5-11.7866497*q**3+22.6807411*q**3.5-15.9618719*q**4+1.80122502*q**7.5));
}
export function pointConditions(point:Point,cycle=1){
  const override=point.round_conditions?.find(r=>r.round===cycle);
  const temperature=override?.temperature_c??point.temperature_c+(cycle-1)*(point.temperature_increment_c??0);
  const mode=override?override.pressure_mode:point.pressure_mode;
  return {temperature,pressure:mode==='water_saturation'?saturationPressure(temperature):override?.pressure_bar??point.pressure_bar+(cycle-1)*(point.pressure_increment_bar??0),pressure_mode:mode||'fixed',overridden:!!override};
}
export type FlowChoice='fresh'|'path'|'repeat'|'custom';
export function flowChoice(routes:Route[]):FlowChoice{
  if(routes.length!==1||routes[0].phase!=='all'||routes[0].fraction!==1||routes[0].when!=='always'||(routes[0].source!=='material'&&(routes[0].fallback!=='material'||routes[0].fallback_fraction!==1)))return 'custom';
  return ({material:'fresh',previous_point:'path',previous_cycle:'repeat',output:'custom'} as const)[routes[0].source];
}
export function chooseFlow(choice:Exclude<FlowChoice,'custom'>,routes:Route[],material:string){
  if(flowChoice(routes)===choice)return routes;
  const source=({fresh:'material',path:'previous_point',repeat:'previous_cycle'} as const)[choice];
  const old=routes[0];return [{...makeRoute('all',source,old?.material_id||material),fraction:1}];
}
export function runNumber(config:Config,index:number,cycle:number){return (cycle-1)*config.points.length+index+1;}
/** Preserve execution order; never infer material transfer from geometric proximity. */
export function matrixShape(points:Point[]){
  const ts=[...new Set(points.map(p=>p.temperature_c))],ps=[...new Set(points.map(p=>p.pressure_bar))];
  if(ts.length<2||ps.length<2||ts.length*ps.length!==points.length||points.some(p=>p.pressure_mode==='water_saturation'))return null;
  if(new Set(points.map(p=>`${p.temperature_c}:${p.pressure_bar}`)).size!==points.length)return null;
  return {temperatures:ts,pressures:ps};
}
