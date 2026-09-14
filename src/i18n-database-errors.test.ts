import {readFileSync} from 'node:fs';
import {afterEach,expect,it} from 'vitest';
import {setLanguage,translateMessage} from './i18n';
import {databaseErrorMessages,translateDatabaseMessage} from './i18n-database-errors';
import {userMessage} from './user-messages';
afterEach(()=>setLanguage('zh-CN'));
it('localizes exact database errors with a reversible display language',()=>{
 const diagnostic='文件已被其他程序修改或删除。请另存为新文件，避免覆盖外部更改。';setLanguage('en');
 const english=translateDatabaseMessage(diagnostic);expect(english).toContain('Save as a new file');expect(english).not.toMatch(/[\u3400-\u9fff]/);
 setLanguage('zh-CN');expect(translateDatabaseMessage(english)).toBe(diagnostic);
});
it('covers every static Chinese database require/BridgeError/need/issue diagnostic in the shipped modules',()=>{
 const files=['repository.py','service.py','models.py','converted.py','converted_equations.py'];
 const messages:string[]=[];
 for(const name of files){const source=readFileSync(new URL(`../bridge/easyreaktoro_runtime/${name}`,import.meta.url),'utf8');
  // Calls in these modules keep their diagnostic as the last argument on a source line.
  for(const line of source.split('\n')){if(!/\b(?:require|BridgeError|need|issue)\(/.test(line))continue;
   for(const match of line.matchAll(/(?:,\s*)"([^"\n]*[\u3400-\u9fff][^"\n]*)"\)/g))messages.push(match[1]);
  }
 }
 expect(messages.length).toBeGreaterThan(50);setLanguage('en');
 for(const message of messages){expect(translateDatabaseMessage(message),message).not.toBe(message);expect(translateDatabaseMessage(message),message).not.toMatch(/[\u3400-\u9fff]/);}
});
it('preserves dynamic species names and scientific quantities inside translated diagnostics',()=>{
 setLanguage('en');const name='矿物：实验[1] / Ca++ (aq)';
 expect(translateDatabaseMessage(`物种名称重复：${name}`)).toBe(`Duplicate species name: ${name}`);
 expect(translateDatabaseMessage(`${name} 没有可导出的原生模型参数`)).toBe(`${name} has no source-model parameters available for export.`);
 expect(translateDatabaseMessage(`${name}: G0 未提供或非有限值`)).toBe(`${name}: G0 is missing or nonfinite.`);
 expect(translateDatabaseMessage('Cp 必须包含至少 120 个有限系数')).toBe('Cp must contain at least 120 finite coefficients.');
 expect(translateDatabaseMessage('此记录来自 Reaktoro 2.13.0，当前为 2.14.0。请使用原环境，或从当前环境重新创建副本。')).toContain('Reaktoro 2.13.0; the connected version is 2.14.0');
});
it('translates species-prefixed and combined validation messages while preserving unrecognized diagnostics',()=>{
 setLanguage('en');const name='矿物：试样1';
 const source=`${name}：离子尺寸 aᵢ 必须大于 0 Å; 缺少参数 参考 pK; new solver detail: |r|=2.5e-15`;
 expect(translateDatabaseMessage(source)).toBe(`${name}: The ion size aᵢ must be greater than 0 Å.; Missing parameter: Reference pK; new solver detail: |r|=2.5e-15`);
 const unknown='未识别诊断 / test：原始信息 / T=373.15 K / code 27';expect(translateDatabaseMessage(unknown)).toBe(unknown);
 expect(userMessage({code:'FUTURE_SCIENCE_ERROR',diagnostic:unknown})).toBe(unknown);
});
it('translates nested bridge errors, connection recovery, and Python code line messages',()=>{
 setLanguage('en');expect(userMessage(JSON.stringify({error:{code:'RTDB_SCHEMA_UNSUPPORTED',diagnostic:'easyreaktoro.rtdb/v99'}}))).toContain('compatible version of EasyReaktoro');
 expect(userMessage(new Error('invalid bridge response: expected object'))).toContain('Reconnect Reaktoro in Settings');
 const result=userMessage({code:'SIMULATION_CODE',diagnostic:JSON.stringify([{line:7,message:'缺少参数 参考 pK'},{line:11,message:'unknown solver detail: 9e-12'}])});
 expect(result).toBe('Line 7: Missing parameter: Reference pK\nLine 11: unknown solver detail: 9e-12');
});
it('does not translate stored scientific records or unfamiliar keys through the model/error catalogs',()=>{
 setLanguage('en');const original='my-study: unsupported gas baseline 1.234e-8 J/mol';expect(translateMessage(original)).toBe(original);
 expect(Object.keys(databaseErrorMessages)).not.toContain('手动修改离子尺寸；原赋值保留在 original_assignment。');
});
it('renders known structured import/compose diagnostics while preserving all source identifiers and unknown issue data',()=>{
 setLanguage('en');
 const source=[{code:'REACTION_REQUIRED',species:'矿物/1',message:'需要填写形成反应'},{code:'FUTURE_RULE',detail:'原始值 1.2300e-17'}];
 const imported=userMessage({code:'IMPORT_BLOCKED',diagnostic:JSON.stringify(source)});
 expect(imported).toBe('矿物/1: A formation reaction is required.\n'+JSON.stringify(source[1]));
 const composed=userMessage({code:'COMPOSE_BLOCKED',diagnostic:JSON.stringify({missing:[{code:'AMBIGUOUS_DEPENDENCY',dependency:'H2O(aq)',chain:['目标','H2O(aq)'],candidates:['原库A','原库B']}],cycles:[['物种A','物种B','物种A']]})});
 expect(composed).toContain('Ambiguous source for species: H2O(aq)');expect(composed).toContain('目标 → H2O(aq)');expect(composed).toContain('["原库A","原库B"]');expect(composed).toContain('Formation-reaction cycle: 物种A → 物种B → 物种A');
 const unknown='{"some_new_diagnostic":"原始信息","value":"1.2300e-17"}';expect(userMessage({code:'IMPORT_BLOCKED',diagnostic:unknown})).toBe(unknown);
});
