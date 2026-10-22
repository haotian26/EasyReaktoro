// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EnvironmentHelp, REAKTORO_INSTALLATION_URL} from './EnvironmentHelp';
import {setLanguage} from './i18n';
const mocks = vi.hoisted(() => ({invoke: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({invoke: mocks.invoke}));
beforeEach(() => {vi.clearAllMocks(); setLanguage('zh-CN'); mocks.invoke.mockResolvedValue({success:true});});
afterEach(() => {cleanup(); setLanguage('zh-CN');});
const ready = {available:true,status:'ready' as const,version:'2.13.0',python:'/working/bin/python'};
const absent = {available:false,status:'error' as const,diagnostic:'No usable external Python was found'};
const actions = () => ({onDiscover:vi.fn(),onChoose:vi.fn(),onChooseFolder:vi.fn(),onCandidate:vi.fn()});

it('does not claim that Reaktoro is uninstalled after a failed search; provides both next steps', () => {
  render(<EnvironmentHelp runtime={absent} candidates={[]} discovering={false} {...actions()}/>);
  expect(screen.getByRole('heading', {name:'尚未找到可用的 Reaktoro 环境'})).toBeTruthy();
  expect(screen.getByRole('heading', {name:'尚未安装 Reaktoro'})).toBeTruthy();
  expect(screen.getByRole('heading', {name:'已经安装，但没有连上'})).toBeTruthy();
  expect(screen.queryByText('这个 Python 中没有安装 Reaktoro')).toBeNull();
  const detail=screen.getByText('查看检测详情').closest('details')!;
  expect(detail.open).toBe(false);
  expect(detail.querySelector('pre')?.textContent).toBe(absent.diagnostic);
  expect(screen.getByText('安装与连接说明').closest('details')?.open).toBe(true);
});
it('keeps detection, environment folder and Python executable as distinct operations', () => {
  const callbacks=actions(); render(<EnvironmentHelp runtime={absent} candidates={[]} discovering={false} {...callbacks}/>);
  fireEvent.click(screen.getByRole('button',{name:'重新检测'}));
  fireEvent.click(screen.getByRole('button',{name:'选择环境文件夹'}));
  fireEvent.click(screen.getByRole('button',{name:'选择 Python'}));
  expect(callbacks.onDiscover).toHaveBeenCalledOnce();expect(callbacks.onChooseFolder).toHaveBeenCalledOnce();expect(callbacks.onChoose).toHaveBeenCalledOnce();
});
it('opens official installation guidance through the native browser command',async () => {
  render(<EnvironmentHelp runtime={absent} candidates={[]} discovering={false} {...actions()}/>);
  const link=screen.getByRole('link',{name:'打开官方安装说明'});
  expect(link.getAttribute('href')).toBe(REAKTORO_INSTALLATION_URL);
  fireEvent.click(link);await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('open_reference',{url:REAKTORO_INSTALLATION_URL}));
});
it('offers the exact URL when the system browser cannot be opened',async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('open failed'));
  render(<EnvironmentHelp runtime={absent} candidates={[]} discovering={false} {...actions()}/>);
  fireEvent.click(screen.getByRole('link',{name:'打开官方安装说明'}));
  expect((await screen.findByRole('alert')).textContent).toContain(REAKTORO_INSTALLATION_URL);
});
it('distinguishes a missing module in the selected Python from a generic connection failure', () => {
  render(<EnvironmentHelp runtime={ready} connectionError={{python:'/other/bin/python',diagnostic:"ModuleNotFoundError: No module named 'reaktoro'"}} candidates={[]} discovering={false} {...actions()}/>);
  expect(screen.getByText('这个 Python 中没有安装 Reaktoro')).toBeTruthy();
  expect(screen.getByText(/当前连接和已打开的数据库保持不变/)).toBeTruthy();
  expect(screen.getByRole('heading',{name:'Reaktoro 2.13.0'})).toBeTruthy();
  const detail=screen.getByText('查看连接详情').closest('details')!;
  expect(detail.open).toBe(false);expect(detail.textContent).toContain('/other/bin/python');
});
it('keeps low-level errors inside details and does not label a broken library as an absent package', () => {
  render(<EnvironmentHelp runtime={absent} connectionError={{python:'/installed/bin/python',diagnostic:'Library not loaded: libSomething.dylib'}} candidates={[]} discovering={false} {...actions()}/>);
  expect(screen.getByText('这个环境暂时无法连接')).toBeTruthy();
  expect(screen.queryByText('这个 Python 中没有安装 Reaktoro')).toBeNull();
  expect(screen.getByText('Library not loaded: libSomething.dylib').closest('details')).toBeTruthy();
});
it('switches help language without losing connection identity or pending errors', () => {
  render(<EnvironmentHelp runtime={ready} connectionError={{python:'/other/bin/python',diagnostic:'load failed'}} candidates={[]} discovering={false} {...actions()}/>);
  act(()=>setLanguage('en'));
  expect(screen.getByRole('heading',{name:'Reaktoro 2.13.0'})).toBeTruthy();
  expect(screen.getByText('This environment could not be connected')).toBeTruthy();
  expect(screen.getByText('/working/bin/python')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Open official installation instructions'})).toBeTruthy();
});
it('disables concurrent connection operations while detecting', () => {
  const callbacks=actions();render(<EnvironmentHelp runtime={{...absent,status:'probing'}} candidates={[ready]} discovering={true} {...callbacks}/>);
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'选择 Python'}));expect(callbacks.onChoose).not.toHaveBeenCalled();
});

it.each(["No module named 'reaktoro._core'", "No module named 'reaktoro_helper'"])('does not misclassify a missing submodule or different package as an uninstalled Reaktoro: %s',diagnostic=>{
 render(<EnvironmentHelp runtime={absent} connectionError={{python:'/installed/bin/python',diagnostic}} candidates={[]} discovering={false} {...actions()}/>);expect(screen.getByText('这个环境暂时无法连接')).toBeTruthy();expect(screen.queryByText('这个 Python 中没有安装 Reaktoro')).toBeNull();
});
