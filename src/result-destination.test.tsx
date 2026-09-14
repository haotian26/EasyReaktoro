// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {ResultDestinationDialog} from './ResultDestinationDialog';
afterEach(cleanup);
const destination={path:'/runs/experiment',name:'experiment',exists:true,can_overwrite:true,overwrite_token:'token',suggested_name:'experiment 2'};
it('offers explicit overwrite or a separately editable result name',()=>{const choose=vi.fn();render(<ResultDestinationDialog destination={destination} onChoice={choose}/>);fireEvent.click(screen.getByRole('button',{name:'另存为…'}));fireEvent.change(screen.getByLabelText('新的结果名称'),{target:{value:'experiment different'}});fireEvent.click(screen.getByRole('button',{name:'使用新名称'}));expect(choose).toHaveBeenCalledWith({kind:'save_as',name:'experiment different'});});
it('cannot overwrite an unrelated file and Escape cancels without a choice',()=>{const choose=vi.fn();render(<ResultDestinationDialog destination={{...destination,can_overwrite:false}} onChoice={choose}/>);expect((screen.getByRole('button',{name:'覆盖结果'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.keyDown(screen.getByRole('alertdialog'),{key:'Escape'});expect(choose).toHaveBeenCalledWith({kind:'cancel'});});
