// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DatabaseVersions} from './DatabaseVersions';
import {setLanguage} from './i18n';
const {invoke,save}=vi.hoisted(()=>({invoke:vi.fn(),save:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({save}));
const entry={id:'abc',name:'Water chemistry',saved_at:'2026-09-28T10:30:00Z',database_modified_at:'2026-09-27T10:30:00Z',species_count:1,element_count:2,bytes:65536,path:'/tmp/versions/abc.rtdb'};
const listing={entries:[entry],unavailable:0,settings:{enabled:true,keep:10},directory:'/tmp/versions'};
const preview={entry,current_available:true,changes:{added:['Calcite'],removed:[],changed:[{name:'Water',previous_name:'Water',fields:['references']}]},records:[{name:'Water',formula:'H2O',state:'Aqueous'}],metadata_changed:{}};
beforeEach(()=>{setLanguage('zh-CN');invoke.mockReset();save.mockReset();invoke.mockImplementation(async(_command,args)=>args.payload.action==='preview'?preview:listing);});
afterEach(cleanup);
it('shows readable history and saved-only comparison without changing the database',async()=>{
 render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={()=>{}}/>);
 await screen.findByText('Water chemistry');
 fireEvent.click(screen.getByRole('button',{name:/Water chemistry/}));
 await screen.findByText('版本内容');
 expect(screen.getByText('Calcite')).toBeTruthy();expect(screen.getByText('参考文献')).toBeTruthy();
 expect(screen.getByText('以下为这个历史版本保存之后发生的变化，不包含当前未保存的编辑。')).toBeTruthy();
 expect(invoke.mock.calls.map(call=>call[1].payload.action)).toEqual(['list','preview']);
});
it('restores to a chosen new path and offers opening that copy',async()=>{
 const restored=vi.fn();save.mockResolvedValue('/tmp/recovered.rtdb');invoke.mockImplementation(async(_command,args)=>args.payload.action==='preview'?preview:args.payload.action==='restore'?{path:'/tmp/recovered.rtdb'}:listing);
 render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={()=>{}} onRestored={restored}/>);
 fireEvent.click(await screen.findByRole('button',{name:/Water chemistry/}));fireEvent.click(await screen.findByRole('button',{name:'恢复为副本…'}));
 fireEvent.click(await screen.findByRole('button',{name:'打开副本'}));
 expect(restored).toHaveBeenCalledWith('/tmp/recovered.rtdb');expect(invoke).toHaveBeenCalledWith('rtdb_versions',{handleId:'db',payload:{action:'restore',version_id:'abc',path:'/tmp/recovered.rtdb'}});
});
it('requires visible confirmation before removing only the selected saved version',async()=>{
 render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={()=>{}}/>);
 fireEvent.click(await screen.findByRole('button',{name:/Water chemistry/}));fireEvent.click(await screen.findByRole('button',{name:'删除此版本…'}));
 expect(invoke.mock.calls.some(call=>call[1].payload.action==='delete')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(screen.queryByRole('button',{name:'永久删除'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'删除此版本…'}));fireEvent.click(screen.getByRole('button',{name:'永久删除'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('rtdb_versions',{handleId:'db',payload:{action:'delete',version_id:'abc'}}));
});
it('keeps history settings explicit, global, validated and cancellable',async()=>{
 const close=vi.fn();render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={close}/>);
 await screen.findByText('Water chemistry');
 expect(screen.getByText(/适用于所有个人数据库/)).toBeTruthy();
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'保存设置'}));
 expect(screen.getByRole('alert').textContent).toContain('1 至 100');expect(invoke.mock.calls.some(call=>call[1].payload.action==='settings')).toBe(false);
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(close).toHaveBeenCalledOnce();
});
it('uses application language for the whole history panel',async()=>{
 setLanguage('en');render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={()=>{}}/>);
 expect(screen.getByRole('dialog',{name:'Database version history'})).toBeTruthy();
 await screen.findByText('Water chemistry');expect(screen.getByText(/Applies to all personal databases/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/Water chemistry/}));expect(await screen.findByRole('button',{name:'Restore a copy…'})).toBeTruthy();
});
it('ignores late preview responses after selecting another version',async()=>{
 let resolveFirst:(value:unknown)=>void=()=>{};const second={...entry,id:'def',name:'Second version'};
 invoke.mockImplementation(async(_command,args)=>args.payload.action==='list'?{...listing,entries:[entry,second]}:args.payload.version_id==='abc'?new Promise(resolve=>{resolveFirst=resolve;}):{...preview,entry:second,records:[{name:'Second',formula:'NaCl',state:'Aqueous'}]});
 render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={()=>{}}/>);
 fireEvent.click(await screen.findByRole('button',{name:/Water chemistry/}));fireEvent.click(screen.getByRole('button',{name:/Second version/}));await screen.findByText('Second');
 resolveFirst(preview);await waitFor(()=>expect(screen.queryByText('H2O')).toBeNull());
});

it('switches existing validation and saved notices with the app language without discarding edits',async()=>{
 invoke.mockImplementation(async(_command,args)=>args.payload.action==='settings'?{settings:args.payload.settings}:listing);render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={()=>{}}/>);await screen.findByText('Water chemistry');
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'保存设置'}));expect(screen.getByRole('alert').textContent).toContain('1 至 100');
 act(()=>setLanguage('en'));expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 1 to 100.');expect(screen.getByRole('spinbutton')).toHaveProperty('value','0');
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'5'}});fireEvent.click(screen.getByRole('button',{name:'Save preferences'}));await screen.findByText('Version history preferences saved.');
 act(()=>setLanguage('zh-CN'));expect(screen.getByRole('status').textContent).toBe('历史版本设置已保存。');expect(screen.getByRole('spinbutton')).toHaveProperty('value','5');
});
it('retains the original backend error so it can be shown in either language',async()=>{
 invoke.mockRejectedValue({error:{code:'RTDB_VERSION',diagnostic:'该历史版本不存在，请刷新列表。'}});render(<DatabaseVersions handleId="db" databaseName="Chemistry" onClose={()=>{}}/>);await screen.findByText('该历史版本不存在，请刷新列表。');
 act(()=>setLanguage('en'));expect(screen.getByRole('alert').textContent).toBe('This version is no longer available. Refresh the list.');act(()=>setLanguage('zh-CN'));expect(screen.getByRole('alert').textContent).toBe('该历史版本不存在，请刷新列表。');
});
