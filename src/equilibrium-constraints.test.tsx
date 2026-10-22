// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG,readConfig,type Config,type EquilibriumConstraint,type SimSpecies} from './simulation-types';
import {compileSchedule,defaultSchedule,type ParameterSetting} from './simulation-schedule';
import {constraintActiveAt,removeConstraint} from './equilibrium-constraints';
import {actualVariationSummaries} from './schedule-reading';
import {targetKey} from './simulation-loops';
import {referenceKey} from './schedule-references';
import {decodeDocument,encodeDraft} from './simulation-history';
import {ScheduleEditor} from './ScheduleEditor';
import {SimulationConditions} from './SimulationConditions';
import {SchedulePreview} from './SchedulePreview';
import {setLanguage} from './i18n';

beforeEach(()=>setLanguage('zh-CN'));afterEach(()=>{cleanup();setLanguage('zh-CN');});
function base():Config{return {...structuredClone(DEFAULT_CONFIG),activity_model:'ideal',species:['H2O','H+','OH-'],materials:[{id:'initial',name:'Water',inputs:[{species:'H2O',amount:1,unit:'kg'}]}],schedule:{...defaultSchedule({temperature_c:25,pressure_bar:1}),positions:4,rounds:3}};}
const ph=(id='ph',value=7):Extract<EquilibriumConstraint,{kind:'ph'}>=>({id,kind:'ph',value,titrant:'HCl',exchange:'add_only'});
const gas=(id='gas',value=1):Extract<EquilibriumConstraint,{kind:'fugacity'}>=>({id,kind:'fugacity',value,species:'CO2(g)'});
const target=(id:string)=>({kind:'equilibrium_constraint' as const,constraint_id:id});
const setting=(id:string,value:number):ParameterSetting=>({id:'value-'+id,target:target(id),value:{mode:'fixed',value}});
const items:SimSpecies[]=[
 {name:'H2O',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null},
 {name:'CO2(g)',formula:'CO2',phase:'gas',charge:0,elements:['C','O'],is_water:false,disabled:false,reason:'',ion_size:null},
 {name:'CO2(aq)',formula:'CO2',phase:'aqueous',charge:0,elements:['C','O'],is_water:false,disabled:false,reason:'',ion_size:null},
 {name:'Charged(g)',formula:'H+',phase:'gas',charge:1,elements:['H'],is_water:false,disabled:false,reason:'',ion_size:null},
];
let latest:Config;
function Editor({initial=base(),whole=false}:{initial?:Config;whole?:boolean}){
 const [config,set]=useState(initial);latest=config;const patch=(p:Partial<Config>)=>set(c=>({...c,...p}));
 return whole?<SimulationConditions config={config} patch={patch} items={items} disabled={false} onError={vi.fn()}/>:<ScheduleEditor config={config} schedule={config.schedule!} items={items} onChange={schedule=>patch({schedule})} onConfigChange={patch}/>;
}

