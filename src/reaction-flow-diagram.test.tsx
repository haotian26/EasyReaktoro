// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ReactionFlowDiagram} from './ReactionFlowDiagram';
import {DiagramMaterialStages,DiagramMaterialTerm} from './LoopDiagram';
import {setLanguage} from './i18n';
afterEach(()=>{cleanup();setLanguage('zh-CN');});
const term=(source:DiagramMaterialTerm['source'],phase:string,fraction=1):DiagramMaterialTerm=>({source,phase,fraction,label:source});
function materials():DiagramMaterialStages{return {first_start:[{...term('fresh','all'),label:'Water'}],first_following:[term('left','aqueous')],later_start:[term('above','mineral'),{...term('fresh','all'),label:'Brine'}],later_following:[term('left','aqueous'),term('above','mineral')]};}
const point=(i:number,o:number)=>({temperature_c:250-i*5,pressure_bar:o===0?39.761649561576:700,pressure_mode:o===0?'water_saturation':'fixed'});
function Harness({m=materials(),positions=4,rounds=3}:{m?:DiagramMaterialStages;positions?:number;rounds?:number}){const [selected,setSelected]=useState({inner:0,outer:0});return <ReactionFlowDiagram positions={positions} rounds={rounds} selected={selected} materials={m} point={point} onSelect={(inner,outer)=>setSelected({inner,outer})}/>;}
it('shows the whole multi-step, multi-round flow and preserves it when a different node is selected',()=>{
 const {container}=render(<Harness/>);
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(12);
 expect(container.querySelectorAll('[data-source="left"]')).toHaveLength(9);
 expect(container.querySelectorAll('[data-source="above"]')).toHaveLength(8);
 fireEvent.click(screen.getByRole('button',{name:'查看第 2 轮位置 3'}));
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(12);
 expect(container.querySelector('.reaction-flow__current')?.textContent).toContain('第 2 轮 · 位置 3');
 expect(screen.getByRole('button',{name:'查看第 2 轮位置 3'}).getAttribute('aria-pressed')).toBe('true');
 for(const edge of container.querySelectorAll('.reaction-flow__connection')){
  const d=(edge as HTMLElement).dataset;
  expect(Number(d.toInner)-Number(d.fromInner)).toBe(d.source==='left'?1:0);
  expect(Number(d.toOuter)-Number(d.fromOuter)).toBe(d.source==='above'?1:0);
 }
});
it('connects phases according to settings, without hardcoding fluid across or solid down',()=>{
 const m=materials();m.first_following=[term('left','mineral',.3)];m.later_following=[term('left','gas',.2),term('above','aqueous',.5)];
 const {container}=render(<Harness m={m}/>);
 expect(container.querySelector('[data-source="left"][data-to-outer="0"]')?.textContent).toContain('固相 30%');
 expect(container.querySelector('[data-source="above"]')?.textContent).toContain('固相 100%');
 expect(container.querySelector('[data-source="above"][data-to-inner="1"]')?.textContent).toContain('水相 50%');
 expect(container.querySelector('[data-source="left"][data-to-outer="1"]')?.textContent).toContain('气相 20%');
});
it('does not fabricate lines between independently calculated fresh inputs',()=>{
 const m=materials();for(const key of Object.keys(m) as (keyof typeof m)[])m[key]=[{...term('fresh','all'),label:'Fresh gas'}];
 const {container}=render(<Harness m={m}/>);
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(12);
 expect(container.querySelectorAll('.reaction-flow__connection')).toHaveLength(0);
 expect(container.querySelectorAll('[data-source="fresh"]')).toHaveLength(12);
});
it('shows varying transfer fractions at each destination and omits zero transfers only there',()=>{
 const m=materials();m.first_following=[{...term('left','aqueous'),fractionAt:i=>i===2?0:1/(i+1)}];
 const {container}=render(<Harness m={m}/>);
 expect(container.querySelector('[data-source="left"][data-to-inner="1"][data-to-outer="0"]')?.textContent).toContain('50%');
 expect(container.querySelector('[data-source="left"][data-to-inner="2"][data-to-outer="0"]')).toBeNull();
 expect(container.querySelector('[data-source="left"][data-to-inner="3"][data-to-outer="0"]')?.textContent).toContain('25%');
});
it('shows new composition names and selected species without requiring a tooltip',()=>{
 const m=materials();m.first_start=[{...term('fresh','all'),label:'Water'},{...term('fresh','all'),label:'Rock'},{...term('fresh','species'),label:'Brine',species:['NaCl(aq)'],fractionAt:()=>.25}];
 const {container,rerender}=render(<ReactionFlowDiagram positions={1} rounds={1} selected={{inner:0,outer:0}} materials={m} point={point} onSelect={()=>{}}/>);
 const feed=container.querySelector('.reaction-flow__feed')!.textContent!;
 for(const name of ['Water','Rock','Brine','NaCl(aq)','0.25'])expect(feed).toContain(name);
 expect(container.querySelector('[data-actual-pressure]')?.textContent).toContain('39.762');
 rerender(<ReactionFlowDiagram positions={1} rounds={1} selected={{inner:0,outer:0}} materials={m} point={point} onSelect={()=>{}} showConditions={false}/>);expect(container.querySelector('.reaction-flow__conditions')).toBeNull();
});
it('keeps exact nonadjacent source coordinates rather than turning them into neighbour connections',()=>{
 const m=materials();m.later_following=[{...term('above','aqueous',.3),sourceAt:()=>({inner:0,outer:0})}];
 const select=vi.fn(),{container}=render(<ReactionFlowDiagram positions={3} rounds={3} selected={{inner:2,outer:2}} materials={m} point={point} onSelect={select}/>);
 const edge=container.querySelector('[data-source="other"][data-to-inner="2"][data-to-outer="2"]');
 expect(edge?.getAttribute('data-from-inner')).toBe('0');expect(edge?.getAttribute('data-from-outer')).toBe('0');expect(edge?.textContent).toContain('30%');
 fireEvent.click(screen.getByRole('button',{name:'查看来源：第 1 轮 · 位置 1'}));expect(select).toHaveBeenCalledWith(0,0);
});
it('omits unavailable, future and invalid-quantity sources',()=>{
 const m=materials();m.first_start=[term('fresh','gas',0),term('left','aqueous',NaN),term('above','mineral',-1),{...term('above','mineral'),sourceAt:()=>null},{...term('above','mineral'),sourceAt:(i,o)=>({inner:i,outer:o+1})},{...term('left','aqueous'),sourceAt:()=>({inner:-1,outer:0})},{...term('left','aqueous'),sourceAt:()=>{throw new Error('Incomplete source');}}];
 const {container}=render(<ReactionFlowDiagram positions={1} rounds={1} selected={{inner:0,outer:0}} materials={m} point={point} onSelect={()=>{}}/>);expect(container.querySelectorAll('[data-source]')).toHaveLength(0);expect(screen.getByText('这一步没有投料或取用的反应结果。')).toBeTruthy();
});
it('shows unequal round endings and does not connect to an absent previous-round location',()=>{
 const {container}=render(<ReactionFlowDiagram positions={4} rounds={3} selected={{inner:3,outer:2}} materials={materials()} point={point} onSelect={()=>{}} active={(i,o)=>i<[2,3,4][o]} runIndex={(i,o)=>[0,2,5][o]+i}/>);
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(9);
 expect(screen.getByText('第 9 次平衡计算')).toBeTruthy();
 expect(container.querySelector('[data-source="above"][data-to-inner="3"][data-to-outer="2"]')).toBeNull();
 expect(container.querySelector('[data-source="left"][data-to-inner="3"][data-to-outer="2"]')?.getAttribute('data-from-inner')).toBe('2');
});
it('summarizes a large flow, expands a bounded neighbourhood and keeps the overview visible',()=>{
 const m=materials(),{container,rerender}=render(<ReactionFlowDiagram positions={500} rounds={200} selected={{inner:0,outer:0}} materials={m} point={point} onSelect={()=>{}}/>);
 expect(container.querySelectorAll('[data-overview-stage]')).toHaveLength(4);
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(0);
 const counts=[...container.querySelectorAll('[data-point-count]')].map(node=>Number(node.getAttribute('data-point-count')));
 expect(counts.reduce((a,b)=>a+b,0)).toBe(100000);
 rerender(<ReactionFlowDiagram positions={500} rounds={200} selected={{inner:250,outer:150}} materials={m} point={point} onSelect={()=>{}}/>);
 expect(screen.getByRole('button',{name:'查看第 151 轮位置 251'})).toBeTruthy();
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(9);
 expect(container.querySelectorAll('[data-overview-stage]')).toHaveLength(4);
 expect(container.querySelector('[data-source="left"][data-to-inner="250"][data-to-outer="150"]')?.getAttribute('data-from-inner')).toBe('249');
 expect(container.querySelector('.reaction-flow__map')!.getAttribute('width')).not.toMatch(/e/);
 expect(Number(container.querySelector('.reaction-flow__map')!.getAttribute('width'))).toBeLessThan(1000);
 fireEvent.click(screen.getByRole('button',{name:'收起附近步骤'}));
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(0);
 expect(container.querySelectorAll('[data-overview-stage]')).toHaveLength(4);
});
it('makes a transfer interrupted in the middle visible and opens that exact neighbourhood',()=>{
 const m=materials();m.later_following=[{...term('left','gas'),fractionAt:(i,o)=>i===50&&o===20?0:.5},term('above','aqueous',.3)];
 const {container}=render(<Harness m={m} positions={100} rounds={40}/>);
 expect(container.querySelector('[data-overview-transfer="left"][data-stage="later_following"]')?.textContent).toContain('气相 50%');
 fireEvent.click(screen.getByRole('button',{name:'仅 3,860/3,861 步取用'}));
 expect(container.querySelector('.reaction-flow__current')?.textContent).toContain('第 21 轮 · 位置 51');
 expect(container.querySelector('[data-source="left"][data-to-inner="50"][data-to-outer="20"]')).toBeNull();
 expect(container.querySelector('[data-source="above"][data-to-inner="50"][data-to-outer="20"]')?.textContent).toContain('水相 30%');
});
it('represents unequal endings and arbitrary source references without inventing arrows',()=>{
 const m=materials();m.later_following=[{...term('above','mineral'),sourceAt:()=>({inner:0,outer:0})}];
 const {container}=render(<ReactionFlowDiagram positions={100} rounds={40} active={(i,o)=>i<(o===0?10:100-o)} selected={{inner:0,outer:0}} materials={m} point={point} onSelect={()=>{}}/>);
 expect(screen.getByText('每轮 61–99 步')).toBeTruthy();
 expect(container.querySelector('[data-overview-transfer="above"][data-stage="later_following"]')).toBeNull();
 expect(screen.getByRole('button',{name:'↘ 来源：第 1 轮 · 位置 1'})).toBeTruthy();
 expect(container.querySelectorAll('.flow-overview__stage')).toHaveLength(4);
});
it('keeps independent long paths free of transfer arrows and switches overview language',()=>{
 const m=materials();for(const key of Object.keys(m) as (keyof typeof m)[])m[key]=[{...term('fresh','all'),label:'Fresh input'}];
 const {container}=render(<Harness m={m} positions={100} rounds={40}/>);act(()=>setLanguage('en'));
 expect(container.querySelectorAll('[data-overview-transfer]')).toHaveLength(0);
 expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
 fireEvent.click(screen.getByRole('button',{name:'Show steps near the selected position'}));
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(9);
 expect(container.querySelectorAll('.reaction-flow__connection')).toHaveLength(0);
});
it('keeps all nodes and values when changing language or zoom',()=>{
 const {container}=render(<Harness positions={3} rounds={2}/>);act(()=>setLanguage('en'));
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(6);
 expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
 const before=container.querySelector('[data-actual-temperature]')!.textContent;
 fireEvent.click(screen.getByRole('button',{name:'Zoom out'}));
 expect(container.querySelectorAll('.reaction-flow__node')).toHaveLength(6);
 expect(container.querySelector('[data-actual-temperature]')!.textContent).toBe(before);
 expect(within(screen.getByLabelText('Diagram zoom')).getByRole('button',{name:'Reset diagram zoom'}).textContent).toBe('80%');
});

