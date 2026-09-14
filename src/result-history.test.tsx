// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ResultHistory} from './ResultHistory';
import {loadResultHistory,useResultHistory} from './result-history';
import {mockHistory,resultHistoryEntries} from './test-history';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
beforeEach(()=>{const values=new Map<string,string>();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),clear:()=>values.clear()}});resultHistoryEntries.clear();localStorage.clear();mocks.invoke.mockReset();mocks.invoke.mockImplementation((_command,{payload})=>Promise.resolve(mockHistory(payload)));});
afterEach(cleanup);
const job:any={job_id:'case',output_path:'/saved/实验一',name:'实验一',status:'running',completed:1,total:12,source:{name:'My database'}};
it('migrates every legacy location once and keeps the old list when durable saving fails',async()=>{
 const entries=Array.from({length:15},(_,i)=>({path:`/saved/${i}`,name:`实验 ${i}`}));localStorage.setItem('easyreaktoro.simulation.runs',JSON.stringify(entries));
 mocks.invoke.mockRejectedValueOnce('disk unavailable');await expect(loadResultHistory()).rejects.toBe('disk unavailable');
 expect(JSON.parse(localStorage.getItem('easyreaktoro.simulation.runs')!)).toHaveLength(15);
 expect(await loadResultHistory()).toHaveLength(15);expect(localStorage.getItem('easyreaktoro.simulation.runs')).toBeNull();
 await loadResultHistory();expect(mocks.invoke.mock.calls.at(-1)![1].payload.action).toBe('results_list');
});
it('preserves opened time during progress and never resurrects a forgotten running result',async()=>{
 const hook=renderHook(({current})=>useResultHistory(current),{initialProps:{current:null as any}});
 await waitFor(()=>expect(hook.result.current.loading).toBe(false));
 await act(()=>hook.result.current.remember(job));const opened=hook.result.current.entries[0].opened_at;
 hook.rerender({current:{...job,completed:4}});await waitFor(()=>expect(hook.result.current.entries[0].completed).toBe(4));
 expect(hook.result.current.entries[0].opened_at).toBe(opened);
 await act(()=>hook.result.current.forget(job.output_path));hook.rerender({current:{...job,status:'completed',completed:12}});
 await waitFor(()=>expect(mocks.invoke.mock.calls.at(-1)![1].payload.entry?.status).toBe('completed'));
 expect(hook.result.current.entries).toHaveLength(0);expect(resultHistoryEntries.size).toBe(0);
 await act(()=>hook.result.current.rememberWorkspace('/saved/对比.html','pH 对比'));
 expect(hook.result.current.entries[0]).toMatchObject({kind:'workspace',path:'/saved/对比.html',name:'pH 对比'});
 hook.unmount();const reopened=renderHook(()=>useResultHistory(null));await waitFor(()=>expect(reopened.result.current.entries).toHaveLength(1));
 expect(reopened.result.current.entries[0].kind).toBe('workspace');
});
it('searches full paths, distinguishes result types, and only removes the selected metadata',async()=>{
 const onOpen=vi.fn(),onForget=vi.fn().mockResolvedValue(true),onClose=vi.fn();
 render(<ResultHistory entries={[{kind:'run',path:'/saved/a/同名',name:'同名',opened_at:'2026-09-08T00:00:00Z',status:'completed',completed:12,total:12},{kind:'workspace',path:'/saved/b/同名.html',name:'同名',opened_at:'2026-09-08T01:00:00Z'}]} loading={false} error="" busy={false} running={false} onClose={onClose} onOpen={onOpen} onForget={onForget}/>);
 expect(screen.getByText('计算结果')).toBeTruthy();expect(screen.getByText('图表工作区')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('搜索结果历史'),{target:{value:'/saved/b'}});expect(screen.queryByText('计算结果')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'打开结果'}));expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({path:'/saved/b/同名.html',kind:'workspace'}));
 fireEvent.click(screen.getByRole('button',{name:'移除记录'}));await waitFor(()=>expect(onForget).toHaveBeenCalledWith('/saved/b/同名.html'));
 expect(mocks.invoke).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('搜索结果历史'),{target:{value:'unmatched'}});expect(screen.getByText('没有匹配的结果。')).toBeTruthy();
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(onClose).toHaveBeenCalled();
});

it('keeps a failed history write visible when the next progress update succeeds without adding the missing record',async()=>{
 const hook=renderHook(({current})=>useResultHistory(current),{initialProps:{current:null as any}});await waitFor(()=>expect(hook.result.current.loading).toBe(false));
 mocks.invoke.mockImplementation((_command,{payload})=>payload.action==='results_remember'?Promise.reject('disk unavailable'):Promise.resolve(mockHistory(payload)));
 await act(async()=>{const pending=hook.result.current.remember(job);hook.rerender({current:job});await pending;});
 await waitFor(()=>expect(mocks.invoke.mock.calls.at(-1)![1].payload.action).toBe('results_update'));
 expect(hook.result.current.error).toContain('disk unavailable');expect(hook.result.current.entries).toHaveLength(0);
 mocks.invoke.mockImplementation((_command,{payload})=>Promise.resolve(mockHistory(payload)));await act(()=>hook.result.current.remember(job));
 expect(hook.result.current.error).toBe('');expect(hook.result.current.entries).toHaveLength(1);
});

it('keeps keyboard focus inside the history after the focused entry is removed',async()=>{
 const onForget=vi.fn().mockResolvedValue(true);
 const props={loading:false,error:'',busy:false,running:false,onClose:vi.fn(),onOpen:vi.fn(),onForget};
 const view=render(<ResultHistory {...props} entries={[{kind:'workspace',path:'/saved/chart.html',name:'图表',opened_at:'2026-09-08T00:00:00Z'}]}/>);
 const remove=screen.getByRole('button',{name:'移除记录'});remove.focus();fireEvent.click(remove);
 await waitFor(()=>expect(onForget).toHaveBeenCalledWith('/saved/chart.html'));
 view.rerender(<ResultHistory {...props} entries={[]}/>);
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'关闭结果历史'}));
 fireEvent.keyDown(document.activeElement!,{key:'Tab',shiftKey:true});
 expect(document.activeElement).toBe(screen.getByLabelText('搜索结果历史'));
});

it('places history outside clipped workspace ancestors and restores its opener on close',()=>{
 const host=document.createElement('div');host.style.overflow='hidden';host.style.transform='translateZ(0)';document.body.append(host);
 const opener=document.createElement('button');opener.textContent='Open history';host.append(opener);opener.focus();const mount=document.createElement('div');host.append(mount);
 const view=render(<ResultHistory entries={[]} loading={false} error="" busy={false} running={false} onClose={vi.fn()} onOpen={vi.fn()} onForget={vi.fn()}/>,{container:mount});
 const panel=screen.getByRole('dialog',{name:'结果历史'});
 expect(host.contains(panel)).toBe(false);expect(panel.closest('.simulation-page')?.parentElement).toBe(document.body);
 expect(document.activeElement).toBe(screen.getByRole('button',{name:'关闭结果历史'}));
 // Replace the clipped render container, but retain a connected caller to restore.
 document.body.append(opener);view.unmount();expect(document.activeElement).toBe(opener);
 host.remove();opener.remove();
});
