import {describe,expect,it} from 'vitest';
import {DEFAULT_CONFIG,type Config,type ReactionStageKey} from './simulation-types';
import {compileSchedule,defaultSchedule,type ParameterProfile,type Schedule,type ScheduleOverride} from './simulation-schedule';
import {setStageCondition,stageCondition,stageConditionScope} from './reaction-stage-conditions';

const stages:ReactionStageKey[]=['first_start','first_following','later_start','later_following'];
const fixed=(value:number):ParameterProfile=>({mode:'fixed',value});
const relative=(along:'path'|'round',step:number,other_step=0):ParameterProfile=>({mode:'relative',along,start:250,step,other_step});
const config=(schedule:Schedule):Config=>({...structuredClone(DEFAULT_CONFIG),species:['H2O'],materials:[{id:'initial',name:'Water',inputs:[{species:'H2O',amount:1,unit:'kg'}]}],schedule});
const base=():Schedule=>({...defaultSchedule(),positions:5,rounds:4});
const temperature=(schedule:Schedule,i:number,o:number)=>compileSchedule(config(schedule)).point(i,o).temperature_c;
const local=(value:ParameterProfile,extra:Partial<ScheduleOverride>={}):ScheduleOverride=>({id:'existing',name:'Preserve name',positions:{start:1},rounds:{start:1},parameters:[{id:'existing-temperature',target:{kind:'temperature'},value}],...extra});
const ids=(s:Schedule)=>[...s.parameters.map(p=>p.id),...s.overrides.flatMap(o=>[o.id,...o.parameters.map(p=>p.id)])];

