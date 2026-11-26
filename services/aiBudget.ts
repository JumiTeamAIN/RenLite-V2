// Conservative internal attempt allowance, NOT a guaranteed provider dollar ceiling.
// Dollar estimates cover reported standard text tokens only; no cached discount or free search allowance assumed.
export const DEFAULT_BUDGET={monthlyCents:475,searchEnabled:true,standardDebitCents:1,searchDebitCents:5};
export type Budget=typeof DEFAULT_BUDGET;
export function parseBudget(v:any):Budget|null{
 if(!v||!Number.isSafeInteger(v.monthlyCents)||v.monthlyCents<0||v.monthlyCents>500||typeof v.searchEnabled!=='boolean')return null;
 return {...DEFAULT_BUDGET,monthlyCents:v.monthlyCents,searchEnabled:v.searchEnabled};
}
export function attemptDebit(policy:Budget,operation:string,used:number):number|null{
 if(!Number.isSafeInteger(used)||used<0)return null;
 const search=operation==='search'||operation==='probe-search';
 const debit=search?policy.searchDebitCents:policy.standardDebitCents;
 return (search&&!policy.searchEnabled)||used+debit>policy.monthlyCents?null:debit;
}
export function estimateTokenDollars(row:any):number|null{
 if(row.model!=='gemini-3.5-flash-lite'&&row.model!=='gemini-2.5-flash')return null;
 const n=(k:string)=>Number.isFinite(row[k])&&row[k]>=0?row[k]:0;
 return (n('inputTokens')*.30+(n('outputTokens')+n('thinkingTokens'))*2.50)/1e6;
}
