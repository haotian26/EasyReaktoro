import {registerMessages,registerMessagePatterns,translateMessage} from './i18n';

// Messages emitted by equilibrium-target validation and the open-system solver.
// Only application prose is localized; IDs, formulae, species and numbers are kept.
export const equilibriumErrorMessages:Record<string,string>={
 '无法确定此点的轮次与位置，不能应用平衡约束；请保留标准反应推进模块或明确传入点坐标':'The round and position of this point could not be determined, so equilibrium targets cannot be applied. Keep the standard reaction process module or pass explicit point coordinates.',
 '平衡约束须为列表':'Equilibrium targets must be a list.',
 '平衡约束格式无效':'The equilibrium target format is invalid.',
 '请选择 pH 或气体逸度约束':'Choose a pH or gas fugacity target.',
 '平衡约束字段不完整或无法识别':'The equilibrium target has incomplete or unrecognized fields.',
 '平衡约束编号须唯一且非空':'Equilibrium target IDs must be nonempty and unique.',
 '平衡约束编号会产生重复结果列，请使用不同编号':'These equilibrium target IDs produce duplicate result columns. Use different IDs.',
 '请填写中性滴定物质的化学式':'Enter the formula of an electrically neutral substance for pH adjustment.',
 '滴定方式请选择只加入或允许加入与移除':'Choose addition only, or allow both addition and removal.',
 '请选择参考气体 species':'Choose a reference gas species.',
 '固定 pH 需要在体系中选择唯一的水相 H⁺ species':'A fixed pH requires exactly one aqueous H⁺ species in the system.',
 'pH 滴定物质须为有明确元素组成的中性化学式；不会自动补入反离子':'The pH adjustment substance must have an electrically neutral formula with a defined elemental composition. Counterions are not added automatically.',
 '同一位置不能同时指定多个 pH 目标，请调整适用范围':'A reaction point cannot have multiple pH targets. Adjust their ranges.',
 '同一位置不能重复约束同一个气体的逸度':'A reaction point cannot specify the same gas fugacity more than once.',
 '这些约束依赖相同或相互重复的交换组成，无法独立调节；请减少约束或改选滴定物质':'These targets depend on identical or linearly dependent exchange compositions and cannot be adjusted independently. Remove a target or choose another pH adjustment substance.',
 '当前所有输入组成都可以与外界交换，缺少封闭组分确定物质总量；请减少外部交换约束或保留不会被交换的物料组成':'All input compositions can exchange with the surroundings, leaving no closed component to determine the total amount. Remove an external-exchange target or retain a component that cannot be exchanged.',
 '外部交换量不是有限数':'The external exchange amount is not finite.',
 '找不到唯一对应的平衡约束，请重新选择参数':'The equilibrium target is missing or duplicated. Choose the parameter again.',
 '气体逸度必须大于零，单位为 bar':'Gas fugacity must be greater than zero, in bar.',
 'constraints 需要列表。':'constraints must be a list.',
 '每点平衡约束记录需要唯一编号。':'Each equilibrium target record at a reaction point needs a unique ID.',
 '平衡约束记录需要类型及交换化学式。':'An equilibrium target record needs its type and exchange formula.',
 '气体逸度须大于零。':'Gas fugacity must be greater than zero.',
};
registerMessages(equilibriumErrorMessages);

function translateSolverAttempts(value:string):string{
 // Semicolons also occur inside individual explanations. Split only at the
 // recognized beginning of a subsequent solve-attempt diagnostic.
 return value.split(/；(?=求解器未收敛|pH 未达到目标：|此 pH 目标需要移除 |无法从当前平衡组成核对 |外部交换量不是有限数|守恒误差 |[^；\r\n]+ 逸度未达到目标 )/).map(translateMessage).join(' ');
}
registerMessagePatterns([
 [/^([-+\d.eE]+ °C \/ [-+\d.eE]+ bar)：([\s\S]+)$/,(conditions,detail)=>`${conditions}: ${translateSolverAttempts(detail)}`],
 [/^第 (\d+) 轮、位置 (\d+) 的 ([^\r\n]+) 目标值须为有限数$/,(round,position,id)=>`Round ${round}, position ${position}: target ${id} must have a finite value.`],
 [/^无法读取滴定物质化学式：([^\r\n]+)$/,formula=>`The pH adjustment formula could not be read: ${formula}`],
 [/^([^\r\n]+) 须为当前数据库中唯一、可计算的中性气体记录$/,species=>`${species} must be a unique, calculable neutral gas record in the current database.`],
 [/^([^\r\n]+) 的交换物质包含当前体系没有的元素，请先补充允许参与平衡的 species$/,id=>`The exchange substance for ${id} contains elements absent from the current system. Add the corresponding equilibrium species first.`],
 [/^([^\r\n]+) 的交换组成无法由所选 species 表示，请补充相应 species$/,id=>`The exchange composition for ${id} cannot be represented by the selected species. Add the corresponding species.`],
 [/^pH 未达到目标：目标 ([-+\d.eE]+)，实际 ([-+\d.eE]+)$/,(target,actual)=>`The pH target was not reached: target ${target}, actual ${actual}.`],
 [/^此 pH 目标需要移除 ([^\r\n]+)；当前仅允许加入，请改变目标或交换方式$/,formula=>`This pH target requires removing ${formula}. Only addition is allowed; change the target or exchange option.`],
 [/^无法从当前平衡组成核对 ([^\r\n]+) 逸度；必要物质可能已耗尽$/,species=>`The fugacity of ${species} could not be verified from the equilibrium composition. A required substance may be depleted.`],
 [/^([^\r\n]+) 逸度未达到目标 ([-+\d.eE]+) bar$/,(species,target)=>`The fugacity of ${species} did not reach the target of ${target} bar.`],
 [/^求解器未收敛；当前仅允许加入 ([^\r\n]+)，请检查目标能否通过该物质达到$/,formulae=>`The equilibrium solver did not converge. Only addition of ${formulae.split('、').join(', ')} is allowed; check whether the target can be reached using this substance.`],
],{priority:true});