it('accepts negative pH without silently clipping it, including through settings import',()=>{
 const c=base();c.equilibrium_constraints=[ph('acid',-1)];c.schedule!.parameters.push({id:'acid-series',target:target('acid'),value:{mode:'linear',start:-2,path_step:.5,round_step:0}});
 const imported=readConfig(encodeDraft(c)),plan=compileSchedule(imported);
 expect([0,1,2,3].map(i=>plan.valueAt(target('acid'),i,0))).toEqual([-2,-1.5,-1,-.5]);
});
it.each([0,-1])('requires positive fugacity when the target is active: %s bar',value=>{
 const c=base();c.equilibrium_constraints=[gas('co2',value)];
 expect(()=>compileSchedule(c)).toThrow(/逸度须大于 0/);
});
it('checks fugacity values only where the target applies, including local overrides',()=>{
 const c=base();c.equilibrium_constraints=[{...gas('co2',-1),rounds:{start:2,end:2},positions:{start:2,end:3}}];
 c.schedule!.parameters.push(setting('co2',NaN));
 c.schedule!.overrides=[{id:'active',rounds:{start:2,end:2},positions:{start:2,end:3},parameters:[{id:'valid-gas',target:target('co2'),value:{mode:'list',along:'path',values:[.01,.02]}}]}];
 const plan=compileSchedule(c);expect(plan.valueAt(target('co2'),1,1)).toBe(.01);expect(plan.valueAt(target('co2'),2,1)).toBe(.02);
 const bad=structuredClone(c);bad.schedule!.overrides[0].parameters[0].value={mode:'fixed',value:0};expect(()=>compileSchedule(bad)).toThrow(/第 2 轮.*位置 2.*逸度/);
});
it('keeps an entirely out-of-range target draft dormant',()=>{
 const c=base();c.equilibrium_constraints=[{...gas('unused',NaN),species:'',rounds:{start:4}}];expect(()=>compileSchedule(c)).not.toThrow();
 const expanded=structuredClone(c);expanded.schedule!.rounds=4;expect(()=>compileSchedule(expanded)).toThrow(/选择.*气体/);
});
it('uses stable target IDs so pH and fugacity profiles never share values',()=>{
 const c=base();c.equilibrium_constraints=[ph('a',6),gas('b',.1)];
 c.schedule!.parameters.push({id:'ph-profile',target:target('a'),value:{mode:'linear',start:3,path_step:1,round_step:.5}},{id:'gas-profile',target:target('b'),value:{mode:'list',along:'round',values:[.1,1,10]}});
 const plan=compileSchedule(c);expect(plan.valueAt(target('a'),3,2)).toBe(7);expect(plan.valueAt(target('b'),3,2)).toBe(10);
 expect(targetKey(target('a'))).not.toBe(targetKey(target('b')));expect(referenceKey(target('a'))).not.toBe(referenceKey(target('b')));
});
it('applies local target values only at the selected rounds and positions',()=>{
 const c=base();c.equilibrium_constraints=[ph('acid',6)];c.schedule!.overrides=[{id:'local',rounds:{start:2,end:3},positions:{start:2,end:4,step:2},parameters:[{id:'local-ph',target:target('acid'),value:{mode:'linear',start:2,path_step:1,round_step:.1}}]}];
 const plan=compileSchedule(c);
 expect([0,1,2,3].map(i=>plan.valueAt(target('acid'),i,0))).toEqual([6,6,6,6]);
 expect([0,1,2,3].map(i=>plan.valueAt(target('acid'),i,1))).toEqual([6,2,6,3]);
 expect([0,1,2,3].map(i=>plan.valueAt(target('acid'),i,2))).toEqual([6,2.1,6,3.1]);
});
it('allows separate pH targets on disjoint scopes but rejects overlapping targets',()=>{
 const c=base();c.equilibrium_constraints=[{...ph('first',4),rounds:{start:1,end:1}},{...ph('later',8),rounds:{start:2}}];
 expect(()=>compileSchedule(c)).not.toThrow();expect(constraintActiveAt(c.equilibrium_constraints[0],0,1)).toBe(false);
 const conflict=structuredClone(c);conflict.equilibrium_constraints![1].rounds={start:1};expect(()=>compileSchedule(conflict)).toThrow(/多个 pH 目标/);
});
it('removing a target clears its general and local profiles while retaining all T/P and other target settings',()=>{
 const c=base();c.equilibrium_constraints=[ph('acid'),gas('co2')];c.schedule!.parameters.push(setting('acid',4),setting('co2',.1));
 c.schedule!.overrides=[{id:'mixed',rounds:{start:2},positions:{start:1},parameters:[{id:'t-local',target:{kind:'temperature'},value:{mode:'fixed',value:50}},{id:'acid-local',target:target('acid'),value:{mode:'fixed',value:2}}]},{id:'acid-only',rounds:{start:1,end:1},positions:{start:1},parameters:[{id:'acid-first',target:target('acid'),value:{mode:'fixed',value:3}}]}];
 const remaining={...c,...removeConstraint(c,'acid')};expect(remaining.equilibrium_constraints?.map(c=>c.id)).toEqual(['co2']);
 expect(remaining.schedule!.parameters.map(p=>p.target.kind)).toEqual(['temperature','pressure','equilibrium_constraint']);
 expect(remaining.schedule!.overrides).toHaveLength(1);expect(remaining.schedule!.overrides[0].parameters.map(p=>p.id)).toEqual(['t-local']);
 const plan=compileSchedule(remaining);expect(plan.point(0,1).temperature_c).toBe(50);expect(plan.point(0,1).pressure_bar).toBe(1);expect(plan.valueAt(target('co2'),0,1)).toBe(.1);
});
it('preserves incomplete target values and scopes through draft saving and restoring',()=>{
 const c=base();c.equilibrium_constraints=[{...ph('acid',NaN),titrant:'',positions:{start:NaN,end:4}}];c.schedule!.parameters.push(setting('acid',NaN));
 const restored=decodeDocument(encodeDraft({version:1,id:'unfinished',database:{kind:'rtdb',path:'/test.rtdb',name:'Test'},config:c,updated_at:''})).config;
 expect(Number.isNaN(restored.equilibrium_constraints![0].value)).toBe(true);expect(Number.isNaN(restored.equilibrium_constraints![0].positions!.start)).toBe(true);
 expect(restored.equilibrium_constraints![0]).toMatchObject({kind:'ph',titrant:''});
 expect(Number.isNaN((restored.schedule!.parameters.at(-1)!.value as {value:number}).value)).toBe(true);
 expect(()=>readConfig(restored)).toThrow(/平衡目标设置格式/);expect(()=>compileSchedule(restored)).toThrow(/适用.*范围/);
});
it('adds pH with an explicit empty adjustment substance, accepts negative target entry, and keeps it across panel switching',()=>{
 render(<Editor whole/>);fireEvent.change(screen.getByLabelText('添加指定条件'),{target:{value:'ph'}});
 expect((screen.getByLabelText('pH 调节物质') as HTMLInputElement).value).toBe('');expect(()=>compileSchedule(latest)).toThrow(/中性物质/);
 fireEvent.change(screen.getByLabelText('pH 调节物质'),{target:{value:'HCl'}});
 const value=screen.getByLabelText('pH · HCl 数值或公式') as HTMLInputElement;expect(value.min).toBe('');fireEvent.change(value,{target:{value:'-1'}});
 expect(compileSchedule(latest).valueAt(target(latest.equilibrium_constraints![0].id),0,0)).toBe(-1);
 fireEvent.change(screen.getByLabelText('pH 物质交换方式'),{target:{value:'both'}});

 expect((screen.getByLabelText('pH · HCl 数值或公式') as HTMLInputElement).value).toBe('-1');expect(latest.equilibrium_constraints![0]).toMatchObject({exchange:'both'});
});
it('offers eligible database gases explicitly, without automatically adding a finite gas phase or changing selected species',()=>{
 render(<Editor/>);fireEvent.change(screen.getByLabelText('添加平衡目标'),{target:{value:'fugacity'}});
 const selector=screen.getByLabelText('逸度目标气体');expect(within(selector).getAllByRole('option').map(o=>(o as HTMLOptionElement).value)).toEqual(['','CO2(g)']);
 fireEvent.change(selector,{target:{value:'CO2(g)'}});expect(latest.equilibrium_constraints![0]).toMatchObject({kind:'fugacity',species:'CO2(g)'});
 expect(latest.species).toEqual(['H2O','H+','OH-']);expect(latest.materials[0].inputs).toEqual([{species:'H2O',amount:1,unit:'kg'}]);
});
it('sets target round and position scopes independently and preserves blank numeric drafts across a panel switch',()=>{
 const c=base();c.equilibrium_constraints=[ph('acid')];render(<Editor initial={c} whole/>);
 fireEvent.change(screen.getByLabelText('适用轮次'),{target:{value:'range'}});fireEvent.change(screen.getByLabelText('适用轮次 起点'),{target:{value:'2'}});
 fireEvent.change(screen.getByLabelText('适用位置'),{target:{value:'range'}});fireEvent.change(screen.getByLabelText('适用位置 终点'),{target:{value:'3'}});
 expect(latest.equilibrium_constraints![0]).toMatchObject({rounds:{start:2,end:3},positions:{start:1,end:3}});
 fireEvent.change(screen.getByLabelText('pH · HCl 数值或公式'),{target:{value:''}});
 expect((screen.getByLabelText('pH · HCl 数值或公式') as HTMLInputElement).value).toBe('');expect(()=>compileSchedule(latest)).toThrow();
});
it('previews the effective local target only within its scope and exposes it in the conditions table',()=>{
 const c=base();c.equilibrium_constraints=[{...ph('acid'),rounds:{start:2,end:2},positions:{start:2,end:3}}];c.schedule!.overrides=[{id:'target-local',rounds:{start:2,end:2},positions:{start:2,end:2},parameters:[{id:'ph-local',target:target('acid'),value:{mode:'fixed',value:2.5}}]}];
 const props={config:c,items,selected:{inner:1,outer:1},onSelect:vi.fn(),onAdjust:vi.fn()};const view=render(<SchedulePreview {...props}/>);
 const targets=document.querySelector('.schedule-preview__targets')!;expect(targets.textContent).toContain('pH · HCl');expect(targets.querySelector('dd')?.textContent).toBe('2.5');
 fireEvent.click(screen.getByRole('tab',{name:'逐点条件表'}));fireEvent.change(screen.getByLabelText('条件表附加参数'),{target:{value:targetKey(target('acid'))}});
 const row=screen.getByRole('button',{name:'查看第 2 轮位置 2'}).closest('tr')!;expect(row.textContent).toContain('2.5');
 view.rerender(<SchedulePreview {...props} selected={{inner:1,outer:0}}/>);expect(document.querySelector('.schedule-preview__targets')?.textContent).toContain('此处没有启用额外目标');
});
it('updates target labels with the application language without losing target identity or values',()=>{
 const c=base();c.equilibrium_constraints=[ph('acid'),gas('co2')];render(<Editor initial={c}/>);act(()=>setLanguage('en'));
 expect(screen.getByLabelText('pH adjustment substance')).toBeTruthy();expect(screen.getByLabelText('Fugacity target gas')).toBeTruthy();
 expect(latest.equilibrium_constraints!.map(c=>[c.id,c.value])).toEqual([['acid',7],['co2',1]]);
});

