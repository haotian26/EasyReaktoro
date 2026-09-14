// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import {Config,DEFAULT_CONFIG,makeRoute,readConfig,ReactionStageKey} from './simulation-types';
import {activeRouteEntries,normalizeStageRoutes,toStageConfig} from './reaction-stages';
import {controlledBy,defaultLoops,loopCounts,loopIssue,LoopTarget,targetDescription,targetKey} from './simulation-loops';
import {compileSchedule,scheduleIssue} from './simulation-schedule';
import {ReactionStageEditor} from './ReactionStageEditor';
import {LoopEditor} from './LoopEditor';
afterEach(cleanup);
const raw=():Config=>{
 const route={...makeRoute('all','material','initial'),when:'always' as const};delete route.id;
 return {...structuredClone(DEFAULT_CONFIG),species:['H2O','H+'],materials:[{id:'initial',name:'水',inputs:[{species:'H2O',amount:1,unit:'kg'}]}],loops:{...defaultLoops(),inner:{mode:'repeat',count:3},outer:{mode:'repeat',count:2}},reaction_stages:{first_start:[structuredClone(route),structuredClone(route)],first_following:[],later_start:[structuredClone(route)],later_following:[]}};
};
function Editor({initial,stage='first_start'}:{initial:Config;stage?:ReactionStageKey}){
 const [config,setConfig]=useState(initial);return <><ReactionStageEditor config={config} items={[]} selected={stage} onSelect={()=>{}} onChange={patch=>setConfig({...config,...patch})}/><output data-testid="config">{JSON.stringify(config)}</output></>;
}
const edited=():Config=>JSON.parse(screen.getByTestId('config').textContent!);

describe('imported reaction composition identities',()=>{
 it('assigns the same stable IDs at settings load and direct four-stage entry without mutating input',()=>{
  const input=raw(),snapshot=structuredClone(input),loaded=readConfig(input),direct=toStageConfig(input),ids=(c:Config)=>activeRouteEntries(c).map(e=>e.route.id);
  expect(ids(loaded)).toEqual(['first_start-route-1','first_start-route-2','later_start-route-1']);expect(ids(direct)).toEqual(ids(loaded));expect(toStageConfig(direct)).toBe(direct);expect(input).toEqual(snapshot);
 });
 it('lets a loaded no-ID row actually change and be removed without changing its neighbor',()=>{
  render(<Editor initial={readConfig(raw())}/>);fireEvent.change(screen.getByLabelText('物料 1 份数'),{target:{value:'3'}});
  expect(edited().reaction_stages!.first_start.map(r=>r.fraction)).toEqual([3,1]);fireEvent.change(screen.getByLabelText('物料 1 相态'),{target:{value:'species'}});fireEvent.click(screen.getByRole('checkbox',{name:'H2O'}));expect(edited().reaction_stages!.first_start[0].species).toEqual(['H2O']);
  fireEvent.click(screen.getByRole('button',{name:'移除物料 2'}));expect(edited().reaction_stages!.first_start).toHaveLength(1);expect(edited().reaction_stages!.later_start).toHaveLength(1);
 });
 it('reserves all explicit identities before generating missing IDs and preserves existing axis bindings',()=>{
  const c=raw();c.reaction_stages!.later_start[0].id='first_start-route-1';c.loops!.outer={mode:'list',target:{kind:'route_fraction',route_id:'first_start-route-1',field:'fraction'},values:[1,2]};const loaded=readConfig(c);
  expect(loaded.reaction_stages!.first_start[0].id).toBe('first_start-route-1-1');expect(loaded.reaction_stages!.later_start[0].id).toBe('first_start-route-1');expect(loaded.loops).toBeUndefined();expect(loaded.schedule!.parameters).toContainEqual(expect.objectContaining({target:{kind:'route_fraction',route_id:'first_start-route-1',field:'fraction'},value:{mode:'list',along:'round',values:[1,2]}}));expect(compileSchedule(loaded).valueAt({kind:'route_fraction',route_id:'first_start-route-1',field:'fraction'},0,1)).toBe(2);expect(scheduleIssue(loaded)).toBeUndefined();
 });
 it('rejects explicit duplicate or invalid IDs instead of silently retargeting quantities',()=>{
  for(const value of ['', '   ',7,null]){const c=raw();(c.reaction_stages!.first_start[0] as any).id=value;expect(()=>readConfig(c)).toThrow();expect(()=>toStageConfig(c)).toThrow();}
  const c=raw();c.reaction_stages!.first_start[0].id='duplicate';c.reaction_stages!.later_start[0].id='duplicate';expect(()=>readConfig(c)).toThrow('重复');expect(()=>toStageConfig(c)).toThrow('重复');
 });
 it('rejects hidden round gates in explicit stages while still expanding legacy gates correctly',()=>{
  const c=raw();c.reaction_stages!.later_start[0].when='first_cycle';expect(()=>readConfig(c)).toThrow('每次');expect(()=>toStageConfig(c)).toThrow('每次');
  delete c.reaction_stages;c.routes=[{...makeRoute(),when:'first_cycle'}];const converted=toStageConfig(c);expect(converted.reaction_stages!.first_start).toHaveLength(1);expect(converted.reaction_stages!.later_start).toEqual([]);
 });
});

