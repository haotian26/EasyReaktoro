// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {DatabaseSwitcher} from './DatabaseSwitcher';
const invoke=vi.hoisted(()=>vi.fn(async()=>({items:[{path:'/rocks.rtdb',status:'ready',species_count:1820,element_count:44}]})));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
afterEach(cleanup);
it('searches both database libraries and passes an explicit source to the simulation',async()=>{
 const choose=vi.fn(),combine=vi.fn();render(<DatabaseSwitcher name="Current" current={{kind:'rtdb',path:'/a.rtdb',name:'A'}} dirty={false} disabled={false} catalog={[{id:'b',group:'SUPCRT',embedded_name:'supcrtbl',species_count:1108,element_count:83}]} recents={[{name:'A',path:'/a.rtdb'},{name:'My rocks',path:'/rocks.rtdb'}]} onChoose={choose} onCombine={combine} onFile={()=>{}} onInspect={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'切换模拟数据库'}));fireEvent.change(screen.getByLabelText('搜索可切换数据库'),{target:{value:'rocks'}});expect(screen.queryByRole('button',{name:/supcrtbl/})).toBeNull();await screen.findByText('1,820 species · 44 元素');fireEvent.click(screen.getByRole('button',{name:/^My rocks/}));expect(choose).toHaveBeenCalledWith({kind:'rtdb',path:'/rocks.rtdb',name:'My rocks'});
 fireEvent.click(screen.getByRole('button',{name:'切换模拟数据库'}));fireEvent.click(screen.getByRole('button',{name:'跨库选择 species，创建组合数据库…'}));expect(combine).toHaveBeenCalledOnce();
});
