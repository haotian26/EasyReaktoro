import {describe,it,expect} from 'vitest';
import cases from './fixtures/schedule-contract.json';
import {compileSchedule,migrateSchedule} from './simulation-schedule';
import type {Config} from './simulation-types';
describe('frontend and Python evaluate the same saved schedule',()=>{
 for(const scenario of cases.cases)it(scenario.name,()=>{
  const config=scenario.config as unknown as Config,plan=compileSchedule(config);
  for(const frame of scenario.frames){const ii=frame.inner_index-1,oi=frame.outer_index-1,p=plan.point(ii,oi);expect(p.temperature_c).toBeCloseTo(frame.point.temperature_c,11);expect(p.pressure_bar).toBeCloseTo(frame.point.pressure_bar,10);expect(p.pressure_mode).toBe(frame.point.pressure_mode);
   for(const value of frame.parameters)expect(plan.valueAt(value.target as any,ii,oi)).toBeCloseTo(value.value,12);
  }
  if('legacyConfig' in scenario){const migrated=migrateSchedule(scenario.legacyConfig as unknown as Config)!;migrated.rounds=config.schedule!.rounds;const legacyPlan=compileSchedule({...config,schedule:migrated});for(const frame of scenario.frames){const p=legacyPlan.point(frame.inner_index-1,frame.outer_index-1);expect(p.temperature_c).toBeCloseTo(frame.point.temperature_c,11);expect(p.pressure_bar).toBeCloseTo(frame.point.pressure_bar,10);expect(p.pressure_mode).toBe(frame.point.pressure_mode);}}
 });
});
