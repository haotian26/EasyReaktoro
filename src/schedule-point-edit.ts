import {newId} from './simulation-types';
import {decimalSum} from './simulation-schedule';
import type {IndexScope,ParameterProfile,Schedule,ScheduleOverride} from './simulation-schedule';

const contains=(s:IndexScope,n:number)=>n>=s.start&&(s.end===undefined||n<=s.end)&&(n-s.start)%(s.step??1)===0;
function shift(profile:ParameterProfile,path:number,round:number):ParameterProfile {
 if(profile.mode==='linear')return {...profile,start:decimalSum([profile.start,1],[profile.path_step,path],[profile.round_step,round])};
 if(profile.mode==='list')return {...profile,values:profile.values.slice(profile.along==='path'?path:round)};
 return structuredClone(profile);
}
/** Carve a single point out without changing the values or future extent of its existing ranges. */
export function isolateSchedulePoint(schedule:Schedule,inner:number,outer:number):{schedule:Schedule;id:string}{
 const p=inner+1,r=outer+1;
 const matching=schedule.overrides.filter(o=>contains(o.positions,p)&&contains(o.rounds,r));
 if(matching.length===1&&matching[0].positions.start===p&&matching[0].positions.end===p&&matching[0].rounds.start===r&&matching[0].rounds.end===r)return {schedule,id:matching[0].id};
 const id=newId(),point:ScheduleOverride={id,positions:{start:p,end:p},rounds:{start:r,end:r},parameters:[]};
 const overrides=schedule.overrides.flatMap(o=>{
  if(!matching.includes(o))return [o];
  const rows:ScheduleOverride[]=[],ps=o.positions.step??1,rs=o.rounds.step??1;
  const part=(positions:IndexScope,rounds:IndexScope)=>{
   if(positions.start>10000||rounds.start>10000||positions.end!==undefined&&positions.start>positions.end||rounds.end!==undefined&&rounds.start>rounds.end)return;
   rows.push({...o,id:newId(),name:undefined,positions,rounds,parameters:o.parameters.map(s=>({...s,id:newId(),value:shift(s.value,(positions.start-o.positions.start)/ps,(rounds.start-o.rounds.start)/rs)}))});
  };
  if(r>o.rounds.start)part(o.positions,{...o.rounds,end:r-rs});
  part(o.positions,{...o.rounds,start:r+rs});
  if(p>o.positions.start)part({...o.positions,end:p-ps},{start:r,end:r});
  part({...o.positions,start:p+ps},{start:r,end:r});
  point.parameters.push(...o.parameters.map(s=>({...s,id:newId(),value:shift(s.value,(p-o.positions.start)/ps,(r-o.rounds.start)/rs)})));
  return rows;
 });
 return {schedule:{...schedule,overrides:[...overrides,point]},id};
}
