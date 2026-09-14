import {describe,expect,it,vi} from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
import {DEFAULT_CONFIG,type Config} from './simulation-types';
import {decodeDocument} from './simulation-history';
import {normalizeEditorDraft,type CodeDocument,type EditorDraft} from './use-simulation-code';
import {encodeDraft} from './draft-json';
const cellIds=['system','materials','conditions','transfers','activity','solver','runtime','build','states','equilibrium','inventory','collect','process','execute'];
function editor(config:Config):EditorDraft{
 const document:CodeDocument={version:2,cells:cellIds.map((id,index)=>({id,title:id,description:id,source:id==='equilibrium'?'my_custom_solver(state)\n':`# unfinished text ${id}\n`,...(index>=6?{kind:'execution' as const,baseline_source:`# standard ${id}\n`}:{})}))};
 return {version:1,mode:'code',document,config,dirty:true,recovery:{document:structuredClone(document),config:structuredClone(config)}};
}
function legacy():Config{return {...structuredClone(DEFAULT_CONFIG),loops:{base:{temperature_c:250,pressure_bar:700},inner:{mode:'range',target:{kind:'temperature'},start:250,end:270,step:10},outer:{mode:'repeat',count:2}}};}
describe('canonical schedule recovery without rewriting user code',()=>{
 it('uses normalized history and editor configs, including recovery, while preserving all source text',()=>{
  const config=legacy(),code=editor(config),input={version:1,id:'history-id',database:{kind:'rtdb',path:'/example.rtdb',name:'example'},config,code_editor:code,updated_at:'2026-09-09'};
  const decoded=decodeDocument(encodeDraft(input));expect(decoded.config.schedule?.positions).toBe(3);expect(decoded.config.loops).toBeUndefined();expect(decoded.code_editor!.config.schedule?.rounds).toBe(2);expect(decoded.code_editor!.recovery!.config.schedule?.positions).toBe(3);
  expect(decoded.code_editor!.document).toEqual(code.document);expect(decoded.code_editor!.recovery!.document).toEqual(code.recovery!.document);expect(decoded.code_editor!.dirty).toBe(true);expect(input.config.schedule).toBeUndefined();
 });
 it('keeps unfinished numeric drafts blank instead of migrating zero substitutes',()=>{
  const config=legacy();config.loops!.inner={mode:'repeat',count:NaN};config.materials[0].inputs=[{species:'water',amount:NaN,unit:'kg'}];const draft=editor(config),next=normalizeEditorDraft(draft);
  expect(next.config.schedule).toBeUndefined();expect(next.config.loops?.inner.mode).toBe('repeat');expect((next.config.loops!.inner as {count:number}).count).toBeNaN();expect(next.config.materials[0].inputs[0].amount).toBeNaN();expect(next.document).toEqual(draft.document);expect(next.recovery!.config.materials[0].inputs[0].amount).toBeNaN();
 });
 it('retains incomplete canonical schedule values and rejects invalid recovery code structure',()=>{
  const draft=normalizeEditorDraft(editor(legacy()));draft.config.schedule!.parameters[0].value={mode:'fixed',value:NaN};
  expect((normalizeEditorDraft(draft).config.schedule!.parameters[0].value as {value:number}).value).toBeNaN();
  const invalid={...draft,recovery:{...draft.recovery!,document:{version:2,cells:[]}}} as EditorDraft;expect(()=>normalizeEditorDraft(invalid)).toThrow('恢复代码');
 });
});
