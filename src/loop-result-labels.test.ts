import explorerHTML from '../bridge/easyreaktoro_runtime/result_explorer.html?raw';
import vm from 'node:vm';
import {expect,it} from 'vitest';
it('uses saved loop variable names and units without leaking labels into a later dataset',()=>{
 const parser=explorerHTML.slice(explorerHTML.indexOf('"use strict";'),explorerHTML.indexOf('// View state only;'));
 const context=vm.createContext({document:{documentElement:{lang:'zh-CN'}}});
 vm.runInContext(parser+';globalThis.inspectPayload=p=>{model=buildModel(p);return {label:withUnit("state:inner_value"),unit:model.byState.get("state:inner_value").unit};};',context);
 const data={format:'result-explorer-1',key_columns:['run_index'],summary:{columns:['run_index','step','inner_value'],rows:[[1,1,.1],[2,2,.2]]},species_tables:[],metadata:{field_info:{inner_value:['盐水 · NaCl 投料量','Brine · NaCl input amount','mol']}}};
 expect(context.inspectPayload(data)).toEqual({label:'盐水 · NaCl 投料量 / mol',unit:'mol'});
 expect(context.inspectPayload({...data,metadata:{}})).toEqual({label:'路径变量值',unit:''});
 expect(context.inspectPayload({...data,metadata:{field_info:{inner_value:[{},false,'mol']}}}).label).toBe('路径变量值');
});
