import {describe,expect,it} from 'vitest';
import {userMessage} from './user-messages';
describe('user-facing failure messages',()=>{
  it('explains a lost connection instead of showing protocol details',()=>{
    expect(userMessage(JSON.stringify({code:'BRIDGE_UNRESPONSIVE',diagnostic:'RecvError: subprocess exited'}))).toContain('重新连接 Reaktoro');
    expect(userMessage(new Error('invalid bridge response: expected object'))).not.toMatch(/bridge|object/i);
  });
  it('keeps species, conditions and scientific failure information',()=>{
    const message='250 °C / 700 bar：Na+ 的电荷约束不平衡';
    expect(userMessage({diagnostic:message,code:'EQUILIBRIUM_FAILED'})).toBe(message);
  });
  it('explains an unavailable database without exposing its schema identifier',()=>{
    expect(userMessage({error:{code:'RTDB_SCHEMA_UNSUPPORTED',diagnostic:'easyreaktoro.rtdb/v99'}})).toBe('此数据库版本暂不支持，请使用兼容版本的 EasyReaktoro 打开。');
  });
  it('gives a save action for disk-space errors',()=>{
    expect(userMessage(new Error('No space left on device'))).toContain('选择其他位置');
  });
});
