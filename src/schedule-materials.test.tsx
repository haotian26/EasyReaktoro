// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {Config,DEFAULT_CONFIG,SimSpecies,makeRoute,readConfig} from './simulation-types';
import {defaultSchedule,compileSchedule} from './simulation-schedule';
import {ReactionStageEditor,evaluatedRecipeInputs,inputPreview} from './ReactionStageEditor';
import {SimulationMaterials} from './SimulationSpecies';
import {toStageConfig} from './reaction-stages';
import {setupSteps} from './simulation-guidance';
import {materialBaseUsage} from './material-base-usage';
afterEach(cleanup);
const water:SimSpecies={name:'water',formula:'H2O',phase:'aqueous',charge:0,elements:['H','O'],is_water:true,disabled:false,reason:'',ion_size:null};
const salt:SimSpecies={...water,name:'salt',formula:'NaCl',is_water:false};
function config():Config{
 const c={...structuredClone(DEFAULT_CONFIG),species:['water','salt'],materials:[{id:'initial',name:'fluid',inputs:[{species:'water',amount:0,unit:'kg' as const},{species:'salt',amount:2,unit:'mol' as const}]}],schedule:{...defaultSchedule(),positions:3,rounds:2}};
 const next=toStageConfig(c);next.schedule!.parameters.push({id:'water-amount',target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:2}});
 const route=next.reaction_stages!.later_following[0];next.schedule!.overrides.push({id:'last-point',rounds:{start:2,end:2},positions:{start:3,end:3},parameters:[{id:'last-fraction',target:{kind:'route_fraction',route_id:route.id!,field:'fraction'},value:{mode:'fixed',value:.5}}]});return next;
}
describe('actual material previews and editing',()=>{
 it('shows the effective general composition content and links to its controlling parameter',()=>{
  const c=config(),patch=vi.fn(),onEdit=vi.fn();render(<SimulationMaterials items={[water,salt]} config={c} patch={patch} disabled={false} onError={vi.fn()} onEditParameter={onEdit}/>);
  const input=screen.getByLabelText('water 投料量') as HTMLInputElement;expect(input.disabled).toBe(true);expect(input.value).toBe('2');expect(c.materials[0].inputs[0].amount).toBe(0);
  fireEvent.change(input,{target:{value:'9'}});expect(patch).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'修改通常设置中的water 每份含量'}));expect(onEdit).toHaveBeenCalledWith({settingId:'water-amount'});
 });
 it('keeps base contents editable outside local overrides and identifies the overridden range',()=>{
  const c=config();c.schedule!.parameters=c.schedule!.parameters.filter(p=>p.id!=='water-amount');c.schedule!.overrides=[{id:'only-third',rounds:{start:2,end:2},positions:{start:3,end:3},parameters:[{id:'local-water',target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:6}}]}];
  const patch=vi.fn(),onEdit=vi.fn();render(<SimulationMaterials items={[water,salt]} config={c} patch={patch} disabled={false} onError={vi.fn()} onEditParameter={onEdit}/>);
  const input=screen.getByLabelText('water 投料量') as HTMLInputElement;expect(input.disabled).toBe(false);fireEvent.change(input,{target:{value:'3'}});
  const next={...c,...patch.mock.calls[0][0]},plan=compileSchedule(next);expect(plan.valueAt({kind:'material_amount',material_id:'initial',species:'water'},0,0)).toBe(3);expect(plan.valueAt({kind:'material_amount',material_id:'initial',species:'water'},2,1)).toBe(6);
  fireEvent.click(screen.getByRole('button',{name:'修改第 2 轮 · 第 3 步中的water 每份含量'}));expect(onEdit).toHaveBeenCalledWith({settingId:'local-water',overrideId:'only-third'});
 });
 it('disables an unused base value when several local ranges together cover every position',()=>{
  const c=config();c.schedule!.parameters=c.schedule!.parameters.filter(p=>p.id!=='water-amount');c.schedule!.overrides=[1,2].map(round=>({id:'round-'+round,rounds:{start:round,end:round},positions:{start:1},parameters:[{id:'water-'+round,target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:round*2}}]}));
  const view=render(<SimulationMaterials items={[water,salt]} config={c} patch={vi.fn()} disabled={false} onError={vi.fn()}/>);expect((screen.getByLabelText('water 投料量') as HTMLInputElement).disabled).toBe(true);
  const extended={...c,schedule:{...c.schedule!,rounds:3}};view.rerender(<SimulationMaterials items={[water,salt]} config={extended} patch={vi.fn()} disabled={false} onError={vi.fn()}/>);expect((screen.getByLabelText('water 投料量') as HTMLInputElement).disabled).toBe(false);
 });
 it('links the selected reaction quantity to the local setting instead of its general default',()=>{
  const c=config(),onEdit=vi.fn(),route=c.reaction_stages!.later_following[0];c.schedule!.parameters.push({id:'general-fraction',target:{kind:'route_fraction',route_id:route.id!,field:'fraction'},value:{mode:'fixed',value:.8}});
  render(<ReactionStageEditor config={c} items={[water,salt]} selected="later_following" coordinate={[2,1]} onSelect={vi.fn()} onChange={vi.fn()} onEditParameter={onEdit}/>);
  expect((screen.getByLabelText('物料 1 份数') as HTMLInputElement).value).toBe('0.5');expect(screen.queryByRole('button',{name:'修改通常设置中的加入份数'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'修改第 2 轮 · 第 3 步中的加入份数'}));expect(onEdit).toHaveBeenCalledWith({settingId:'last-fraction',overrideId:'last-point'});
 });
 it('allows a blank base only when every actual addition is covered, and exposes it after coverage is removed',()=>{
  const c=config();c.materials[0].inputs[0].amount=NaN;c.schedule!.parameters=c.schedule!.parameters.filter(p=>p.id!=='water-amount');c.schedule!.overrides=[{id:'initial-only',rounds:{start:1,end:1},positions:{start:1,end:1},parameters:[{id:'initial-water',target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:2}}]}];
  for(const key of ['first_following','later_start','later_following'] as const)c.reaction_stages![key]=[{...makeRoute('all',key==='later_start'?'previous_cycle':'previous_point'),id:key}];
  const target={kind:'material_amount' as const,material_id:'initial',species:'water'},usage=materialBaseUsage(c,target,[water,salt]);expect(usage).toMatchObject({known:true,baseRequired:false,firstUse:[0,0],used:1});expect(setupSteps(c,[water,salt],{handle_id:'db',kind:'rtdb',dirty:false})[1].issue).toBeUndefined();
  const props={items:[water,salt],patch:vi.fn(),disabled:false,onError:vi.fn()},view=render(<SimulationMaterials {...props} config={c}/>);expect((screen.getByLabelText('water 投料量') as HTMLInputElement).disabled).toBe(true);expect((screen.getByLabelText('water 投料量') as HTMLInputElement).value).toBe('2');
  const uncovered={...c,schedule:{...c.schedule!,overrides:[]}};view.rerender(<SimulationMaterials {...props} config={uncovered}/>);expect((screen.getByLabelText('water 投料量') as HTMLInputElement).disabled).toBe(false);expect((screen.getByLabelText('water 投料量') as HTMLInputElement).value).toBe('');expect(setupSteps(uncovered,[water,salt],{handle_id:'db',kind:'rtdb',dirty:false})[1].issue).toContain('第 1 轮 · 位置 1');expect(Number.isNaN(c.materials[0].inputs[0].amount)).toBe(true);
 });
 it('does not require an input excluded by phase, species selection, or an actual zero composition factor',()=>{
  const c=config(),target={kind:'material_amount' as const,material_id:'initial',species:'water'};c.materials[0].inputs[0].amount=NaN;c.schedule!.parameters=c.schedule!.parameters.filter(p=>p.id!=='water-amount');c.schedule!.overrides=[];
  for(const routes of Object.values(c.reaction_stages!))for(const route of routes)route.phase='mineral';expect(materialBaseUsage(c,target,[water,salt])).toMatchObject({known:true,baseRequired:false,used:0});
  for(const routes of Object.values(c.reaction_stages!))for(const route of routes){route.phase='species';route.species=['salt'];}expect(materialBaseUsage(c,target,[water,salt]).baseRequired).toBe(false);
  for(const routes of Object.values(c.reaction_stages!))for(const route of routes){route.phase='all';route.fraction=0;}expect(materialBaseUsage(c,target,[water,salt]).baseRequired).toBe(false);
  const changed={...c,reaction_stages:structuredClone(c.reaction_stages)};changed.reaction_stages!.later_start[0].fraction=1;expect(materialBaseUsage(changed,target,[water,salt])).toMatchObject({baseRequired:true,firstBase:[0,1]});
 });
 it('normalizes only explicitly blank composition amounts when reading an unfinished draft',()=>{
  const c=config(),raw=JSON.parse(JSON.stringify(c));raw.materials[0].inputs[0].amount=null;const restored=readConfig(raw,{allowDraft:true});expect(Number.isNaN(restored.materials[0].inputs[0].amount)).toBe(true);expect(compileSchedule(restored).valueAt({kind:'material_amount',material_id:'initial',species:'water'},0,0)).toBe(2);expect(raw.materials[0].inputs[0].amount).toBeNull();expect(()=>readConfig(raw)).toThrow();
  raw.balance_tolerance_mol=null;expect(()=>readConfig(raw,{allowDraft:true})).toThrow();
 });
 it('does not let a local valid quantity hide a missing base at other actual additions',()=>{
  const c=config();c.materials[0].inputs[0].amount=NaN;c.schedule!.parameters=c.schedule!.parameters.filter(p=>p.id!=='water-amount');c.schedule!.overrides=[{id:'last-only',rounds:{start:2,end:2},positions:{start:3,end:3},parameters:[{id:'last-water',target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:2}}]}];
  expect(setupSteps(c,[water,salt],{handle_id:'db',kind:'rtdb',dirty:false})[1].issue).toContain('第 1 轮 · 位置 1');const invalid={...c,materials:structuredClone(c.materials)};invalid.materials[0].inputs[0].amount=-1;invalid.schedule={...c.schedule!,parameters:[...c.schedule!.parameters,{id:'all-water',target:{kind:'material_amount',material_id:'initial',species:'water'},value:{mode:'fixed',value:2}}]};expect(setupSteps(invalid,[water,salt],{handle_id:'db',kind:'rtdb',dirty:false})[1].issue).toContain('投料数量');
 });
 it('uses the precise coordinate and one compiled schedule for amount and fraction',()=>{
  const c=config(),route=c.reaction_stages!.later_following[0],plan=compileSchedule(c);
  expect(evaluatedRecipeInputs(c,route,'later_following',[water,salt],[1,1],plan).map(r=>r.amount)).toEqual([2,2]);
  expect(evaluatedRecipeInputs(c,route,'later_following',[water,salt],[2,1],plan).map(r=>r.amount)).toEqual([1,1]);
  expect(inputPreview(c,route,'later_following',[water,salt],[2,1],plan)).toBe('water 1 kg + salt 1 mol');
 });
 it('locks only the selected position whose quantity is separately set',()=>{
  const c=config(),change=vi.fn(),props={config:c,items:[water,salt],selected:'later_following' as const,onSelect:vi.fn(),onChange:change};
  const view=render(<ReactionStageEditor {...props} coordinate={[1,1]}/>);
  expect((screen.getByLabelText('物料 1 份数') as HTMLInputElement).disabled).toBe(false);
  view.rerender(<ReactionStageEditor {...props} coordinate={[2,1]}/>);
  expect((screen.getByLabelText('物料 1 份数') as HTMLInputElement).disabled).toBe(true);expect((screen.getByLabelText('物料 1 份数') as HTMLInputElement).value).toBe('0.5');expect(screen.getByText(/第 2 轮 · 位置 3 实际加入：water 1 kg/)).toBeTruthy();expect(change).not.toHaveBeenCalled();
 });
 it('cleans only the removed composition input and keeps species available to result sources',()=>{
  const c=config();c.materials.push({id:'other',name:'other',inputs:[{species:'water',amount:3,unit:'kg'}]});c.schedule!.parameters.push({id:'other-water',target:{kind:'material_amount',material_id:'other',species:'water'},value:{mode:'fixed',value:4}});
  c.reaction_stages!.first_start[0]={...c.reaction_stages!.first_start[0],phase:'species',species:['water','salt']};c.reaction_stages!.first_following[0]={...makeRoute('species','previous_point'),id:'result-route',species:['water','salt']};
  const patch=vi.fn();render(<SimulationMaterials items={[water,salt]} config={c} patch={patch} disabled={false} onError={vi.fn()}/>);fireEvent.click(screen.getByLabelText('移除投料 water'));
  const next=patch.mock.calls[0][0];expect(next.materials[0].inputs.map((r:{species:string})=>r.species)).toEqual(['salt']);expect(next.schedule.parameters.some((p:{id:string})=>p.id==='water-amount')).toBe(false);expect(next.schedule.parameters.some((p:{id:string})=>p.id==='other-water')).toBe(true);
  expect(next.reaction_stages.first_start[0].species).toEqual(['salt']);expect(next.reaction_stages.first_following[0].species).toEqual(['water','salt']);expect(next.species).toBeUndefined();
 });
 it('reviews unit reinterpretation before changing a scheduled input',()=>{
  const c=config(),patch=vi.fn();render(<SimulationMaterials items={[water,salt]} config={c} patch={patch} disabled={false} onError={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('water 投料单位'),{target:{value:'g'}});expect(patch).not.toHaveBeenCalled();expect(screen.getByText(/数值不自动换算/)).toBeTruthy();fireEvent.click(screen.getByText('保留原单位'));expect(patch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('water 投料单位'),{target:{value:'g'}});fireEvent.click(screen.getByText('按新单位使用这些数值'));
  expect(patch.mock.calls[0][0].materials[0].inputs[0]).toEqual({species:'water',amount:0,unit:'g'});expect(patch.mock.calls[0][0].schedule).toBeUndefined();expect(c.schedule!.parameters.at(-1)!.value).toEqual({mode:'fixed',value:2});
 });
 it('guides a migrated result-only source to fill the genuinely empty starting group',()=>{
  const c=config();delete c.reaction_stages;c.schedule!.parameters=c.schedule!.parameters.filter(p=>p.target.kind!=='route_fraction');c.schedule!.overrides=[];
  c.routes=[{...makeRoute('all','previous_cycle'),id:'reuse',fallback:'none'}];
  expect(setupSteps(c,[water,salt],{handle_id:'db',kind:'rtdb',dirty:false}).find(s=>s.id==='conditions')!.issue).toBe('为首次起点加入反应物');
 });
 it('recognizes scheduled positive charge when all stored composition amounts are zero',()=>{
  const c=config();c.materials[0].inputs.forEach(row=>row.amount=0);const steps=setupSteps(c,[water,salt],{handle_id:'db',kind:'rtdb',dirty:false});
  expect(steps.find(s=>s.id==='materials')!.issue).toBeUndefined();expect(steps.find(s=>s.id==='materials')!.detail).toBe('1 / 1 份 composition 实际投料');
  const zero={...c,schedule:{...c.schedule!,parameters:c.schedule!.parameters.map(p=>p.id==='water-amount'?{...p,value:{mode:'fixed' as const,value:0}}:p)}};
  expect(setupSteps(zero,[water,salt],{handle_id:'db',kind:'rtdb',dirty:false}).find(s=>s.id==='materials')!.issue).toContain('初始投料');
 });
});
