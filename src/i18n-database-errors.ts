import {getLanguage,registerMessages,registerMessagePatterns,translateMessage} from './i18n';
import {translateModelMessage} from './i18n-models';

// Exact messages produced by the database reader and model validator.
// Only display text is translated; interpolated species, paths, and numbers are preserved.
export const databaseErrorMessages:Record<string,string>={
 '电荷必须是有限数值':'Charge must be a finite number.',
 '文件不存在，请重新选择数据库。':'The file does not exist. Choose the database again.',
 '请选择 .rtdb 数据库文件。':'Choose an .rtdb database file.',
 '数据库正在被其他 SQLite 程序使用。请关闭其他程序后重试，或另存为新文件。':'Another SQLite application is using this database. Close that application and retry, or save as a new file.',
 '文件已被其他程序修改或删除。请另存为新文件，避免覆盖外部更改。':'Another application has changed or deleted this file. Save as a new file to preserve the external changes.',
 '此数据库版本暂不支持，请使用兼容版本打开。':'This database version is not supported. Open it with a compatible version of EasyReaktoro.',
 '暂时无法读取数量，请检查文件是否完整或正在被其他程序使用。':'Counts could not be read. Check that the file is complete and is not in use by another application.',
 '数据库的元素组成无法读取。':'The database’s elemental composition could not be read.',
 '目标文件已存在，请选择新文件名。':'The destination file already exists. Choose a new filename.',
 '原生记录名称重复':'Duplicate names in the source records.',
 '原生 YAML 存在缺失、循环或非原生依赖，无法独立重新加载':'The YAML contains missing, circular, or externally defined dependencies and cannot be reloaded independently.',
 '原生记录没有可重新加载的来源数据库或模型参数':'This record has no source database or model parameters that can be reloaded.',
 '草稿物种不能计算或正式导出':'Draft species cannot be used in calculations or final exports.',
 '请选择已打开的系统数据库或个人数据库':'Choose an open system or personal database.',
 '需要可编辑数据库':'An editable database is required.',
 '源文件或选择已经改变，请重新预览':'The source file or selection has changed. Preview it again.',
 '源文件已改变，请重新预览':'The source file has changed. Preview it again.',
 '导出路径及其实际目标必须使用 YAML 扩展名（.yaml 或 .yml），不能覆盖数据库文件。':'The export path and its resolved destination must have a YAML extension (.yaml or .yml). Database files cannot be overwritten.',
 '没有具备完整原生参数及形成反应的记录；可尝试经过真实采样验证的插值导出。':'No records have complete source-model parameters and formation reactions. Try interpolation export, which samples and verifies the model.',
 '温压网格必须为严格递增的正数，不能重复':'Temperature and pressure grids must contain strictly increasing positive values without duplicates.',
 '误差容限必须大于 0 且不超过 1':'The error tolerance must be greater than 0 and no more than 1.',
 '采样总量超过 500,000 点，请缩小网格或数据库':'The sample count exceeds 500,000 points. Reduce the grid or the number of species.',
 '来源库包含多个同名物种，旧记录没有唯一定位信息。请从当前运行时重新创建副本。':'The source database has multiple species with the same name, and this record does not identify one uniquely. Create a new copy from the connected Reaktoro environment.',
 '请先选择元素并填写化学计量数':'Select elements and enter their stoichiometric coefficients first.',
 '元素化学计量数必须大于 0':'Elemental stoichiometric coefficients must be greater than 0.',
 '请先保存或关闭未保存的数据库':'Save or close databases with unsaved changes first.',
 '数据库列表无法读取，请重新打开数据库页面。':'The database list could not be read. Reopen the database page.',
 '草稿不参与计算或正式导出':'Draft species are excluded from calculations and final exports.',
 '元素组成必须包含大于 0 的有限数值':'Elemental composition must contain finite values greater than 0.',
 '相态不适用于该模型':'This phase is not supported by the model.',
 'Akinfiev–Diamond 仅适用于中性水溶物种':'Akinfiev–Diamond applies only to neutral aqueous species.',
 '文件夹包含多个候选数据文件，请直接选择要导入的 YAML；不能自动忽略其他文件。':'The folder contains multiple candidate data files. Choose the YAML file to import explicitly; other files cannot be ignored automatically.',
 '来源数据库的物种参数已改变。请重新创建副本，避免使用与保存记录不一致的数据。':'Species parameters in the source database have changed. Create a new copy to avoid using data that differ from the saved record.',
 '来源数据库的物种顺序已改变，请从当前运行时重新创建副本':'The order of species in the source database has changed. Create a new copy from the connected Reaktoro environment.',
 '来源数据库的物种顺序已改变':'The order of species in the source database has changed.',
 '来源记录的热力学身份和模型不能直接改写；可编辑名称、来源、参考文献、活度参数和备注。自定义模型请新建物种。':'The thermodynamic identity and model of a source record cannot be overwritten directly. You can edit its name, provenance, references, activity parameters, and notes. Create a new species for a custom model.',
 '离子尺寸 aᵢ 必须大于 0 Å':'The ion size aᵢ must be greater than 0 Å.',
 '需要填写形成反应':'A formation reaction is required.',
 '形成反应与引用物种不一致':'The formation reaction does not match the referenced species.',
 '反应系数必须是非零有限数值':'Reaction coefficients must be finite and nonzero.',
 '形成反应包含被排除、缺失或自身引用的物种':'The formation reaction contains excluded or missing species, or refers to itself.',
 '同名物种无法在 Reaktoro YAML 中区分，请先重命名':'Species with identical names cannot be distinguished in Reaktoro YAML. Rename them first.',
 '当前 Python 环境缺少 PyYAML，无法读取原生 YAML 模型；.rtdb 和结构化模型 JSON 仍可使用。':'PyYAML is missing from the selected Python environment, so source YAML models cannot be read. You can still use .rtdb files and structured model JSON.',
 '形成反应的元素或电荷不守恒，请检查已有物种与计量系数':'The formation reaction does not conserve elements or charge. Check the existing species and their stoichiometric coefficients.',
 '缺少原生模型参数':'Source-model parameters are missing.',
 '温度 (K) 和压力 (Pa) 必须是大于 0 的有限数值':'Temperature (K) and pressure (Pa) must be finite values greater than 0.',
 '模型返回非有限数值，请检查参数和有效温压范围':'The model returned a nonfinite value. Check its parameters and valid temperature and pressure range.',
 '至少需要 3 组温度、压力和平衡常数数据':'At least 3 sets of temperature, pressure, and equilibrium constant data are required.',
 '温压点分布不足以拟合 MRB 参数':'The temperature and pressure points do not provide enough variation to fit the MRB parameters.',
 '模型返回非有限数值':'The model returned a nonfinite value.',
 '温压点分布不足以唯一拟合三个 MRB 参数':'The temperature and pressure points do not uniquely determine the three MRB parameters.',
 '未知模型只能保存为 disabled draft':'An unrecognized model can only be saved as an inactive draft.',
 '不支持此转换模型版本':'This converted-model version is not supported.',
 '未识别的转换模型类型':'The converted-model type is not recognized.',
 '分段热容方程数量无效':'The number of piecewise heat-capacity equations is invalid.',
 '必须明确气相或凝聚相体积约定':'Specify the volume convention for the gas or condensed phase.',
 '参考态约定引用了反应中不存在的物种':'The reference-state convention refers to a species that is not in the reaction.',
 '气相热容系数数量无效':'The number of gas heat-capacity coefficients is invalid.',
 '外部参考系数无效':'An external reference coefficient is invalid.',
 '缺少原生参考记录快照':'Reference species data are missing.',
 '缺少参考物种数据':'Reference species data are missing.',
 '原生参考快照与保存的校验值不一致':'The reference species data do not match the saved checksum.',
 '参考物种数据与保存的校验值不一致':'The reference species data do not match the saved checksum.',
 '模型参数必须是结构化对象':'Model parameters must be supplied as a structured object.',
 '相变温度必须为递增的正数':'Phase-transition temperatures must be increasing positive values.',
 '必须明确 AD 参考态偏移，不能猜测或使用其他数据库的常数':'Specify the AD reference-state offsets explicitly; they cannot be inferred or taken from another database.',
 '参考态约定必须来自已支持的版本':'The reference-state convention must use a supported version.',
 '外部参考必须是原生记录快照列表':'External references must be a list of saved source-species records.',
 '水参考约定只能引用中性 H2O':'The water reference convention can only refer to neutral H2O.',
 '外部参考记录或系数无效':'An external reference record or coefficient is invalid.',
 '请先在设置中连接 Reaktoro，再进行计算。':'Connect Reaktoro in Settings before calculating.',
 '计算工具暂时没有响应，请在设置中重新连接 Reaktoro。':'The calculation engine is not responding. Reconnect Reaktoro in Settings.',
 '当前数据库已关闭，请重新打开后继续。':'The current database is closed. Reopen it to continue.',
 '找不到数据库文件，请重新选择文件。':'The database file could not be found. Choose the file again.',
 '无法读取此数据库，请检查文件是否完整，并确认选择的是 .rtdb 文件。':'This database could not be read. Check that the file is complete and has the .rtdb extension.',
 '此数据库版本暂不支持，请使用兼容版本的 EasyReaktoro 打开。':'This database version is not supported. Open it with a compatible version of EasyReaktoro.',
 '该位置已有同名数据库，请使用其他名称。':'A database with this name already exists at that location. Choose another name.',
 '系统数据库只能查看。需要编辑时，请选取物种创建自己的数据库。':'System databases are read-only. To edit data, select species and create your own database.',
 '数据库有未保存的修改，请先保存或放弃修改。':'The database has unsaved changes. Save or discard them first.',
 '操作未完成，请重试。':'The operation did not finish. Try again.',
 '与计算工具的连接已中断，请在设置中重新连接 Reaktoro。':'The connection to the calculation engine was lost. Reconnect Reaktoro in Settings.',
 '设置暂时无法保存，请重启应用后重试。':'Settings could not be saved. Restart the app and try again.',
 '保存位置的剩余空间不足，请清理空间或选择其他位置。':'The destination has insufficient free space. Free up space or choose another location.',
 '没有权限访问所选位置，请选择可以访问的文件夹。':'You do not have permission to access this location. Choose a folder you can access.',
};
registerMessages(databaseErrorMessages);

