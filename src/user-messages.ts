import './i18n-equilibrium-errors';
import './i18n-simulation-legacy';
import './i18n-simulation-errors';
import './i18n-code-errors';
import {t} from './i18n';
import {translateDatabaseMessage} from './i18n-database-errors';
/** User explanations for connection/file failures; scientific details stay visible. */
const explanations:Record<string,string>={
  RUNTIME_UNAVAILABLE:'请先在设置中连接 Reaktoro，再进行计算。',
  BRIDGE_UNRESPONSIVE:'计算工具暂时没有响应，请在设置中重新连接 Reaktoro。',
  HANDLE_NOT_FOUND:'当前数据库已关闭，请重新打开后继续。',
  RTDB_NOT_FOUND:'找不到数据库文件，请重新选择文件。',
  RTDB_INVALID:'无法读取此数据库，请检查文件是否完整，并确认选择的是 .rtdb 文件。',
  RTDB_SCHEMA_UNSUPPORTED:'此数据库版本暂不支持，请使用兼容版本的 EasyReaktoro 打开。',
  RTDB_EXTENSION:'请选择 .rtdb 数据库文件。',
  RTDB_ALREADY_EXISTS:'该位置已有同名数据库，请使用其他名称。',
  DATABASE_READ_ONLY:'系统数据库只能查看。需要编辑时，请选取物种创建自己的数据库。',
  DIRTY_DATABASE:'数据库有未保存的修改，请先保存或放弃修改。',
};
export function userMessage(error:unknown):string{
  let value:any=error instanceof Error?error.message:error;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{}}
  if(value && typeof value==='object' && value.error)value=value.error;
  const code=typeof value?.code==='string'?value.code:'';
  if(explanations[code])return translateDatabaseMessage(explanations[code]);
  let message=typeof value==='string'?value:String(value?.diagnostic || value?.message || '操作未完成，请重试。');
  if(/bridge (?:spawn|stdin|stdout|lock|unavailable)|invalid bridge response|python lock poisoned/i.test(message))return translateDatabaseMessage('与计算工具的连接已中断，请在设置中重新连接 Reaktoro。');
  if(/settings lock poisoned/i.test(message))return translateDatabaseMessage('设置暂时无法保存，请重启应用后重试。');
  if(/no space left on device|disk full/i.test(message))return translateDatabaseMessage('保存位置的剩余空间不足，请清理空间或选择其他位置。');
  if(/permission denied|operation not permitted/i.test(message))return translateDatabaseMessage('没有权限访问所选位置，请选择可以访问的文件夹。');
  if(code==='SIMULATION_CODE'){
    try{const issues=JSON.parse(message);if(Array.isArray(issues))return issues.map(x=>t('第 '+(x.line || 1)+' 行：','Line '+(x.line || 1)+': ')+translateDatabaseMessage(x.message || t('请检查代码','Check the code'))).join('\n');}catch{}
  }
  const translated=translateDatabaseMessage(message,code);
  if(translated!==message)return translated;
  return translateDatabaseMessage(message.replace(/Reaktoro 运行时/g,'Reaktoro').replace(/运行时物种数据已改变/g,'所连接的 Reaktoro 中，该物种的数据已改变').replace(/原生参考记录快照|原生参考快照/g,'参考物种数据'));
}