describe('only real quantities and available results can be used in a four-stage plan',()=>{
 it('offers no unused first-feed quantity for stages, while retaining that choice in legacy settings',()=>{
  const legacy=raw();delete legacy.reaction_stages;legacy.routes=[{...makeRoute('aqueous','previous_point','initial'),id:'water'}];legacy.loops!.inner={mode:'range',target:{kind:'pressure'},start:100,end:200,step:100};
  const node=render(<LoopEditor config={legacy} definition={legacy.loops!} onChange={()=>{}}/>);const values=()=>Array.from((screen.getByLabelText('反应路径变量') as HTMLSelectElement).options,o=>o.value);
  expect(values().some(v=>v.includes('fallback_fraction'))).toBe(true);const stages=toStageConfig(legacy);node.rerender(<LoopEditor config={stages} definition={stages.loops!} onChange={()=>{}}/>);expect(values().some(v=>v.includes('fallback_fraction'))).toBe(false);
 });
 it('rejects imported no-op first-feed axes and flags an invalid alias even when another alias is valid',()=>{
  const c=normalizeStageRoutes(raw()),r=c.reaction_stages!.later_start[0];r.source='previous_cycle';r.fallback='material';const t:LoopTarget={kind:'route_fraction',route_id:r.id!,field:'fallback_fraction'};
  c.loops!.outer={mode:'list',target:t,values:[1,2]};expect(targetDescription(t,c).available).toBe(false);expect(loopIssue(c)).toContain('配方份数');
  const first={route_id:c.reaction_stages!.first_start[0].id!,field:'fraction' as const};c.loops!.outer.target={kind:'route_fraction',...first,bindings:[first,{route_id:r.id!,field:'fallback_fraction'}]};expect(loopIssue(c)).toContain('配方份数');
 });
 it('does not fall back to a fresh recipe when an explicit active stage has no previous result',()=>{
  const c=readConfig(raw()),r=c.reaction_stages!.first_start[0];
  for(const fallback of ['material','none','error'] as const){r.fallback=fallback;r.source='previous_point';expect(scheduleIssue(c)).toContain('没有前一步');r.source='previous_cycle';expect(scheduleIssue(c)).toContain('没有上一轮');r.source='output';r.point_id='loop-1';r.lag=1;expect(scheduleIssue(c)).toContain('没有上一轮');r.lag=0;expect(scheduleIssue(c)).toContain('尚未完成');}
 });
 it('validates explicit same-round sources against the earliest position that uses them and ignores dormant stages',()=>{
  const c=readConfig(raw()),r={...makeRoute('all','output','initial'),id:'output',point_id:'loop-2',lag:0};c.reaction_stages!.first_following=[r];expect(scheduleIssue(c)).toContain('尚未完成');r.point_id='loop-1';expect(scheduleIssue(c)).toBeUndefined();r.point_id='loop-100';const dormant={...c,schedule:{...c.schedule!,positions:1}};expect(scheduleIssue(dormant)).toBeUndefined();
 });
});

