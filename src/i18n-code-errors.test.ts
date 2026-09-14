import {afterEach,expect,it} from 'vitest';
import {setLanguage,translateMessage} from './i18n';
import './i18n-code-errors';
afterEach(()=>setLanguage('zh-CN'));
it('translates real parameter-validation paths while preserving quoted species names and indices',()=>{
 setLanguage('en');
 expect(translateMessage("ion_size_overrides['Eu+2(aq)'].a_angstrom：必须是有限数值")).toBe("ion_size_overrides['Eu+2(aq)'].a_angstrom: must be a finite number");
 expect(translateMessage('reaction_stages.later_following[2].lag：可用值为 0, 1')).toBe('reaction_stages.later_following[2].lag: allowed values are 0, 1');
 expect(translateMessage('materials[0].inputs[8]：缺少字段 amount, unit')).toBe('materials[0].inputs[8]: missing fields amount, unit');
 expect(translateMessage("字典字段 '络合物 Cu(HS)2-' 重复，无法确定应采用哪一个。")).toBe("Dictionary field '络合物 Cu(HS)2-' is duplicated; the value to use is ambiguous.");
});
it('translates code diagnostics without rewriting Python tokens, messages, or scientific text',()=>{
 setLanguage('en');
 expect(translateMessage("本模块不包含参数 'Ca+2'。可修改：species、water_species")).toBe("This module has no parameter 'Ca+2'. Editable parameters: species, water_species");
 expect(translateMessage("Python 语法不完整：'[' was never closed")).toBe("Incomplete Python syntax: '[' was never closed");
 expect(translateMessage('bootstrap 必须为 True 或 False。')).toBe('bootstrap must be True or False.');
 const source="# 初始溶液\nmaterials = [{'species': '水溶液实验', 'amount': 0.1, 'unit': 'mol'}]";expect(translateMessage(source)).toBe(source);
 expect(translateMessage('用户备注：必须填入 H2O')).toBe('用户备注：必须填入 H2O');
});
it('localizes module descriptions and restores unchanged Chinese diagnostics after switching back',()=>{
 const text='四类位置独立选择反应物料；执行顺序本身不会转移任何物质。';setLanguage('en');expect(translateMessage(text)).toContain('four position types');
 setLanguage('zh-CN');expect(translateMessage(text)).toBe(text);expect(translateMessage('materials[0].inputs[8]：缺少字段 amount, unit')).toBe('materials[0].inputs[8]：缺少字段 amount, unit');
});
