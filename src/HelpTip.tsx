import {t as tr,useLanguage} from './i18n';
import {ReactNode,useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {CircleHelp} from 'lucide-react';

/** Context help also works with keyboard focus and a click, without taking layout space. */
export function HelpTip({label,children}:{label:string;children:ReactNode}){
 useLanguage();
  const id=useId(),anchor=useRef<HTMLSpanElement>(null),timer=useRef<ReturnType<typeof setTimeout>>();
  const [position,setPosition]=useState<{left:number;top:number;above:boolean}|null>(null);
  const close=()=>setPosition(null);
  const show=()=>{clearTimeout(timer.current);const r=anchor.current?.getBoundingClientRect();if(r)setPosition({left:Math.min(Math.max(10,r.left-12),window.innerWidth-330),top:r.bottom+8,above:r.bottom>window.innerHeight-190});};
  const later=()=>{timer.current=setTimeout(close,140);};
  useEffect(()=>{if(!position)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')close();};window.addEventListener('keydown',escape);window.addEventListener('resize',close);window.addEventListener('scroll',close,true);return()=>{window.removeEventListener('keydown',escape);window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true);};},[!!position]);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  return <><span ref={anchor} role="button" tabIndex={0} className="help-tip-trigger" aria-label={tr(`${label}帮助`, `${label} help`)} aria-describedby={position?id:undefined} onMouseEnter={show} onMouseLeave={later} onFocus={show} onBlur={later} onClick={e=>{e.preventDefault();show();}} onKeyDown={e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();show();}}}><CircleHelp size={14}/></span>{position && createPortal(<div role="tooltip" id={id} className="help-tip" style={{left:position.left,top:position.above?undefined:position.top,bottom:position.above?window.innerHeight-position.top+32:undefined}} onMouseEnter={()=>clearTimeout(timer.current)} onMouseLeave={later}><strong>{label}</strong><div>{children}</div></div>,document.body)}</>;
}
