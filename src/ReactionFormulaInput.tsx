import {createContext,useContext,useId,useState,useRef,useLayoutEffect,type InputHTMLAttributes} from 'react';
import {t,useLanguage} from './i18n';
import {targetKey,type LoopTarget} from './simulation-loops';
import {stageAt} from './reaction-stages';
import type {ReactionStageKey} from './simulation-types';
import type {ScheduleDiagnostic,ScheduleIssueLocation} from './schedule-diagnostics';

export const FormulaDiagnosticContext=createContext<ScheduleDiagnostic|undefined>(undefined);
export type FormulaReference={target?:LoopTarget;settingIds?:string[];stage?:ReactionStageKey;overrideId?:string;stop?:'first'|'later'|'rounds';scope?:{overrideId:string;axis:'positions'|'rounds';field:'start'|'end'|'step'};routeId?:string;routeField?:'source'|'position'|'round';constraint?:{id:string;field:'titrant'|'species'|'rounds'|'positions'|'exchange';bound?:'start'|'end'|'step'}};
export function matchesFormulaInput(field:FormulaReference,location?:ScheduleIssueLocation):boolean{
 if(!location)return false;
 if(location.kind==='stop')return field.stop===location.rule;
 if(location.kind==='scope')return !!field.scope&&field.scope.overrideId===location.overrideId&&field.scope.axis===location.axis&&field.scope.field===location.field;
 if(location.kind==='source')return field.routeId===location.routeId&&(field.routeField??'source')===(location.field??'source');
 if(location.kind==='constraint')return field.constraint?.id===location.constraintId&&field.constraint.field===location.field&&field.constraint.bound===location.bound;
 if(!field.target||targetKey(field.target)!==targetKey(location.target))return false;
 if(field.stage&&field.stage!==stageAt(location.inner,location.outer))return false;
 if(field.overrideId&&field.overrideId!==location.overrideId)return false;
 return !field.settingIds||!location.settingId||field.settingIds.includes(location.settingId);
}
export function formulaField(root:HTMLElement|null,location?:ScheduleIssueLocation):HTMLElement|undefined{
 if(!root||!location)return;
 return Array.from(root.querySelectorAll<HTMLElement>('[data-formula-reference]')).find(el=>{
  try{return matchesFormulaInput(JSON.parse(el.dataset.formulaReference!),location);}catch{return false;}
 });
}
export function revealInput(field:HTMLElement){
 for(let parent=field.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;
 field.scrollIntoView?.({block:'center'});field.focus({preventScroll:true});
}
export type FormulaContext={kind:'temperature'|'pressure'|'amount'|'value'|'stop'|'completion';stage?:ReactionStageKey};
export function formulaHelp({kind,stage}:FormulaContext):string[]{
 if(kind==='completion')return [t('N：轮次编号，从 0 开始。N = 2 表示共计算 3 轮。','N: round index, starting at 0. N = 2 runs 3 rounds.'),t('达到条件的这一轮仍会计算。','The round that meets the condition is included.')];
 if(kind==='stop')return [t('T、P：本步温压；i：步骤编号；N：轮次编号。编号从 0 开始。','T, P: current temperature and pressure; i: step index; N: round index. Indices start at 0.'),t('例如 i = 3（4 步）或 P <= 150。达到条件的这一步仍会计算。','For example, i = 3 (4 steps) or P <= 150. The step that meets the condition is included.')];
 const first=stage==='first_start',later=stage?.startsWith('later'),start=stage?.endsWith('start');
 const previous=start?t('上一轮起点','the previous round’s initial step'):t('前一步','the previous step');
 const lines:string[]=[];
 if(kind==='temperature'){
  lines.push(first?t('填写初始温度，例如 250。此处没有前次温压。','Enter the initial temperature, for example 250. There are no previous conditions here.'):t(`T、P：${previous}的温度（°C）和压力（bar）。`,`T, P: temperature (°C) and pressure (bar) at ${previous}.`));
 }else if(kind==='pressure'){
  lines.push(t('T：本步温度（°C）。Psat(T)：本步纯水饱和蒸汽压（bar）。','T: current temperature (°C). Psat(T): current pure-water saturation pressure (bar).'));
  if(stage&&!first)lines.push(t(`P：${previous}的压力。`,`P: pressure at ${previous}.`));
 }else{
  lines.push(t('T、P：本步温度（°C）和压力（bar）。','T, P: current temperature (°C) and pressure (bar).'));
  if(stage&&!first)lines.push(t(`X：同一参数在${previous}的值。`,`X: the same parameter’s value at ${previous}.`));
  if(kind==='amount')lines.push(t('新 Composition：份数；反应结果：取用比例，0.5 = 50%。','Fresh composition: number of portions. Reaction output: fraction taken, 0.5 = 50%.'));
 }
 if(later)lines.push(kind==='temperature'||kind==='pressure'?t('Tr、Pr：上一轮同位置的温度、压力。','Tr, Pr: temperature and pressure at the same position in the previous round.'):t('Tr、Pr、Xr：上一轮同位置的温度、压力、同一参数值。','Tr, Pr, Xr: temperature, pressure and the same parameter’s value at the same position in the previous round.'));
 lines.push(t('i：步骤编号；N：轮次编号，均从 0 开始。','i: step index; N: round index. Both start at 0.'));
 if(!stage)lines.push(t('此公式也作用于首点；引用 X 或 Xr 时，应另设初始值及适用范围。','This rule also applies to the first point. References to X or Xr need separate initial values and a valid scope.'));
 return lines;
}
type Props=InputHTMLAttributes<HTMLInputElement>&{reference:FormulaReference;help:FormulaContext};
export function ReactionFormulaInput({reference,help,className='',onFocus,onBlur,onKeyDown,...props}:Props){
 const language=useLanguage(),[helpOpen,setHelpOpen]=useState(false),[above,setAbove]=useState(false);
 const field=useRef<HTMLSpanElement>(null),bubble=useRef<HTMLSpanElement>(null),diagnostic=useContext(FormulaDiagnosticContext),id=useId(),invalid=matchesFormulaInput(reference,diagnostic?.location);
 useLayoutEffect(()=>{
  if(!helpOpen)return;
  const place=()=>{
   if(!field.current||!bubble.current)return;
   const bounds=field.current.getBoundingClientRect(),height=bubble.current.getBoundingClientRect().height;
   let top=0,bottom=window.innerHeight;
   for(let parent=field.current.parentElement;parent;parent=parent.parentElement){
    if(/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)){
     const clip=parent.getBoundingClientRect();if(clip.height){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
    }
   }
   setAbove(bounds.bottom+6+height>bottom&&bounds.top-top>bottom-bounds.bottom);
  };
  place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  return ()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
 },[helpOpen,diagnostic?.message,language]);
 return <span ref={field} className="wave-formula-field" data-help-open={helpOpen||undefined} data-help-above={above||undefined}>
  <input {...props} onFocus={e=>{setHelpOpen(true);onFocus?.(e);}} onBlur={e=>{setHelpOpen(false);onBlur?.(e);}} onKeyDown={e=>{if(e.key==='Escape')setHelpOpen(false);onKeyDown?.(e);}} className={`wave-formula ${className}`} spellCheck={false} data-formula-reference={JSON.stringify(reference)} aria-invalid={invalid||undefined} aria-describedby={[props['aria-describedby'],`${id}-help`].filter(Boolean).join(' ')} aria-errormessage={invalid?`${id}-error`:undefined}/>
  <span ref={bubble} className="wave-formula-help" id={`${id}-help`} role="tooltip">
   {invalid&&<span id={`${id}-error`} className="wave-formula-error">{diagnostic?.message}</span>}
   {formulaHelp(help).map((line,i)=><span key={i}>{line}</span>)}
  </span>
 </span>;
}
