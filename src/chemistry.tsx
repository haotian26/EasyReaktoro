import React from 'react'

export type ElementInfo = { symbol:string; zh:string; en:string; group:number; period:number; series?:'lanthanide'|'actinide' }

const RAW = `
H|氢|Hydrogen|1|1;He|氦|Helium|18|1
Li|锂|Lithium|1|2;Be|铍|Beryllium|2|2;B|硼|Boron|13|2;C|碳|Carbon|14|2;N|氮|Nitrogen|15|2;O|氧|Oxygen|16|2;F|氟|Fluorine|17|2;Ne|氖|Neon|18|2
Na|钠|Sodium|1|3;Mg|镁|Magnesium|2|3;Al|铝|Aluminium|13|3;Si|硅|Silicon|14|3;P|磷|Phosphorus|15|3;S|硫|Sulfur|16|3;Cl|氯|Chlorine|17|3;Ar|氩|Argon|18|3
K|钾|Potassium|1|4;Ca|钙|Calcium|2|4;Sc|钪|Scandium|3|4;Ti|钛|Titanium|4|4;V|钒|Vanadium|5|4;Cr|铬|Chromium|6|4;Mn|锰|Manganese|7|4;Fe|铁|Iron|8|4;Co|钴|Cobalt|9|4;Ni|镍|Nickel|10|4;Cu|铜|Copper|11|4;Zn|锌|Zinc|12|4;Ga|镓|Gallium|13|4;Ge|锗|Germanium|14|4;As|砷|Arsenic|15|4;Se|硒|Selenium|16|4;Br|溴|Bromine|17|4;Kr|氪|Krypton|18|4
Rb|铷|Rubidium|1|5;Sr|锶|Strontium|2|5;Y|钇|Yttrium|3|5;Zr|锆|Zirconium|4|5;Nb|铌|Niobium|5|5;Mo|钼|Molybdenum|6|5;Tc|锝|Technetium|7|5;Ru|钌|Ruthenium|8|5;Rh|铑|Rhodium|9|5;Pd|钯|Palladium|10|5;Ag|银|Silver|11|5;Cd|镉|Cadmium|12|5;In|铟|Indium|13|5;Sn|锡|Tin|14|5;Sb|锑|Antimony|15|5;Te|碲|Tellurium|16|5;I|碘|Iodine|17|5;Xe|氙|Xenon|18|5
Cs|铯|Caesium|1|6;Ba|钡|Barium|2|6;La|镧|Lanthanum|3|6|lanthanide;Hf|铪|Hafnium|4|6;Ta|钽|Tantalum|5|6;W|钨|Tungsten|6|6;Re|铼|Rhenium|7|6;Os|锇|Osmium|8|6;Ir|铱|Iridium|9|6;Pt|铂|Platinum|10|6;Au|金|Gold|11|6;Hg|汞|Mercury|12|6;Tl|铊|Thallium|13|6;Pb|铅|Lead|14|6;Bi|铋|Bismuth|15|6;Po|钋|Polonium|16|6;At|砹|Astatine|17|6;Rn|氡|Radon|18|6
Fr|钫|Francium|1|7;Ra|镭|Radium|2|7;Ac|锕|Actinium|3|7|actinide;Rf|𬬻|Rutherfordium|4|7;Db|𬭊|Dubnium|5|7;Sg|𬭳|Seaborgium|6|7;Bh|𬭛|Bohrium|7|7;Hs|𬭶|Hassium|8|7;Mt|鿏|Meitnerium|9|7;Ds|𫟼|Darmstadtium|10|7;Rg|𬬭|Roentgenium|11|7;Cn|鿔|Copernicium|12|7;Nh|鿭|Nihonium|13|7;Fl|𫓧|Flerovium|14|7;Mc|镆|Moscovium|15|7;Lv|𫟷|Livermorium|16|7;Ts|鿬|Tennessine|17|7;Og|鿫|Oganesson|18|7
Ce|铈|Cerium|4|8|lanthanide;Pr|镨|Praseodymium|5|8|lanthanide;Nd|钕|Neodymium|6|8|lanthanide;Pm|钷|Promethium|7|8|lanthanide;Sm|钐|Samarium|8|8|lanthanide;Eu|铕|Europium|9|8|lanthanide;Gd|钆|Gadolinium|10|8|lanthanide;Tb|铽|Terbium|11|8|lanthanide;Dy|镝|Dysprosium|12|8|lanthanide;Ho|钬|Holmium|13|8|lanthanide;Er|铒|Erbium|14|8|lanthanide;Tm|铥|Thulium|15|8|lanthanide;Yb|镱|Ytterbium|16|8|lanthanide;Lu|镥|Lutetium|17|8|lanthanide
Th|钍|Thorium|4|9|actinide;Pa|镤|Protactinium|5|9|actinide;U|铀|Uranium|6|9|actinide;Np|镎|Neptunium|7|9|actinide;Pu|钚|Plutonium|8|9|actinide;Am|镅|Americium|9|9|actinide;Cm|锔|Curium|10|9|actinide;Bk|锫|Berkelium|11|9|actinide;Cf|锎|Californium|12|9|actinide;Es|锿|Einsteinium|13|9|actinide;Fm|镄|Fermium|14|9|actinide;Md|钔|Mendelevium|15|9|actinide;No|锘|Nobelium|16|9|actinide;Lr|铹|Lawrencium|17|9|actinide`

