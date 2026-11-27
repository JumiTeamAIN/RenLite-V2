import React,{useState,useEffect,useRef} from 'react';
import {auth} from '../services/firebase';
import {EMPTY_MENU,parseDiningMenu,parseMenuExtraction,appendMenuDraft,type DiningMenu,type MenuItem} from '../services/diningMenu';
import {menuSource} from '../services/menuDocument';
export function DiningMenuManager({hotelId}:{hotelId:string}){
 const [menu,setMenu]=useState<DiningMenu>(EMPTY_MENU),[version,setVersion]=useState(0),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[feedback,setFeedback]=useState(''),[dirty,setDirty]=useState(false);
 const fileRef=useRef<HTMLInputElement>(null),cameraRef=useRef<HTMLInputElement>(null);
 const generation=useRef(0);
 async function api(route:string,body?:unknown){
   const user=auth.currentUser;if(!user)throw Error('Sign in again.');
   const r=await fetch('/api/dining/'+route+'/'+encodeURIComponent(hotelId),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+await user.getIdToken(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
   const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Request failed.');return data;
 }
 async function load(){
   const g=++generation.current;setBusy(true);setReady(false);setFeedback('');
   try{const r=await api('menu');const m=parseDiningMenu(r.menu);if(!m)throw Error('Invalid saved menu.');if(g===generation.current){setMenu(m);setVersion(r.version);setDirty(false);setReady(true);}}
   catch(e){if(g===generation.current)setFeedback(e instanceof Error?e.message:'Could not load menu.');}
   finally{if(g===generation.current)setBusy(false);}
 }
 useEffect(()=>{void load();return()=>{generation.current++;};},[hotelId]);
 const update=(patch:Partial<DiningMenu>)=>{setMenu(p=>({...p,...patch}));setDirty(true);};
 const item=(id:string,patch:Partial<MenuItem>)=>{setMenu(p=>({...p,items:p.items.map(x=>x.id===id?{...x,...patch}:x)}));setDirty(true);};
 const remove=(id:string)=>{setMenu(p=>({...p,items:p.items.filter(x=>x.id!==id).map(x=>({...x,upsells:x.upsells.filter(y=>y!==id)}))}));setDirty(true);};
 const add=()=>{if(menu.items.length>=150){setFeedback('Maximum 150 items.');return;}update({items:[...menu.items,{id:crypto.randomUUID(),name:'',category:'General',description:'',priceCents:null,available:false,modifiers:[],upsells:[],allergens:''}]});};
 async function importFiles(files:FileList|null){
   if(!files?.length||busy||!ready)return;
   const list=Array.from(files);
   if(list.length>5){setFeedback('Import at most five files at a time.');return;}
   const g=generation.current;setBusy(true);setFeedback('');
   try{
     let next=menu.items,skipped=0,added=0;
     for(const file of list){
       const source=await menuSource(file);const response=await api('extract',source);
       const extracted=parseMenuExtraction(response.items);if(!extracted?.length)throw Error('No valid menu items in '+file.name);
       const merged=appendMenuDraft(next,extracted,()=>crypto.randomUUID());added+=merged.items.length-next.length;skipped+=merged.skipped;next=merged.items;
     }
     if(g===generation.current){update({items:next});setFeedback(added+' draft items added; '+skipped+' duplicates skipped. Review every item, price, currency and available option. Imported items are unavailable by default. Nothing is saved until you save.');}
   }catch(e){if(g===generation.current)setFeedback((e instanceof Error?e.message:'Import failed.')+' No draft items added from this batch.');}
   finally{if(g===generation.current){setBusy(false);if(fileRef.current)fileRef.current.value='';if(cameraRef.current)cameraRef.current.value='';}}
 }
 async function save(){
   const valid=parseDiningMenu(menu);if(!valid){setFeedback('Review missing names, prices, duplicate items, currency and modifiers. Enable at least one priced item before enabling dining.');return;}
   const g=generation.current;setBusy(true);setFeedback('');
   try{const r=await api('menu',{menu:valid,version});if(g===generation.current){setMenu(r.menu);setVersion(r.version);setDirty(false);setFeedback('Menu saved. Guest menu preview is available when enabled; submission is not yet active.');}}
   catch(e){if(g===generation.current)setFeedback(e instanceof Error?e.message:'Save failed.');}
   finally{if(g===generation.current)setBusy(false);}
 }
 const input='w-full border border-slate-300 rounded-md px-3 py-2 text-sm';
 return <section className="flex-1 overflow-y-auto p-6"><div className="max-w-5xl mx-auto space-y-4">
   <header><h2 className="text-2xl font-bold">Dining Menu</h2><p className="text-sm text-slate-600">Create and review the hotel menu. Guests can browse and review approved menu items when enabled; order submission is not yet active.</p></header>
   {feedback&&<p role="status" className="border rounded-lg p-3 text-sm bg-slate-50">{feedback}</p>}
   <div className="flex gap-2 flex-wrap"><button type="button" disabled={busy} onClick={()=>{if(!dirty||window.confirm('Discard unsaved menu changes?'))void load();}} className="border rounded px-3 py-2 text-sm disabled:opacity-50">Reload menu</button></div>
   {!ready?<p className="text-sm">{busy?'Loading…':'Menu not loaded. Reload to continue.'}</p>:<fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
   <div className="bg-white border rounded-xl p-4 space-y-3">
     <h3 className="font-semibold">Import menu documents or photos</h3>
     <p className="text-sm text-slate-600">AI extracts menu text and prices into disabled draft items. Each file uses one budget-metered AI request. Review source currency manually; never assume allergens from a photo. Files are sent to the configured AI provider for extraction.</p>
     <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.webp,.docx,.xlsx,.pdf,.csv,.txt" multiple hidden onChange={e=>void importFiles(e.target.files)}/>
     <input ref={cameraRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={e=>void importFiles(e.target.files)}/>
     <div className="flex flex-wrap gap-2"><button type="button" onClick={()=>cameraRef.current?.click()} className="border rounded-lg px-4 py-2">Take photo</button><button type="button" onClick={()=>fileRef.current?.click()} className="border rounded-lg px-4 py-2">Upload menu</button><button type="button" onClick={add} className="border rounded-lg px-4 py-2">Add item manually</button></div>
   </div>
   <div className="bg-white border rounded-xl p-4 flex flex-wrap items-center gap-4"><label className="text-sm">Currency code <input className="border rounded p-2 w-24 uppercase" value={menu.currency} maxLength={3} onChange={e=>update({currency:e.target.value.toUpperCase()})}/></label><label className="text-sm"><input type="checkbox" checked={menu.enabled} onChange={e=>update({enabled:e.target.checked})}/> Enable guest menu preview</label><span className="text-xs text-slate-500">{menu.items.length}/150 items</span></div>
   {menu.items.map(x=><div key={x.id} className="bg-white border rounded-xl p-4 space-y-3">
     <div className="flex justify-between items-center"><strong>{x.name||'New item'}</strong><button type="button" className="text-red-700 text-sm" onClick={()=>remove(x.id)}>Remove</button></div>
     <div className="grid sm:grid-cols-3 gap-3"><label className="text-sm">Name<input className={input} value={x.name} maxLength={150} onChange={e=>item(x.id,{name:e.target.value})}/></label><label className="text-sm">Category<input className={input} value={x.category} maxLength={80} onChange={e=>item(x.id,{category:e.target.value})}/></label><label className="text-sm">Price ({menu.currency})<input className={input} type="number" min="0" max="10000" step=".01" value={x.priceCents===null?'':x.priceCents/100} onChange={e=>item(x.id,{priceCents:e.target.value===''?null:Math.round(Number(e.target.value)*100)})}/></label></div>
     <label className="block text-sm">Description<textarea className={input} value={x.description} maxLength={500} onChange={e=>item(x.id,{description:e.target.value})}/></label>
     <label className="block text-sm">Hotel-verified allergen information (unknown if blank)<input className={input} value={x.allergens} maxLength={300} onChange={e=>item(x.id,{allergens:e.target.value})}/></label>
     <label className="block text-sm">Required preparation choices (one group per line: question | option | option)<textarea className={input} placeholder={'Cooking temperature | Medium rare | Medium | Medium well | Well done'} value={x.modifiers.join('\n')} onChange={e=>item(x.id,{modifiers:e.target.value.split('\n').slice(0,10)})}/></label>
     <label className="block text-sm">Suggested upsell items<select multiple className={input} value={x.upsells} onChange={e=>item(x.id,{upsells:Array.from(e.target.selectedOptions,o=>o.value).slice(0,10)})}>{menu.items.filter(y=>y.id!==x.id&&y.name).map(y=><option key={y.id} value={y.id}>{y.name}</option>)}</select></label>
     <label className="text-sm"><input type="checkbox" disabled={x.priceCents===null} checked={x.available} onChange={e=>item(x.id,{available:e.target.checked})}/> Approved for guest menu</label>
   </div>)}
   <button type="button" disabled={!dirty||busy} onClick={()=>void save()} className="bg-indigo-600 text-white px-5 py-3 rounded-lg font-semibold disabled:opacity-50">{busy?'Working…':'Save menu'}</button>{dirty&&<span className="ml-3 text-sm text-amber-700">Unsaved changes</span>}
   </fieldset>}
 </div></section>;
}
