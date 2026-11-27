import React,{useEffect,useState,useRef} from 'react';
import {auth} from '../services/firebase';
import {EMPTY_MENU,orderable,type DiningMenu,type MenuItem} from '../services/diningMenu';
import {modifierGroups,reviewCart,type CartLine} from '../services/diningOrder';
export function GuestDining({hotelId,sessionId}:{hotelId:string;sessionId:string}){
 const [menu,setMenu]=useState<DiningMenu>(EMPTY_MENU),[room,setRoom]=useState(''),[guestCount,setGuestCount]=useState(0),[lines,setLines]=useState<CartLine[]>([]),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[review,setReview]=useState<ReturnType<typeof reviewCart>|null>(null);
 const generation=useRef(0);
 const money=(n:number)=>menu.currency+' '+(n/100).toFixed(2);
 async function api(body:object){
   const user=auth.currentUser;if(!user)throw Error('Sign in again.');
   const r=await fetch('/api/dining/guest/'+encodeURIComponent(hotelId),{method:'POST',headers:{Authorization:'Bearer '+await user.getIdToken(),'Content-Type':'application/json'},body:JSON.stringify({sessionId,...body}),signal:AbortSignal.timeout(15000)});
   const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Dining unavailable.');return data;
 }
 async function refresh(){
   const g=++generation.current;setBusy(true);setReady(false);setReview(null);setError('');
   try{const r=await api({});if(g===generation.current){setMenu(r.menu);setRoom(r.roomNumber);setReady(true);}}
   catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Menu unavailable.');}
   finally{if(g===generation.current)setBusy(false);}
 }
 useEffect(()=>{void refresh();return()=>{generation.current++;};},[hotelId,sessionId]);
 const change=(next:CartLine[])=>{setLines(next);setReview(null);};
 const add=(item:MenuItem)=>{if(lines.length<30&&orderable(item))change([...lines,{itemId:item.id,quantity:1,choices:{}}]);};
 const edit=(index:number,patch:Partial<CartLine>)=>change(lines.map((l,i)=>i===index?{...l,...patch}:l));
 async function preview(){
   const g=generation.current;setBusy(true);setError('');setReview(null);
   try{const r=await api({lines,guestCount});if(g===generation.current){setReview(r.review);setRoom(r.roomNumber);}}
   catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Unable to review.');}
   finally{if(g===generation.current)setBusy(false);}
 }
 return <section className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
 <h2 className="text-lg font-bold">In-room dining</h2>
 <p className="text-sm text-slate-600">Menu and order preview only. Orders are not sent to the hotel in this release. Contact staff to place your order.</p>
 {room&&<p className="text-xs text-slate-500">Current location: {room}</p>}
 <button type="button" disabled={busy} onClick={()=>void refresh()} className="border rounded-lg px-3 py-2 text-xs">Refresh menu availability</button>
 {error&&<p role="alert" className="text-red-700 text-sm">{error}</p>}
 {!ready?<p>{busy?'Loading…':'Menu not confirmed. Refresh or contact staff.'}</p>:!menu.enabled?<p>Online room service is not currently available. Please contact the front desk.</p>:<fieldset disabled={busy} className="space-y-4">
 <label className="block text-sm font-medium">How many guests are dining?<select value={guestCount} onChange={e=>{setGuestCount(Number(e.target.value));setReview(null);}} className="block w-full border rounded p-2 mt-1"><option value={0}>Select guest count</option>{Array.from({length:20},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</select></label>
 {menu.items.map(item=><div key={item.id} className="border rounded-xl p-3 bg-white space-y-1"><p className="text-xs text-slate-500">{item.category}</p><div className="flex justify-between gap-2"><strong>{item.name}</strong><span>{item.priceCents===null?'':money(item.priceCents)}</span></div><p className="text-sm">{item.description}</p>{item.allergens&&<p className="text-xs">Hotel-provided allergen information: {item.allergens}</p>}<button type="button" disabled={!orderable(item)||!guestCount||lines.length>=30} onClick={()=>add(item)} className="border rounded px-3 py-2 text-sm disabled:opacity-50">{item.soldOut?'Sold out':'Add to order'}</button></div>)}
 <h3 className="font-bold">Your selections</h3>
 {lines.map((line,index)=>{const item=menu.items.find(x=>x.id===line.itemId);return <div key={index} className="border rounded-xl p-3 space-y-2"><div className="flex justify-between"><strong>{item?.name||'Unavailable item'}</strong><button type="button" className="text-red-700 text-sm" onClick={()=>change(lines.filter((_,i)=>i!==index))}>Remove</button></div>{(!item||!orderable(item))&&<p className="text-red-700 text-xs">No longer available. Remove or replace.</p>}<label className="block text-sm">Quantity<select className="ml-2 border rounded p-1" value={line.quantity} onChange={e=>edit(index,{quantity:Number(e.target.value)})}>{Array.from({length:20},(_,i)=><option key={i}>{i+1}</option>)}</select></label>{item&&modifierGroups(item).map(group=><label key={group.id} className="block text-sm">{group.question}{group.options.length?<select className="block border rounded p-2 w-full" value={line.choices[group.id]||''} onChange={e=>edit(index,{choices:{...line.choices,[group.id]:e.target.value}})}><option value="">Choose an option</option>{group.options.map(o=><option key={o}>{o}</option>)}</select>:<p className="text-amber-800 text-xs">Preparation choices have not been configured. Contact staff.</p>}</label>)}</div>})}
 <p className="text-xs text-slate-600">For allergies or dietary concerns, confirm directly with hotel staff. Do not rely on this menu as a guarantee of allergen safety.</p>
 <button type="button" disabled={!lines.length||!guestCount} onClick={()=>void preview()} className="bg-indigo-600 text-white rounded-lg px-4 py-3 disabled:opacity-50">Review order</button>
 {review&&'subtotalCents' in review&&<div className="border rounded-xl p-4 space-y-2"><h3 className="font-bold">Order preview — not submitted</h3><p>{review.guestCount} guests · {room||'Location not confirmed'}</p>{review.lines.map((l,i)=><div key={i} className="text-sm">{l.quantity} × {l.name} — {money(l.lineTotalCents)}{l.choices.map(c=><div key={c.question} className="text-xs">{c.question}: {c.answer}</div>)}</div>)}<p className="font-bold">Subtotal: {money(review.subtotalCents)}</p><p className="text-xs">Taxes, charges, availability and delivery subject to staff confirmation. This is not an order confirmation.</p></div>}
 </fieldset>}
 </section>;
}
