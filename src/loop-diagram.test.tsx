// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DiagramMaterialStages,DiagramMaterialTerm,LoopDiagram,LoopDiagramAxis} from './LoopDiagram';
afterEach(cleanup);
const repeat=(n:number):LoopDiagramAxis=>({label:'重复',unit:'',values:Array.from({length:n},(_,i)=>i+1),mode:'repeat'});
const pressure:LoopDiagramAxis={label:'压力',unit:'bar',values:[700,695,690],mode:'range',step:-5};
const stages=(values:Partial<DiagramMaterialStages>={}):DiagramMaterialStages=>({first_start:[],first_following:[],later_start:[],later_following:[],...values});
const term=(source:DiagramMaterialTerm['source'],phase='aqueous',fraction=1,label=''):DiagramMaterialTerm=>({source,phase,fraction,label});
const hch=()=>stages({first_start:[term('fresh','aqueous',1,'流体'),term('fresh','mineral',1,'岩石')],first_following:[term('fresh','mineral',1,'岩石'),term('left')],later_start:[term('fresh','aqueous',1,'流体'),term('above','mineral')],later_following:[term('left'),term('above','mineral')]});
const ledger=(container:HTMLElement)=>container.querySelector('.loop-diagram__material-ledger')!;
it('never invents material arrows from execution order or the legacy summary',()=>{
 const {container}=render(<LoopDiagram inner={pressure} outer={repeat(3)} fixedConditions={[]} materialFlow={{inner:'水相承接上一步',outer:'矿物承接上一轮'}}/>);
 expect(container.querySelectorAll('.loop-diagram__point')).toHaveLength(9);expect(container.querySelectorAll('.loop-diagram__material-edge')).toHaveLength(0);expect(container.querySelector('.loop-diagram__return,.loop-diagram__forward')).toBeNull();expect(screen.getByText('第9次')).toBeTruthy();
});
it('draws only external feeds for independent equilibria and shows complete source and portions in the ledger',()=>{
 const feed=[term('fresh','aqueous',.2,'composition 3')];const {container}=render(<LoopDiagram inner={pressure} outer={repeat(2)} fixedConditions={[]} materialStages={stages({first_start:feed,first_following:feed,later_start:feed,later_following:feed})}/>);
 expect(container.querySelectorAll('[data-source="fresh"]')).toHaveLength(6);expect(container.querySelectorAll('[data-source="left"],[data-source="above"]')).toHaveLength(0);
 expect(ledger(container).textContent).toContain('composition 3水相0.2 份');expect(ledger(container).querySelectorAll('li')).toHaveLength(1);expect(screen.getAllByText('+ 水相')).toHaveLength(6);
});
it('represents four-stage horizontal and vertical sources without imposing particular phases',()=>{
 const sources=stages({first_following:[term('left','gas',.3)],later_start:[term('above','aqueous',.8)],later_following:[term('left','mineral',.6),term('above','species',.4)]});
 const {container}=render(<LoopDiagram inner={pressure} outer={repeat(3)} fixedConditions={[]} materialStages={sources}/>);
 const left=[...container.querySelectorAll('[data-source="left"]')],above=[...container.querySelectorAll('[data-source="above"]')];expect(left).toHaveLength(6);expect(above).toHaveLength(6);
 for(const e of left){expect(Number(e.getAttribute('data-from-inner'))+1).toBe(Number(e.getAttribute('data-to-inner')));expect(e.getAttribute('data-from-outer')).toBe(e.getAttribute('data-to-outer'));}
 for(const e of above){expect(Number(e.getAttribute('data-from-outer'))+1).toBe(Number(e.getAttribute('data-to-outer')));expect(e.getAttribute('data-from-inner')).toBe(e.getAttribute('data-to-inner'));}
 expect(left[0].querySelector('.loop-diagram__edge-label')?.textContent).toBe('气相');expect(above[0].querySelector('.loop-diagram__edge-label')?.textContent).toBe('水相');expect(ledger(container).textContent).toContain('30%');expect(ledger(container).textContent).toContain('40%');
});
it('does not connect sampled points across omitted predecessors and retains real global numbers',()=>{
 const choose=vi.fn();const {container}=render(<LoopDiagram inner={{...pressure,values:Array.from({length:100},(_,i)=>700-i),step:-1}} outer={repeat(40)} fixedConditions={[]} materialStages={hch()} onSelect={choose}/>);
 expect(container.querySelectorAll('.loop-diagram__point')).toHaveLength(16);
 for(const e of container.querySelectorAll('[data-source="left"]'))expect(Number(e.getAttribute('data-to-inner'))-Number(e.getAttribute('data-from-inner'))).toBe(1);
 for(const e of container.querySelectorAll('[data-source="above"]'))expect(Number(e.getAttribute('data-to-outer'))-Number(e.getAttribute('data-from-outer'))).toBe(1);
 expect(screen.getByText('第4000次')).toBeTruthy();expect(screen.getByText('显示部分反应条件，共 4000 次平衡')).toBeTruthy();const last=screen.getByRole('button',{name:/第 4000 次反应/});fireEvent.click(last);fireEvent.keyDown(last,{key:' '});expect(choose).toHaveBeenNthCalledWith(1,99,39);expect(choose).toHaveBeenNthCalledWith(2,99,39);
});
it('leaves zero, invalid, impossible and unspecified-source transfers unconnected and visible in the ledger',()=>{
 const inputs=stages({first_start:[term('left'),term('above')],first_following:[term('left','aqueous',0),term('above')],later_start:[term('above','mineral',NaN),term('other','gas',1,'指定结果')],later_following:[term('left','aqueous',-1),term('above','mineral',Infinity)]});
 const {container}=render(<LoopDiagram inner={pressure} outer={repeat(2)} fixedConditions={[]} materialStages={inputs}/>);expect(container.querySelectorAll('.loop-diagram__material-edge')).toHaveLength(0);expect(ledger(container).textContent).toContain('指定来源 · 指定结果');expect(ledger(container).textContent).toContain('此处没有上一个位置');
});
it('uses actual per-point quantities including a zero first value, with complete range information beside the graph',()=>{
 const flow={...term('left','aqueous',0),quantityLabel:'0–100%',fractionAt:(ii:number)=>ii===1?0:ii===2?.5:1};const {container}=render(<LoopDiagram inner={{...pressure,values:[700,695,690,685]}} outer={repeat(1)} fixedConditions={[]} materialStages={stages({first_following:[flow]})}/>);
 expect(container.querySelector('[data-source="left"][data-to-inner="1"]')).toBeNull();expect(container.querySelectorAll('[data-source="left"]')).toHaveLength(2);expect(container.querySelector('[data-source="left"][data-to-inner="2"] title')?.textContent).toContain('50%');expect(ledger(container).textContent).toContain('0–100%');
});
it('highlights the matching sources and all positions in the selected stage while retaining keyboard selection',()=>{
 const choose=vi.fn();const {container,rerender}=render(<LoopDiagram inner={pressure} outer={repeat(3)} fixedConditions={[]} materialStages={hch()} selectedStage="later_start" onSelect={choose}/>);expect(container.querySelectorAll('.loop-diagram__point--selected')).toHaveLength(2);expect(container.querySelectorAll('.loop-diagram__material-entry.is-selected')).toHaveLength(2);
 fireEvent.keyDown(container.querySelector('.loop-diagram__point[data-inner-index="0"][data-outer-index="2"]')!,{key:'Enter'});expect(choose).toHaveBeenCalledWith(0,2);
 rerender(<LoopDiagram inner={repeat(1)} outer={repeat(1)} fixedConditions={[]} materialStages={hch()} selectedStage="later_start"/>);expect(ledger(container).textContent).toContain('首次起点');expect(ledger(container).textContent).not.toContain('后续轮起点');
});
it('keeps single-reaction composition, conditions and units readable without fake controls or duplicate summaries',()=>{
 const {container}=render(<LoopDiagram inner={repeat(1)} outer={repeat(1)} fixedConditions={['温度 25 °C']} outerAnnotations={['700 bar']} reactants={['旧摘要']} materialStages={hch()}/>);expect(screen.getByText('单次反应')).toBeTruthy();expect(screen.getByText('700 bar')).toBeTruthy();expect(ledger(container).textContent).toContain('流体');expect(container.querySelector('svg')).toBeNull();expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByText('旧摘要')).toBeNull();
});
it('keeps a one-position multi-round plan vertical with its actual variable',()=>{
 const {container}=render(<LoopDiagram inner={{label:'压力',unit:'bar',mode:'list',values:[100]}} outer={{label:'温度',unit:'°C',mode:'range',values:[100,150,200],step:50}} fixedConditions={[]} materialStages={stages({later_start:[term('above','mineral',.75)]})}/>);expect(container.querySelectorAll('[data-source="above"]')).toHaveLength(2);expect(container.querySelectorAll('[data-source="left"]')).toHaveLength(0);expect(screen.getByText('温度 / °C')).toBeTruthy();expect(ledger(container).textContent).toContain('75%');
});
it('preserves precise condition ranges and distinguishes ordering from material arrows',()=>{
 const {container}=render(<LoopDiagram inner={{label:'投料量',unit:'mol',mode:'range',values:[1,1.00000001],step:1e-8}} outer={repeat(2)} fixedConditions={[]} materialStages={hch()}/>);expect(screen.getByText(/1 → 1\.00000001 mol · 每步 1e-8 mol/)).toBeTruthy();expect(screen.getByText('编号表示计算顺序，箭头表示物料传递。')).toBeTruthy();expect(container.textContent).not.toMatch(/循环|执行顺序|间距|数值差|索引|算法/);
});
it('handles incomplete conditions without invalid coordinates and recovers',()=>{
 const {container,rerender}=render(<LoopDiagram inner={{...pressure,values:[]}} outer={repeat(1)} fixedConditions={[]}/>);expect(screen.getByText('补全反应条件后，这里会显示反应路径。')).toBeTruthy();expect(container.querySelector('svg')).toBeNull();rerender(<LoopDiagram inner={{...pressure,values:[100,NaN]}} outer={repeat(1)} fixedConditions={[]}/>);expect(container.querySelector('svg')).toBeNull();rerender(<LoopDiagram inner={pressure} outer={repeat(1)} fixedConditions={[]}/>);expect(screen.getByRole('img')).toBeTruthy();
});
it('keeps marker IDs unique and does not render unconfigured coordinate-direction arrows',()=>{
 const {container}=render(<><LoopDiagram inner={pressure} outer={repeat(2)} fixedConditions={[]} materialStages={hch()}/><LoopDiagram inner={pressure} outer={repeat(2)} fixedConditions={[]} materialStages={hch()}/></>);const ids=[...container.querySelectorAll('marker')].map(e=>e.id);expect(new Set(ids).size).toBe(ids.length);for(const svg of container.querySelectorAll('svg')){const own=new Set([...svg.querySelectorAll('marker')].map(e=>e.id));for(const edge of svg.querySelectorAll('[marker-end]'))expect(own.has(edge.getAttribute('marker-end')!.slice(5,-1))).toBe(true);}expect(container.querySelector('.loop-diagram__axis')).toBeNull();
});
it('retains all composition names, phases, selected species and quantities instead of hiding a third or later input',()=>{
 const feeds=[term('fresh','aqueous',1,'water composition'),term('fresh','mineral',.2,'rock composition'),{...term('fresh','species',.01,'tracer composition'),species:['NaCl','H+']}];const {container}=render(<LoopDiagram inner={pressure} outer={repeat(2)} fixedConditions={[]} materialStages={stages({first_start:feeds,first_following:feeds})}/>);
 expect(container.querySelector('[data-source="fresh"][data-to-inner="0"] .loop-diagram__edge-label')?.textContent).toBe('+ 水相+ 固相+ species');const text=ledger(container).textContent!;for(const expected of ['water composition','rock composition','tracer composition','水相','矿物','指定 species','NaCl · H+','1 份','0.2 份','0.01 份'])expect(text).toContain(expected);expect(container.textContent).not.toMatch(/另 \d+ 项/);expect(ledger(container).querySelectorAll('li')).toHaveLength(3);
});
it('uses disjoint calculated label bands for all five phases and every real source direction',()=>{
 const phases=['all','aqueous','mineral','gas','species'],fresh=phases.map(p=>term('fresh',p)),left=phases.map(p=>term('left',p)),above=phases.map(p=>term('above',p));const {container}=render(<LoopDiagram inner={{...pressure,values:[700,695,690,685]}} outer={repeat(4)} fixedConditions={[]} materialStages={stages({first_start:fresh,first_following:[...fresh,...left],later_start:[...fresh,...above],later_following:[...fresh,...left,...above]})}/>);
 const label=(selector:string)=>container.querySelector(`${selector} .loop-diagram__edge-label`)!;const bounds=(e:Element)=>[Number(e.getAttribute('data-label-top')),Number(e.getAttribute('data-label-bottom'))];
 const firstLeft=bounds(label('[data-source="left"][data-to-inner="1"][data-to-outer="0"]')),nextAbove=bounds(label('[data-source="above"][data-to-inner="1"][data-to-outer="1"]')),nextFresh=bounds(label('[data-source="fresh"][data-to-inner="1"][data-to-outer="1"]'));
 expect(firstLeft[1]).toBeLessThan(nextAbove[0]);expect(nextAbove[1]).toBeLessThan(nextFresh[0]);
 for(const e of container.querySelectorAll('.loop-diagram__edge-label'))expect(e.querySelectorAll('text')).toHaveLength(5);
 for(const node of container.querySelectorAll('.loop-diagram__point')){const rect=node.querySelector('rect')!,top=Number(rect.getAttribute('y')),i=node.getAttribute('data-inner-index'),o=node.getAttribute('data-outer-index');expect(bounds(label(`[data-source="fresh"][data-to-inner="${i}"][data-to-outer="${o}"]`))[1]).toBeLessThan(top);}
});
it('shows actual row pressure annotations by real round index, including sampled final rows',()=>{
 const annotations=Array.from({length:40},(_,i)=>i===0?'Psat(T)':`${700+i} bar`);const {container}=render(<LoopDiagram inner={pressure} outer={repeat(40)} fixedConditions={[]} outerAnnotations={annotations} materialStages={hch()}/>);expect([...container.querySelectorAll('.loop-diagram__row-annotation')].map(e=>e.textContent)).toEqual(['Psat(T)','701 bar','738 bar','739 bar']);
});
it('shows explicit zero feed when a chosen composition subset contributes nothing',()=>{
 const input={...term('fresh','species',1,'empty selection'),quantityLabel:'1 份',fractionAt:()=>0};const {container}=render(<LoopDiagram inner={repeat(1)} outer={repeat(1)} fixedConditions={[]} materialStages={stages({first_start:[input]})}/>);expect(ledger(container).textContent).toContain('此处没有投料');expect(container.querySelector('.loop-diagram__material-entry.is-inactive')).toBeTruthy();
});

