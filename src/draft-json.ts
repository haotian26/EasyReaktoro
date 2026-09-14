// JSON has no representation for a temporarily empty numeric input.
export function encodeDraft(value:unknown){return JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='number'&&!Number.isFinite(v)?{easyreaktoro_empty_number:true}:v));}
export function restoreDraft(value:unknown){return JSON.parse(JSON.stringify(value),(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&v.easyreaktoro_empty_number===true?NaN:v);}
