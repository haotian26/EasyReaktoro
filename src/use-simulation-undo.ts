import {useEffect,useMemo,useRef,useState} from 'react';
import {Config} from './simulation-types';
import {EditorDraft} from './use-simulation-code';
import {encodeDraft,restoreDraft} from './draft-json';
export type EditSnapshot={config:Config;editor?:EditorDraft};
type Entry={text:string;group?:number};

function textField(target:EventTarget|null):HTMLElement|null{
 if(!(target instanceof HTMLElement))return null;
 if(target instanceof HTMLTextAreaElement)return target;
 if(target instanceof HTMLInputElement&&['text','number','search','email','url','tel','password'].includes(target.type))return target;
 return target.closest<HTMLElement>('[contenteditable=true]');
}

/** Saving retains history. A continuous edit is one undo step; commands and
 * field changes end the group, and every intermediate draft remains editable. */
export function useSimulationUndo(key:string,ready:boolean,value:EditSnapshot,apply:(v:EditSnapshot)=>void){
 const text=useMemo(()=>JSON.stringify(encodeDraft(value)),[value.config,value.editor]);
 const state=useRef({key:'',values:[] as Entry[],cursor:0,applying:''}),[,render]=useState(0);
 const editing=useRef({field:null as HTMLElement|null,serial:0,last:0,pending:undefined as number|undefined});
 const endEdit=()=>{const e=editing.current;e.field=null;e.pending=undefined;e.serial++;};
 useEffect(()=>{
  endEdit();if(!ready)return;
  const input=(event:Event)=>{
   const field=textField(event.target),e=editing.current;if(!field){endEdit();return;}
   const now=Date.now();if(e.field!==field||now-e.last>1500)e.serial++;
   e.field=field;e.last=now;e.pending=e.serial;
  };
  const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'||event.key==='Tab'||event.key==='Enter'&&event.target instanceof HTMLInputElement)endEdit();};
  document.addEventListener('input',input,true);document.addEventListener('change',input,true);
  document.addEventListener('focusout',endEdit,true);document.addEventListener('pointerdown',endEdit,true);
  document.addEventListener('click',endEdit,true);document.addEventListener('keydown',keydown,true);
  return ()=>{
   document.removeEventListener('input',input,true);document.removeEventListener('change',input,true);
   document.removeEventListener('focusout',endEdit,true);document.removeEventListener('pointerdown',endEdit,true);
   document.removeEventListener('click',endEdit,true);document.removeEventListener('keydown',keydown,true);
  };
 },[key,ready]);
 useEffect(()=>{
  if(!ready)return;
  const s=state.current,group=editing.current.pending;editing.current.pending=undefined;
  if(s.key!==key||!s.values.length){s.key=key;s.values=[{text}];s.cursor=0;s.applying='';endEdit();render(n=>n+1);return;}
  if(s.applying===text){s.applying='';return;}
  if(s.values[s.cursor].text===text)return;
  const join=group!==undefined&&s.cursor===s.values.length-1&&s.cursor>0&&s.values[s.cursor].group===group;
  s.values=s.values.slice(0,s.cursor+1);
  if(join){s.values[s.cursor]={text,group};if(s.values[s.cursor-1].text===text){s.values.pop();s.cursor--;}}
  else s.values.push({text,group});
  while(s.values.length>2&&(s.values.length>80||s.values.reduce((n,v)=>n+v.text.length,0)>16_000_000))s.values.shift();
  s.cursor=s.values.length-1;render(n=>n+1);
 },[key,ready,text]);
 const move=(delta:number)=>{const s=state.current;if(!ready||s.key!==key)return;const cursor=s.cursor+delta;if(cursor<0||cursor>=s.values.length)return;endEdit();s.cursor=cursor;s.applying=s.values[cursor].text;apply(restoreDraft(JSON.parse(s.applying)));render(n=>n+1);};
 return {canUndo:ready&&state.current.key===key&&state.current.cursor>0,canRedo:ready&&state.current.key===key&&state.current.cursor<state.current.values.length-1,undo:()=>move(-1),redo:()=>move(1)};
}
