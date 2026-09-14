import {describe,it,expect} from 'vitest';
import {Config,DEFAULT_CONFIG,makeRoute} from './simulation-types';
import {defaultSchedule,scheduleIssue,type ParameterSetting} from './simulation-schedule';
import {atomicTargets,copyRouteParameterReferences,removeParameterReferences,restoreRemovedScheduleReferences} from './schedule-references';
import {reactionSourceIssue,toStageConfig} from './reaction-stages';

const material=(species='salt'):ParameterSetting=>({id:`amount-${species}`,target:{kind:'material_amount',material_id:'initial',species},value:{mode:'linear',start:1,path_step:2,round_step:3}});
const fraction=(id:string,route_id:string):ParameterSetting=>({id,target:{kind:'route_fraction',route_id,field:'fraction'},value:{mode:'fixed',value:.5}});
const config=():Config=>({...structuredClone(DEFAULT_CONFIG),schedule:{...defaultSchedule(),positions:4,rounds:3}});
describe('schedule reference transforms',()=>{
 it('removes only atomic route references and keeps unrelated parameters and scope metadata',()=>{
  const c=config();const shared=fraction('shared','remove');shared.target={kind:'route_fraction',route_id:'remove',field:'fraction',bindings:[{route_id:'remove',field:'fraction'},{route_id:'keep',field:'fraction'}]};c.schedule!.parameters.push(shared);
  c.schedule!.overrides=[{id:'both',name:'temperature and feed',rounds:{start:2,end:2},positions:{start:2,end:4},parameters:[fraction('delete','remove'),{id:'local-t',target:{kind:'temperature'},value:{mode:'fixed',value:300}}]},{id:'empty-after',rounds:{start:1},positions:{start:1},parameters:[fraction('only','remove')]}];
  const next=removeParameterReferences(c,t=>t.kind==='route_fraction'&&t.route_id==='remove').schedule!;
  expect(next.parameters.find(p=>p.id==='shared')!.target).toEqual({kind:'route_fraction',route_id:'keep',field:'fraction'});
  expect(next.overrides.map(g=>g.id)).toEqual(['both']);expect(next.overrides[0]).toEqual({...c.schedule!.overrides[0],parameters:[c.schedule!.overrides[0].parameters[1]]});
  expect(next.positions).toBe(4);expect(next.rounds).toBe(3);expect(atomicTargets(c.schedule!.parameters.at(-1)!.target)).toHaveLength(2);
 });
 it('copies general quantity profiles independently without cloning local ranges or other targets',()=>{
  const c=config();c.schedule!.parameters.push(fraction('source-quantity','source'),fraction('old-quantity','destination'),material());
  c.schedule!.overrides=[{id:'source-exception',rounds:{start:2,end:2},positions:{start:3,end:3},parameters:[fraction('local-source','source')]},{id:'mixed-destination',rounds:{start:1},positions:{start:1},parameters:[fraction('local-dest','destination'),{id:'keep-pressure',target:{kind:'pressure'},value:{mode:'fixed',value:80}}]}];
  const next=copyRouteParameterReferences(c,new Map([['source','copied']]),new Set(['destination'])).schedule!;
  expect(next.parameters.map(p=>p.id)).not.toContain('old-quantity');expect(next.parameters.find(p=>p.id==='source-quantity-copy')).toEqual({...fraction('source-quantity-copy','copied')});
  expect(next.overrides[0]).toEqual(c.schedule!.overrides[0]);expect(next.overrides[1].parameters.map(p=>p.id)).toEqual(['keep-pressure']);
  expect(next.overrides.flatMap(g=>g.parameters).some(p=>atomicTargets(p.target).some(t=>t.kind==='route_fraction'&&t.route_id==='copied'))).toBe(false);
  (next.parameters.find(p=>p.id==='source-quantity-copy')!.value as {value:number}).value=.8;
  expect(c.schedule!.parameters.find(p=>p.id==='source-quantity')!.value).toEqual({mode:'fixed',value:.5});
 });
 it('restores removed settings by ID while preserving later temperature, scope and count edits',()=>{
  const c=config();c.schedule!.parameters.push(material());c.schedule!.overrides=[{id:'mixed',name:'local',rounds:{start:2,end:2},positions:{start:1,end:2},parameters:[{...material(),id:'local-salt'},{id:'local-t',target:{kind:'temperature'},value:{mode:'fixed',value:310}}]},{id:'removed-group',rounds:{start:3,end:3},positions:{start:1},parameters:[{...material(),id:'third-salt'}]}];
  const after=removeParameterReferences(c,t=>t.kind==='material_amount').schedule!;const edited=structuredClone(after);edited.positions=6;edited.parameters[0].value={mode:'fixed',value:180};edited.overrides[0].name='renamed';edited.overrides[0].positions={start:2,end:4};edited.overrides[0].parameters[0].value={mode:'fixed',value:333};
  const next=restoreRemovedScheduleReferences(edited,c.schedule!,after);
  expect(next.positions).toBe(6);expect(next.parameters[0].value).toEqual({mode:'fixed',value:180});expect(next.parameters.find(p=>p.id==='amount-salt')).toEqual(material());
  expect(next.overrides.find(g=>g.id==='mixed')).toMatchObject({name:'renamed',positions:{start:2,end:4}});expect(next.overrides[0].parameters.find(p=>p.id==='local-t')!.value).toEqual({mode:'fixed',value:333});expect(next.overrides[0].parameters.some(p=>p.id==='local-salt')).toBe(true);
  expect(next.overrides.find(g=>g.id==='removed-group')).toEqual(c.schedule!.overrides[1]);
 });
 it('does not restore over a new setting of the same input or an intentionally reused parameter ID',()=>{
  const c=config();c.schedule!.parameters.push(material());const after=removeParameterReferences(c,t=>t.kind==='material_amount').schedule!;
  const edited=structuredClone(after);edited.parameters.push({...material(),id:'new-salt',value:{mode:'fixed',value:12}});
  expect(restoreRemovedScheduleReferences(edited,c.schedule!,after).parameters.filter(p=>p.target.kind==='material_amount')).toEqual([edited.parameters.at(-1)]);
  const reused=structuredClone(after);reused.parameters.push({...material('water'),id:'amount-salt'});
  expect(restoreRemovedScheduleReferences(reused,c.schedule!,after).parameters.at(-1)!.target).toEqual(material('water').target);
 });
 it('restores part of a binding without overwriting its later quantity edit',()=>{
  const c=config(),shared=fraction('shared','a');shared.target={kind:'route_fraction',route_id:'a',field:'fraction',bindings:[{route_id:'a',field:'fraction'},{route_id:'b',field:'fraction'}]};c.schedule!.parameters.push(shared);
  const after=removeParameterReferences(c,t=>t.kind==='route_fraction'&&t.route_id==='a').schedule!,edited=structuredClone(after);edited.parameters.at(-1)!.value={mode:'fixed',value:.25};
  const restored=restoreRemovedScheduleReferences(edited,c.schedule!,after).parameters.at(-1)!;
  expect(atomicTargets(restored.target).map(t=>'route_id' in t?t.route_id:'')).toEqual(['b','a']);expect(restored.value).toEqual({mode:'fixed',value:.25});
 });
 it('keeps an unmapped alias visible to validation when another alias migrates successfully',()=>{
  const c=config();c.routes=[{...makeRoute('all','material'),id:'real'}];
  c.schedule!.parameters.push({...fraction('mixed','real'),target:{kind:'route_fraction',route_id:'real',field:'fraction',bindings:[{route_id:'real',field:'fraction'},{route_id:'missing',field:'fraction'}]}});
  const next=toStageConfig(c),target=next.schedule!.parameters.find(p=>p.id==='mixed')!.target;
  expect(atomicTargets(target)).toContainEqual({kind:'route_fraction',route_id:'missing',field:'fraction'});expect(atomicTargets(target)).toHaveLength(5);
  expect(scheduleIssue(next)).toBe('通常设置中的参数已移除，请重新选择或删除该项。');
 });
 it('maps legacy regular and first-charge schedule references when expanding actual stage inputs',()=>{
  const c=config();c.routes=[{...makeRoute('all','previous_point'),id:'flow',fraction:.8,fallback:'material',fallback_fraction:.2}];
  c.schedule!.parameters.push({...fraction('first','flow'),target:{kind:'route_fraction',route_id:'flow',field:'fallback_fraction'}},fraction('following','flow'));
  c.schedule!.overrides=[{id:'local',rounds:{start:2,end:2},positions:{start:2,end:2},parameters:[fraction('local-flow','flow')]}];
  const next=toStageConfig(c);expect(atomicTargets(next.schedule!.parameters.find(p=>p.id==='first')!.target)).toEqual([{kind:'route_fraction',route_id:'first_start-flow',field:'fraction'},{kind:'route_fraction',route_id:'later_start-flow',field:'fraction'}]);
  expect(atomicTargets(next.schedule!.parameters.find(p=>p.id==='following')!.target)).toEqual([{kind:'route_fraction',route_id:'first_following-flow',field:'fraction'},{kind:'route_fraction',route_id:'later_following-flow',field:'fraction'}]);
  expect(next.schedule!.overrides[0].rounds).toEqual({start:2,end:2});expect(next.reaction_stages!.first_start[0].fraction).toBe(.2);expect(c.reaction_stages).toBeUndefined();
 });
});
describe('reaction source availability',()=>{
 const staged=()=>toStageConfig(config());
 it('rejects earlier-result sources where that result does not yet exist',()=>{
  const c=staged();c.reaction_stages!.first_start[0].source='previous_point';expect(reactionSourceIssue(c,{inner:4,outer:3})).toContain('没有前一步');
  c.reaction_stages!.first_start[0].source='previous_cycle';expect(reactionSourceIssue(c,{inner:4,outer:3})).toContain('没有上一轮');
 });
 it('rejects future and out-of-range outputs but preserves an inactive group for later editing',()=>{
  const c=staged();c.reaction_stages!.first_following=[{...makeRoute('all','output'),id:'future',point_id:'loop-3',lag:0}];
  expect(reactionSourceIssue(c,{inner:4,outer:1})).toContain('尚未完成');expect(reactionSourceIssue(c,{inner:1,outer:1})).toBeUndefined();
  c.reaction_stages!.first_following[0].point_id='loop-5';expect(reactionSourceIssue(c,{inner:4,outer:1})).toContain('超出');
  c.reaction_stages!.first_following[0].point_id='old-id';expect(reactionSourceIssue(c,{inner:4,outer:1})).toContain('不属于');
  c.reaction_stages!.first_following[0].point_id='loop-1';expect(reactionSourceIssue(c,{inner:4,outer:1})).toBeUndefined();
 });
});
