import {t as tr,useLanguage,translateMessage} from './i18n';
import {useEffect,useRef,useState} from 'react';
import {Compartment,EditorState} from '@codemirror/state';
import {EditorView,drawSelection,highlightActiveLine,highlightActiveLineGutter,highlightSpecialChars,keymap,lineNumbers} from '@codemirror/view';
import {python} from '@codemirror/lang-python';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {HighlightStyle,bracketMatching,foldGutter,foldKeymap,indentOnInput,syntaxHighlighting} from '@codemirror/language';
import {closeBrackets,closeBracketsKeymap} from '@codemirror/autocomplete';
import {tags} from '@lezer/highlight';
import {Check,ChevronDown,Code2,RotateCcw} from 'lucide-react';
import {CodeCell,CodeDocument,CodeIssue} from './use-simulation-code';
import {HelpTip} from './HelpTip';
import './simulation-code.css';

const moduleHelp:Record<string,string>={get system(){return tr("选择参与平衡的物种和水溶剂。", "Choose equilibrium species and the water solvent.");},get materials(){return tr("填写每份配方的物种、数量和单位。", "Enter the species, amounts, and units in each composition portion.");},get conditions(){return tr("设置温度、压力或投料变化，指定反应路径与轮次。", "Set temperature, pressure, or input changes and define path positions and rounds.");},get transfers(){return tr("设置每个点接收哪些物料，以及取用比例。", "Choose the materials received at each point and the fractions taken.");},get activity(){return tr("选择活度模型与气相模型，填写离子尺寸。", "Select aqueous and gas activity models and specify ion sizes.");},get solver(){return tr("设置初始状态和物料守恒的误差容限。", "Set initialization options and the material-balance tolerance.");},get runtime(){return tr("准备计算所需工具，读取当前模拟参数。", "Prepare calculation tools and read the current simulation parameters.");},get build(){return tr("建立各相、活度模型和求解器，换算投料数量。", "Build phases, activity models, and the solver, and convert input amounts.");},get states(){return tr("由实际投料建立初始状态和组分约束。", "Build initial states and component constraints from the actual inputs.");},get equilibrium(){return tr("在指定温压下求平衡，检查收敛与物料守恒。", "Solve equilibrium at the specified temperature and pressure, then check convergence and material balance.");},get inventory(){return tr("按来源和比例分配物料，记录输入、转移和剩余量。", "Allocate material by source and fraction, recording inputs, transfers, and remaining amounts.");},get collect(){return tr("读取物种量、活度、pH 和物料守恒结果。", "Read species amounts, activities, pH, and material-balance results.");},get process(){return tr("沿路径和各轮接收物料、求平衡并保存结果。", "Receive materials, solve equilibrium, and save results along the path and across rounds.");},get execute(){return tr("开始计算，并将每个完成点保存到所选位置。", "Start the calculation and save every completed point to the selected location.");}};

const moduleTitles:Record<string,readonly [string,string]>={
 system:['系统物种','System species'],materials:['初始物质','Compositions'],conditions:['反应路径与条件','Reaction path and conditions'],transfers:['反应物料','Reaction materials'],activity:['活度与气相模型','Activity and gas models'],solver:['求解设置','Solver settings'],runtime:['运行环境','Runtime'],build:['建立体系与求解器','Build system and solver'],states:['初始状态与组分','Initial states and components'],equilibrium:['平衡求解','Equilibrium solving'],inventory:['物料分配与库存','Material allocation and inventory'],collect:['提取结果','Collect results'],process:['反应推进与物料传递','Reaction progress and material transfer'],execute:['运行并保存','Run and save'],
};
export function codeCellTitle(cell:Pick<CodeCell,'id'|'title'>){const pair=moduleTitles[cell.id];return pair&&pair.includes(cell.title)?tr(pair[0],pair[1]):cell.title;}

