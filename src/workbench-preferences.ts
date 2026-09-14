export type SimulationPreferences={temperature_c:number;pressure_bar:number;activity_model:'auto'|'nacl_edh'|'hkf'|'davies'|'ideal';gas_model:'ideal'|'peng_robinson';select_basics:boolean;allow_database_defaults:boolean;allow_recorded_assignments:boolean;species_order:'chemical'|'common'|'name'|'phase';species_preview:boolean;results_directory?:string;settings_directory?:string};
export type ResultPreferences={x_direction:'asc'|'desc';layout:'stack'|'grid';playback_ms:number;inspector:'auto'|'show'|'hide';library:boolean;export_directory?:string};
export const SIMULATION_DEFAULTS:SimulationPreferences={temperature_c:250,pressure_bar:700,activity_model:'auto',gas_model:'ideal',select_basics:true,allow_database_defaults:true,allow_recorded_assignments:true,species_order:'chemical',species_preview:true};
export const RESULT_DEFAULTS:ResultPreferences={x_direction:'asc',layout:'stack',playback_ms:600,inspector:'auto',library:true};
export function simulationPreferences(raw:any):SimulationPreferences{
 const v=raw&&typeof raw==='object'?raw:{},next={...SIMULATION_DEFAULTS};
 for(const key of ['select_basics','allow_database_defaults','allow_recorded_assignments','species_preview'] as const)if(typeof v[key]==='boolean')next[key]=v[key];
 for(const key of ['results_directory','settings_directory'] as const)if(typeof v[key]==='string'&&v[key])next[key]=v[key];
 if(Number.isFinite(v.temperature_c)&&v.temperature_c>-273.15)next.temperature_c=v.temperature_c;if(Number.isFinite(v.pressure_bar)&&v.pressure_bar>0)next.pressure_bar=v.pressure_bar;
 if(['auto','nacl_edh','hkf','davies','ideal'].includes(v.activity_model))next.activity_model=v.activity_model;if(['ideal','peng_robinson'].includes(v.gas_model))next.gas_model=v.gas_model;if(['chemical','common','name','phase'].includes(v.species_order))next.species_order=v.species_order;return next;
}
export function resultPreferences(raw:any):ResultPreferences{
 const v=raw&&typeof raw==='object'?raw:{},next={...RESULT_DEFAULTS};if(v.x_direction==='desc')next.x_direction='desc';if(v.layout==='grid')next.layout='grid';if([250,600,1200].includes(v.playback_ms))next.playback_ms=v.playback_ms;if(['auto','show','hide'].includes(v.inspector))next.inspector=v.inspector;if(typeof v.library==='boolean')next.library=v.library;if(typeof v.export_directory==='string'&&v.export_directory)next.export_directory=v.export_directory;return next;
}