it('shows changing target activation even when the target value stays constant',()=>{
 const c=base();c.equilibrium_constraints=[{...gas('co2',.01),rounds:{start:2}}];
 const readings=actualVariationSummaries(c,compileSchedule(c),{inner:0,outer:0});
 expect(readings.rounds).toEqual([{key:targetKey(target('co2')),label:'CO2(g) 逸度',value:'不施加 → 0.01 → 0.01 bar'}]);
});

it('restores an explicit Python None target base as an unfinished draft without losing a complete schedule',()=>{
 const c=base();c.equilibrium_constraints=[ph('acid')];c.schedule!.parameters.push(setting('acid',4));
 const input={...c,equilibrium_constraints:[{...c.equilibrium_constraints[0],value:null}]};
 const restored=readConfig(input,{allowDraft:true});expect(Number.isNaN(restored.equilibrium_constraints![0].value)).toBe(true);
 expect(compileSchedule(restored).valueAt(target('acid'),0,0)).toBe(4);expect(()=>readConfig(input)).toThrow();
});

it('keeps a cleared target interval visibly blank, including after language switching',()=>{
 const c=base();c.equilibrium_constraints=[ph('acid')];render(<Editor initial={c}/>);fireEvent.change(screen.getByLabelText('适用轮次'),{target:{value:'range'}});
 const step=screen.getByLabelText('适用轮次 间隔') as HTMLInputElement;expect(step.value).toBe('1');fireEvent.change(step,{target:{value:''}});
 expect(step.value).toBe('');expect(latest.equilibrium_constraints![0].rounds!.step).toBeNaN();expect(()=>compileSchedule(latest)).toThrow(/范围/);
 act(()=>setLanguage('en'));expect(screen.getByLabelText('Rounds to apply interval')).toHaveProperty('value','');
 fireEvent.change(screen.getByLabelText('Rounds to apply interval'),{target:{value:'2'}});expect(()=>compileSchedule(latest)).not.toThrow();
});
