// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {setLanguage} from './i18n';
import {SimulationMaterials} from './SimulationSpecies';
import {DEFAULT_CONFIG,type Config} from './simulation-types';
afterEach(()=>{cleanup();setLanguage('zh-CN');});
it('creates language-neutral composition names and preserves an existing Chinese name when switching language',()=>{
 const original=structuredClone(DEFAULT_CONFIG);original.materials[0].name='初始盐水（样本甲）';let current=original;
 function Harness(){const [value,setValue]=useState(original);current=value;return <SimulationMaterials config={value} items={[]} patch={patch=>setValue(c=>({...c,...patch}))} disabled={false} onError={vi.fn()}/>;}
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'添加 composition'}));
 expect(current.materials.at(-1)?.name).toBe('Composition 2');
 const entered=screen.getByLabelText('Composition 名称') as HTMLInputElement;fireEvent.change(entered,{target:{value:'现场输入水'}});
 act(()=>setLanguage('en'));expect(screen.getByLabelText('Composition name')).toBe(entered);expect(entered.value).toBe('现场输入水');expect(current.materials[0].name).toBe('初始盐水（样本甲）');
 fireEvent.click(screen.getByRole('button',{name:'Add composition'}));expect(current.materials.at(-1)?.name).toBe('Composition 3');
 act(()=>setLanguage('zh-CN'));expect(current.materials.at(-1)?.name).toBe('Composition 3');expect(current.materials[1].name).toBe('现场输入水');
});
