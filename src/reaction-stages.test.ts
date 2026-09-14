import {describe,expect,it} from 'vitest';
import {DEFAULT_CONFIG,Config,Route} from './simulation-types';
import {activeRouteEntries,stageAt,stageKeys,toStageConfig} from './reaction-stages';
import {controlledBy,defaultLoops,Loop,LoopTarget,loopIssue,routeTargetBindings,targetDescription,targetKey} from './simulation-loops';

const route=(id:string,source:Route['source'],phase:Route['phase'],material_id:string,extra:Partial<Route>={}):Route=>({id,source,phase,material_id,fraction:1,fallback:'material',fallback_fraction:1,when:'always',...extra});
const config=(routes:Route[]):Config=>({...structuredClone(DEFAULT_CONFIG),species:['H2O','Quartz','Tracer'],materials:[{id:'water',name:'流体',inputs:[{species:'H2O',amount:10,unit:'mol'}]},{id:'rock',name:'岩石',inputs:[{species:'Quartz',amount:2,unit:'mol'}]},{id:'tracer',name:'示踪剂',inputs:[{species:'Tracer',amount:1,unit:'mol'}]}],routes,loops:{...defaultLoops(DEFAULT_CONFIG.points[0]),inner:{mode:'repeat',count:3},outer:{mode:'repeat',count:2}}});
const amounts={water:{H2O:10},rock:{Quartz:2},tracer:{Tracer:1}} as Record<string,Record<string,number>>;
const outputs=[ [{H2O:8,Quartz:1},{H2O:7,Quartz:.8},{H2O:6,Quartz:.5}], [{H2O:9,Quartz:.7},{H2O:8,Quartz:.4},{H2O:7,Quartz:.2}] ] as Record<string,number>[][];
// A fixed set of chemically distinguishable inventories makes a wrong source, phase, or amount observable.
function inputAt(c:Config,ii:number,oi:number){
  const rules=c.reaction_stages?.[stageAt(ii,oi)]||c.routes,received:Record<string,number>={};
  for(const r of rules){
    if(r.when==='first_cycle'&&oi!==0||r.when==='after_first_cycle'&&oi===0)continue;
    let inventory:Record<string,number>|undefined;
    if(r.source==='previous_point'&&ii>0)inventory=outputs[oi][ii-1];
    if(r.source==='previous_cycle'&&oi>0)inventory=outputs[oi-1][ii];
    if(r.source==='output'&&oi>=(r.lag||0))inventory=outputs[oi-(r.lag||0)][Number(r.point_id!.slice(5))-1];
    if(!inventory&&r.source!=='material'&&r.fallback==='none')continue;
    if(!inventory&&r.source!=='material'&&r.fallback==='error')throw new Error('missing source');
    const factor=inventory?r.fraction:r.source==='material'?r.fraction:r.fallback_fraction;
    inventory ||= amounts[r.material_id];
    for(const [name,value] of Object.entries(inventory)){
      const selected=r.phase==='all'||r.phase==='species'&&r.species?.includes(name)||r.phase==='aqueous'&&name==='H2O'||r.phase==='mineral'&&name==='Quartz';
      if(selected)received[name]=(received[name]||0)+factor*value;
    }
  }
  return received;
}
function applyRouteAxis(c:Config,loop:Loop,index:number):Config{
  if(loop.mode==='repeat'||loop.target.kind!=='route_fraction')return c;
  const next=structuredClone(c),value=loop.mode==='list'?loop.values[index]:loop.start+loop.step*index;
  for(const binding of routeTargetBindings(loop.target))for(const {route:r,index:i} of activeRouteEntries(next))if((r.id||`route-${i+1}`)===binding.route_id)r[binding.field]=value;
  return next;
}
const axis=(route_id:string,field:'fraction'|'fallback_fraction',values:number[]):Loop=>({mode:'list',target:{kind:'route_fraction',route_id,field},values});
const target=(loop:Loop)=>{if(loop.mode==='repeat')throw new Error('expected variable');return loop.target;};