describe('four-stage condition projection',()=>{
  it('maps the two directions independently and projects a shared fixed rule',()=>{
    expect(stages.map(stageConditionScope)).toEqual([
      {rounds:{start:1,end:1},positions:{start:1,end:1}},
      {rounds:{start:1,end:1},positions:{start:2}},
      {rounds:{start:2},positions:{start:1,end:1}},
      {rounds:{start:2},positions:{start:2}},
    ]);
    const c=config(base()),snapshot=structuredClone(c);
    for(const stage of stages)expect(stageCondition(c,stage,'temperature')).toMatchObject({profile:fixed(250),rawProfile:fixed(250),actualValue:250,complex:false,active:true,settingId:'temperature'});
    expect(c).toEqual(snapshot);
  });

  it('distinguishes a path recurrence from its per-round initialization',()=>{
    const s=base();s.parameters[0].value=relative('path',-5,10);
    const c=config(s);
    expect(stageCondition(c,'first_start','temperature')).toMatchObject({profile:fixed(250),rawProfile:relative('path',-5,10),actualValue:250,complex:false});
    expect(stageCondition(c,'first_following','temperature')).toMatchObject({profile:relative('path',-5,10),actualValue:245,complex:false});
    expect(stageCondition(c,'later_start','temperature')).toMatchObject({profile:null,rawProfile:relative('path',-5,10),actualValue:260,complex:true});
    expect(stageCondition(c,'later_following','temperature')).toMatchObject({profile:relative('path',-5,10),actualValue:255,complex:false});
    s.parameters[0].value=relative('path',-5,0);
    expect(stageCondition(config(s),'later_start','temperature').profile).toEqual(fixed(250));
  });

  it('distinguishes a round recurrence from its first-row initialization',()=>{
    const s=base();s.parameters[0].value=relative('round',-10,-5);
    const c=config(s);
    expect(stageCondition(c,'first_start','temperature').profile).toEqual(fixed(250));
    expect(stageCondition(c,'first_following','temperature')).toMatchObject({profile:null,complex:true,actualValue:245});
    expect(stageCondition(c,'later_start','temperature')).toMatchObject({profile:relative('round',-10,-5),complex:false,actualValue:240});
    expect(stageCondition(c,'later_following','temperature')).toMatchObject({profile:relative('round',-10,-5),complex:false,actualValue:235});
  });

  it.each<ParameterProfile>([
    {mode:'linear',start:250,path_step:-5,round_step:0},
    {mode:'list',along:'path',values:[250,245,240,235,230]},
  ])('keeps $mode available for full editing rather than relabelling it as a recurrence',profile=>{
    const s=base();s.parameters[0].value=profile;
    const read=stageCondition(config(s),'first_following','temperature');
    expect(read).toMatchObject({profile:null,rawProfile:profile,complex:true,settingId:'temperature',actualValue:245});
  });

  it('keeps local differences, including inactive future edits, visible as complex',()=>{
    const s=base();s.overrides=[local(fixed(123),{positions:{start:8,end:8},rounds:{start:1,end:1}})];
    const read=stageCondition(config(s),'first_following','temperature');
    expect(read).toMatchObject({profile:null,rawProfile:null,complex:true,actualValue:250,settingIds:['temperature','existing-temperature']});
    expect(stageCondition(config(s),'later_following','temperature').complex).toBe(false);
  });

  it('reads a whole-stage override without mixing in the unused general rule',()=>{
    const s={...base(),overrides:[local(fixed(120),stageConditionScope('later_start'))]};
    expect(stageCondition(config(s),'later_start','temperature')).toMatchObject({profile:fixed(120),complex:false,settingId:'existing-temperature',overrideId:'existing',settingIds:['existing-temperature']});
  });

  it('preserves incomplete inactive edits and returns no invented numerical preview',()=>{
    const s=setStageCondition({...base(),rounds:1},'later_start',{kind:'temperature'},fixed(NaN));
    const read=stageCondition(config(s),'later_start','temperature');
    expect(read.active).toBe(false);expect(read.actualValue).toBeNull();expect(read.profile).toEqual(fixed(NaN));expect(read.complex).toBe(false);
    const active=stageCondition(config({...s,rounds:2}),'later_start','temperature');
    expect(active.actualValue).toBeNull();expect(active.issue).toBeTruthy();expect(active.profile).toEqual(fixed(NaN));
  });

  it('does not project a partial local rule as uniform when its general setting is absent',()=>{
    const s=base();s.parameters=s.parameters.filter(p=>p.target.kind!=='temperature');
    s.overrides=[local(fixed(123),{positions:{start:2,end:2},rounds:{start:1,end:1}})];
    const read=stageCondition(config(s),'first_following','temperature');
    expect(read).toMatchObject({profile:null,rawProfile:null,complex:true,settingIds:['existing-temperature']});
    expect(read.actualValue).toBeNull();expect(read.issue).toBeTruthy();
  });

  it('offers the base point as an editable fallback without pretending missing general settings can execute',()=>{
    const s=base();s.parameters=[];const c=config(s);c.points[0]={...c.points[0],temperature_c:100,pressure_bar:300};
    for(const stage of stages){
      expect(stageCondition(c,stage,'temperature')).toMatchObject({profile:fixed(100),rawProfile:null,complex:false,actualValue:null,settingIds:[]});
      expect(stageCondition(c,stage,'pressure')).toMatchObject({profile:fixed(300),complex:false,actualValue:null,settingIds:[]});
      expect(stageCondition(c,stage,'temperature').issue).toBeTruthy();
    }
    c.points[0].pressure_mode='water_saturation';
    expect(stageCondition(c,'first_start','pressure')).toMatchObject({profile:{mode:'water_saturation'},complex:false,actualValue:null});
    c.points[0].temperature_c=NaN;
    expect(stageCondition(c,'first_start','temperature').profile).toEqual(fixed(NaN));
  });
});

