// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import {Config,DEFAULT_CONFIG,makeRoute,ReactionStageKey,Route} from './simulation-types';
import {defaultLoops} from './simulation-loops';
import {inputPreview,ReactionStageEditor} from './ReactionStageEditor';
afterEach(cleanup);
const cfg=():Config=>{
 const row=(key:string):Route=>({...makeRoute('all','material','initial'),id:key});
 return {...structuredClone(DEFAULT_CONFIG),species:['H2O','H+'],materials:[{id:'initial',name:'水',inputs:[{species:'H2O',amount:1,unit:'kg'},{species:'H+',amount:0,unit:'mol'}]}],points:[1,2,3].map(n=>({id:`loop-${n}`,label:`位置 ${n}`,temperature_c:250,pressure_bar:700})),loops:{...defaultLoops(),inner:{mode:'repeat',count:3},outer:{mode:'repeat',count:2}},reaction_stages:{first_start:[row('first')],first_following:[row('following')],later_start:[row('start')],later_following:[row('later')]}};
};
function Editor({initial,stage}:{initial:Config;stage:ReactionStageKey}){const [c,setConfig]=useState(initial);return <><ReactionStageEditor config={c} items={[]} selected={stage} onSelect={()=>{}} onChange={patch=>setConfig({...c,...patch})}/><output data-testid="config">{JSON.stringify(c)}</output></>;}
const edited=():Config=>JSON.parse(screen.getByTestId('config').textContent!);
const select=(label:string)=>screen.getByLabelText(label) as HTMLSelectElement;
const option=(label:string,value:string)=>Array.from(select(label).options).find(o=>o.value===value)!;
const change=(label:string,value:string)=>fireEvent.change(select(label),{target:{value}});

describe('only existing reaction results are offered as new sources',()=>{
 it('disables other-position output at the first start without overwriting an imported selection',()=>{
  const c=cfg();Object.assign(c.reaction_stages!.first_start[0],{source:'output',point_id:'loop-2',lag:1});const original=structuredClone(c);render(<Editor initial={c} stage="first_start"/>);
  expect(option('物料 1 来源','output').disabled).toBe(true);expect(select('物料 1 来源').value).toBe('output');expect(screen.getByText('首次起点还没有反应结果，请选择composition。')).toBeTruthy();expect(edited()).toEqual(original);
 });
 it('starts a first-round following output with this round and position one',()=>{
  render(<Editor initial={cfg()} stage="first_following"/>);change('物料 1 来源','output');expect(edited().reaction_stages!.first_following[0]).toMatchObject({source:'output',lag:0,point_id:'loop-1'});
  expect(option('物料 1 来源轮次','1').disabled).toBe(true);expect(option('物料 1 来源轮次','0').disabled).toBe(false);expect(option('物料 1 来源位置','loop-1').disabled).toBe(false);expect(option('物料 1 来源位置','loop-2').disabled).toBe(true);expect(option('物料 1 来源位置','loop-3').disabled).toBe(true);
 });
 it('lets a later-round start use any previous-round position but never the unfinished current round',()=>{
  render(<Editor initial={cfg()} stage="later_start"/>);change('物料 1 来源','output');expect(edited().reaction_stages!.later_start[0]).toMatchObject({lag:1,point_id:'loop-1'});expect(option('物料 1 来源轮次','0').disabled).toBe(true);expect(option('物料 1 来源位置','loop-3').disabled).toBe(false);change('物料 1 来源位置','loop-3');expect(edited().reaction_stages!.later_start[0].point_id).toBe('loop-3');
 });
 it('selects a valid position when the user changes from previous round to this round',()=>{
  render(<Editor initial={cfg()} stage="later_following"/>);change('物料 1 来源','output');change('物料 1 来源位置','loop-3');change('物料 1 来源轮次','0');expect(edited().reaction_stages!.later_following[0]).toMatchObject({lag:0,point_id:'loop-1'});expect(option('物料 1 来源位置','loop-3').disabled).toBe(true);
  change('物料 1 来源轮次','1');expect(edited().reaction_stages!.later_following[0].point_id).toBe('loop-1');expect(option('物料 1 来源位置','loop-3').disabled).toBe(false);
 });
 it('preserves an invalid imported point through unrelated edits and explains how to repair it',()=>{
  const c=cfg();Object.assign(c.reaction_stages!.later_following[0],{source:'output',point_id:'loop-2',lag:0});render(<Editor initial={c} stage="later_following"/>);expect(select('物料 1 来源位置').value).toBe('loop-2');expect(option('物料 1 来源位置','loop-2').disabled).toBe(true);expect(screen.getByText('这类反应从位置 2 开始，此时本轮只有位置 1 已完成。')).toBeTruthy();
  change('物料 1 相态','aqueous');expect(edited().reaction_stages!.later_following[0]).toMatchObject({lag:0,point_id:'loop-2'});change('物料 1 来源轮次','1');expect(edited().reaction_stages!.later_following[0]).toMatchObject({lag:1,point_id:'loop-2'});expect(screen.queryByText('这类反应从位置 2 开始，此时本轮只有位置 1 已完成。')).toBeNull();
 });
 it('keeps unavailable imported point and round values visible until the user replaces them',()=>{
  const c=cfg();Object.assign(c.reaction_stages!.first_following[0],{source:'output',point_id:'removed-point',lag:1});render(<Editor initial={c} stage="first_following"/>);expect(select('物料 1 来源位置').value).toBe('removed-point');expect(option('物料 1 来源位置','removed-point').disabled).toBe(true);expect(select('物料 1 来源轮次').value).toBe('1');expect(screen.getByText('第一轮没有上一轮结果，请改选本轮已完成的结果。')).toBeTruthy();
  change('物料 1 来源轮次','0');expect(edited().reaction_stages!.first_following[0]).toMatchObject({lag:0,point_id:'loop-1'});
 });
 it('can repair a removed prior-round position without changing the selected round',()=>{
  const c=cfg();Object.assign(c.reaction_stages!.later_start[0],{source:'output',point_id:'removed-point',lag:1});render(<Editor initial={c} stage="later_start"/>);expect(screen.getByText('来源位置已不在当前路径中，请重新选择。')).toBeTruthy();change('物料 1 来源位置','loop-2');expect(edited().reaction_stages!.later_start[0]).toMatchObject({lag:1,point_id:'loop-2'});
 });
});

