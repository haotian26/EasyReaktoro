// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ReactionFlowDiagram,nearbyIndices} from './ReactionFlowDiagram';
import {DiagramMaterialStages,DiagramMaterialTerm} from './LoopDiagram';
afterEach(cleanup);
const term=(source:DiagramMaterialTerm['source'],phase:string,fraction=1):DiagramMaterialTerm=>({source,phase,fraction,label:source});
function materials():DiagramMaterialStages{return {first_start:[term('fresh','all')],first_following:[term('left','aqueous')],later_start:[term('above','mineral'),term('fresh','aqueous')],later_following:[term('left','aqueous'),term('above','mineral')]};}
const point=(i:number,o:number)=>({temperature_c:250-i*5,pressure_bar:o===0?39.761649561576:700,pressure_mode:o===0?'water_saturation':'fixed'});
it('draws only adjacent material sources around the actual selected location',()=>{
 const {container}=render(<ReactionFlowDiagram positions={100} rounds={40} selected={{inner:50,outer:20}} materials={materials()} point={point} onSelect={()=>{}}/>);
 expect(container.querySelectorAll('.reaction-flow__point')).toHaveLength(9);
 for(const edge of container.querySelectorAll('[data-source]')){const d=(edge as HTMLElement).dataset;expect(Number(d.toInner)-Number(d.fromInner)).toBe(d.source==='left'?1:0);expect(Number(d.toOuter)-Number(d.fromOuter)).toBe(d.source==='above'?1:0);}
 expect(container.querySelectorAll('.reaction-flow__omitted').length).toBeGreaterThan(0);expect(screen.getByText(/完整路径共 100 个位置、40 轮/)).toBeTruthy();expect(nearbyIndices(100,99)).toEqual([97,98,99]);
});
it('exposes full actual pressure and mixed pressure modes while keeping labels brief',()=>{
 const select=vi.fn(),{container}=render(<ReactionFlowDiagram positions={3} rounds={2} selected={{inner:0,outer:0}} materials={materials()} point={point} onSelect={select}/>);
 const first=screen.getByRole('button',{name:/第 1 轮 · 位置 1/});expect(first.title).toContain('39.761649561576');expect(first.textContent).toContain('39.762');expect(container.querySelectorAll('.reaction-flow__psat')).toHaveLength(3);
 fireEvent.click(screen.getByRole('button',{name:/第 2 轮 · 位置 3/}));expect(select).toHaveBeenCalledWith(2,1);
});
it('does not invent transfers when each reaction uses a fresh composition',()=>{
 const m=materials();for(const key of Object.keys(m) as (keyof typeof m)[])m[key]=[term('fresh','gas')];
 const {container}=render(<ReactionFlowDiagram positions={5} rounds={4} selected={{inner:2,outer:2}} materials={m} point={point} onSelect={()=>{}}/>);expect(container.querySelectorAll('.reaction-flow__edge')).toHaveLength(0);expect(container.querySelectorAll('.reaction-flow__fresh')).toHaveLength(9);
});
it('does not draw empty, unavailable, or invalid quantities',()=>{
 const m=materials();for(const key of Object.keys(m) as (keyof typeof m)[])m[key]=[term('fresh','gas',0),term('left','aqueous',NaN),term('above','mineral',-1)];
 const {container}=render(<ReactionFlowDiagram positions={3} rounds={3} selected={{inner:0,outer:0}} materials={m} point={point} onSelect={()=>{}}/>);expect(container.querySelectorAll('.reaction-flow__edge,.reaction-flow__fresh,.reaction-flow__omitted')).toHaveLength(0);
});