it('opens an existing remote selection and refreshes interior values without changing the selected point',()=>{
 const m=materials(),selected={inner:50,outer:49};const {container,rerender}=render(<ReactionFlowDiagram positions={100} rounds={100} selected={selected} materials={m} point={point} onSelect={()=>{}}/>);
 expect(container.querySelector('.reaction-flow__current')?.textContent).toContain('第 50 轮 · 位置 51');
 rerender(<ReactionFlowDiagram positions={100} rounds={100} selected={selected} materials={m} point={(i,o)=>({...point(i,o),temperature_c:i===50&&o===49?80:100})} onSelect={()=>{}}/>);
 expect(container.querySelector('[data-overview-stage="later_following"]')?.textContent).toContain('80–100');expect(container.querySelector('[data-actual-temperature]')?.textContent).toContain('80');
});
it('preserves trace inputs in scientific notation and handles a long single path',()=>{
 const m=materials();m.first_following=[{...term('fresh','all',1e-12),label:'Tracer'}];
 const {container}=render(<Harness m={m} positions={500} rounds={1}/>);
 expect(container.querySelectorAll('[data-overview-stage]')).toHaveLength(2);expect(container.querySelector('[data-overview-stage="first_following"]')?.textContent).toContain('1e-12');expect(container.querySelectorAll('[data-overview-transfer]')).toHaveLength(0);
});

it('keeps long transfer labels below the fixed position headings',()=>{
 const m=materials();m.first_following=[{...term('left','species'),species:['CalciumCarbonateComplex','MagnesiumBicarbonateComplex','SodiumChlorideComplex','IronHydroxideComplex','SilicateComplex']}];
 const {container}=render(<Harness m={m} positions={3} rounds={1}/>);
 for(const text of container.querySelectorAll('.reaction-flow__connection[data-source="left"]>text'))expect(Number(text.getAttribute('y'))).toBeGreaterThanOrEqual(50);
 expect(container.querySelector('.reaction-flow__connection')?.textContent).toContain('IronHydroxideComplex');
});