describe('fresh-input previews identify which variable reaction they represent',()=>{
 it('marks a changing recipe multiplier as the first occurrence of this stage',()=>{
  const c=cfg();c.loops!.inner={mode:'list',target:{kind:'route_fraction',route_id:'following',field:'fraction'},values:[1,2,3]};render(<Editor initial={c} stage="first_following"/>);expect(screen.getByText(/本类首次反应实际加入：H2O 2 kg/)).toBeTruthy();expect(inputPreview(c,c.reaction_stages!.first_following[0],'first_following',[],[2,0])).toBe('H2O 3 kg');
 });
 it('marks a changing material amount even when the recipe multiplier itself is constant',()=>{
  const c=cfg();c.loops!.inner={mode:'list',target:{kind:'material_amount',material_id:'initial',species:'H2O'},values:[1,2,3]};render(<Editor initial={c} stage="first_following"/>);expect(screen.getByText('本类首次反应实际加入：H2O 2 kg')).toBeTruthy();
 });
 it('does not imply every reaction is empty when the first occurrence has zero input',()=>{
  const c=cfg();c.loops!.inner={mode:'list',target:{kind:'material_amount',material_id:'initial',species:'H2O'},values:[0,0,2]};render(<Editor initial={c} stage="first_following"/>);expect(screen.getByText('本类首次反应实际加入：无')).toBeTruthy();expect(screen.queryByText('当前选择没有可加入的物质。')).toBeNull();expect(inputPreview(c,c.reaction_stages!.first_following[0],'first_following',[],[2,0])).toBe('H2O 2 kg');
 });
 it('does not label a constant selected contribution as varying when only an excluded species changes',()=>{
  const c=cfg();Object.assign(c.reaction_stages!.first_following[0],{phase:'species',species:['H2O']});c.loops!.inner={mode:'list',target:{kind:'material_amount',material_id:'initial',species:'H+'},values:[0,1,2]};render(<Editor initial={c} stage="first_following"/>);expect(screen.getByText('实际加入：H2O 1 kg')).toBeTruthy();expect(screen.queryByText(/本类首次反应实际加入/)).toBeNull();
 });
});
