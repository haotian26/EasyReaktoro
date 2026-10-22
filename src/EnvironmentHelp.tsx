import {Check, ChevronRight, ExternalLink, FolderOpen, MonitorCog, RefreshCw} from 'lucide-react';
import {ReferenceLink} from './ActivityReferences';
import {t, useLanguage} from './i18n';
import './environment-help.css';

export const REAKTORO_INSTALLATION_URL = 'https://reaktoro.org/installation/index.html';
export type RuntimeConnectionError = {diagnostic: string; python?: string};
type Environment = {
  available: boolean;
  status: 'unconfigured' | 'probing' | 'ready' | 'error';
  version?: string;
  python?: string;
  environment_root?: string;
  diagnostic?: string;
};
type Props = {
  runtime: Environment;
  candidates: (Environment & {python: string})[];
  connectionError?: RuntimeConnectionError | null;
  discovering: boolean;
  onDiscover: () => void;
  onChoose: () => void;
  onChooseFolder: () => void;
  onCandidate: (python: string) => void;
  onDiagnose?: () => void;
};

function ConnectionIssue({issue, connected}: {issue: RuntimeConnectionError; connected: boolean}) {
  const missingPackage = /No module named (?:[']reaktoro[']|"reaktoro"|reaktoro(?=[\s:;)]|$))/i.test(issue.diagnostic);
  return <div className="environment-issue" role="status">
    <strong>{missingPackage
      ? t('这个 Python 中没有安装 Reaktoro', 'Reaktoro is not installed in this Python environment')
      : t('这个环境暂时无法连接', 'This environment could not be connected')}</strong>
    <p>{missingPackage
      ? t('请选择已安装 Reaktoro 的环境，或按官方说明在所选环境中安装后重试。', 'Choose an environment that already contains Reaktoro, or install it in this environment using the official instructions and try again.')
      : t('请确认所选 Python 属于 Reaktoro 的安装环境。下面可以重新检测或选择其他环境。', 'Check that the selected Python belongs to your Reaktoro environment. You can detect environments again or choose another one below.')}
      {connected && <> {t('当前连接和已打开的数据库保持不变。', 'Your current connection and open database are unchanged.')}</>}
    </p>
    <details><summary>{t('查看连接详情', 'Connection details')}</summary>
      {issue.python && <p className="environment-path">{issue.python}</p>}
      <pre>{issue.diagnostic}</pre>
    </details>
  </div>;
}

/** Shared onboarding and settings use the same connection actions and never infer
 * an uninstalled package merely from a failed search. */
export function EnvironmentHelp({runtime, candidates, connectionError, discovering, onDiscover, onChoose, onChooseFolder, onCandidate, onDiagnose}: Props) {
  useLanguage();
  const probing = runtime.status === 'probing' || discovering;
  const issue = connectionError || (!runtime.available && runtime.diagnostic && runtime.python
    ? {diagnostic: runtime.diagnostic, python: runtime.python} : null);
  return <section className="environment-help" aria-label={t('连接 Reaktoro', 'Connect Reaktoro')}>
    <div className="environment-heading">
      <MonitorCog size={23} aria-hidden="true"/>
      <div>
        <span className={`status-chip ${runtime.available ? 'ready' : runtime.status}`}>{runtime.available ? t('已连接', 'Connected') : t('未连接', 'Not connected')}</span>
        <h3>{runtime.available ? `Reaktoro ${runtime.version || ''}` : probing
          ? t('正在查找 Reaktoro 环境…', 'Looking for a Reaktoro environment…')
          : t('尚未找到可用的 Reaktoro 环境', 'No usable Reaktoro environment found yet')}</h3>
        {runtime.available ? <p className="environment-path">{runtime.python}</p>
          : <p>{probing ? t('正在检查常见安装位置。', 'Checking common installation locations.')
            : t('已经安装？选择现有环境即可连接；尚未安装？请先按官方说明安装。', 'Already installed? Select your existing environment. Otherwise, follow the official installation instructions first.')}</p>}
      </div>
    </div>
    {issue && <ConnectionIssue issue={issue} connected={runtime.available}/>}
    {!issue && !runtime.available && runtime.diagnostic && !probing && <details className="environment-diagnostic"><summary>{t('查看检测详情', 'Detection details')}</summary><pre>{runtime.diagnostic}</pre></details>}
    <div className="environment-actions">
      <button className={runtime.available ? 'secondary' : 'primary'} disabled={probing} onClick={onDiscover}><RefreshCw size={16}/>{probing ? t('正在检查…', 'Checking…') : runtime.available || onDiagnose ? t('检查并重新连接', 'Check and reconnect') : t('重新检测', 'Detect again')}</button>
      <button className="secondary" disabled={probing} onClick={onChooseFolder}><FolderOpen size={16}/>{t('选择环境文件夹', 'Choose environment folder')}</button>
      <button className="secondary" disabled={probing} onClick={onChoose}>{t('选择 Python', 'Choose Python')}</button>
      {onDiagnose && runtime.available && <button className="text-button" disabled={probing} onClick={onDiagnose}>{t('检查连接', 'Check connection')}</button>}
    </div>
    {runtime.available && <p className="environment-caption">{t('检查正常连接不会关闭当前数据库。切换到其他环境后，需要重新打开数据库。', 'Checking a working connection keeps your current database open. Switching to another environment requires reopening it.')}</p>}
    {candidates.length > 0 && <div className="candidate-list environment-candidates" aria-label={t('找到的 Reaktoro 环境', 'Detected Reaktoro environments')}>
      {candidates.map(candidate => <button key={candidate.python} disabled={probing} className={runtime.available && runtime.python === candidate.python ? 'selected' : ''} onClick={() => onCandidate(candidate.python)}>
        <span><strong>Reaktoro {candidate.version}</strong><small>{candidate.environment_root || candidate.python}</small></span>
        {runtime.available && runtime.python === candidate.python ? <Check aria-label={t('当前环境', 'Current environment')}/> : <ChevronRight aria-hidden="true"/>}
      </button>)}
    </div>}
    <details className="environment-guide" key={runtime.available ? 'connected' : 'disconnected'} open={runtime.available ? undefined : true}>
      <summary>{t('安装与连接说明', 'Installation and connection help')}</summary>
      <div className="environment-guide-grid">
        <article><h4>{t('尚未安装 Reaktoro', 'New to Reaktoro')}</h4>
          <p>{t('Reaktoro 需要单独安装，EasyReaktoro 不会替你安装或修改 Python 环境。安装完成后，回到这里点击“重新检测”。', 'Install Reaktoro separately. EasyReaktoro does not install or modify your Python environment. After installation, return here and detect environments again.')}</p>
          <ReferenceLink url={REAKTORO_INSTALLATION_URL}>{t('打开官方安装说明', 'Open official installation instructions')}<ExternalLink size={13} aria-hidden="true"/></ReferenceLink>
        </article>
        <article><h4>{t('已经安装，但没有连上', 'Already installed, but not connected')}</h4>
          <p>{t('选择安装了 Reaktoro 的 Conda 环境文件夹，或其中的 Python 程序。在 macOS 中，通常是该环境的 bin/python；仅安装 Conda 本身还不够。', 'Choose the Conda environment containing Reaktoro, or its Python executable. On macOS this is usually bin/python inside that environment; installing Conda alone is not enough.')}</p>
        </article>
      </div>
    </details>
  </section>;
}
