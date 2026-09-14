// @vitest-environment jsdom
import {afterEach,describe,expect,it} from 'vitest';
import {getLanguage,setLanguage,t,translateMessage} from './i18n';
import './i18n-simulation-errors';
import {DEFAULT_CONFIG,makeRoute,PHASE_LABELS,type Config} from './simulation-types';
import {compileSchedule,defaultSchedule,scheduleSettingSummary} from './simulation-schedule';
import {stageInfo,stageKeys} from './reaction-stages';
import {actualVariationSummaries} from './schedule-reading';
import {targetDescription} from './simulation-loops';
afterEach(()=>setLanguage('zh-CN'));
describe('language and scientific state separation',()=>{
 it('switches active messages in both directions without changing captured user names',()=>{
  const chinese=t('模拟“中文样本 H2O(aq)”已保存','Simulation “中文样本 H2O(aq)” saved');
  setLanguage('en-US');expect(getLanguage()).toBe('en');expect(document.documentElement.lang).toBe('en');
  const english=translateMessage(chinese);expect(english).toBe('Simulation “中文样本 H2O(aq)” saved');
  setLanguage('zh-CN');expect(translateMessage(english)).toBe(chinese);
 });
 it('localizes known backend messages and preserves scientific diagnostics and unknown text',()=>{
  setLanguage('en');expect(translateMessage('当前数据库没有物种：Au(HS)2-')).toBe('The current database does not contain species: Au(HS)2-');
  expect(translateMessage('反应轮次 2/40 · 路径位置 3 (3/111)')).toBe('Round 2/40 · Path position 3 (3/111)');
  expect(translateMessage('本次汇合物料净电荷为 1.230e-03 mol；当前计算要求总输入电中性，请调整此处加入的物种及用量。各份配方不必单独中性')).toContain('1.230e-03 mol');
  expect(translateMessage('Unrecognized solver message: Au+1')).toBe('Unrecognized solver message: Au+1');
 });
 it('updates static phase and stage labels, while existing simulation names remain unchanged',()=>{
  const saved=structuredClone(DEFAULT_CONFIG);expect(saved.name).toBe('新的平衡模拟');
  setLanguage('en');expect(PHASE_LABELS.aqueous).toBe('Aqueous');expect(stageInfo.first_start.title).toBe('First reaction');
  expect(structuredClone(DEFAULT_CONFIG).name).toBe('New equilibrium simulation');expect(saved.name).toBe('新的平衡模拟');
 });
 it('keeps values and percent scaling identical and refreshes cached readings on the same plan',()=>{
  const cfg:Config=structuredClone(DEFAULT_CONFIG);cfg.name='中文样本';cfg.species=['H2O'];cfg.materials[0].inputs=[{species:'H2O',amount:1,unit:'kg'}];
  cfg.reaction_stages=Object.fromEntries(stageKeys.map(stage=>[stage,[{...makeRoute(),id:stage,source:stage.endsWith('following')?'previous_point':'material',fallback:'error',phase:'aqueous'}]])) as Config['reaction_stages'];
  const target={kind:'route_fraction' as const,route_id:'first_following',field:'fraction' as const};
  cfg.schedule={...defaultSchedule(),positions:3,rounds:2,parameters:[{id:'t',target:{kind:'temperature'},value:{mode:'linear',start:150,path_step:-25,round_step:0}},{id:'p',target:{kind:'pressure'},value:{mode:'fixed',value:700}},{id:'f',target,value:{mode:'linear',start:.25,path_step:.25,round_step:0}}]};
  const before=JSON.stringify(cfg),plan=compileSchedule(cfg),values=Array.from({length:6},(_,i)=>[plan.point(i%3,Math.floor(i/3)).temperature_c,plan.valueAt(target,i%3,Math.floor(i/3))]);
  const chinese=actualVariationSummaries(cfg,plan,{inner:1,outer:0});expect(JSON.stringify(chinese)).toContain('温度');
  setLanguage('en');expect(targetDescription(target,cfg).quantityKind).toBe('fraction');expect(targetDescription(target,cfg).unit).toBe('fraction');
  expect(scheduleSettingSummary(cfg.schedule.parameters[2],cfg)).toContain('25 %');
  const english=actualVariationSummaries(cfg,plan,{inner:1,outer:0});expect(JSON.stringify(english)).toContain('Temperature');expect(JSON.stringify(english)).toContain('50 → 75 %');expect(JSON.stringify(english)).not.toMatch(/[\u4e00-\u9fff]/);
  expect(Array.from({length:6},(_,i)=>[plan.point(i%3,Math.floor(i/3)).temperature_c,plan.valueAt(target,i%3,Math.floor(i/3))])).toEqual(values);expect(JSON.stringify(cfg)).toBe(before);
  setLanguage('zh-CN');expect(actualVariationSummaries(cfg,plan,{inner:1,outer:0})).toEqual(chinese);
 });
 it('keeps empty values empty even when a bilingual optional label uses an empty branch',()=>{t('','Optional empty field text');setLanguage('en');expect(translateMessage('')).toBe('');expect(translateMessage('  ')).toBe('  ');setLanguage('zh-CN');expect(translateMessage('Optional empty field text')).toBe('Optional empty field text');});
 it('matches generated parameter messages without interpreting punctuation or altering inserted text',()=>{
  setLanguage('en');expect(translateMessage('第 17 轮压力须为有效数值。')).toBe('Enter a valid pressure for round 17.');
 });
});
