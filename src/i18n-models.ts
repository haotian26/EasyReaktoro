import {getLanguage,registerMessages,translateMessage} from './i18n';

// Labels and explanatory text supplied by the shipped model registry.
// Scientific record contents, parameter values, identifiers, and units are untouched.
const modelMessages:Record<string,string>={
 '转换标准态模型':'Converted standard-state model',
 '保留来源方程、分段热容、相变及参考态约定的版本化模型；可计算，可修改备注和活度参数，当前不提供方程参数编辑器。':'Preserves the source equations, piecewise heat capacities, phase transitions, and reference-state conventions. Calculations are supported. You can edit notes and activity parameters; equation parameters cannot be edited here.',
 'Reaktoro 数据':'Reaktoro data',
 '使用数据库已有的热力学参数。可以选取已有物种，不支持在这里新建此类模型。':'Uses thermodynamic parameters already in the database. Select an existing species; this model cannot be created from scratch here.',
 '根据形成反应的平衡常数模型和依赖物种计算目标物种标准态性质。':'Calculates the target species’ standard-state properties from its formation-reaction equilibrium constant and the properties of the required species.',
 '参考 pK':'Reference pK',
 '298.15 K 参考项':'Reference term at 298.15 K',
 '溶剂项 Azz':'Solvent term Azz',
 'MRB 溶剂修正系数':'MRB solvent correction coefficient',
 '溶剂项 Bzz':'Solvent term Bzz',
 'MRB 温度修正系数':'MRB temperature correction coefficient',
 '以 298.15 K、1 bar 的标准态量和热容系数计算 G°、H°、S°、Cp° 与 V°。':'Calculates G°, H°, S°, Cp°, and V° from standard-state properties at 298.15 K and 1 bar and the heat-capacity coefficients.',
 'Cp 系数 a':'Cp coefficient a',
 'Cp 系数 b':'Cp coefficient b',
 'Cp 系数 c':'Cp coefficient c',
 '标准摩尔体积':'Standard molar volume',
 '由气相参考态和水合参数计算中性水溶物种标准态性质。':'Calculates standard-state properties of neutral aqueous species from gas reference-state properties and hydration parameters.',
 '水合参数 ξ':'Hydration parameter ξ',
 '水合参数 A':'Hydration parameter A',
 '水合参数 B':'Hydration parameter B',
 '气相 G°(298.15 K)':'Gas G°(298.15 K)',
 '气相 H°(298.15 K)':'Gas H°(298.15 K)',
 '气相 S°(298.15 K)':'Gas S°(298.15 K)',
 '气相 Cp 系数 a':'Gas Cp coefficient a',
 '气相 Cp 系数 b':'Gas Cp coefficient b',
 '气相 Cp 系数 c':'Gas Cp coefficient c',
 '特殊 water/OH 模型':'Specialized water/OH model',
 '仅用于导入并保留已有的受验证记录；当前通用编辑器不能从零创建。':'Available for importing and preserving existing validated records. This model cannot be created from scratch in this editor.',
 'Gas reference 模型':'Gas reference model',
 'Extended Maier–Kelley · 分段热容':'Extended Maier–Kelley · Piecewise heat capacity',
 'Gas reference · 扩展热容':'Gas reference · Extended heat capacity',
 'Akinfiev–Diamond · 气相参考态':'Akinfiev–Diamond · Gas reference state',
 '参考摩尔体积（气体标准态不使用此项）':'Reference molar volume (not used for the gas standard state)',
 '相变温度 / 末项存在上限':'Transition temperature / upper stability limit for the last entry',
 '相变焓':'Transition enthalpy',
 '相变体积':'Transition volume',
 '相变边界 dT/dP':'Phase-boundary dT/dP',
 'b · √(1000 K/T) 约定':'b · √(1000 K/T) convention',
 '热容分段数':'Number of heat-capacity segments',
 '气相热容系数数目':'Number of gas heat-capacity coefficients',
};
registerMessages(modelMessages);

/** Only used for model-registry descriptions, never free-form scientific records. */
export function translateModelMessage(value:string):string{
 if(getLanguage()!=='en')return value;
 const phase=value.match(/^(相变温度 \/ 末项存在上限|相变焓|相变体积|相变边界 dT\/dP) · (\d+)$/);
 if(phase)return `${translateMessage(phase[1])} · ${phase[2]}`;
 const cp=value.match(/^热容系数 · 第 (\d+) 段 · T\^([+\-\d.]+)$/);
 if(cp)return `Heat-capacity coefficient · segment ${cp[1]} · T^${cp[2]}`;
 return translateMessage(value);
}
