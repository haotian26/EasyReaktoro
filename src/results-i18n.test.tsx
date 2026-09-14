// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {setLanguage} from './i18n';
import {ResultHistory} from './ResultHistory';
import {ResultDestinationDialog} from './ResultDestinationDialog';
import {historyDate} from './result-history';
import {SimulationResults} from './SimulationResults';
import {ConditionSchedule} from './ConditionSchedule';
import {LoopDiagram,type DiagramMaterialStages} from './LoopDiagram';
import {ReactionFlowDiagram} from './ReactionFlowDiagram';
import {DEFAULT_CONFIG} from './simulation-types';
import {simulationCall} from './simulation-api';
vi.mock('./simulation-api',()=>({simulationCall:vi.fn(),simulationError:(e:any)=>String(e)}));
afterEach(()=>{cleanup();setLanguage('zh-CN');vi.clearAllMocks();});
const switchTo=(language:'en'|'zh-CN')=>act(()=>setLanguage(language));

it('updates result history in place while preserving a user name, search and selected file path',()=>{
 const path='/Users/geologist/水岩实验/view.html',open=vi.fn();render(<ResultHistory entries={[{path,name:'水岩实验',kind:'workspace',status:'completed',opened_at:'2026-09-14T02:15:00Z',completed:7,total:9}]} loading={false} error="" busy={false} running={false} onClose={()=>{}} onOpen={open} onForget={async()=>true}/>);
 fireEvent.change(screen.getByLabelText('搜索结果历史'),{target:{value:'水岩'}});switchTo('en');
 expect(screen.getByRole('dialog',{name:'Result history'})).toBeTruthy();expect((screen.getByLabelText('Search result history') as HTMLInputElement).value).toBe('水岩');expect(screen.getByText('Chart workspace')).toBeTruthy();expect(screen.getByText('Completed')).toBeTruthy();expect(screen.getByText('7 / 9 equilibrium points')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Open results'}));expect(open).toHaveBeenCalledWith(expect.objectContaining({path,name:'水岩实验'}));
 const time=new Date('2026-09-14T02:15:00Z');expect(historyDate(time.toISOString())).toBe(time.toLocaleString('en'));switchTo('zh-CN');expect(historyDate(time.toISOString())).toBe(time.toLocaleString('zh-CN'));
});
it('retains the exact edited save-as name while translating the native destination dialog',()=>{
 const choose=vi.fn();render(<ResultDestinationDialog destination={{path:'/QA/水岩实验',name:'水岩实验',exists:true,can_overwrite:true}} onChoice={choose}/>);
 fireEvent.click(screen.getByRole('button',{name:'另存为…'}));fireEvent.change(screen.getByLabelText('新的结果名称'),{target:{value:'水岩实验 – 250 °C'}});switchTo('en');expect(screen.getByRole('alertdialog',{name:'Results with this name already exist'})).toBeTruthy();
 expect((screen.getByLabelText('New result name') as HTMLInputElement).value).toBe('水岩实验 – 250 °C');fireEvent.click(screen.getByRole('button',{name:'Use new name'}));expect(choose).toHaveBeenCalledWith({kind:'save_as',name:'水岩实验 – 250 °C'});
});
it('posts host language without remounting the result iframe or reloading a selected run',async()=>{
 vi.mocked(simulationCall).mockResolvedValue({point_count:1,data:'AA=='});
 const job:any={job_id:'same-run',status:'completed',completed:1,total:1,elapsed_seconds:1,name:'水岩实验',output_path:'/QA/水岩实验',message:''};
 const view=render(<SimulationResults job={job} visible onError={()=>{}} onNotice={()=>{}}/>),frame=screen.getByTitle('结果') as HTMLIFrameElement,original=frame.srcdoc;
 const channel=JSON.parse(original.match(/const hostChannel = ("[^";]+");/)![1]),post=vi.spyOn(frame.contentWindow!,'postMessage');act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{channel,type:'ready'}})));
 await waitFor(()=>expect(post.mock.calls.some(([m])=>m.type==='load')).toBe(true));post.mockClear();const calls=vi.mocked(simulationCall).mock.calls.length;
 switchTo('en');await waitFor(()=>expect(post).toHaveBeenCalledWith(expect.objectContaining({type:'appearance',language:'en'}),'*'));
 expect(screen.getByTitle('Results')).toBe(frame);expect(frame.srcdoc).toBe(original);expect(vi.mocked(simulationCall).mock.calls.length).toBe(calls);expect(post.mock.calls.some(([m])=>['clear','load'].includes(m.type))).toBe(false);expect(view.getByRole('button',{name:'Run details'})).toBeTruthy();
});
it('keeps staged numerical edits when a legacy path editor changes language',()=>{
 const config=structuredClone(DEFAULT_CONFIG),patch=vi.fn();render(<ConditionSchedule config={config} patch={patch} onError={()=>{}} onRules={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'批量生成路线'}));fireEvent.change(screen.getByLabelText('起始温度 (°C)'),{target:{value:'123'}});switchTo('en');
 expect((screen.getByLabelText('Start temperature (°C)') as HTMLInputElement).value).toBe('123');expect(patch).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Generate base path'})).toBeTruthy();
});
it('relabels material diagrams without changing source coordinates, phase classification or actual fractions',()=>{
 const materials:DiagramMaterialStages={first_start:[{source:'fresh',phase:'aqueous',label:'Brine',fraction:.25}],first_following:[{source:'left',phase:'水相',label:'',fraction:.5}],later_start:[],later_following:[]};
 const {container}=render(<LoopDiagram inner={{label:'Position',unit:'',mode:'repeat',values:[1,2]}} outer={{label:'Round',unit:'',mode:'repeat',values:[1]}} fixedConditions={[]} materialStages={materials}/>);
 const before=container.querySelector('[data-source="left"]')!,className=before.getAttribute('class');switchTo('en');const edge=container.querySelector('[data-source="left"]')!;
 expect(edge.getAttribute('class')).toBe(className);expect(edge.getAttribute('data-from-inner')).toBe('0');expect(edge.getAttribute('data-to-inner')).toBe('1');expect(edge.textContent).toContain('50%');expect(screen.getByRole('region',{name:'Reaction diagram'})).toBeTruthy();expect(container.querySelector('.loop-diagram__material-ledger')?.textContent).toContain('First round, later positions');expect(container.querySelector('.loop-diagram__material-ledger')?.textContent).not.toMatch(/[\u4e00-\u9fff]/);
});
it('keeps reaction flow labels compact and actual full values accessible in English',()=>{
 switchTo('en');const select=vi.fn(),materials:DiagramMaterialStages={first_start:[],first_following:[{source:'left',phase:'aqueous',fraction:.12345,label:'Brine'}],later_start:[],later_following:[]};
 const {container}=render(<ReactionFlowDiagram positions={3} rounds={1} selected={{inner:1,outer:0}} materials={materials} point={i=>({temperature_c:250-i*5,pressure_bar:39.761649561576,pressure_mode:'water_saturation'})} onSelect={select}/>);
 expect(container.querySelector('.reaction-flow__round')?.textContent).toBe('Round 1');expect((container.querySelector('.reaction-flow__round') as HTMLElement).style.writingMode).toBe('horizontal-tb');expect(container.querySelector('.reaction-flow__edge span')?.textContent).toBe('Aq.');
 const button=screen.getByRole('button',{name:/Round 1 · position 3;/});expect(button.title).toContain('39.761649561576');fireEvent.click(button);expect(select).toHaveBeenCalledWith(2,0);expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
});