const databasePatterns:Array<[RegExp,(...captures:string[])=>string]>=[
 [/^(.+) 没有可导出的原生模型参数$/,name=>`${name} has no source-model parameters available for export.`],
 [/^此记录来自 Reaktoro (.+)，当前为 (.+)。请使用原环境，或从当前环境重新创建副本。$/,(source,current)=>`This record comes from Reaktoro ${source}; the connected version is ${current}. Use the original environment or create a new copy from the current one.`],
 [/^以下物种仍使用该物种：([\s\S]+)$/,names=>`This species is still used by: ${names}`],
 [/^物种名称重复：([\s\S]+)$/,name=>`Duplicate species name: ${name}`],
 [/^反应循环：([\s\S]+)$/,chain=>`Formation-reaction cycle: ${chain}`],
 [/^(.+) 必须是正数且下限小于上限$/,key=>`${key} must contain positive values with the minimum below the maximum.`],
 [/^缺少已有物种 ([\s\S]+)$/,name=>`Missing existing species: ${name}`],
 [/^引用的物种 ([\s\S]+) 是草稿$/,name=>`The referenced species ${name} is a draft.`],
 [/^([\s\S]+): (\w+) 未提供或非有限值$/,(name,key)=>`${name}: ${key} is missing or nonfinite.`],
 [/^第 (\d+) 行数据无效$/,row=>`Invalid data in row ${row}.`],
 [/^第 (\d+) 行必须包含有效的 T、P 和数值$/,row=>`Row ${row} must contain valid T, P, and observed values.`],
 [/^缺少参数 (.+)$/,parameter=>`Missing parameter: ${translateModelMessage(parameter)}`],
 [/^参数 (.+) 必须是数值$/,parameter=>`Parameter ${translateModelMessage(parameter)} must be a number.`],
 [/^(.+) 必须包含至少 (\d+) 个有限系数$/,(key,count)=>`${key} must contain at least ${count} finite coefficients.`],
 [/^(.+) 必须是有限数值$/,key=>`${key} must be a finite number.`],
];
registerMessagePatterns(databasePatterns);

