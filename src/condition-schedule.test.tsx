// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {applyConditions,ConditionSchedule} from './ConditionSchedule';
import {Config,DEFAULT_CONFIG,makeRoute,Point,readConfig} from './simulation-types';
import {pointConditions,saturationPressure} from './process-layout';
import {useSimulationUndo} from './use-simulation-undo';
afterEach(cleanup);
const setNumber=(label:string,value:number|string)=>fireEvent.change(screen.getByLabelText(label),{target:{value:String(value)}});
function mount(initial:Config=structuredClone(DEFAULT_CONFIG)){
 let current=initial;const onError=vi.fn(),patched=vi.fn();
 function Harness(){
  const [config,setConfig]=useState(initial);current=config;
  const undo=useSimulationUndo('schedule-test',true,{config},snapshot=>setConfig(snapshot.config));
  return <><ConditionSchedule config={config} patch={change=>{patched(change);setConfig(old=>({...old,...change}));}} onError={onError} onRules={()=>{}}/><button disabled={!undo.canUndo} onClick={undo.undo}>撤销本次温压编辑</button><button disabled={!undo.canRedo} onClick={undo.redo}>重做本次温压编辑</button></>;
 }
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'批量生成路线'}));return {config:()=>current,onError,patched};
}
const conditions=(config:Config,round:number)=>config.points.map(p=>pointConditions(p,round));
it('generates 100 positions in one operation including both endpoints, with unique persistent position IDs',()=>{
 const h=mount();
 for(const [label,value] of [['起始温度 (°C)',100],['终止温度 (°C)',397],['起始压力 (bar)',700],['终止压力 (bar)',106],['位置数（含两端）',100]] as const)setNumber(label,value);
 fireEvent.click(screen.getByRole('button',{name:'生成基础路线'}));
 expect(h.onError).not.toHaveBeenCalled();expect(h.patched).toHaveBeenCalledTimes(1);
 const points=h.config().points;expect(points).toHaveLength(100);expect(new Set(points.map(p=>p.id)).size).toBe(100);expect(points[0].id).toBe(DEFAULT_CONFIG.points[0].id);
 points.forEach((p,i)=>{expect(p.temperature_c).toBeCloseTo(100+i*3,10);expect(p.pressure_bar).toBeCloseTo(700-i*6,10);});
 fireEvent.click(screen.getByRole('button',{name:'撤销本次温压编辑'}));expect(h.config().points).toEqual(DEFAULT_CONFIG.points);
 fireEvent.click(screen.getByRole('button',{name:'重做本次温压编辑'}));expect(h.config().points).toEqual(points);
});
it('sets a whole middle round to absolute conditions without applying increments or changing the surrounding rounds',()=>{
 const initial={...structuredClone(DEFAULT_CONFIG),cycles:3,points:Array.from({length:100},(_,i):Point=>({id:`position-${i}`,label:`位置 ${i+1}`,temperature_c:100+i,pressure_bar:700+2*i,temperature_increment_c:5,pressure_increment_bar:10,...(i===50?{round_conditions:[{round:3,temperature_c:777,pressure_bar:2000}]}:{})}))};
 const h=mount(initial),beforeFirst=conditions(initial,1),beforeThird=conditions(initial,3);
 fireEvent.click(screen.getByRole('button',{name:'单独设置某一轮'}));expect((screen.getByLabelText('单独设置轮次') as HTMLInputElement).value).toBe('2');expect((screen.getByLabelText('位置数（含两端）') as HTMLInputElement).value).toBe('100');
 for(const [label,value] of [['起始温度 (°C)',300],['终止温度 (°C)',399],['起始压力 (bar)',500],['终止压力 (bar)',401]] as const)setNumber(label,value);
 fireEvent.click(screen.getByRole('button',{name:'应用到第 2 轮'}));
 expect(h.onError).not.toHaveBeenCalled();expect(h.config().points.map(p=>p.id)).toEqual(initial.points.map(p=>p.id));
 conditions(h.config(),2).forEach((p,i)=>{expect(p.temperature).toBeCloseTo(300+i,10);expect(p.pressure).toBeCloseTo(500-i,10);expect(p.overridden).toBe(true);});
 expect(conditions(h.config(),1)).toEqual(beforeFirst);expect(conditions(h.config(),3)).toEqual(beforeThird);
 expect(readConfig(h.config()).points).toEqual(h.config().points);
 fireEvent.click(screen.getByRole('button',{name:'撤销本次温压编辑'}));expect(h.config()).toEqual(initial);
 fireEvent.click(screen.getByRole('button',{name:'重做本次温压编辑'}));expect(conditions(h.config(),2)[99]).toMatchObject({temperature:399,pressure:401,overridden:true});
});
it('keeps the base route separate from a first-round override when switching the editor scope',()=>{
 const initial={...structuredClone(DEFAULT_CONFIG),cycles:3,points:[{id:'start',label:'起点',temperature_c:100,pressure_bar:20,round_conditions:[{round:1,temperature_c:300,pressure_bar:150,pressure_mode:'fixed' as const}]}]};
 const h=mount(initial);fireEvent.click(screen.getByRole('button',{name:'单独设置某一轮'}));setNumber('单独设置轮次',1);
 expect((screen.getByLabelText('起始温度 (°C)') as HTMLInputElement).value).toBe('300');
 fireEvent.click(screen.getByRole('button',{name:'基础路线'}));expect((screen.getByLabelText('起始温度 (°C)') as HTMLInputElement).value).toBe('100');expect((screen.getByLabelText('起始压力 (bar)') as HTMLInputElement).value).toBe('20');
 fireEvent.click(screen.getByRole('button',{name:'生成基础路线'}));expect(h.config().points[0].temperature_c).toBe(100);expect(pointConditions(h.config().points[0],1)).toMatchObject({temperature:300,pressure:150});expect(pointConditions(h.config().points[0],2)).toMatchObject({temperature:100,pressure:20});
});
it('initializes an existing saturation-pressure route correctly and computes pressure for every generated temperature',()=>{
 const h=mount({...structuredClone(DEFAULT_CONFIG),points:[{...DEFAULT_CONFIG.points[0],temperature_c:100,pressure_bar:700,pressure_mode:'water_saturation'}]});
 expect((screen.getByLabelText('生成路线压力方式') as HTMLSelectElement).value).toBe('water_saturation');expect(screen.queryByLabelText('起始压力 (bar)')).toBeNull();
 setNumber('起始温度 (°C)',100);setNumber('终止温度 (°C)',250);setNumber('位置数（含两端）',4);fireEvent.click(screen.getByRole('button',{name:'生成基础路线'}));
 expect(h.onError).not.toHaveBeenCalled();h.config().points.forEach((p,i)=>{expect(p.pressure_mode).toBe('water_saturation');expect(p.temperature_c).toBe(100+i*50);expect(pointConditions(p).pressure).toBeCloseTo(saturationPressure(100+i*50),10);expect(p.pressure_bar).not.toBe(700);});
});
it('rejects a different number of positions for a round without changing existing routes or conditions',()=>{
 const points:Point[]=[{...DEFAULT_CONFIG.points[0],id:'a'},{...DEFAULT_CONFIG.points[0],id:'b'}],snapshot=structuredClone(points);
 expect(()=>applyConditions(points,[{temperature_c:20,pressure_bar:1}],2)).toThrow('第 2 轮需要 2 个位置');expect(points).toEqual(snapshot);
 const h=mount({...structuredClone(DEFAULT_CONFIG),cycles:2,points});fireEvent.click(screen.getByRole('button',{name:'单独设置某一轮'}));setNumber('位置数（含两端）',3);fireEvent.click(screen.getByRole('button',{name:'应用到第 2 轮'}));
 expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('第 2 轮需要 2 个位置'));expect(h.patched).not.toHaveBeenCalled();expect(h.config().points).toEqual(snapshot);
});
it('retains IDs, labels, material routes and other round overrides through both base and specific-round changes',()=>{
 const route={...makeRoute('mineral','previous_cycle'),fraction:.6};
 const points:Point[]=[{id:'reactor-a',label:'入口岩石',temperature_c:100,pressure_bar:20,routes:[route],temperature_increment_c:5,round_conditions:[{round:2,temperature_c:200,pressure_bar:60},{round:4,temperature_c:400,pressure_bar:80}]},{id:'reactor-b',label:'出口岩石',temperature_c:150,pressure_bar:30}];
 const before=structuredClone(points),values=[{temperature_c:50,pressure_bar:2},{temperature_c:60,pressure_bar:3}];
 const changed=applyConditions(points,values,2);expect(changed[0]).toMatchObject({id:'reactor-a',label:'入口岩石',temperature_c:100,pressure_bar:20,routes:[route],temperature_increment_c:5,round_conditions:[{round:2,temperature_c:50,pressure_bar:2},{round:4,temperature_c:400,pressure_bar:80}]});
 expect(changed[1].id).toBe('reactor-b');expect(points).toEqual(before);
 const rebased=applyConditions(changed,[{temperature_c:70,pressure_bar:4},{temperature_c:80,pressure_bar:5}],null);expect(rebased[0].round_conditions).toEqual(changed[0].round_conditions);expect(rebased[0].routes).toEqual([route]);expect(rebased.map(p=>p.id)).toEqual(['reactor-a','reactor-b']);expect(pointConditions(rebased[0],2)).toMatchObject({temperature:50,pressure:2});
});
it('rejects missing, blank and duplicate round definitions during configuration import',()=>{
 const valid={round:2,temperature_c:200,pressure_bar:30,pressure_mode:'fixed'};
 const parse=(rows:unknown)=>readConfig({...structuredClone(DEFAULT_CONFIG),points:[{...DEFAULT_CONFIG.points[0],round_conditions:rows}]});
 for(const row of [{temperature_c:200,pressure_bar:30},{...valid,round:''},{...valid,round:null},{...valid,round:NaN},{...valid,round:0},{...valid,temperature_c:''},{...valid,pressure_bar:null}])expect(()=>parse([row])).toThrow();
 expect(()=>parse([valid,valid])).toThrow();expect(()=>parse([valid])).not.toThrow();
});
it('keeps independent round conditions while lowering the run count and restores their effect when rounds are re-enabled',()=>{
 const initial={...structuredClone(DEFAULT_CONFIG),cycles:3,points:[{...DEFAULT_CONFIG.points[0],temperature_c:100,pressure_bar:10,temperature_increment_c:5,round_conditions:[{round:3,temperature_c:333,pressure_bar:44}]}]};
 const h=mount(initial),before=structuredClone(initial.points);
 setNumber('循环次数',1);expect(h.config().cycles).toBe(1);expect(h.config().points).toEqual(before);expect(screen.getByRole('button',{name:'第 3 轮 · 暂不运行'})).toBeTruthy();
 expect(readConfig(h.config()).points[0].round_conditions).toEqual(before[0].round_conditions);
 setNumber('循环次数',3);expect(h.config().cycles).toBe(3);expect(h.config().points).toEqual(before);fireEvent.click(screen.getByRole('button',{name:'第 3 轮'}));expect((screen.getByLabelText('点 1 温度') as HTMLInputElement).value).toBe('333');expect((screen.getByLabelText('点 1 压力') as HTMLInputElement).value).toBe('44');
 fireEvent.click(screen.getByRole('button',{name:'恢复使用基础路线'}));expect(pointConditions(h.config().points[0],3)).toMatchObject({temperature:110,pressure:10,overridden:false});
 fireEvent.click(screen.getByRole('button',{name:'撤销本次温压编辑'}));expect(pointConditions(h.config().points[0],3)).toMatchObject({temperature:333,pressure:44,overridden:true});
});

