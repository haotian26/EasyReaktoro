import {t as tr,useLanguage} from './i18n';
import {useEffect,useRef} from 'react';
import {createPortal} from 'react-dom';

export function ConfirmDialog({title,children,onCancel,onConfirm,confirmLabel=tr("放弃修改", "Discard changes"),busy=false,onSave,saveLabel=tr("保存并继续", "Save and continue"),cancelLabel=tr("继续编辑", "Keep editing")}:{title:string;children:React.ReactNode;onCancel:()=>void;onConfirm:()=>void;confirmLabel?:string;busy?:boolean;onSave?:()=>void;saveLabel?:string;cancelLabel?:string}){
 useLanguage();
 const panel=useRef<HTMLDivElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;panel.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>previous?.focus();},[]);
 return createPortal(<div className="confirm-backdrop" onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'&&!busy)onCancel();if(e.key==='Tab'){const nodes=[...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0]?.focus();}}}}><div className="confirm-panel" role="alertdialog" aria-modal="true" aria-label={title} ref={panel}><h2>{title}</h2><div className="confirm-copy">{children}</div><div className="button-row"><button className="secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</button><button className="danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>{onSave&&<button className="primary" disabled={busy} onClick={onSave}>{saveLabel}</button>}</div></div></div>,document.body);
}