describe('four reaction compositions',()=>{
  it('preserves the four different HCh-style water–rock inputs at every position',()=>{
    const before=config([route('fluid','previous_point','aqueous','water'),route('rock','previous_cycle','mineral','rock')]),snapshot=structuredClone(before),after=toStageConfig(before);
    expect(inputAt(after,0,0)).toEqual({H2O:10,Quartz:2});
    expect(inputAt(after,1,0)).toEqual({H2O:8,Quartz:2});
    expect(inputAt(after,0,1)).toEqual({H2O:10,Quartz:1});
    expect(inputAt(after,1,1)).toEqual({H2O:9,Quartz:.8});
    for(let oi=0;oi<2;oi++)for(let ii=0;ii<3;ii++)expect(inputAt(after,ii,oi)).toEqual(inputAt(before,ii,oi));
    const fresh=activeRouteEntries(after).filter(e=>e.route.source==='material');
    const waterFresh=fresh.filter(e=>e.route.material_id==='water').reduce((n,e)=>n+(e.stage?.endsWith('following')?2:1),0);
    const rockFresh=fresh.filter(e=>e.route.material_id==='rock').reduce((n,e)=>n+(e.stage?.endsWith('following')?2:1),0);
    expect([waterFresh,rockFresh]).toEqual([2,3]);
    expect(before).toEqual(snapshot);expect(after.routes).toBe(before.routes);expect(after.points).toBe(before.points);
  });
  it('expands round restrictions, omits absent inputs, and keeps missing-source errors visible',()=>{
    const before=config([route('initial','material','all','tracer',{when:'first_cycle'}),route('return','previous_point','aqueous','water',{when:'after_first_cycle',fallback:'none'}),route('invalid','previous_cycle','all','rock',{fallback:'error'})]),after=toStageConfig(before);
    expect(after.reaction_stages!.first_start.map(r=>r.id)).toEqual(['first_start-initial','first_start-invalid']);
    expect(after.reaction_stages!.later_start.map(r=>r.id)).toEqual(['later_start-invalid']);
    expect(after.reaction_stages!.later_following.map(r=>r.id)).toEqual(['later_following-return','later_following-invalid']);
    expect(after.reaction_stages!.first_start[1]).toMatchObject({source:'previous_cycle',fallback:'error',when:'always'});
    expect(()=>inputAt(after,0,0)).toThrow('missing source');
    expect(activeRouteEntries(after).every(e=>e.route.when==='always')).toBe(true);
  });
  it('preserves recipe fallback amounts for a specific previous-round result',()=>{
    const before=config([route('specific','output','mineral','rock',{point_id:'loop-1',lag:1,fraction:.25,fallback_fraction:3})]),after=toStageConfig(before);
    expect(inputAt(after,0,0)).toEqual({Quartz:6});expect(inputAt(after,2,0)).toEqual({Quartz:6});expect(inputAt(after,2,1)).toEqual({Quartz:.25});
    expect(after.reaction_stages!.later_following[0]).toMatchObject({source:'output',point_id:'loop-1',lag:1,fraction:.25});
  });
  it('creates deterministic independent identities without changing already explicit compositions',()=>{
    const before=config([route('same','material','species','tracer',{species:['Tracer']})]),after=toStageConfig(before),again=toStageConfig(before);
    const ids=activeRouteEntries(after).map(e=>e.route.id);expect(new Set(ids).size).toBe(4);expect(ids).toEqual(activeRouteEntries(again).map(e=>e.route.id));
    after.reaction_stages!.first_start[0].species!.push('Quartz');expect(after.reaction_stages!.later_start[0].species).toEqual(['Tracer']);expect(before.routes[0].species).toEqual(['Tracer']);expect(toStageConfig(after)).toBe(after);
    expect(stageKeys.map((_,i)=>stageAt(i%2,Math.floor(i/2)))).toEqual(stageKeys);
  });
  it('does not discard legacy per-position inputs but ignores inactive legacy routes when loops are present',()=>{
    const c=config([route('fluid','material','all','water')]);c.points[0].routes=[route('other','material','all','rock')];expect(()=>toStageConfig(c)).not.toThrow();delete c.loops;expect(()=>toStageConfig(c)).toThrow('逐步路线');
  });
  it('uses only the selected composition once stages exist',()=>{
    const c=toStageConfig(config([route('fluid','material','all','water')]));c.reaction_stages!.first_start.push(route('once','material','all','tracer'));c.reaction_stages!.later_following=[];
    expect(inputAt(c,0,0)).toEqual({H2O:10,Tracer:1});expect(inputAt(c,1,0)).toEqual({H2O:10});expect(inputAt(c,1,1)).toEqual({});expect(c.routes).toHaveLength(1);
  });
});