it('preserves an existing temperature increment when only pressure is changed, and blank preserves mixed values',()=>{
 const h=mount({...structuredClone(DEFAULT_CONFIG),cycles:3,points:[{...DEFAULT_CONFIG.points[0],temperature_increment_c:10,pressure_increment_bar:20},{...DEFAULT_CONFIG.points[0],id:'b',temperature_increment_c:10,pressure_increment_bar:20}]});
 expect((screen.getByLabelText('每轮温度增加 (°C)') as HTMLInputElement).value).toBe('10');
 setNumber('每轮压力增加 (bar)',5);fireEvent.click(screen.getByRole('button',{name:'用于所有位置'}));expect(h.config().points.map(p=>[p.temperature_increment_c,p.pressure_increment_bar])).toEqual([[10,5],[10,5]]);
 setNumber('每轮温度增加 (°C)','');setNumber('每轮压力增加 (bar)',0);fireEvent.click(screen.getByRole('button',{name:'用于所有位置'}));expect(h.config().points.map(p=>[p.temperature_increment_c,p.pressure_increment_bar])).toEqual([[10,0],[10,0]]);
 fireEvent.click(screen.getByRole('button',{name:'清除增量'}));expect((screen.getByLabelText('每轮温度增加 (°C)') as HTMLInputElement).value).toBe('0');setNumber('每轮压力增加 (bar)',5);fireEvent.click(screen.getByRole('button',{name:'用于所有位置'}));expect(h.config().points.map(p=>[p.temperature_increment_c,p.pressure_increment_bar])).toEqual([[0,5],[0,5]]);fireEvent.click(screen.getByRole('button',{name:'撤销本次温压编辑'}));expect((screen.getByLabelText('每轮压力增加 (bar)') as HTMLInputElement).value).toBe('0');
});

it('shows the actual route before bulk editing and applies staged numbers only on request',()=>{
 const h=mount();fireEvent.click(screen.getByRole('button',{name:'收起批量生成'}));expect(screen.queryByLabelText('位置数（含两端）')).toBeNull();expect((screen.getByLabelText('点 1 温度') as HTMLInputElement).value).toBe('250');
 fireEvent.click(screen.getByRole('button',{name:'批量生成路线'}));setNumber('起始温度 (°C)',50);expect(h.config().points[0].temperature_c).toBe(250);fireEvent.click(screen.getByRole('button',{name:'生成基础路线'}));expect(h.config().points[0].temperature_c).toBe(50);expect(screen.queryByLabelText('起始温度 (°C)')).toBeNull();
});
