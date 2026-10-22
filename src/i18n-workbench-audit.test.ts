import {afterEach,expect,it} from 'vitest';
import {setLanguage} from './i18n';
import {userMessage} from './user-messages';
afterEach(()=>setLanguage('zh-CN'));
it('translates nested validator labels, not just the surrounding failure sentence',()=>{
 setLanguage('en');
 const cases:Record<string,string>={
  '第 3 点温度 不能小于 -273.149999':'Temperature at position 3 must be at least -273.149999.',
  '指定轮次压力 必须是有限数':'Pressure for the selected round must be a finite number.',
  '守恒误差限值 不能大于 1e-05':'Balance tolerance must be no greater than 1e-05.',
  '第 2 轮、路径位置 100 的参数须为有限数值':'Parameter at round 2, position 100 must be a finite number.',
  '传入比例 超出允许范围或不是有限数':'Transferred fraction is outside the allowed range or is not finite.',
  '第 3 点的物料来源规则无效':'Position 3: invalid material source rule.',
  '第 2 点引用的物质配方不存在':'Position 2: the referenced composition does not exist.',
 };
 for(const [diagnostic,expected] of Object.entries(cases))expect(userMessage({code:'SIMULATION_INPUT',diagnostic}),diagnostic).toBe(expected);
});
it('localizes generated path positions in allocation and pressure diagnostics while preserving scientific names and numbers',()=>{
 setLanguage('en');
 expect(userMessage({diagnostic:'循环 2 的 路径位置 17 输出 H2O(aq) 被分配了 125.0%，超过 100%；请调整分流比例'})).toBe('Round 2, Path position 17: 125.0% of H2O(aq) has been allocated, exceeding 100%. Adjust the transfer fractions.');
 expect(userMessage({diagnostic:'路径位置 12 第 8 轮温度为 450 °C；纯水饱和蒸汽压需要 0.01 ≤ T < 373.946 °C，请调整温度或改为指定压力'})).toBe('Path position 12, round 8: temperature is 450 °C. Pure-water saturation pressure requires 0.01 ≤ T < 373.946 °C. Adjust the temperature or use fixed pressure.');
 expect(userMessage({diagnostic:'矿物：实验 1 投料量 不能小于 0'})).toBe('矿物：实验 1 input amount must be at least 0.');
 expect(userMessage({diagnostic:'循环 3 的 取样站甲 输出 试样矿物 被分配了 120.0%，超过 100%；请调整分流比例'})).toBe('Round 3, 取样站甲: 120.0% of 试样矿物 has been allocated, exceeding 100%. Adjust the transfer fractions.');
});