describe('copying and deleting controlled amounts',()=>{
 it('removes just one alias, and preserves the calculation count when the last controlled term is removed',()=>{
  const c=normalizeStageRoutes(raw()),a=c.reaction_stages!.first_start[0],b=c.reaction_stages!.later_start[0],bindings=[a,b].map(r=>({route_id:r.id!,field:'fraction' as const}));c.reaction_stages!.first_start=[a];c.loops!.inner={mode:'list',target:{kind:'route_fraction',...bindings[0],bindings},values:[1,2,3]};
  const view=render(<Editor initial={c}/>);fireEvent.click(screen.getByRole('button',{name:'移除物料 1'}));const next=edited();expect(controlledBy(next.loops!,{kind:'route_fraction',...bindings[1]})).toBe('inner');expect(loopCounts(next).inner).toBe(3);
  view.unmount();render(<Editor initial={next} stage="later_start"/>);fireEvent.click(screen.getByRole('button',{name:'移除物料 1'}));expect(edited().loops!.inner).toEqual({mode:'repeat',count:3});
 });
 it('clears a replaced unique quantity axis without changing the number of reactions',()=>{
  const c=normalizeStageRoutes(raw()),r=c.reaction_stages!.first_start[0];c.reaction_stages!.first_start=[r];c.loops!.inner={mode:'list',target:{kind:'route_fraction',route_id:r.id!,field:'fraction'},values:[1,2,3]};render(<Editor initial={c}/>);fireEvent.change(screen.getByLabelText('复制其他位置的组成'),{target:{value:'later_start'}});expect(edited().loops!.inner).toEqual({mode:'repeat',count:3});expect(edited().reaction_stages!.first_start[0].id).not.toBe(c.reaction_stages!.later_start[0].id);
 });
});

function ProcessEditor({initial}:{initial:Config}){
 const [config,setConfig]=useState(initial);return <><LoopEditor config={config} definition={config.loops!} onChange={loops=>setConfig({...config,loops})}/><ReactionStageEditor config={config} items={[]} selected="first_start" onSelect={()=>{}} onChange={patch=>setConfig({...config,...patch})}/><output data-testid="config">{JSON.stringify(config)}</output></>;
}
it('does not restore a deleted quantity from cached range or list settings',()=>{
 const c=normalizeStageRoutes(raw()),r=c.reaction_stages!.first_start[0];c.reaction_stages!.first_start=[r];c.loops!.inner={mode:'range',target:{kind:'route_fraction',route_id:r.id!,field:'fraction'},start:1,end:3,step:1};render(<ProcessEditor initial={c}/>);
 fireEvent.change(screen.getByLabelText('反应路径方式'),{target:{value:'list'}});fireEvent.change(screen.getByLabelText('反应路径方式'),{target:{value:'range'}});
 fireEvent.click(screen.getByRole('button',{name:'移除物料 1'}));expect(edited().loops!.inner).toEqual({mode:'repeat',count:3});
 fireEvent.change(screen.getByLabelText('反应路径方式'),{target:{value:'range'}});expect(edited().loops!.inner).toMatchObject({mode:'range',target:{kind:'pressure'}});expect(loopIssue(edited())).toBeUndefined();
 fireEvent.change(screen.getByLabelText('反应路径方式'),{target:{value:'list'}});expect(edited().loops!.inner).toMatchObject({mode:'list',target:{kind:'pressure'}});expect(loopIssue(edited())).toBeUndefined();
});
