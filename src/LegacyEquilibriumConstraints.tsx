import {useContext} from 'react';
import {FormulaDiagnosticContext,matchesFormulaInput} from './ReactionFormulaInput';
import {Plus,Trash2} from 'lucide-react';
import {t,useLanguage} from './i18n';
import {newId,numeric,type Config,type EquilibriumConstraint,type SimSpecies} from './simulation-types';
import {loopCounts,targetDescription} from './simulation-loops';
import {constraintDefinitionsIssue,removeConstraint} from './equilibrium-constraints';
import {EquilibriumConstraintFields} from './EquilibriumConstraintFields';
import './legacy-equilibrium-constraints.css';

/** Keep equilibrium targets visible on paths whose position-specific sources cannot be migrated. */
export function LegacyEquilibriumConstraints({config,items,onChange}:{config:Config;items:SimSpecies[];onChange:(value:Partial<Config>)=>void}){
 useLanguage();const diagnostic=useContext(FormulaDiagnosticContext);
 const rows=config.equilibrium_constraints||[],counts=loopCounts(config),issue=constraintDefinitionsIssue(config);
 const change=(row:EquilibriumConstraint)=>onChange({equilibrium_constraints:rows.map(old=>old.id===row.id?row:old)});
 const add=(kind:EquilibriumConstraint['kind'])=>{const row:EquilibriumConstraint=kind==='ph'?{id:newId(),kind,value:7,titrant:'',exchange:'add_only'}:{id:newId(),kind,value:1,species:''};onChange({equilibrium_constraints:[...rows,row]});};
 return <section className="sim-panel legacy-equilibrium-targets" aria-label={t('平衡目标','Equilibrium targets')}>
  <div className="sim-panel-heading"><h3>{t('平衡目标','Equilibrium targets')}</h3><span>{t('可选','Optional')}</span></div>
  {!rows.length&&<p className="sim-help">{t('需要控制 pH 或气体逸度时添加目标；否则由实际物料和温压决定平衡。','Add a target to control pH or gas fugacity. Otherwise, the material inputs, temperature and pressure determine equilibrium.')}</p>}
  <div className="legacy-equilibrium-target-list">{rows.map((row,index)=>{const description=targetDescription({kind:'equilibrium_constraint',constraint_id:row.id},config);return <article className="legacy-equilibrium-target" key={row.id}>
   <div className="legacy-equilibrium-target-heading"><strong>{description.label}</strong><label><span>{t('目标值','Target value')}{description.unit?` / ${description.unit}`:''}</span><input data-formula-reference={JSON.stringify({target:{kind:'equilibrium_constraint',constraint_id:row.id}})} aria-invalid={matchesFormulaInput({target:{kind:'equilibrium_constraint',constraint_id:row.id}},diagnostic?.location)||undefined} aria-label={t(`目标 ${index+1} 数值`,`Target ${index+1} value`)} type="number" step="any" value={Number.isFinite(row.value)?row.value:''} onChange={e=>change({...row,value:numeric(e.target.value)})}/></label><button type="button" className="sim-icon-btn" aria-label={t(`删除平衡目标 ${index+1}`,`Remove equilibrium target ${index+1}`)} onClick={()=>onChange(removeConstraint(config,row.id))}><Trash2 size={15}/></button></div>
   <EquilibriumConstraintFields row={row} items={items} onChange={change} positions={counts.inner} rounds={counts.outer} lengths={Number.isInteger(counts.inner)&&Number.isInteger(counts.outer)&&counts.inner>0&&counts.outer>0&&counts.total<=20000?Array.from({length:counts.outer},()=>counts.inner):undefined}/>
  </article>;})}</div>
  <div className="legacy-equilibrium-target-actions"><button type="button" className="text-btn" disabled={rows.length>=100} onClick={()=>add('ph')}><Plus size={14}/>{t('指定 pH','Specify pH')}</button><button type="button" className="text-btn" disabled={rows.length>=100} onClick={()=>add('fugacity')}><Plus size={14}/>{t('指定气体逸度','Specify gas fugacity')}</button></div>
  {rows.length>0&&<p className="sim-help">{t('每个目标在所选范围内保持固定值。不同轮次或位置需要不同值时，可添加同类目标并设置互不重叠的范围。','Each target is fixed within its selected range. For different values across rounds or positions, add another target of the same kind and select non-overlapping ranges.')}</p>}
  {issue&&<p className="loop-error" role="status">{issue}</p>}
 </section>;
}