it('keeps an exact selected middle point in the sampled grid and highlights only that point',()=>{
 const choose=vi.fn();const {container}=render(<LoopDiagram inner={repeat(100)} outer={repeat(40)} fixedConditions={[]} materialStages={hch()} selectedPoint={{inner:50,outer:20}} pointLabel={(ii,oi)=>`T ${ii+oi} °C`} onSelect={choose}/>);
 const selected=container.querySelectorAll('.loop-diagram__point--selected');expect(selected).toHaveLength(1);expect(selected[0].getAttribute('data-inner-index')).toBe('50');expect(selected[0].getAttribute('data-outer-index')).toBe('20');
 expect(selected[0].getAttribute('aria-label')).toContain('T 70 °C');expect(selected[0].getAttribute('aria-pressed')).toBe('true');fireEvent.keyDown(selected[0],{key:'Enter'});expect(choose).toHaveBeenCalledWith(50,20);
});
it('does not classify a stage as empty just because its only feed is between the sampled nodes',()=>{
 const feed={...term('fresh','aqueous',0,'中间补充流体'),fractionAt:(ii:number)=>ii===50?1:0};const {container}=render(<LoopDiagram inner={repeat(100)} outer={repeat(1)} fixedConditions={[]} materialStages={stages({first_following:[feed]})}/>);
 expect(ledger(container).textContent).not.toContain('此处没有投料');expect(ledger(container).textContent).toContain('部分位置加入');expect(ledger(container).querySelector('.is-inactive')).toBeNull();
});
it('can omit the duplicate ledger and draws a specified output only when its exact completed source is present',()=>{
 const other={...term('other','mineral',.25,'本轮位置 1'),sourceAt:(_:number,oi:number)=>({inner:0,outer:oi})};const {container}=render(<LoopDiagram inner={repeat(3)} outer={repeat(1)} fixedConditions={[]} materialStages={stages({first_following:[other]})} showMaterialLedger={false}/>);
 expect(container.querySelector('.loop-diagram__material-ledger')).toBeNull();expect(container.querySelectorAll('[data-source="other"]')).toHaveLength(2);expect(container.querySelector('[data-source="other"][data-to-inner="2"]')?.getAttribute('data-from-inner')).toBe('0');
});
