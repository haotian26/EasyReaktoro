import {expect,it} from 'vitest';
import {flowOverview,flowWindow} from './reaction-flow-overview';
import type {DiagramMaterialStages} from './LoopDiagram';
it('includes interior extremes, zero transfers, pressure-mode changes and all destinations in ranges',()=>{
 const t={source:'left' as const,phase:'aqueous',label:'Aqueous',fraction:1,fractionAt:(i:number,o:number)=>i===37&&o===17?0:i===63?.12:1};
 const m:DiagramMaterialStages={first_start:[],first_following:[t],later_start:[],later_following:[t]};
 const overview=flowOverview(100,100,m,(i,o)=>({temperature_c:i===50&&o===49?999:100,pressure_bar:i===70?700:50,pressure_mode:i===70?'fixed':'water_saturation'}),()=>true);
 expect(overview.total).toBe(10000);
 const stage=overview.stages.later_following!;expect(stage.count).toBe(9801);expect(stage.temperature).toEqual({min:100,max:999});
 expect(stage.saturation).toBe(9702);expect(stage.pressure).toEqual({min:700,max:700});
 expect(stage.inputs[0].count).toBe(9800);expect(stage.inputs[0].missing).toEqual({inner:37,outer:17});expect(stage.inputs[0].amount).toEqual({min:.12,max:1});
});
it('bounds local views at either end without skipping adjacent steps',()=>{
 expect(flowWindow(500,0)).toEqual({start:0,end:3});expect(flowWindow(500,499)).toEqual({start:497,end:500});expect(flowWindow(500,250)).toEqual({start:249,end:252});expect(flowWindow(1,0)).toEqual({start:0,end:1});
});
