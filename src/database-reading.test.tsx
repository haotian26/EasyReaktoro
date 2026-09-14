// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DEFAULT_TRIAL_TP,TrialConditions,changeTrialUnit,readTrialTP,readingNumber,ReadableNumber} from './database-reading';
afterEach(cleanup);
it('keeps exact physical quantities through repeated unit changes and formatted display values',()=>{
 let tp={...DEFAULT_TRIAL_TP,temperature:'25.123456789012345',pressure:'1.23456789012345'};const expected=readTrialTP(tp);
 for(let i=0;i<20;i++){tp=changeTrialUnit(tp,'temperature','K');tp=changeTrialUnit(tp,'pressure','MPa');tp=changeTrialUnit(tp,'temperature','°C');tp=changeTrialUnit(tp,'pressure','Pa');tp=changeTrialUnit(tp,'pressure','bar');}
 expect(readTrialTP(tp)).toEqual(expected);
});
it('does not resurrect a cached physical value after the visible input has been cleared',()=>{
 const value=changeTrialUnit(DEFAULT_TRIAL_TP,'temperature','K'),change=vi.fn();render(<TrialConditions value={value} onChange={change}/>);fireEvent.change(screen.getByLabelText('试算温度 (K)'),{target:{value:''}});const cleared=change.mock.calls[0][0];expect(cleared.temperatureK).toBeUndefined();expect(Number.isNaN(readTrialTP(changeTrialUnit(cleared,'temperature','°C')).temperatureK)).toBe(true);expect(changeTrialUnit(cleared,'temperature','°C').temperature).toBe('');
});
it('uses compact significant figures without converting missing or extreme values to zero',()=>{
 expect(readingNumber(0.018015279999999998)).toBe('0.01801528');expect(readingNumber(1.234567891e-12)).toBe('1.2345679e-12');expect(readingNumber(123456789123)).toBe('1.2345679e+11');expect(readingNumber(0)).toBe('0');expect(readingNumber(NaN)).toBe('未提供');
});
it('keeps short exact parameters plain and offers full precision only when the reading was shortened',()=>{
 render(<><ReadableNumber value={101325}/><ReadableNumber value={-17.118123456789}/></>);expect(screen.getByText('101325').tagName).toBe('STRONG');expect(screen.getByLabelText('查看完整数值 -17.118123').tagName).toBe('SUMMARY');expect(screen.getByText('-17.118123456789').tagName).toBe('CODE');
});
