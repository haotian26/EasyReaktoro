import {describe,expect,it} from 'vitest';
import {ionSizeGaps,setupSteps} from './simulation-guidance';
import {Config,DEFAULT_CONFIG,SimSpecies} from './simulation-types';
const water:SimSpecies={name:'water',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null};
const ion:SimSpecies={...water,name:'H+',formula:'H+',is_water:false,charge:1};
const db={handle_id:'db',kind:'rtdb',dirty:false};
const config=():Config=>({...structuredClone(DEFAULT_CONFIG),species:['water','H+']});
describe('editing guidance without replacing scientific validation',()=>{
 it('explains an empty feed and missing radii without changing the selected model',()=>{
  const c=config(),before=structuredClone(c),steps=setupSteps(c,[water,ion],db);
  expect(steps.find(s=>s.id==='materials')?.issue).toContain('初始投料');
  expect(steps.find(s=>s.id==='activity')?.issue).toContain('1 个离子');
  expect(c).toEqual(before);
 });
 it('distinguishes explicit overrides, documented assignments and default records',()=>{
  const c={...config(),allow_database_defaults:false,allow_recorded_assignments:false},record={...ion,ion_size:{a_angstrom:9,source:'',reason:'Documented assignment',is_default:true}};
  expect(ionSizeGaps(c,[record])[0].reason).toContain('文献');
  c.allow_recorded_assignments=true;expect(ionSizeGaps(c,[record])[0].reason).toContain('默认');
  c.allow_database_defaults=true;expect(ionSizeGaps(c,[record])).toEqual([]);
  c.ion_size_overrides['H+']={a_angstrom:9,source:'Paper',reason:''};
  expect(ionSizeGaps(c,[record])[0].reason).toContain('来源和理由');
  c.ion_size_overrides['H+'].reason='Use recorded value';expect(ionSizeGaps(c,[record])).toEqual([]);
 });
 it('does not request aqueous parameters for a gas-only system or the ideal model',()=>{
  const c=config();c.activity_model='ideal';
  expect(setupSteps(c,[water,ion],db)[3].issue).toBeUndefined();
  c.species=['gas'];c.activity_model='nacl_edh';
  const steps=setupSteps(c,[{...water,name:'gas',phase:'gas',is_water:false}],db);
  expect(steps[0].issue).toBeUndefined();expect(steps[3].detail).toBe('当前体系无水相');
 });
 it('handles incomplete source metadata without crashing the workbench',()=>{
  const broken={...ion,ion_size:{a_angstrom:9,source:null,reason:null}} as unknown as SimSpecies;
  expect(ionSizeGaps(config(),[broken])[0].reason).toContain('缺少文献来源');
 });
 it('keeps unfinished size edits discoverable after changing the model',()=>{
  const c=config();c.activity_model='ideal';c.ion_size_overrides['H+']={a_angstrom:NaN,source:'',reason:''};
  expect(setupSteps(c,[water,ion],db)[3].issue).toContain('未完成的编辑');
  c.ion_size_overrides={};expect(setupSteps(c,[water,ion],db)[3].issue).toBeUndefined();
 });
 it('catches invalid transient input and final-cycle conditions',()=>{
  const c=config();c.points[0].temperature_increment_c=NaN;
  expect(setupSteps(c,[water,ion],db)[2].issue).toBeTruthy();
  c.points[0].temperature_increment_c=-400;c.cycles=3;
  expect(setupSteps(c,[water,ion],db)[2].issue).toBeTruthy();
  c.materials[0].inputs=[{species:'water',amount:NaN,unit:'kg'}];
  expect(setupSteps(c,[water,ion],db)[1].issue).toContain('投料数量');
 });
 it('shows incompatible PHREEQC and ambiguous water definitions',()=>{
  const c=config();c.activity_model='phreeqc';
  expect(setupSteps(c,[water,ion],{...db,kind:'official',group:'PHREEQC',embedded_name:'pitzer.dat'})[3].issue).toBeTruthy();
  expect(setupSteps(c,[water,ion],{...db,kind:'official',group:'PHREEQC',embedded_name:'phreeqc.dat'})[3].issue).toBeUndefined();
  c.species.push('other-water');expect(setupSteps(c,[water,ion,{...water,name:'other-water'}],db)[0].issue).toContain('一个水溶剂');
 });
});

it('checks actual saturation and intermediate overrides while retaining inactive rounds',()=>{
 const c=structuredClone(DEFAULT_CONFIG);c.cycles=3;c.points[0]={...c.points[0],temperature_c:100,pressure_bar:-1,pressure_mode:'water_saturation',round_conditions:[{round:2,temperature_c:400,pressure_bar:1,pressure_mode:'water_saturation'}]};
 const step=()=>setupSteps(c,[],{handle_id:'x',kind:'rtdb',dirty:false}).find(s=>s.id==='conditions');
 expect(step()?.issue).toBeTruthy();c.cycles=1;expect(step()?.issue).toBeUndefined();c.cycles=3;c.points[0].round_conditions![0].temperature_c=150;expect(step()?.issue).toBeUndefined();
 c.points[0].round_conditions![0].pressure_mode='fixed';c.points[0].round_conditions![0].pressure_bar=NaN;expect(step()?.issue).toBeTruthy();
});

it('does not let endpoint overrides conceal invalid intermediate base conditions',()=>{
 const c=structuredClone(DEFAULT_CONFIG);c.cycles=3;c.points[0]={...c.points[0],pressure_bar:50,pressure_increment_bar:-60,round_conditions:[{round:1,temperature_c:25,pressure_bar:50},{round:3,temperature_c:25,pressure_bar:50}]};
 const step=()=>setupSteps(c,[],db)[2];expect(step().issue).toBeTruthy();c.points[0].round_conditions!.push({round:2,temperature_c:25,pressure_bar:50});expect(step().issue).toBeUndefined();
});
