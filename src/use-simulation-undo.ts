import {useEffect,useRef,useState} from 'react';
import {Config} from './simulation-types';
import {EditorDraft} from './use-simulation-code';
import {encodeDraft,restoreDraft} from './draft-json';
export type EditSnapshot={config:Config;editor?:EditorDraft};
/** Bounded, lossless UI + raw-code history; saving does not clear the undo stack. */
export function useSimulationUndo(key:string,ready:boolean,value:EditSnapshot,apply:(v:EditSnapshot)=>void){
 const text=JSON.stringify(encodeDraft(value)),state=useRef({key:'',values:[] as string[],cursor:0,applying:''}),[,render]=useState(0);
 useEffect(()=>{
  if(!ready)return;
  const s=state.current;
  if(s.key!==key){s.key=key;s.values=[text];s.cursor=0;s.applying='';render(n=>n+1);return;}
  if(s.applying===text){s.applying='';return;}
  if(s.values[s.cursor]===text)return;
  s.values=s.values.slice(0,s.cursor+1);s.values.push(text);
  while(s.values.length>2&&(s.values.length>80||s.values.reduce((n,v)=>n+v.length,0)>16_000_000))s.values.shift();
  s.cursor=s.values.length-1;render(n=>n+1);
 },[key,ready,text]);
 const move=(delta:number)=>{const s=state.current;if(!ready||s.key!==key)return;const cursor=s.cursor+delta;if(cursor<0||cursor>=s.values.length)return;s.cursor=cursor;s.applying=s.values[cursor];apply(restoreDraft(JSON.parse(s.applying)));render(n=>n+1);};
 return {canUndo:ready&&state.current.key===key&&state.current.cursor>0,canRedo:ready&&state.current.key===key&&state.current.cursor<state.current.values.length-1,undo:()=>move(-1),redo:()=>move(1)};
}
