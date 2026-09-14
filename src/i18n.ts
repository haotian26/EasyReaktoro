import catalog from './i18n-messages.json';
import {useSyncExternalStore} from 'react';

export type Language = 'zh-CN' | 'en';
let language:Language='zh-CN';
const listeners=new Set<()=>void>();
export const normalizeLanguage=(value:unknown):Language=>typeof value==='string'&&value.toLowerCase().startsWith('en')?'en':'zh-CN';
export const getLanguage=()=>language;
export function setLanguage(value:unknown){
  const next=normalizeLanguage(value);
  if(typeof document!=='undefined')document.documentElement.lang=next;
  if(next===language)return;
  language=next;
  listeners.forEach(notify=>notify());
}
const subscribe=(notify:()=>void)=>{listeners.add(notify);return()=>{listeners.delete(notify);};};
/** Subscribe without remounting workspaces or changing scientific/user data. */
export const useLanguage=()=>useSyncExternalStore(subscribe,getLanguage,getLanguage);
const recentPairs=new Map<string,string>();
const recentReverse=new Map<string,string>();
export function t(chinese:string,english:string):string{
 if(chinese.trim()&&english.trim()&&chinese!==english){
  if(!recentPairs.has(chinese)&&recentPairs.size>=2048){const first=recentPairs.keys().next().value!;recentReverse.delete(recentPairs.get(first)!);recentPairs.delete(first);}
  recentPairs.set(chinese,english);recentReverse.set(english,chinese);
 }
 return language==='en'?english:chinese;
}

/** Known application messages only. Never apply this to user names or scientific records. */
const messages=new Map<string,string>(Object.entries(catalog.statics));
const reverseMessages=new Map<string,string>(Object.entries(catalog.statics).map(([zh,en])=>[en,zh]));
const escapePattern=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns:Array<[RegExp,(...values:string[])=>string]>=catalog.patterns.map(entry=>[
 new RegExp('^'+entry.zh.map(escapePattern).join('([\\s\\S]*?)')+'$'),
 (...values:string[])=>entry.en.map((part,index)=>part+(index<entry.order.length?values[entry.order[index]]:'')).join(''),
]);
export function registerMessagePatterns(entries:Array<[RegExp,(...values:string[])=>string]>){patterns.push(...entries);}

export function registerMessages(entries:Record<string,string>){Object.entries(entries).forEach(([zh,en])=>{messages.set(zh,en);reverseMessages.set(en,zh);});}
export function translateMessage(value:string):string{
 if(!value.trim())return value;
  if(language!=='en')return recentReverse.get(value)??reverseMessages.get(value)??value;
  const exact=recentPairs.get(value)??messages.get(value);if(exact!==undefined)return exact;
 for(const [pattern,format] of patterns){const match=pattern.exec(value);if(match)return format(...match.slice(1));}
 if(value.includes('\n'))return value.split('\n').map(line=>translateMessage(line)).join('\n');
 return value;
}