describe('quantity axes remain chemically equivalent after conversion',()=>{
  it('maps a fresh recipe multiplier to every applicable stage while preserving each applied amount',()=>{
    const before=config([route('water','material','aqueous','water')]);before.loops!.inner=axis('water','fraction',[.5,1,2]);const after=toStageConfig(before),t=target(after.loops!.inner);
    expect(t.kind==='route_fraction'&&t.bindings).toHaveLength(4);
    for(let oi=0;oi<2;oi++)for(let ii=0;ii<3;ii++)expect(inputAt(applyRouteAxis(after,after.loops!.inner,ii),ii,oi)).toEqual({H2O:[5,10,20][ii]});
    expect(loopIssue(after)).toBeUndefined();
  });
  it('keeps initial fresh-fluid amounts separate from fractions transferred along the path',()=>{
    const before=config([route('fluid','previous_point','aqueous','water',{fraction:.4,fallback_fraction:2})]);before.loops!.inner=axis('fluid','fraction',[.2,.4,.6]);before.loops!.outer=axis('fluid','fallback_fraction',[1,3]);const after=toStageConfig(before);
    expect(loopIssue(after)).toBeUndefined();
    for(let oi=0;oi<2;oi++)for(let ii=0;ii<3;ii++){
      const oldAt=applyRouteAxis(applyRouteAxis(before,before.loops!.inner,ii),before.loops!.outer,oi),newAt=applyRouteAxis(applyRouteAxis(after,after.loops!.inner,ii),after.loops!.outer,oi);
      expect(inputAt(newAt,ii,oi)).toEqual(inputAt(oldAt,ii,oi));
    }
    const start=after.reaction_stages!.first_start[0],following=after.reaction_stages!.later_following[0];
    expect(controlledBy(after.loops!,{kind:'route_fraction',route_id:start.id!,field:'fraction'})).toBe('outer');expect(controlledBy(after.loops!,{kind:'route_fraction',route_id:following.id!,field:'fraction'})).toBe('inner');
  });
  it('checks every shared target, including a non-primary transfer fraction and overlapping axes',()=>{
    const c=toStageConfig(config([route('fresh','material','aqueous','water')]));const first=c.reaction_stages!.first_start[0],later=c.reaction_stages!.later_following[0];later.source='previous_point';
    const a={route_id:first.id!,field:'fraction' as const},b={route_id:later.id!,field:'fraction' as const};
    c.loops!.inner={mode:'list',target:{kind:'route_fraction',...a,bindings:[a,b]},values:[1,2]};expect(loopIssue(c)).toContain('0–1');
    c.loops!.inner.values=[.25,.5];c.loops!.outer={mode:'list',target:{kind:'route_fraction',...b},values:[.2,.4]};expect(loopIssue(c)).toContain('同一个量');
    c.loops!.outer={mode:'repeat',count:2};c.reaction_stages!.later_following=[];expect(targetDescription(target(c.loops!.inner),c).available).toBe(false);expect(loopIssue(c)).toContain('已移除');
  });
  it('rejects malformed bindings and preserves stale quantity targets rather than replacing them',()=>{
    const c=toStageConfig(config([route('water','material','aqueous','water')])),r=c.reaction_stages!.first_start[0],binding={route_id:r.id!,field:'fraction' as const};
    const good:LoopTarget={kind:'route_fraction',...binding};
    for(const bindings of [[],[binding,binding],[{route_id:'missing',field:'fraction'}]])expect(targetDescription({...good,bindings} as LoopTarget,c).available).toBe(false);
    const before=config([route('water','material','aqueous','water')]);before.loops!.inner=axis('water','fallback_fraction',[1,2]);expect(loopIssue(toStageConfig(before))).toContain('配方份数');
  });
  it('uses active-stage identities rather than old preserved rules for descriptions and output references',()=>{
    const c=toStageConfig(config([route('water','material','aqueous','water')])),r=c.reaction_stages!.first_start[0];c.routes=[route('old','output','all','water',{point_id:'missing',lag:1})];
    expect(loopIssue(c)).toBeUndefined();expect(targetDescription({kind:'route_fraction',route_id:r.id!,field:'fraction'},c)).toMatchObject({available:true,label:'首次起点 · 流体 · 配方份数'});
    const later=c.reaction_stages!.later_start[0];later.source='output';later.point_id='loop-100';later.lag=1;expect(loopIssue(c)).toContain('超出反应路径');
  });
  it('preserves dormant output rules without letting them block a smaller calculation',()=>{
    const c=toStageConfig(config([route('water','material','aqueous','water')]));
    c.reaction_stages!.first_following=[route('next','output','all','water',{point_id:'loop-1',lag:0})];
    c.reaction_stages!.later_start=[route('next-round','output','all','water',{point_id:'loop-3',lag:1})];
    c.reaction_stages!.later_following=[route('both','output','all','water',{point_id:'old-point',lag:1})];
    const original=structuredClone(c.reaction_stages);
    c.loops!.inner={mode:'repeat',count:1};c.loops!.outer={mode:'repeat',count:1};expect(loopIssue(c)).toBeUndefined();expect(c.reaction_stages).toEqual(original);
    c.loops!.inner={mode:'repeat',count:3};expect(loopIssue(c)).toBeUndefined();
    c.loops!.inner={mode:'repeat',count:1};c.loops!.outer={mode:'repeat',count:2};expect(loopIssue(c)).toContain('超出反应路径');
    c.loops!.inner={mode:'repeat',count:3};expect(loopIssue(c)).toContain('不属于当前反应路径');
  });
  it('still checks the identity and mathematical domain of an axis bound to a dormant position',()=>{
    const c=toStageConfig(config([route('fluid','previous_point','aqueous','water')])),r=c.reaction_stages!.later_following[0];
    c.loops!.inner={mode:'list',target:{kind:'route_fraction',route_id:r.id!,field:'fraction'},values:[2]};c.loops!.outer={mode:'repeat',count:1};expect(loopIssue(c)).toContain('0–1');
    c.loops!.inner.values=[.5];expect(loopIssue(c)).toBeUndefined();c.reaction_stages!.later_following=[];expect(loopIssue(c)).toContain('已移除');
  });
  it('keeps one-target keys compatible and identifies alias groups independently of binding order',()=>{
    const a={route_id:'a',field:'fraction' as const},b={route_id:'b',field:'fraction' as const};expect(targetKey({kind:'route_fraction',...a,bindings:[a]})).toBe(targetKey({kind:'route_fraction',...a}));expect(targetKey({kind:'route_fraction',...a,bindings:[a,b]})).toBe(targetKey({kind:'route_fraction',...b,bindings:[b,a]}));
  });
});
