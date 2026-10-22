import {afterEach,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {setLanguage,translateMessage} from './i18n';
import {userMessage} from './user-messages';
import {equilibriumErrorMessages} from './i18n-equilibrium-errors';
afterEach(()=>setLanguage('zh-CN'));
it('translates all equilibrium-target structural and scientific diagnostics at the user error boundary',()=>{
 setLanguage('en');for(const [diagnostic,english] of Object.entries(equilibriumErrorMessages)){expect(userMessage({error:{code:'EQUILIBRIUM_CONSTRAINT',diagnostic}})).toBe(english);expect(english).not.toMatch(/[\u3400-\u9fff]/);}
});
it.each([
 ['第 40 轮、位置 111 的 pH/HCl-甲 目标值须为有限数','Round 40, position 111: target pH/HCl-甲 must have a finite value.'],
 ['无法读取滴定物质化学式：Ca(OH)2','The pH adjustment formula could not be read: Ca(OH)2'],
 ['CO2(g)_[Gas] 须为当前数据库中唯一、可计算的中性气体记录','CO2(g)_[Gas] must be a unique, calculable neutral gas record in the current database.'],
 ['target_CO2 的交换物质包含当前体系没有的元素，请先补充允许参与平衡的 species','The exchange substance for target_CO2 contains elements absent from the current system. Add the corresponding equilibrium species first.'],
 ['target_CO2 的交换组成无法由所选 species 表示，请补充相应 species','The exchange composition for target_CO2 cannot be represented by the selected species. Add the corresponding species.'],
 ['pH 未达到目标：目标 -1.2，实际 1.2e-05','The pH target was not reached: target -1.2, actual 1.2e-05.'],
 ['此 pH 目标需要移除 HCl；当前仅允许加入，请改变目标或交换方式','This pH target requires removing HCl. Only addition is allowed; change the target or exchange option.'],
 ['无法从当前平衡组成核对 H2S(g) 逸度；必要物质可能已耗尽','The fugacity of H2S(g) could not be verified from the equilibrium composition. A required substance may be depleted.'],
 ['CO2(g) 逸度未达到目标 1.5e-10 bar','The fugacity of CO2(g) did not reach the target of 1.5e-10 bar.'],
 ['求解器未收敛；当前仅允许加入 HCl、Ca(OH)2，请检查目标能否通过该物质达到','The equilibrium solver did not converge. Only addition of HCl, Ca(OH)2 is allowed; check whether the target can be reached using this substance.'],
])('localizes the diagnostic while preserving interpolated values: %s',(diagnostic,english)=>{
 setLanguage('en');expect(userMessage({code:'EQUILIBRIUM_CONSTRAINT',diagnostic})).toBe(english);setLanguage('zh-CN');expect(userMessage({code:'EQUILIBRIUM_CONSTRAINT',diagnostic})).toBe(diagnostic);
});
it('translates combined solver attempts after their actual temperature and pressure prefix',()=>{
 setLanguage('en');const diagnostic='250 °C / 700 bar：求解器未收敛；当前仅允许加入 HCl，请检查目标能否通过该物质达到；pH 未达到目标：目标 3，实际 3.01；此 pH 目标需要移除 HCl；当前仅允许加入，请改变目标或交换方式';
 const result=userMessage({code:'EQUILIBRIUM_FAILED',diagnostic});expect(result).toBe('250 °C / 700 bar: The equilibrium solver did not converge. Only addition of HCl is allowed; check whether the target can be reached using this substance. The pH target was not reached: target 3, actual 3.01. This pH target requires removing HCl. Only addition is allowed; change the target or exchange option.');expect(result).not.toMatch(/[\u3400-\u9fff]/);
});
it('translates code-parse target diagnostics without changing field paths or user formulas',()=>{
 setLanguage('en');expect(userMessage({code:'SIMULATION_CODE',diagnostic:JSON.stringify([{line:12,message:'equilibrium_constraints：平衡约束字段不完整或无法识别'}])})).toBe('Line 12: equilibrium_constraints: The equilibrium target has incomplete or unrecognized fields.');
 const comment='# 我的 pH 目标\nequilibrium_constraints = [{"titrant": "HCl"}]';expect(translateMessage(comment)).toBe(comment);expect(translateMessage('用户备注：H2S 逸度高')).toBe('用户备注：H2S 逸度高');
});

it('covers every static message in the backend target validator, including multiline checks',()=>{
 const source=readFileSync(new URL('../bridge/easyreaktoro_runtime/simulation_constraints.py',import.meta.url),'utf8');
 const messages=[...source.matchAll(/(?<![\w])'([^'\n]*[\u3400-\u9fff][^'\n]*)'\s*(?:\)|,(?=\s*(?:location|source_location|value_location)\b))/g)].map(match=>match[1]).filter(message=>!message.includes('{'));
 expect(messages.length).toBeGreaterThan(14);setLanguage('en');for(const message of messages){expect(translateMessage(message),message).not.toBe(message);expect(translateMessage(message),message).not.toMatch(/[\u3400-\u9fff]/);}
});
