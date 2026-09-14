import {readFileSync} from 'node:fs';
import {afterEach,expect,it} from 'vitest';
import {setLanguage,translateMessage} from './i18n';
import {translateModelMessage} from './i18n-models';
afterEach(()=>setLanguage('zh-CN'));
it('covers every Chinese label, description, and parameter hint in the shipped model registry',()=>{
 const source=readFileSync(new URL('../bridge/easyreaktoro_runtime/models.py',import.meta.url),'utf8');
 const registry=source.slice(source.indexOf('REGISTRY:'),source.indexOf('\ndef definitions()'));
 const labels=[...registry.matchAll(/"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)].map(match=>match[1]);
 expect(labels.length).toBeGreaterThan(25);setLanguage('en');
 for(const label of labels){expect(translateMessage(label),label).not.toBe(label);expect(translateMessage(label),label).not.toMatch(/[\u3400-\u9fff]/);}
});
it('translates generated converted-model labels without limiting segment or transition indices',()=>{
 setLanguage('en');
 expect(translateModelMessage('热容系数 · 第 123 段 · T^-0.5')).toBe('Heat-capacity coefficient · segment 123 · T^-0.5');
 expect(translateModelMessage('相变边界 dT/dP · 27')).toBe('Phase-boundary dT/dP · 27');
 expect(translateModelMessage('相变温度 / 末项存在上限 · 5')).toContain('upper stability limit');
 expect(translateModelMessage('Cp / 3')).toBe('Cp / 3');expect(translateModelMessage('J·mol⁻¹·K^(−2)')).toBe('J·mol⁻¹·K^(−2)');
});
it('preserves all registry source wording in Chinese mode and ignores unrecognized text',()=>{
 setLanguage('zh-CN');expect(translateModelMessage('热容系数 · 第 123 段 · T^-0.5')).toBe('热容系数 · 第 123 段 · T^-0.5');
 setLanguage('en');expect(translateModelMessage('User model / 自定义')).toBe('User model / 自定义');
});
