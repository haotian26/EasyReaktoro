// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SimulationConditions} from './SimulationConditions';
import {DEFAULT_CONFIG,type Config} from './simulation-types';
import {defaultSchedule,compileSchedule} from './simulation-schedule';
import {setStageCondition} from './reaction-stage-conditions';
import {setPointSetting} from './local-point-settings';
import {simulationDiagnostic,simulationError} from './simulation-api';
import {setLanguage} from './i18n';
afterEach(()=>{cleanup();setLanguage('zh-CN');});
const base=():Config=>({...structuredClone(DEFAULT_CONFIG),schedule:{...defaultSchedule(),positions:3,rounds:2}});
it('shows the inherited stage and jumps to its input without changing the config',()=>{
 setLanguage('en');const c=base();c.schedule=setStageCondition(c.schedule!,'first_following',{kind:'temperature'},{mode:'expression',expression:'T-20'});
 c.schedule=setPointSetting(c.schedule,{kind:'temperature'},1,0,{mode:'fixed',value:100});
 const patch=vi.fn();render(<SimulationConditions config={c} items={[]} patch={patch} disabled={false} onError={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText('Preview Position'),{target:{value:'2'}});
 fireEvent.click(screen.getByRole('button',{name:'Adjust this point'}));
 const local=screen.getByLabelText('Local point conditions');
 fireEvent.click(within(local).getByRole('button',{name:'First round · following steps'}));
 expect(document.activeElement).toBe(screen.getByLabelText('first_following Temperature'));expect(patch).not.toHaveBeenCalled();
 expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
 act(()=>setLanguage('zh-CN'));
 expect(within(local).getByRole('button',{name:'首轮 · 后续每一步'})).toBeTruthy();expect(patch).not.toHaveBeenCalled();
});
it('decodes native JSON errors and focuses a backend chemistry error',()=>{
 setLanguage('en');const c=base();c.equilibrium_constraints=[{id:'internal-uuid',kind:'ph',value:7,titrant:'HBr',exchange:'add_only'}];
 const diagnostic=simulationDiagnostic(JSON.stringify({code:'EQUILIBRIUM_CONSTRAINT',diagnostic:'pH · HBr 的交换物质包含当前体系没有的元素，请先补充允许参与平衡的 species',location:{kind:'constraint',constraintId:'internal-uuid',field:'titrant'}}));
 expect(diagnostic.message).toContain('pH · HBr');expect(simulationError(diagnostic.message)).not.toMatch(/[\u3400-\u9fff]/);
 const patch=vi.fn();render(<SimulationConditions config={c} items={[]} patch={patch} disabled={false} onError={vi.fn()} diagnostic={diagnostic} locateDiagnostic={1}/>);
 const field=screen.getByLabelText('pH adjustment substance');expect(document.activeElement).toBe(field);expect(field.getAttribute('aria-invalid')).toBe('true');expect(patch).not.toHaveBeenCalled();
});
it('opens a backend constraint range and locates exchange-direction errors',()=>{
 const c=base();c.equilibrium_constraints=[{id:'a',kind:'ph',value:7,titrant:'HCl',exchange:'add_only',rounds:{start:2}}];
 const props={config:c,items:[],patch:vi.fn(),disabled:false,onError:vi.fn()};
 const diagnostic=simulationDiagnostic({error:{diagnostic:'检查适用范围',location:{kind:'constraint',constraintId:'a',field:'rounds'}}});
 const view=render(<SimulationConditions {...props} diagnostic={diagnostic} locateDiagnostic={1}/>);
 const range=screen.getByLabelText('适用轮次');expect(range.closest('details')?.open).toBe(true);expect(document.activeElement).toBe(range);
 view.rerender(<SimulationConditions {...props} diagnostic={{message:'检查交换方式',location:{kind:'constraint',constraintId:'a',field:'exchange'}}} locateDiagnostic={2}/>);
 expect(document.activeElement).toBe(screen.getByLabelText('pH 物质交换方式'));
});
it('rejects malformed backend input locations',()=>{
 for(const location of [{kind:'constraint',constraintId:'x',field:'anything'},{kind:'parameter',target:{kind:'equilibrium_constraint',constraint_id:'x'},inner:-1,outer:0}])expect(simulationDiagnostic({diagnostic:'failure',location}).location).toBeUndefined();
});

it('locates backend errors on preserved legacy paths',()=>{
 const c=base();delete c.schedule;c.points=[{...c.points[0],routes:structuredClone(c.routes)}];c.equilibrium_constraints=[{id:'a',kind:'ph',value:7,titrant:'HBr',exchange:'add_only'}];
 render(<SimulationConditions config={c} items={[]} patch={vi.fn()} disabled={false} onError={vi.fn()} diagnostic={{message:'检查调节物质',location:{kind:'constraint',constraintId:'a',field:'titrant'}}} locateDiagnostic={1}/>);
 expect(document.activeElement).toBe(screen.getByLabelText('pH 调节物质'));expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
});
