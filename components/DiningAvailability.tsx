import React,{useEffect,useState,useRef} from 'react';
import {auth} from '../services/firebase';
type Item={id:string;name:string;category:string;soldOut:boolean};
export function DiningAvailability({hotelId}:{hotelId:string}){
 const [items,setItems]=useState<Item[]>([]),[version,setVersion]=useState(0),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reason,setReason]=useState('');
 const running=useRef(false),generation=useRef(0);
 async function api(body?:unknown){
   const user=auth.currentUser;if(!user)throw Error('Sign in again.');
   const r=await fetch('/api/dining/availability/'+encodeURIComponent(hotelId),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+await user.getIdToken(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
   const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Availability request failed.');return data;
 }
 async function refresh(){
   const g=generation.current;if(running.current)return;running.current=true;setBusy(true);
   try{const r=await api();if(g===generation.current){setItems(r.items);setVersion(r.version);setReady(true);setError('');}}
   catch(e){if(g===generation.current){setReady(false);setError(e instanceof Error?e.message:'Refresh failed.');}}
   finally{running.current=false;if(g===generation.current)setBusy(false);}
 }
 useEffect(()=>{void refresh();return()=>{generation.current++;};},[hotelId]);
 async function toggle(x:Item){
   if(running.current||!ready)return;
   const g=generation.current;running.current=true;setBusy(true);setError('');setNotice('');
   try{
     await api({itemId:x.id,soldOut:!x.soldOut,version,reason});
     if(g===generation.current){setNotice(x.name+(!x.soldOut?' marked 86 — sold out.':' restored.'));setReason('');}
   }catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Update failed.');}
   finally{running.current=false;if(g===generation.current){setBusy(false);await refresh();}}
 }
 return <section className="flex-1 overflow-y-auto p-6"><div className="max-w-4xl mx-auto space-y-4">
 <header><h2 className="text-2xl font-bold">Live Menu Availability</h2><p className="text-sm text-slate-600">Temporarily 86 or restore approved items. Prices and menu approval are unchanged. Guest ordering is not active yet.</p></header>
 <div className="flex gap-3 items-center"><button type="button" disabled={busy} onClick={()=>void refresh()} className="border rounded px-3 py-2 text-sm">Refresh availability</button>{ready&&<span className="text-sm">{items.filter(x=>x.soldOut).length} sold out · {items.filter(x=>!x.soldOut).length} available</span>}</div>
 {error&&<p role="alert" className="text-red-800 text-sm">{error}</p>}{notice&&<p role="status" className="text-emerald-800 text-sm">{notice}</p>}
 {!ready?<p className="text-sm">{busy?'Loading…':'Availability not confirmed. Refresh before making changes.'}</p>:<>
 <label className="block text-sm">Optional reason for next change<input value={reason} maxLength={200} onChange={e=>setReason(e.target.value)} disabled={busy} className="block border rounded p-2 w-full mt-1" placeholder="e.g. Kitchen out of stock"/></label>
 {items.length===0&&<p className="text-sm">No approved menu items yet.</p>}
 {items.map(x=><div key={x.id} className="bg-white border rounded-xl p-4 flex items-center justify-between gap-4"><div><strong>{x.name}</strong><p className="text-xs text-slate-500">{x.category}</p><p className={x.soldOut?'text-red-700 text-sm font-semibold':'text-emerald-700 text-sm'}>{x.soldOut?'86 — Sold out':'Available'}</p></div><button type="button" disabled={busy} onClick={()=>void toggle(x)} className="border rounded px-4 py-2 text-sm font-semibold disabled:opacity-50">{x.soldOut?'Restore item':'86 item'}</button></div>)}
 </>}
 </div></section>;
}
