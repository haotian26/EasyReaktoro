import {t as tr,useLanguage} from './i18n';
import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Config} from './simulation-types';
export const ACTIVITY_REFERENCES=[
 {id:'oh90',text:'Oelkers, E. H. & Helgeson, H. C. (1990). Triple-ion anions and polynuclear complexing in supercritical electrolyte solutions. Geochimica et Cosmochimica Acta, 54, 727–738.',url:'https://doi.org/10.1016/0016-7037(90)90368-U'},
 {id:'hkf81',text:'Helgeson, H. C., Kirkham, D. H. & Flowers, G. C. (1981). Theoretical prediction of the thermodynamic behavior of aqueous electrolytes… IV. Activity coefficients and osmotic coefficients. American Journal of Science, 281, 1249–1516.',url:'https://doi.org/10.2475/ajs.281.10.1249'},
 {id:'hgk84',get text(){return tr("Haar, L., Gallagher, J. S. & Kell, G. S. (1984). NBS/NRC Steam Tables. Hemisphere Publishing. 链接为 NIST 书目信息。", "Haar, L., Gallagher, J. S. & Kell, G. S. (1984). NBS/NRC Steam Tables. Hemisphere Publishing. Link to the NIST bibliographic record.");},url:'https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nbsspecialpublication708.pdf'},
 {id:'jn91',text:'Johnson, J. W. & Norton, D. (1991). Critical phenomena in hydrothermal systems: state, thermodynamic, electrostatic, and transport properties of H₂O in the critical region. American Journal of Science, 291, 541–648.',url:'https://doi.org/10.2475/ajs.291.6.541'},
 {id:'reaktoro',get text(){return tr("Reaktoro. 水相与气相活度模型说明；下列模型参数和水活度形式对应 Reaktoro 2.13。", "Reaktoro. Aqueous and gas activity-model documentation. The parameters and water-activity expressions shown here correspond to Reaktoro 2.13.");},url:'https://reaktoro.org/tutorials/basics/specifying-activity-models.html'},
 {id:'davies',get text(){return tr("Davies, C. W. (1938). The extent of dissociation of salts in water. Part VIII. Journal of the Chemical Society, 2093–2098. 此处 b = 0.3 与中性物种项采用 Reaktoro 的参数约定。", "Davies, C. W. (1938). The extent of dissociation of salts in water. Part VIII. Journal of the Chemical Society, 2093–2098. The b = 0.3 value and neutral-species term here follow Reaktoro's parameter conventions.");},url:'https://doi.org/10.1039/JR9380002093'},
 {id:'phreeqc',text:'Parkhurst, D. L. & Appelo, C. A. J. (2013). Description of input and examples for PHREEQC version 3. USGS Techniques and Methods, 6–A43.',url:'https://pubs.usgs.gov/tm/06/a43/'},
 {id:'pr76',text:'Peng, D.-Y. & Robinson, D. B. (1976). A New Two-Constant Equation of State. Industrial & Engineering Chemistry Fundamentals, 15, 59–64.',url:'https://doi.org/10.1021/i160057a011'},
 {id:'pr78',get text(){return tr("Robinson, D. B. & Peng, D.-Y. (1978). The Characterization of Heptanes and the Heavier Fractions. University of Alberta. 本软件采用此修订的 Peng–Robinson 模型。", "Robinson, D. B. & Peng, D.-Y. (1978). The Characterization of Heptanes and the Heavier Fractions. University of Alberta. This application uses this revision of the Peng–Robinson model.");},url:'https://reaktoro.org/tutorials/bibliography.html'},
];
export function ReferenceLink({url,children}:{url:string;children:React.ReactNode}){
 useLanguage();
 const [error,setError]=useState(false);
 return <><a href={url} onClick={e=>{e.preventDefault();void invoke('open_reference',{url}).then(()=>setError(false)).catch(()=>setError(true));}}>{children}</a>{error&&<small role="alert">{tr("浏览器未能打开。可复制链接：", "Could not open the browser. Copy this link: ")}{url}</small>}</>;
}
export function Cite({ids}:{ids:string[]}){return <sup className="activity-cite">{ids.map(id=>{const i=ACTIVITY_REFERENCES.findIndex(r=>r.id===id);return <a key={id} href={`#activity-ref-${id}`} title={ACTIVITY_REFERENCES[i]?.text} onClick={e=>{e.preventDefault();document.getElementById('activity-ref-'+id)?.scrollIntoView({block:'center',behavior:'smooth'});}}>[{i+1}]</a>;})}</sup>;}
export function ActivityReferences({model,gas}:{model?:Config['activity_model'];gas?:Config['gas_model']}){
 useLanguage();
 const ids=model==='nacl_edh'?['oh90','hkf81','hgk84','jn91']:model==='hkf'?['hkf81','reaktoro']:model==='davies'?['davies','reaktoro']:model==='phreeqc'?['phreeqc','reaktoro']:model==='ideal'?['reaktoro']:[];
 if(gas)ids.push('reaktoro');if(gas==='peng_robinson')ids.push('pr76','pr78');
 return <section className="activity-references"><h3>{tr("参考文献", "References")}</h3>{ACTIVITY_REFERENCES.map((r,i)=>ids.includes(r.id)&&<p key={r.id} id={'activity-ref-'+r.id}><span>[{i+1}]</span><ReferenceLink url={r.url}>{r.text}</ReferenceLink></p>)}</section>;
}