export const ELEMENTS: ElementInfo[] = RAW.trim().split(/;|\n/).filter(Boolean).map(item => {
  const [symbol,zh,en,group,period,series] = item.split('|')
  return { symbol, zh, en, group:Number(group), period:Number(period), series:series as ElementInfo['series'] }
})

export function parseFormula(value:string) {
  let formula = value || ''
  const phaseMatch = formula.match(/(\((?:aq|g|s|l|cr)\))$/i)
  const phase = phaseMatch?.[1] || ''
  if (phase) formula = formula.slice(0,-phase.length)
  let charge = ''
  const superscript = formula.match(/([⁰¹²³⁴⁵⁶⁷⁸⁹]*)([⁺⁻])$/)
  const explicit = formula.match(/\^(\d*)([+-])$/)
  if(superscript) {
    charge = superscript[1].split('').map(x => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(x)).join('') + superscript[2]
    formula = formula.slice(0,-superscript[0].length)
  } else if(explicit) {
    charge = explicit[1] + (explicit[2] === '+' ? '⁺' : '⁻')
    formula = formula.slice(0,-explicit[0].length)
  }
  const signed = !charge && formula.match(/([+-])(\d*)$/)
  if (signed) {
    charge = `${signed[2] || ''}${signed[1] === '+' ? '⁺' : '⁻'}`
    formula = formula.slice(0, -signed[0].length)
  }
  formula = formula.replace(/[₀₁₂₃₄₅₆₇₈₉]/g,x => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(x)))
  const tokens = formula.split(/(\d+(?:\.\d+)?)/).filter(Boolean).map((token,index,all) => ({ text:token, sub:/^\d/.test(token) && index > 0 && !/[·•]$/.test(all[index-1]) }))
  return { tokens, charge, phase }
}

export function ChemicalFormula({ value, className='' }:{value:string;className?:string}) {
  const parsed = parseFormula(value)
  return <span className={`chemical-formula ${className}`}>{parsed.tokens.map((token,index) => token.sub ? <sub key={index}>{token.text}</sub> : <React.Fragment key={index}>{token.text}</React.Fragment>)}{parsed.charge && <sup>{parsed.charge}</sup>}{parsed.phase && <span className="phase">{parsed.phase}</span>}</span>
}

export function PeriodicTable({ selected, onChange }:{selected:string[];onChange:(next:string[])=>void}) {
  const [query,setQuery]=React.useState('')
  const [focused,setFocused]=React.useState<ElementInfo | null>(null)
  const matches=ELEMENTS.filter(e => `${e.symbol} ${e.zh} ${e.en}`.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (symbol:string) => onChange(selected.includes(symbol) ? selected.filter(x => x !== symbol) : [...selected,symbol])
  return <div className="periodic-table">
    <div className="periodic-tools"><input aria-label="查找元素" placeholder="查找元素：符号 / 中文 / English" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter' && matches.length===1){e.preventDefault();toggle(matches[0].symbol);}}}/><span aria-live="polite">{query ? `${matches.length} 个匹配` : `已选 ${selected.length} 个元素`}</span>{query && <button type="button" className="secondary" onClick={()=>setQuery('')}>清除搜索</button>}</div>
    <div className="periodic-scroll"><div className="periodic-grid full-periodic">{ELEMENTS.map(element => <button type="button" key={element.symbol} aria-pressed={selected.includes(element.symbol)} title={`${element.zh} · ${element.en} · ${element.symbol}`} className={`${selected.includes(element.symbol) ? 'selected' : ''} ${!matches.includes(element) ? 'not-matched' : ''}`} style={{gridColumn:element.group,gridRow:element.period}} onMouseEnter={()=>setFocused(element)} onFocus={()=>setFocused(element)} onClick={() => toggle(element.symbol)}><strong>{element.symbol}</strong><span>{element.zh}</span><small>{element.en}</small></button>)}</div></div>
    <div className="periodic-caption" aria-live="polite"><span>{focused ? `${focused.symbol} · ${focused.zh} · ${focused.en}` : '点击元素选择或取消；精确搜索后可按 Enter 选择。'}</span><span>{selected.length ? selected.join(' · ') : '未选择元素'}</span></div>
  </div>
}
