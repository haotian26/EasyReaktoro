import {compileSchedule} from './simulation-schedule';
import {describe,expect,it} from 'vitest';
import {DEFAULT_CONFIG,readConfig,Config} from './simulation-types';
import {defaultLoops,loopIssue,loopPoint,loopPoints} from './simulation-loops';
import {pointConditions,saturationPressure} from './process-layout';
const config=():Config=>({...structuredClone(DEFAULT_CONFIG),loops:{...defaultLoops(),base:{temperature_c:25,pressure_bar:300,pressure_mode:'water_saturation'},inner:{mode:'range',target:{kind:'temperature'},start:250,end:100,step:-50},outer:{mode:'repeat',count:2},round_conditions:[{round:2,pressure_mode:'fixed',pressure_bar:700}]}});
describe('per-round pressure conditions',()=>{
 it('repeats the temperature path while switching between saturation and fixed pressure',()=>{
  const cfg=config(),before=structuredClone(cfg);expect(loopIssue(cfg)).toBeUndefined();
  for(const ii of [0,1,2,3]){const first=loopPoint(cfg.loops!,ii,0),second=loopPoint(cfg.loops!,ii,1);expect(first.temperature_c).toBe(250-50*ii);expect(second.temperature_c).toBe(first.temperature_c);expect(first.pressure_bar).toBeCloseTo(saturationPressure(first.temperature_c),10);expect(second.pressure_bar).toBe(700);expect(second.pressure_mode).toBe('fixed');}
  const points=loopPoints(cfg);expect(points).toHaveLength(4);
  points.forEach((point,i)=>{expect(pointConditions(point,1).pressure).toBeCloseTo(loopPoint(cfg.loops!,i,0).pressure_bar,10);expect(pointConditions(point,2)).toMatchObject({temperature:250-50*i,pressure:700,pressure_mode:'fixed'});});
  expect(cfg).toEqual(before);expect(compileSchedule(readConfig(cfg)).point(3,1)).toMatchObject({temperature_c:100,pressure_bar:700,pressure_mode:'fixed'});
 });
 it('uses pressure-path values when a fixed round does not specify a replacement value',()=>{
  const cfg=config();cfg.loops!.inner={mode:'list',target:{kind:'pressure'},values:[100,200]};cfg.loops!.round_conditions=[{round:2,pressure_mode:'fixed'}];
  expect(loopIssue(cfg)).toBeUndefined();expect(loopPoint(cfg.loops!,1,1).pressure_bar).toBe(200);
  cfg.loops!.round_conditions[0].pressure_bar=700;expect(loopIssue(cfg)).toContain('没有生效');
  cfg.loops!.round_conditions[0].pressure_bar=undefined;expect(loopIssue(cfg)).toBeUndefined();expect(loopPoint(cfg.loops!,1,1).pressure_bar).toBe(200);expect(compileSchedule(readConfig(cfg)).point(1,1).pressure_bar).toBe(200);
 });
 it('resumes the base mode after an override and retains inactive unfinished values',()=>{
  const cfg=config();cfg.loops!.base.pressure_mode='fixed';cfg.loops!.outer={mode:'repeat',count:3};cfg.loops!.round_conditions=[{round:2,pressure_mode:'water_saturation'},{round:9,pressure_mode:'fixed',pressure_bar:NaN}];
  expect(loopIssue(cfg)).toBeUndefined();expect(loopPoint(cfg.loops!,1,2).pressure_bar).toBe(300);expect(Number.isNaN((readConfig(cfg).schedule!.overrides[1].parameters[0].value as {value:number}).value)).toBe(true);
  cfg.loops!.outer={mode:'repeat',count:9};expect(loopIssue(cfg)).toContain('第 9 轮压力');expect(()=>readConfig(cfg)).toThrow();
 });
 it('rejects duplicate rounds and validates saturation domains only in active saturation rounds',()=>{
  const cfg=config();cfg.loops!.round_conditions!.push({...cfg.loops!.round_conditions![0]});expect(loopIssue(cfg)).toContain('重复');expect(()=>readConfig(cfg)).toThrow();
  cfg.loops!.inner={mode:'list',target:{kind:'temperature'},values:[450,400]};cfg.loops!.base.pressure_mode='fixed';cfg.loops!.round_conditions=[{round:9,pressure_mode:'water_saturation'}];expect(loopIssue(cfg)).toBeUndefined();
  cfg.loops!.round_conditions[0].round=2;expect(loopIssue(cfg)).toContain('第 2 轮');expect(loopIssue(cfg)).toContain('饱和蒸汽压');
  cfg.loops!.base.pressure_mode='water_saturation';cfg.loops!.round_conditions=[{round:1,pressure_mode:'fixed',pressure_bar:100},{round:2,pressure_mode:'fixed',pressure_bar:700}];expect(loopIssue(cfg)).toBeUndefined();
 });
 it('takes the first outer variable value into every projected path point',()=>{
  const cfg=config();cfg.loops!.base.pressure_mode='fixed';cfg.loops!.inner={mode:'repeat',count:2};cfg.loops!.outer={mode:'list',target:{kind:'temperature'},values:[180,230]};cfg.loops!.round_conditions=[];
  const points=loopPoints(cfg);expect(points[0].temperature_c).toBe(180);expect(pointConditions(points[1],2).temperature).toBe(230);
 });
});
