import React, { useState } from 'react';
import type { Request, Session } from '../types';

const ms = (t: any): number | null => {
  const n = t?.toMillis?.();
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const elapsed = (a: any, b: any) => {
  const start = ms(a), end = ms(b);
  return start !== null && end !== null && end >= start ? (end-start)/60000 : null;
};
const mean = (xs: (number|null)[]) => {
  const valid = xs.filter((x): x is number => x !== null);
  return valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : null;
};
const duration = (n: number|null) => n === null ? '—' : n.toFixed(1)+' min';
const money = (n: number) => n.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});

export const Insights: React.FC<{requests:Request[];sessions:Session[];ready:boolean;error:string}> = ({requests,sessions,ready,error}) => {
  const [days,setDays] = useState(30);
  const [minutes,setMinutes] = useState(2);
  const [wage,setWage] = useState(22);
  const [cost,setCost] = useState(149);
  const [displacement,setDisplacement] = useState(50);
  const now = Date.now(), start = now-days*86400000;
  const inWindow = (t:any) => {const n=ms(t);return n!==null && n>=start && n<=now;};
  const cohort = requests.filter(r=>inWindow(r.createdAt));
  const completed = cohort.filter(r=>r.status==='completed');
  const ai = cohort.filter(r=>r.source==='ai');
  const eligible = ai.filter(r=>r.status==='completed');
  const active = requests.filter(r=>!['completed','cancelled'].includes(r.status));
  const recentSessions = sessions.filter(s=>inWindow(s.lastUpdatedAt));
  const hours = eligible.length*minutes*displacement/100/60;
  const value = hours*wage, expense=cost*days/30, net=value-expense;
  const departments = [...new Set(cohort.map(r=>r.department||r.category||'Unassigned'))].sort();
  const metric = (label:string,value:React.ReactNode,note:string) => <div className="bg-white border rounded-xl p-4"><p className="text-sm text-slate-600">{label}</p><p className="text-2xl font-bold mt-1">{value}</p><p className="text-xs text-slate-500 mt-1">{note}</p></div>;
  if(error) return <section className="p-6"><h1 className="text-2xl font-bold">RenLite Insights</h1><p role="alert" className="text-red-700 mt-4">Analytics unavailable: {error}</p></section>;
  if(!ready) return <section className="p-6" role="status">Loading hotel analytics…</section>;
  return <section className="flex-1 overflow-auto p-6 space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">RenLite Insights</h1><p className="text-sm text-slate-600">Operational performance and estimated productivity value</p></div><label className="text-sm">Period <select className="border rounded-lg p-2 bg-white" value={days} onChange={e=>setDays(Number(e.target.value))}>{[7,30,90].map(n=><option key={n} value={n}>Last {n} days</option>)}</select></label></header>
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {metric('Conversations active in period',recentSessions.length,'Based on most recent activity, not conversation starts')}
      {metric('Requests created',cohort.length,'All request sources')}
      {metric('AI-created requests',ai.length,'Logged by Ren, not necessarily fulfilled by AI')}
      {metric('Open requests now',active.length,'All dates; current backlog')}
      {metric('Completed requests',completed.length,'From requests created in selected period')}
      {metric('Average acknowledgment',duration(mean(cohort.map(r=>elapsed(r.createdAt,r.acknowledgedAt)))),'Only records with valid timestamps')}
      {metric('Average completion',duration(mean(completed.map(r=>elapsed(r.createdAt,r.completedAt)))),'Only completed records with valid timestamps')}
      {metric('Escalated requests',cohort.filter(r=>r.status==='escalated').length,'Current status, not historical escalation count')}
    </div>
    <div className="bg-white border rounded-xl p-4 overflow-x-auto"><h2 className="font-semibold mb-3">Department performance</h2><table className="w-full text-sm text-left"><thead className="text-slate-600"><tr>{['Department','Created','Completed','Avg. acknowledgment','Avg. completion'].map(h=><th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{departments.map(d=>{const rs=cohort.filter(r=>(r.department||r.category||'Unassigned')===d);const done=rs.filter(r=>r.status==='completed');return <tr key={d} className="border-t"><td className="p-2">{d}</td><td className="p-2">{rs.length}</td><td className="p-2">{done.length}</td><td className="p-2">{duration(mean(rs.map(r=>elapsed(r.createdAt,r.acknowledgedAt))))}</td><td className="p-2">{duration(mean(done.map(r=>elapsed(r.createdAt,r.completedAt))))}</td></tr>})}</tbody></table>{!departments.length&&<p className="text-sm text-slate-500 p-2">No requests in this period.</p>}</div>
    <div className="bg-white border rounded-xl p-5 space-y-4"><h2 className="font-semibold text-lg">Estimated return on investment</h2><p className="text-sm text-slate-600">Conservative request-intake model: counts completed AI-created requests only. It excludes fulfillment work and FAQ savings until we can measure them reliably. Assumptions are editable for this session, not actual billing or payroll data.</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {([['Minutes saved per qualifying request',minutes,setMinutes,0,15],['Loaded hourly labor cost (USD)',wage,setWage,0,150],['Monthly subscription estimate (USD)',cost,setCost,0,5000],['Share replacing manual intake (%)',displacement,setDisplacement,0,100]] as const).map(([label,v,set,min,max])=><label key={label} className="text-sm">{label}<input className="block border rounded-lg p-2 w-full mt-1" type="number" min={min} max={max} step="any" value={v} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))set(Math.min(max,Math.max(min,n)));}}/></label>)}
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {metric('Qualifying requests',eligible.length,'Completed, AI-created')}
      {metric('Estimated hours saved',hours.toFixed(2),'Request intake only')}
      {metric('Estimated labor capacity value',money(value),'Not verified payroll savings')}
      {metric('Estimated subscription expense',money(expense),'Prorated using a 30-day month')}
      {metric('Estimated net value',money(net),'Labor value less subscription estimate')}
      {metric('Estimated ROI',expense>0?(net/expense*100).toFixed(0)+'%':'—','Excludes other costs and benefits')}
      </div><p className="text-xs text-slate-500">Historical coverage depends on stored records. Current status can change; missing timestamps are excluded from averages. No guest messages or personal identifiers are displayed.</p>
    </div>
  </section>;
};
