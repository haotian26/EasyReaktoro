import {registerMessages,registerMessagePatterns} from './i18n';

// Labels inserted by the shipped validators, not user-authored names or notes.
registerMessages({
 '循环次数':'Number of rounds',
 '守恒误差限值':'Balance tolerance',
 '指定轮次温度':'Temperature for the selected round',
 '指定轮次压力':'Pressure for the selected round',
 '传入比例':'Transferred fraction',
 '首次投料倍数':'Initial composition portions',
 '基础温度':'Base temperature',
 '基础压力':'Base pressure',
 '条件值':'Condition value',
});
registerMessagePatterns([
 [/^第 (\d+) 点(温度|压力)$/,(position,quantity)=>`${quantity==='温度'?'Temperature':'Pressure'} at position ${position}`],
 [/^第 (\d+) 点$/,position=>`Position ${position}`],
 [/^第 (\d+) 轮压力$/,round=>`Pressure in round ${round}`],
 [/^第 (\d+) 轮、路径位置 (\d+) 的参数$/,(round,position)=>`Parameter at round ${round}, position ${position}`],
 [/^路径位置 (\d+)$/,position=>`Path position ${position}`],
 [/^(.+) 投料量$/,species=>`${species} input amount`],
]);
