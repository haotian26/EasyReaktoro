// @vitest-environment jsdom
import {useState} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,it,expect} from 'vitest';
import {LoopEditor} from './LoopEditor';
import {DEFAULT_CONFIG} from './simulation-types';
import {defaultLoops,loopPoint,LoopDefinition} from './simulation-loops';
afterEach(cleanup);
it('sets the second round to 700 bar while preserving the complete temperature path in both rounds',()=>{
 let value:LoopDefinition={...defaultLoops(),base:{temperature_c:250,pressure_bar:700,pressure_mode:'water_saturation'},inner:{mode:'range',target:{kind:'temperature'},start:250,end:100,step:-50},outer:{mode:'repeat',count:2}};
 function Harness(){const [definition,setDefinition]=useState(value);return <LoopEditor config={{...DEFAULT_CONFIG,loops:definition}} definition={definition} onChange={next=>{value=next;setDefinition(next);}}/>;}
 render(<Harness/>);fireEvent.click(screen.getByText('按轮次单独设置压力'));fireEvent.click(screen.getByRole('button',{name:'设置另一轮的压力'}));fireEvent.change(screen.getByLabelText('压力设置 1 轮次'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('压力设置 1 方式'),{target:{value:'fixed'}});fireEvent.change(screen.getByLabelText('压力设置 1 数值'),{target:{value:'700'}});
 expect(value.round_conditions).toEqual([{round:2,pressure_mode:'fixed',pressure_bar:700}]);for(let i=0;i<4;i++){expect(loopPoint(value,i,0).pressure_mode).toBe('water_saturation');expect(loopPoint(value,i,1).pressure_bar).toBe(700);expect(loopPoint(value,i,1).temperature_c).toBe(250-50*i);}
 fireEvent.click(screen.getByRole('button',{name:'删除压力设置 1'}));expect(value.round_conditions).toEqual([]);
});