const colors=HighlightStyle.define([
 {tag:[tags.keyword,tags.bool,tags.null],color:'var(--code-keyword)'},
 {tag:[tags.string,tags.special(tags.string)],color:'var(--code-string)'},
 {tag:tags.number,color:'var(--code-number)'},
 {tag:tags.comment,color:'var(--code-comment)',fontStyle:'italic'},
 {tag:[tags.variableName,tags.definition(tags.variableName)],color:'var(--text)'},
]);
function ParameterCell({cell,index,onChange,disabled,visible,issues}:{cell:CodeCell;index:number;onChange:(id:string,value:string)=>void;disabled:boolean;visible:boolean;issues:CodeIssue[]}){
 const language=useLanguage(),title=codeCellTitle(cell);
 const mount=useRef<HTMLDivElement>(null),editor=useRef<EditorView|null>(null),changing=useRef(false),callback=useRef(onChange),readonly=useRef(new Compartment()),attributes=useRef(new Compartment());
 const [collapsed,setCollapsed]=useState(cell.kind==='execution');callback.current=onChange;
 useEffect(()=>{
  if(!mount.current)return;
  const view=new EditorView({parent:mount.current,state:EditorState.create({doc:cell.source,extensions:[
   lineNumbers(),highlightActiveLineGutter(),highlightSpecialChars(),history(),drawSelection(),foldGutter(),
   python(),indentOnInput(),bracketMatching(),closeBrackets(),syntaxHighlighting(colors),highlightActiveLine(),
   keymap.of([{key:'Escape',run:v=>{v.setTabFocusMode(2000);return false;}},...closeBracketsKeymap,...defaultKeymap,...historyKeymap,...foldKeymap,indentWithTab]),
   readonly.current.of([EditorState.readOnly.of(disabled),EditorView.editable.of(!disabled)]),
   attributes.current.of(EditorView.contentAttributes.of({'aria-label':tr(`${title}代码`,`${title} code`),spellcheck:'false',autocapitalize:'off',autocorrect:'off'})),
   EditorView.updateListener.of(update=>{if(update.docChanged && !changing.current)callback.current(cell.id,update.state.doc.toString());}),
   EditorView.theme({'&':{fontSize:'12px',backgroundColor:'var(--surface)',color:'var(--text)'},'.cm-content':{fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',padding:'12px 0',lineHeight:'1.75'},'.cm-scroller':{maxHeight:'430px',overflow:'auto'},'.cm-gutters':{backgroundColor:'var(--surface)',color:'var(--muted)',border:'none',minWidth:'42px'},'.cm-activeLine,.cm-activeLineGutter':{backgroundColor:'var(--code-active)'},'.cm-cursor':{borderLeftColor:'var(--text)'},'&.cm-focused':{outline:'none'},'&.cm-focused .cm-selectionBackground,.cm-selectionBackground':{backgroundColor:'var(--code-selection)'},'.cm-foldPlaceholder':{backgroundColor:'var(--surface-soft)',borderColor:'var(--line)',color:'var(--muted)'}}),
  ]})});editor.current=view;return()=>{view.destroy();editor.current=null;};
 },[cell.id]);
 useEffect(()=>{const view=editor.current;if(view && cell.source!==view.state.doc.toString()){changing.current=true;try{view.dispatch({changes:{from:0,to:view.state.doc.length,insert:cell.source}});}finally{changing.current=false;}}},[cell.source]);
 useEffect(()=>{editor.current?.dispatch({effects:readonly.current.reconfigure([EditorState.readOnly.of(disabled),EditorView.editable.of(!disabled)])});},[disabled]);
 useEffect(()=>{editor.current?.dispatch({effects:attributes.current.reconfigure(EditorView.contentAttributes.of({'aria-label':tr(`${title}代码`,`${title} code`),spellcheck:'false',autocapitalize:'off',autocorrect:'off'}))});},[language,title]);
 useEffect(()=>{if(visible && !collapsed)editor.current?.requestMeasure();},[visible,collapsed]);
 useEffect(()=>{if(issues.length)setCollapsed(false);},[issues.length]);
 const focusIssue=(issue:CodeIssue)=>{const view=editor.current;if(!view)return;const line=view.state.doc.line(Math.max(1,Math.min(view.state.doc.lines,issue.line || 1))),at=Math.min(line.to,line.from+(issue.column || 1)-1);view.dispatch({selection:{anchor:at},effects:EditorView.scrollIntoView(at,{y:'center'})});view.focus();};
 return <section className={'sim-code-cell'+(issues.length?' has-error':'')} id={'sim-code-'+cell.id}>
  <header><button className="sim-cell-heading" aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}><span className="sim-cell-index">{String(index+1).padStart(2,'0')}</span><strong>{title}</strong><ChevronDown size={14} className={collapsed?'collapsed':''}/></button><p>{moduleTitles[cell.id]?.includes(cell.title)?moduleHelp[cell.id]||cell.description:cell.description}</p></header>
  <div hidden={collapsed}><div ref={mount} className="sim-python-editor"/>{issues.map((issue,i)=><button className="sim-code-error" key={i} onClick={()=>focusIssue(issue)}>{tr(`第 ${issue.line||1} 行 · `,`Line ${issue.line||1} · `)}{translateMessage(issue.message)}</button>)}</div>
 </section>;
}
export default function SimulationCode({document,onChange,disabled,visible,dirty,processing,issues,persisted,onApply,onDiscard,onRestore,canRestore,custom,onResetProgram}:{document:CodeDocument;onChange:(id:string,value:string)=>void;disabled:boolean;visible:boolean;dirty:boolean;processing:boolean;issues:CodeIssue[];persisted:boolean;onApply:()=>void;onDiscard:()=>void;onRestore:()=>void;canRestore:boolean;custom:boolean;onResetProgram:()=>void}){
 useLanguage();
 const region=useRef<HTMLDivElement>(null);
 const go=(id:string)=>{const node=region.current?.querySelector('#sim-code-'+id);const toggle=node?.querySelector<HTMLButtonElement>('.sim-cell-heading[aria-expanded="false"]');toggle?.click();requestAnimationFrame(()=>node?.scrollIntoView({block:'start',behavior:'smooth'}));};
 return <div className="sim-notebook" ref={region}>
  <div className="sim-code-tools"><div><Code2 size={15}/><strong>{custom?tr("自定义 Python", "Custom Python"):tr("Python 模拟", "Python simulation")}</strong><span role="status">{processing?tr("正在检查…", "Checking…"):dirty?tr("有修改，运行前检查", "Modified; check before running"):tr("参数已同步", "Parameters synchronized")}</span><HelpTip label={tr("代码界面", "Code editor")}>{tr("前六个模块与图形设置同步，后面的模块控制平衡求解和物料传递。修改代码后切回图形界面，参数与代码都会保留。", "The first six modules synchronize with visual settings. The remaining modules control equilibrium solving and material transfer. Switching back to the visual editor preserves both parameters and code.")}<br/>{tr("点击运行时，所有模块从头依次执行，不沿用上次计算的变量。代码可以读取和写入电脑上的文件。", "Each run executes all modules from the beginning, without reusing variables from the previous run. Code can read and write files on this computer.")}<br/>{tr("Tab 缩进；按 Esc 再按 Tab 可移出编辑区。保存设置时会一起保存代码和注释。", "Tab indents; press Esc then Tab to leave the editor. Saving settings also saves your code and comments.")}</HelpTip></div><div><button className="text-btn" disabled={disabled || processing} onClick={onApply}><Check size={14}/>{tr("检查代码与参数", "Check code and parameters")}</button>{custom && <button className="text-btn" disabled={disabled || processing} onClick={onResetProgram}>{tr("恢复标准求解代码", "Restore standard solver code")}</button>}{dirty && <button className="text-btn" disabled={disabled || processing} onClick={onDiscard}><RotateCcw size={13}/>{tr("放弃代码修改并返回图形界面", "Discard code edits and return to visual settings")}</button>}{canRestore && <button className="text-btn" disabled={disabled || processing} onClick={onRestore}>{tr("恢复上次代码", "Restore previous code")}</button>}</div></div>
  {!persisted && <div className="sim-message error" role="alert">{tr("代码未能自动保存，请使用“保存设置”另存。当前编辑已保留。", "Code could not be autosaved. Use Save settings to save a separate copy. Your current edits have been kept.")}</div>}
  {issues.filter(x=>!x.cell_id).map((issue,i)=><div className="sim-message error" role="alert" key={i}>{translateMessage(issue.message)}</div>)}
  <div className="sim-code-layout"><nav className="sim-code-nav" aria-label={tr("代码模块", "Code modules")}>{document.cells.map((c,i)=><div key={c.id}>{(i===0 || c.id==='runtime') && <small>{i===0?tr("参数 · 与图形设置同步", "Parameters · Synchronized with visual settings"):tr("执行 · 顺序运行", "Execution · Run in order")}</small>}<button onClick={()=>go(c.id)}><span>{String(i+1).padStart(2,'0')}</span>{codeCellTitle(c)}{c.kind==='execution' && c.source!==c.baseline_source && <i title={tr("已修改", "Modified")}>•</i>}</button></div>)}</nav>
  <div className="sim-code-cells">{document.cells.map((cell,index)=><ParameterCell key={cell.id} {...{cell,index,visible}} onChange={onChange} disabled={disabled || processing} issues={issues.filter(x=>x.cell_id===cell.id)}/>)}</div></div>
 </div>;
}
