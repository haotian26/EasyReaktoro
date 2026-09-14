// @vitest-environment jsdom
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_CONFIG,type Config} from './simulation-types';
import {compileSchedule,defaultSchedule,scheduleSettingSummary,type ParameterSetting} from './simulation-schedule';
import {ScheduleEditor} from './ScheduleEditor';
import {SchedulePreview} from './SchedulePreview';

afterEach(cleanup);
const temperature:ParameterSetting={id:'local-temperature',target:{kind:'temperature'},value:{mode:'linear',start:100,path_step:-10,round_step:5}};
function config():Config{
 const c=structuredClone(DEFAULT_CONFIG);c.species=['H2O'];c.materials[0].inputs=[{species:'H2O',amount:1,unit:'kg'}];
 c.schedule={...defaultSchedule(),positions:8,rounds:4,overrides:[{id:'one-selected-point',positions:{start:2,end:4,step:5},rounds:{start:2,end:4,step:5},parameters:[structuredClone(temperature)]}]};
 return c;
}

it('summarizes an isolated linear point as its actual value without changing its saved increments',()=>{
 const c=config(),before=structuredClone(c),setting=c.schedule!.overrides[0].parameters[0];
 expect(compileSchedule(c).point(1,1).temperature_c).toBe(100);
 expect(scheduleSettingSummary(setting,c,{positions:1,rounds:1})).toBe('100 °C');
 expect(c).toEqual(before);
});

it('keeps only the linear directions with multiple selected coordinates and preserves general summaries',()=>{
 const c=config();
 expect(scheduleSettingSummary(temperature,c,{positions:3,rounds:1})).toBe('100 °C · 每步 -10 °C');
 expect(scheduleSettingSummary(temperature,c,{positions:1,rounds:3})).toBe('100 °C · 每轮 +5 °C');
 expect(scheduleSettingSummary(temperature,c)).toBe('100 °C · 每步 -10 °C · 每轮 +5 °C');
});

it('retains the actual predecessor dependency even when a relative override affects one point',()=>{
 const c=config(),setting:ParameterSetting={...temperature,value:{mode:'relative',along:'path',start:999,step:-10,other_step:5}};
 c.schedule!.overrides[0].parameters=[setting];
 expect(compileSchedule(c).point(1,1).temperature_c).toBe(240);
 expect(scheduleSettingSummary(setting,c,{positions:1,rounds:1})).toBe('前一步 − 10 °C');
 setting.value={mode:'relative',along:'round',start:999,step:10,other_step:5};
 expect(scheduleSettingSummary(setting,c,{positions:1,rounds:1})).toBe('上一轮同位置 + 10 °C');
});

it('uses selected scope counts, including stride, in the editor header and preview details',()=>{
 const c=config(),rendered=render(<><ScheduleEditor config={c} schedule={c.schedule!} onChange={vi.fn()}/><SchedulePreview config={c} items={[]} selected={{inner:1,outer:1}} onSelect={vi.fn()} onAdjust={vi.fn()}/></>);
 expect(rendered.container.querySelector('.schedule-override > summary small')?.textContent).toBe('温度：100 °C');
 expect(rendered.container.querySelector('.schedule-preview__changes li > span')?.textContent).toBe('温度：100 °C');
 const expanded=structuredClone(c);expanded.schedule!.overrides[0].positions={start:2,end:6,step:2};
 rendered.rerender(<><ScheduleEditor config={expanded} schedule={expanded.schedule!} onChange={vi.fn()}/><SchedulePreview config={expanded} items={[]} selected={{inner:1,outer:1}} onSelect={vi.fn()} onAdjust={vi.fn()}/></>);
 expect(rendered.container.querySelector('.schedule-override > summary small')?.textContent).toBe('温度：100 °C · 每步 -10 °C');
 expect(rendered.container.querySelector('.schedule-preview__changes li > span')?.textContent).toBe('温度：100 °C · 每步 -10 °C');
});

it('edits the value of a single-point linear rule without rewriting its method or dormant increments',()=>{
 const c=config(),onChange=vi.fn(),{container}=render(<ScheduleEditor config={c} schedule={c.schedule!} onChange={onChange}/>);
 const input=container.querySelector('.schedule-override input[aria-label="温度 起始值"]')!;
 expect(input.closest('label')?.querySelector('span')?.textContent).toBe('数值');
 expect(container.querySelector('.schedule-override .schedule-profile-note')?.textContent).toBe('当前范围只有一个反应点，使用此值。');
 fireEvent.change(input,{target:{value:'105'}});
 expect(onChange.mock.calls[0][0].overrides[0].parameters[0].value).toEqual({mode:'linear',start:105,path_step:-10,round_step:5});
});