describe('editing a stage without rewriting the other settings',()=>{
  it('runs 111 pressure positions from 700 to 150 across 40 temperature rounds',()=>{
    let s={...base(),positions:111,rounds:40};
    s=setStageCondition(s,'first_following',{kind:'pressure'},{mode:'relative',along:'path',start:700,step:-5,other_step:0});
    s=setStageCondition(s,'later_start',{kind:'temperature'},relative('round',-1));
    s=setStageCondition(s,'later_start',{kind:'pressure'},fixed(700));
    s=setStageCondition(s,'later_following',{kind:'temperature'},relative('path',0));
    s=setStageCondition(s,'later_following',{kind:'pressure'},{mode:'relative',along:'path',start:700,step:-5,other_step:0});
    const plan=compileSchedule(config(s));
    expect(plan.counts.total).toBe(4440);
    for(let o=0;o<40;o++)for(let i=0;i<111;i++)expect(plan.point(i,o)).toMatchObject({temperature_c:250-o,pressure_bar:700-5*i});
  });

  it('mixes Psat, fixed pressure and continuation in separate stages using final T',()=>{
    let s={...base(),positions:3,rounds:2};
    s=setStageCondition(s,'first_start',{kind:'pressure'},{mode:'water_saturation'});
    s=setStageCondition(s,'first_following',{kind:'pressure'},{mode:'water_saturation'});
    s=setStageCondition(s,'first_following',{kind:'temperature'},relative('path',-50));
    s=setStageCondition(s,'later_start',{kind:'pressure'},fixed(700));
    s=setStageCondition(s,'later_following',{kind:'pressure'},{mode:'relative',along:'path',start:700,step:-5,other_step:0});
    const plan=compileSchedule(config(s));
    expect(plan.point(0,0).pressure_mode).toBe('water_saturation');
    expect(plan.point(1,0).pressure_mode).toBe('water_saturation');
    expect(plan.point(1,0).pressure_bar).toBeLessThan(plan.point(0,0).pressure_bar);
    expect([0,1,2].map(i=>plan.point(i,1).pressure_bar)).toEqual([700,695,690]);
    expect(stageCondition(config(s),'first_following','pressure').profile).toEqual({mode:'water_saturation'});
  });

  it.each<ParameterProfile>([
    fixed(250),
    {mode:'linear',start:250,path_step:-2,round_step:-3},
    {mode:'list',along:'path',values:[250,240,230,220,210,200]},
    {mode:'list',along:'round',values:[250,240,230,220,210,200]},
    relative('path',-2,10),
    relative('round',-3,10),
  ])('splits $mode $along rules with open-ended stepped ranges without changing any value',profile=>{
    const s={...base(),positions:7,rounds:5,overrides:[local(profile,{positions:{start:1,step:2},rounds:{start:1,step:2}})]},snapshot=structuredClone(s);
    const edited=setStageCondition(s,'first_start',{kind:'temperature'},fixed(250));
    expect(s).toEqual(snapshot);
    for(const [positions,rounds] of [[7,5],[11,9]]){
      const before=compileSchedule(config({...s,positions,rounds})),after=compileSchedule(config({...edited,positions,rounds}));
      for(let o=0;o<rounds;o++)for(let i=0;i<positions;i++)expect(after.point(i,o)).toEqual(before.point(i,o));
    }
    expect(edited.overrides.some(o=>o.positions.start===3&&o.positions.step===2&&o.positions.end===undefined)).toBe(true);
    expect(edited.overrides.some(o=>o.rounds.start===3&&o.rounds.step===2&&o.rounds.end===undefined)).toBe(true);
    expect(new Set(ids(edited)).size).toBe(ids(edited).length);
  });

  it('retains explicit future ends and shifts only the local ordinal of a finite list',()=>{
    const s={...base(),overrides:[local({mode:'list',along:'path',values:[250,240,230,220,210,200,190]},{positions:{start:1,end:11,step:2},rounds:{start:1,end:9,step:2}})]};
    const edited=setStageCondition(s,'first_start',{kind:'temperature'},fixed(250));
    const before=compileSchedule(config({...s,positions:13,rounds:11})),after=compileSchedule(config({...edited,positions:13,rounds:11}));
    for(let o=0;o<11;o++)for(let i=0;i<13;i++)expect(after.point(i,o)).toEqual(before.point(i,o));
    expect(edited.overrides.filter(o=>o.id!=='existing').some(o=>o.positions.end===11)).toBe(true);
  });

  it('preserves unrelated targets, binding objects, identities, names and drafts in mixed groups',()=>{
    const binding={id:'dose',target:{kind:'route_fraction' as const,route_id:'a',field:'fraction' as const,bindings:[{route_id:'a',field:'fraction' as const},{route_id:'b',field:'fraction' as const}]},value:fixed(NaN)};
    const unrelated=local(fixed(50),{id:'unrelated',positions:{start:7},parameters:[{id:'unrelated-pressure',target:{kind:'pressure'},value:fixed(600)}]});
    const group=local({mode:'linear',start:250,path_step:-1,round_step:-2});group.parameters.push(binding);
    const s={...base(),overrides:[group,unrelated]},snapshot=structuredClone(s),edited=setStageCondition(s,'first_start',{kind:'temperature'},fixed(100));
    expect(s).toEqual(snapshot);expect(edited.parameters).toBe(s.parameters);
    expect(edited.overrides.find(o=>o.id==='unrelated')).toBe(unrelated);
    const retained=edited.overrides.find(o=>o.id==='existing')!;
    expect(retained).toMatchObject({name:'Preserve name',positions:group.positions,rounds:group.rounds});
    expect(retained.parameters).toEqual([binding]);expect(retained.parameters[0]).toBe(binding);
    expect(retained.parameters[0].target).toBe(binding.target);
    expect(new Set(ids(edited)).size).toBe(ids(edited).length);
  });

  it('reuses an exact stage and stable setting IDs on repeated edits',()=>{
    const first=setStageCondition(base(),'later_following',{kind:'pressure'},fixed(600));
    const second=setStageCondition(first,'later_following',{kind:'pressure'},fixed(500));
    expect(second.overrides.length).toBe(first.overrides.length);
    expect(ids(second)).toEqual(ids(first));
    expect(second.overrides[0].parameters[0].value).toEqual(fixed(500));
  });

  it('removes all old writes only inside the selected stage and retains other-stage rules',()=>{
    const s={...base(),overrides:[
      local(fixed(100),{positions:{start:2,end:2}}),
      local(fixed(150),{id:'second',positions:{start:4},parameters:[{id:'second-temperature',target:{kind:'temperature'},value:fixed(150)}]}),
    ]};
    const edited=setStageCondition(s,'later_following',{kind:'temperature'},fixed(200));
    const before=compileSchedule(config(s)),after=compileSchedule(config(edited));
    for(let o=0;o<4;o++)for(let i=0;i<5;i++)expect(after.point(i,o).temperature_c).toBe(o>0&&i>0?200:before.point(i,o).temperature_c);
  });

  it.each(stages)('changes only %s while preserving finite and open-ended stepped rules outside it',stage=>{
    const s={...base(),overrides:[local({mode:'linear',start:250,path_step:-2,round_step:-3},{positions:{start:1,end:11,step:2},rounds:{start:1,step:3}})]};
    const edited=setStageCondition(s,stage,{kind:'temperature'},fixed(100));
    const before=compileSchedule(config({...s,positions:13,rounds:11})),after=compileSchedule(config({...edited,positions:13,rounds:11}));
    for(let o=0;o<11;o++)for(let i=0;i<13;i++){
      const here:ReactionStageKey=o===0?(i===0?'first_start':'first_following'):(i===0?'later_start':'later_following');
      expect(after.point(i,o).temperature_c).toBe(here===stage?100:before.point(i,o).temperature_c);
      expect(after.point(i,o).pressure_bar).toBe(before.point(i,o).pressure_bar);
    }
  });

  it('shifts decimal profiles without introducing a spurious boundary value',()=>{
    const s={...base(),positions:4,rounds:2,overrides:[local({mode:'linear',start:.3,path_step:-.1,round_step:0})]};
    const edited=setStageCondition(s,'first_start',{kind:'temperature'},fixed(.3));
    const before=compileSchedule(config(s)),after=compileSchedule(config(edited));
    for(let o=0;o<2;o++)for(let i=0;i<4;i++)expect(after.point(i,o).temperature_c).toBe(before.point(i,o).temperature_c);
    expect(after.point(3,0).temperature_c).toBe(0);
  });

  it('lets changed starting conditions propagate through relative rules but not linear ones',()=>{
    for(const profile of [relative('path',-5),{mode:'linear',start:250,path_step:-5,round_step:0} as ParameterProfile]){
      const s=base();s.parameters[0].value=profile;
      const edited=setStageCondition(s,'first_start',{kind:'temperature'},fixed(200));
      expect(temperature(edited,1,0)).toBe(profile.mode==='relative'?195:245);
      expect(temperature(edited,1,1)).toBe(245);
    }
  });

  it.each([
    {rounds:{start:NaN,end:3},positions:{start:1,end:1}},
    {rounds:{start:1,end:NaN},positions:{start:1}},
    {rounds:{start:1},positions:{start:1,step:NaN}},
    {rounds:{start:1},positions:{start:1,step:0}},
  ])('does not erase an unfinished or invalid intersecting range: %j',scope=>{
    const s={...base(),overrides:[local(fixed(123),{id:'unfinished',...scope})]},snapshot=structuredClone(s);
    const read=stageCondition(config(s),'first_start','temperature');
    expect(read.complex).toBe(true);expect(read.profile).toBeNull();expect(read.settingIds).toContain('existing-temperature');
    expect(()=>setStageCondition(s,'first_start',{kind:'temperature'},fixed(200))).toThrow(/补全/);
    expect(s).toEqual(snapshot);
  });

  it('retains an incomplete draft when a valid dimension proves it belongs to another stage',()=>{
    const unfinished=local(fixed(123),{rounds:{start:1,end:1},positions:{start:NaN}});
    const s={...base(),overrides:[unfinished]};
    const edited=setStageCondition(s,'later_start',{kind:'temperature'},fixed(200));
    expect(edited.overrides[0]).toBe(unfinished);
    expect(edited.overrides.at(-1)!.parameters[0].value).toEqual(fixed(200));
  });
});
