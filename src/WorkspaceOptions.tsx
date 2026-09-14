import {t as tr,useLanguage} from './i18n';
import {useEffect,useRef} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
export function WorkspaceOptions({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
 useLanguage();
 const panel=useRef<HTMLDivElement>(null);
 useEffect(()=>{const old=document.activeElement as HTMLElement;panel.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>old?.focus();},[]);
 return createPortal(<div className="workspace-options-backdrop" onClick={onClose} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape')onClose();if(e.key==='Tab'){const nodes=[...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')];if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0]?.focus();}}}}><div ref={panel} className="workspace-options" role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><header><h2>{title}</h2><button className="shell-icon" aria-label={tr(`关闭${title}`, `Close ${title}`)} onClick={onClose}><X size={18}/></button></header><div className="workspace-options-content">{children}</div></div></div>,document.body);
}
