import React, { useState, useEffect } from 'react';
import type { Request, Session } from '../types';
import { auth } from '../services/firebase';

import { elapsed, mean, inPeriod, estimateROI, responseCompliance, type ResponseTargets } from '../services/insightsMath';
const duration = (n: number|null) => n === null ? '—' : n.toFixed(1)+' min';
const money = (n: number) => n.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});

export const Insights: React.FC<{hotelId:string;targets:ResponseTargets|null;requests:Request[];sessions:Session[];ready:boolean;error:string}> = ({hotelId,targets,requests,sessions,ready,error}) => {
  const [days,setDays] = useState(30);
  const [activity,setActivity]=useState<Record<string,number>|null>(null);
  const [conversationFeedback,setConversationFeedback]=useState<{count:number;average:number|null}|null>(null);
  const [feedback,setFeedback]=useState<{count:number;average:number|null}|null>(null);
  const [activityError,setActivityError]=useState('');
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    let cancelled=false;
    setActivity(null);setFeedback(null);setConversationFeedback(null);setActivityError('');
    (async()=>{
      try{
        const user=auth.currentUser;
        if(!user)throw new Error('Sign in first.');
        const response=await fetch('/api/insights/'+encodeURIComponent(hotelId)+'?days='+days,{headers:{Authorization:'Bearer '+await user.getIdToken()},signal:controller.signal});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error||'Unable to load assistance activity.');
        if(!cancelled){setActivity(data.counts);setFeedback(data.feedback||null);setConversationFeedback(data.conversationFeedback||null);}
      }catch(e:any){if(!cancelled)setActivityError(e?.message||'Unable to load assistance activity.');}
    })();
    return ()=>{cancelled=true;controller.abort();};
  },[hotelId,days,refresh]);
  const [minutes,setMinutes] = useState(2);
  const [wage,setWage] = useState(22);
  const [cost,setCost] = useState(149);
  const [displacement,setDisplacement] = useState(50);
  const [settingsState,setSettingsState]=useState<'loading'|'ready'|'saving'|'error'>('loading');
  const [settingsNotice,setSettingsNotice]=useState('');
  const [settingsReload,setSettingsReload]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let cancelled=false;
    setSettingsState('loading');setSettingsNotice('');
    (async()=>{
      try{
        const user=auth.currentUser;if(!user)throw new Error('Sign in first.');
        const r=await fetch('/api/insights/settings/'+encodeURIComponent(hotelId),{headers:{Authorization:'Bearer '+await user.getIdToken()},signal:controller.signal});
        const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to load settings.');
        if(cancelled)return;
        const v=d.settings;if(v){setMinutes(v.minutes);setWage(v.wage);setCost(v.cost);setDisplacement(v.displacement);}
        else{setMinutes(2);setWage(22);setCost(149);setDisplacement(50);}
        setSettingsState('ready');
      }catch(e){if(!cancelled){setSettingsState('error');setSettingsNotice(e instanceof Error?e.message:'Unable to load settings.');}}
    })();
    return()=>{cancelled=true;controller.abort();};
  },[hotelId,settingsReload]);
  const saveSettings=async()=>{
    if(settingsState!=='ready')return;
    setSettingsState('saving');setSettingsNotice('');
    try{
      const user=auth.currentUser;if(!user)throw new Error('Sign in first.');
      const r=await fetch('/api/insights/settings',{method:'POST',headers:{Authorization:'Bearer '+await user.getIdToken(),'Content-Type':'application/json'},body:JSON.stringify({hotelId,minutes,wage,cost,displacement})});
      const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to save settings.');
      setSettingsNotice('Hotel ROI assumptions saved.');
    }catch(e){setSettingsNotice(e instanceof Error?e.message:'Unable to save settings.');}
    finally{setSettingsState('ready');}
  };
  const now = Date.now();
  const inWindow = (t:any) => inPeriod(t,now,days);
  const cohort = requests.filter(r=>inWindow(r.createdAt));
  const completed = cohort.filter(r=>r.status==='completed');
  const ai = cohort.filter(r=>r.source==='ai');
  const eligible = ai.filter(r=>r.status==='completed');
  const active = requests.filter(r=>!['completed','cancelled'].includes(r.status));
  const recentSessions = sessions.filter(s=>inWindow(s.lastUpdatedAt));
  const {hours,value,expense,net,roi} = estimateROI(eligible.length,minutes,displacement,wage,cost,days);
  const sla=responseCompliance(cohort,targets,now);
  const departments = [...new Set(cohort.map(r=>r.department||r.category||'Unassigned'))].sort();
  const downloadReport=()=>{
    const rows: (string|number)[][]=[
      ['RenLite Insights','Management performance report'],
      ['Reporting period (rolling days)',days],['Generated at (UTC)',new Date(now).toISOString()],
      ['Cohort','Requests created during period; current status at export'],
      ['Conversations active',recentSessions.length],['Requests created',cohort.length],['Completed requests',completed.length],['AI-created requests',ai.length],['Open requests now (all dates)',active.length],
      ['Average acknowledgment',duration(mean(cohort.map(r=>elapsed(r.createdAt,r.acknowledgedAt))))],['Average completion',duration(mean(completed.map(r=>elapsed(r.createdAt,r.completedAt))))],
      ['Response target compliance',sla.rate===null?'Unavailable':sla.rate.toFixed(1)+'%'],['On time',sla.met],['Late',sla.late],['Overdue',sla.overdue],['Missing evidence',sla.unknown],['Excluded',sla.excluded],
      ['SLA basis','Current configuration, not historical audit'],
      ['AI assistance activity',activity?'First recorded outcomes; not confirmed resolutions':'Unavailable'],
      ...Object.entries(activity||{}),
      ['Legacy response rating average',feedback?.average??'Unavailable'],['Legacy response ratings received',feedback?.count??'Unavailable'],['Ren conversation rating average',conversationFeedback?.average??'Unavailable'],['Conversation ratings received',conversationFeedback?.count??'Unavailable'],
      ['ROI assumptions','Editable estimates, not verified payroll savings'],['Minutes per qualifying request',minutes],['Hourly labor cost USD',wage],['Monthly subscription estimate USD',cost],['Manual intake displacement %',displacement],
      ['Qualifying completed AI requests',eligible.length],['Estimated hours saved',hours.toFixed(2)],['Estimated labor value USD',value.toFixed(2)],['Estimated subscription expense USD',expense.toFixed(2)],['Estimated net value USD',net.toFixed(2)],['Estimated ROI %',roi===null?'Unavailable':roi.toFixed(1)],
      ['Department','Requests','Completed','Avg acknowledgment','Avg completion'],
      ...departments.map(d=>{const rs=cohort.filter(r=>(r.department||r.category||'Unassigned')===d);const done=rs.filter(r=>r.status==='completed');return [d,rs.length,done.length,duration(mean(rs.map(r=>elapsed(r.createdAt,r.acknowledgedAt)))),duration(mean(done.map(r=>elapsed(r.createdAt,r.completedAt))))];})
    ];
    const csv=rows.map(row=>row.map(cell=>{let v=String(cell);if(typeof cell==='string'&&/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF',csv],{type:'text/csv;charset=utf-8;'}));
    const link=document.createElement('a');link.href=url;link.download='RenLite-Insights-'+new Date(now).toISOString().slice(0,10)+'.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const metric = (label:string,value:React.ReactNode,note:string) => <div className="bg-white border rounded-xl p-4"><p className="text-sm text-slate-600">{label}</p><p className="text-2xl font-bold mt-1">{value}</p><p className="text-xs text-slate-500 mt-1">{note}</p></div>;
  if(error) return <section className="p-6"><h1 className="text-2xl font-bold">RenLite Insights</h1><p role="alert" className="text-red-700 mt-4">Analytics unavailable: {error}</p></section>;
  if(!ready) return <section className="p-6" role="status">Loading hotel analytics…</section>;
  return <section className="flex-1 overflow-auto p-6 space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">RenLite Insights</h1><p className="text-sm text-slate-600">Operational performance and estimated productivity value</p></div><label className="text-sm">Period <select className="border rounded-lg p-2 bg-white" value={days} onChange={e=>setDays(Number(e.target.value))}>{[7,30,90].map(n=><option key={n} value={n}>Last {n} days</option>)}</select></label><button type="button" disabled={settingsState==='loading'||settingsState==='saving'||settingsState==='error'} onClick={downloadReport} className="border rounded-lg p-2 bg-white text-sm disabled:opacity-50">Download CSV report</button></header>
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
    <div className="bg-white border rounded-xl p-5 space-y-3"><h2 className="font-semibold text-lg">Response target performance</h2><p className="text-sm text-slate-600">Based on today's saved response targets and request acknowledgment timestamps. This is a retrospective estimate, not a historical SLA audit. Zero or missing targets are excluded.</p><div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {metric('Response target met',sla.rate===null?'—':sla.rate.toFixed(1)+'%','On-time / (on-time + late + overdue)')}
      {metric('On-time acknowledgments',sla.met,'Acknowledged within target')}
      {metric('Late acknowledgments',sla.late,'Acknowledged after target')}
      {metric('Overdue without acknowledgment',sla.overdue,'No acknowledgment recorded and target passed')}
      {metric('Still within target',sla.pending,'Not yet acknowledged')}
      {metric('Missing evidence',sla.unknown,'Missing or invalid response timestamps')}
      {metric('Excluded requests',sla.excluded,'Cancelled or no applicable configured target')}
    </div></div>
    <div className="bg-white border rounded-xl p-5 space-y-3">
      <div className="flex justify-between items-center"><h2 className="font-semibold text-lg">AI assistance activity</h2><button className="border rounded p-2 text-sm" onClick={()=>setRefresh(x=>x+1)}>Refresh</button></div>
      <p className="text-sm text-slate-600">Backend-recorded first outcomes for guest message turns since tracking began. Not a count of resolved needs or proven savings. Staff diagnostics excluded.</p>
      {activityError?<p role="alert" className="text-sm text-red-700">{activityError}</p>:activity===null?<p role="status" className="text-sm">Loading activity…</p>:<div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {metric('Grounded local replies',activity.grounded_recommendation||0,'Direct search-grounded response generated')}
        {metric('Request suggestions',activity.request_suggested||0,'Model proposed a request; not proof of logging')}
        {metric('Configured FAQ matches',activity.configured_faq_match||0,'Exact configured question and answer matches; not proven resolution')}
        {metric('Staff takeovers',activity.staff_takeover||0,'Recorded transitions to staff control, including staff replies')}
        {metric('Other replies generated',activity.reply_generated||0,'May include greetings and clarification')}
        {metric('Human handoff signals',activity.handoff||0,'Model requested staff or escalation')}
        {metric('Search unavailable',activity.search_unavailable||0,'No verified local findings')}
        {metric('Failed outcomes',activity.failed||0,'First recorded outcome was unsuccessful')}
      </div>}
      {conversationFeedback && <div className="grid sm:grid-cols-2 gap-3">{metric('Ren conversation satisfaction',conversationFeedback.average===null?'—':conversationFeedback.average.toFixed(1)+' / 5','Optional conversation feedback, not hotel service satisfaction')}{metric('Conversation ratings received',conversationFeedback.count,'Ratings submitted during selected period')}</div>}
      {feedback && feedback.count>0 && <div className="grid sm:grid-cols-2 gap-3">{metric('Legacy response rating',feedback.average===null?'—':feedback.average.toFixed(1)+' / 5','Optional feedback, not overall stay satisfaction')}{metric('Legacy ratings received',feedback.count,'Ratings submitted during selected period')}</div>}
      <p className="text-xs text-slate-500">These counts are not used in ROI yet. Older activity is not backfilled.</p>
    </div>
    <div className="bg-white border rounded-xl p-5 space-y-4"><h2 className="font-semibold text-lg">Estimated return on investment</h2><p className="text-sm text-slate-600">Conservative request-intake model: counts completed AI-created requests only. It excludes fulfillment work and FAQ savings until we can measure them reliably. Assumptions can be saved for this hotel, and are not actual billing or payroll data.</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {([['Minutes saved per qualifying request',minutes,setMinutes,0,15],['Loaded hourly labor cost (USD)',wage,setWage,0,150],['Monthly subscription estimate (USD)',cost,setCost,0,5000],['Share replacing manual intake (%)',displacement,setDisplacement,0,100]] as const).map(([label,v,set,min,max])=><label key={label} className="text-sm">{label}<input className="block border rounded-lg p-2 w-full mt-1" type="number" disabled={settingsState!=='ready'} min={min} max={max} step="any" value={v} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))set(Math.min(max,Math.max(min,n)));}}/></label>)}
      </div>
      <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={settingsState!=='ready'} onClick={()=>void saveSettings()} className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm disabled:opacity-50">{settingsState==='saving'?'Saving…':'Save hotel assumptions'}</button>{settingsState==='error'&&<button onClick={()=>setSettingsReload(x=>x+1)} className="text-indigo-700 text-sm">Retry loading</button>}<span role="status" className="text-sm text-slate-600">{settingsState==='loading'?'Loading saved assumptions…':settingsNotice}</span></div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {metric('Qualifying requests',eligible.length,'Completed, AI-created')}
      {metric('Estimated hours saved',hours.toFixed(2),'Request intake only')}
      {metric('Estimated labor capacity value',money(value),'Not verified payroll savings')}
      {metric('Estimated subscription expense',money(expense),'Prorated using a 30-day month')}
      {metric('Estimated net value',money(net),'Labor value less subscription estimate')}
      {metric('Estimated ROI',roi!==null?roi.toFixed(0)+'%':'—','Excludes other costs and benefits')}
      </div><p className="text-xs text-slate-500">Historical coverage depends on stored records. Current status can change; missing timestamps are excluded from averages. No guest messages or personal identifiers are displayed.</p>
    </div>
  </section>;
};
