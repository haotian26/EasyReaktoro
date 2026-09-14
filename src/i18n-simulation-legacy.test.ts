import {readFileSync} from 'node:fs';
import {afterEach,expect,it} from 'vitest';
import {setLanguage,translateMessage} from './i18n';
import './i18n-simulation-legacy';
afterEach(()=>setLanguage('zh-CN'));
it('covers every static validation error in the legacy simulation path reader',()=>{
 const source=readFileSync(new URL('../bridge/easyreaktoro_runtime/simulation_loops.py',import.meta.url),'utf8');
 const messages=source.split('\n').filter(line=>line.includes('_check(')).flatMap(line=>[...line.matchAll(/,\s*'([^'\n]*[\u3400-\u9fff][^'\n]*)'\)/g)].map(match=>match[1]));
 expect(messages.length).toBeGreaterThan(30);setLanguage('en');
 for(const message of messages){expect(translateMessage(message),message).not.toBe(message);expect(translateMessage(message),message).not.toMatch(/[\u3400-\u9fff]/);}
});
it('keeps round numbers and unit-independent quantities intact in legacy diagnostics',()=>{
 setLanguage('en');expect(translateMessage('第 123 轮的压力设置重复，请保留一项')).toBe('Round 123 has duplicate pressure settings. Keep one entry.');
 expect(translateMessage('第 8 轮压力须为有限数值')).toBe('Pressure in round 8 must be a finite number.');
 expect(translateMessage('基础温度须为有限数值')).toBe('Base temperature must be a finite number.');
});
it('covers the static notebook import diagnostics without executing or altering notebook source',()=>{
 const source=readFileSync(new URL('../bridge/easyreaktoro_runtime/simulation_templates.py',import.meta.url),'utf8');
 const messages=source.split('\n').filter(line=>/\b(?:require|ValueError)\(/.test(line)).flatMap(line=>[...line.matchAll(/"([^"\n]*[\u3400-\u9fff][^"\n]*)"\)/g)].map(match=>match[1]));
 expect(messages.length).toBeGreaterThan(15);setLanguage('en');for(const message of messages)expect(translateMessage(message),message).not.toMatch(/[\u3400-\u9fff]/);
});