/** Translate combined validator diagnostics without changing names or unknown details. */
export function translateDatabaseMessage(value:string,code?:string):string{
 if(getLanguage()!=='en')return translateMessage(value);
 if(code==='IMPORT_BLOCKED'||code==='COMPOSE_BLOCKED'){
  try{
   const parsed=JSON.parse(value);
   const issueText=(issue:any):string=>{
    if(typeof issue==='string')return translateDatabaseMessage(issue);
    if(Array.isArray(issue)&&issue.every(x=>typeof x==='string'))return `Formation-reaction cycle: ${issue.join(' → ')}`;
    if(issue&&typeof issue==='object'){
     if(typeof issue.message==='string'){
      const message=translateDatabaseMessage(issue.message),name=typeof issue.species==='string'?issue.species:'';
      return name&&!message.startsWith(name+':')&&!message.startsWith(name+'：')?`${name}: ${message}`:message;
     }
     const dependency=typeof issue.dependency==='string'?issue.dependency:typeof issue.species==='string'?issue.species:'';
     if(dependency&&(issue.code==='MISSING_DEPENDENCY'||issue.code==='AMBIGUOUS_DEPENDENCY')){
      const heading=issue.code==='AMBIGUOUS_DEPENDENCY'?`Ambiguous source for species: ${dependency}`:`Missing required species: ${dependency}`;
      const chain=Array.isArray(issue.chain)&&issue.chain.every((x:unknown)=>typeof x==='string')?` · ${issue.chain.join(' → ')}`:'';
      const candidates=issue.candidates?` · Candidate sources: ${typeof issue.candidates==='string'?issue.candidates:JSON.stringify(issue.candidates)}`:'';
      return heading+chain+candidates;
     }
    }
    return JSON.stringify(issue);
   };
   if(Array.isArray(parsed)&&parsed.length)return parsed.map(issueText).join('\n');
   if(parsed&&Array.isArray(parsed.missing)&&Array.isArray(parsed.cycles)){
    const issues=[...parsed.missing,...parsed.cycles];if(issues.length)return issues.map(issueText).join('\n');
   }
  }catch{/* Unknown or incomplete diagnostics remain visible verbatim. */}
 }
 const direct=translateMessage(value);if(direct!==value)return direct;
 if(value.includes('; '))return value.split('; ').map(part=>translateDatabaseMessage(part)).join('; ');
 // validate() prefixes a known diagnostic with the untouched species name and a full-width colon.
 for(let index=value.lastIndexOf('：');index>=0;index=value.lastIndexOf('：',index-1)){
  const suffix=value.slice(index+1),translated=translateMessage(suffix);
  if(translated!==suffix)return value.slice(0,index)+': '+translated;
  if(index===0)break;
 }
 return value;
}
