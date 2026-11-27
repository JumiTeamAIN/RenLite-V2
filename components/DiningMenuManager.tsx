import React,{useState,useEffect,useRef} from 'react';
import {auth} from '../services/firebase';
import {EMPTY_MENU,parseDiningMenu,parseMenuExtraction,appendMenuDraft,parseModifierSuggestions,type ModifierSuggestion,type DiningMenu,type MenuItem} from '../services/diningMenu';
import {menuSource} from '../services/menuDocument';
export function DiningMenuManager({hotelId}:{hotelId:string}){
 const [menu,setMenu]=useState<DiningMenu>(EMPTY_MENU),[version,setVersion]=useState(0),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[feedback,setFeedback]=useState(''),[dirty,setDirty]=useState(false);
 const fileRef=useRef<HTMLInputElement>(null),cameraRef=useRef<HTMLInputElement>(null);
 const generation=useRef(0);
 const [suggestions,setSuggestions]=useState<Record<string,{source:string;groups:ModifierSuggestion[]}>>({});
 const [draftPrices,setDraftPrices]=useState<Record<string,string>>({});
 const sourceKey=(x:MenuItem)=>JSON.stringify([x.name,x.category,x.description]);
 async function suggest(x:MenuItem){
   if(busy||!ready||!x.name.trim())return;
   const g=generation.current;setBusy(true);setFeedback('');
   try{
     const response=await api('suggest-modifiers',{name:x.name,category:x.category,description:x.description});
     const groups=parseModifierSuggestions(response.suggestions);
     if(!groups)throw Error('Invalid suggestions.');
     if(g===generation.current){
       setSuggestions(prev=>({...prev,[x.id]:{source:sourceKey(x),groups}}));
       setDraftPrices(prev=>Object.fromEntries(Object.entries(prev).filter(([k])=>!k.startsWith(x.id+':'))));
       setFeedback(groups.length?'Review suggested choices and enter confirmed prices (including 0 for included options). Suggestions are not published.':'No suggestions returned. You can still add choice groups manually.');
     }
   }catch(e){if(g===generation.current)setFeedback(e instanceof Error?e.message:'Suggestions unavailable.');}
   finally{if(g===generation.current)setBusy(false);}
 }
 const dismiss=(id:string,index:number)=>setSuggestions(prev=>({...prev,[id]:{...prev[id],groups:prev[id].groups.filter((_,i)=>i!==index)}}));
 function accept(x:MenuItem,index:number){
   const pending=suggestions[x.id],group=pending?.groups[index];
   if(!group||pending.source!==sourceKey(x)||(x.modifierGroups||[]).length>=10)return;
   const values=group.options.map((_,i)=>draftPrices[x.id+':'+index+':'+i]??'');
   if(values.some(v=>!/^\\d{1,5}(?:\\.\\d{1,2})?$/.test(v)||Number(v)>10000)){setFeedback('Enter a verified additional price for every option, including 0 if included.');return;}
   const norm=(s:string)=>s.trim().toLowerCase();
   if((x.modifierGroups||[]).some(g=>norm(g.question)===norm(group.question))||x.modifiers.some(m=>norm(m.split('|')[0])===norm(group.question))){setFeedback('A choice group with this question already exists. Edit the existing group instead.');return;}
   if(!window.confirm('Confirm the kitchen offers these options, the required/optional setting is correct, and all additional prices are verified. Add to unsaved menu?'))return;
   item(x.id,{modifierGroups:[...(x.modifierGroups||[]),{id:crypto.randomUUID(),question:group.question,required:group.required,options:group.options.map((label,i)=>({label,priceCents:Math.round(Number(values[i])*100)}))}]});
   clearSuggestion(x.id,index);
   setFeedback('Choice group added to the unsaved menu. Edit as needed, then Save menu to publish.');
 }
 function clearSuggestion(id:string,index:number){
   // Keep remaining groups and their price fields aligned after removing a draft.
   dismiss(id,index);
   setDraftPrices(prev=>{
     const next:Record<string,string>={};
     for(const [k,v] of Object.entries(prev)){
       if(!k.startsWith(id+':')){next[k]=v;continue;}
       const [gi,oi]=k.slice(id.length+1).split(':').map(Number);
       if(gi!==index)next[id+':'+(gi>index?gi-1:gi)+':'+oi]=v;
     }
     return next;
   });
 }
 async function api(route:string,body?:unknown){
   const user=auth.currentUser;if(!user)throw Error('Sign in again.');
   const r=await fetch('/api/dining/'+route+'/'+encodeURIComponent(hotelId),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+await user.getIdToken(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
   const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Request failed.');return data;
 }
 async function load(){
   const g=++generation.current;setBusy(true);setReady(false);setFeedback('');setSuggestions({});setDraftPrices({});
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
   try{const r=await api('menu',{menu:valid,version});if(g===generation.current){setMenu(r.menu);setVersion(r.version);setDirty(false);setFeedback('Menu saved. Guest ordering is available when enabled.');}}
   catch(e){if(g===generation.current)setFeedback(e instanceof Error?e.message:'Save failed.');}
   finally{if(g===generation.current)setBusy(false);}
 }
 const input='w-full border border-slate-300 rounded-md px-3 py-2 text-sm';
 return <section className="flex-1 overflow-y-auto p-6"><div className="max-w-5xl mx-auto space-y-4">
   <header><h2 className="text-2xl font-bold">Dining Menu</h2><p className="text-sm text-slate-600">Create and review the hotel menu. Guests can browse and submit approved menu items when enabled.</p></header>
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
   <div className="bg-white border rounded-xl p-4 flex flex-wrap items-center gap-4"><label className="text-sm">Currency code <input className="border rounded p-2 w-24 uppercase" value={menu.currency} maxLength={3} onChange={e=>update({currency:e.target.value.toUpperCase()})}/></label><label className="text-sm"><input type="checkbox" checked={menu.enabled} onChange={e=>update({enabled:e.target.checked})}/> Enable guest dining orders</label><span className="text-xs text-slate-500">{menu.items.length}/150 items</span></div>
   {menu.items.map(x=><div key={x.id} className="bg-white border rounded-xl p-4 space-y-3">
     <div className="flex justify-between items-center"><strong>{x.name||'New item'}</strong><button type="button" className="text-red-700 text-sm" onClick={()=>remove(x.id)}>Remove</button></div>
     <div className="grid sm:grid-cols-3 gap-3"><label className="text-sm">Name<input className={input} value={x.name} maxLength={150} onChange={e=>item(x.id,{name:e.target.value})}/></label><label className="text-sm">Category<input className={input} value={x.category} maxLength={80} onChange={e=>item(x.id,{category:e.target.value})}/></label><label className="text-sm">Price ({menu.currency})<input className={input} type="number" min="0" max="10000" step=".01" value={x.priceCents===null?'':x.priceCents/100} onChange={e=>item(x.id,{priceCents:e.target.value===''?null:Math.round(Number(e.target.value)*100)})}/></label></div>
     <label className="block text-sm">Description<textarea className={input} value={x.description} maxLength={500} onChange={e=>item(x.id,{description:e.target.value})}/></label>
     <label className="block text-sm">Hotel-verified allergen information (unknown if blank)<input className={input} value={x.allergens} maxLength={300} onChange={e=>item(x.id,{allergens:e.target.value})}/></label>
     <label className="block text-sm">Required preparation choices (one group per line: question | option | option)<textarea className={input} placeholder={'Cooking temperature | Medium rare | Medium | Medium well | Well done'} value={x.modifiers.join('\n')} onChange={e=>item(x.id,{modifiers:e.target.value.split('\n').slice(0,10)})}/></label>
     <div className="border border-indigo-200 rounded-lg p-3 space-y-3">
       <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">AI-assisted preparation and add-ons</strong><button type="button" disabled={!x.name.trim()||busy} className="border rounded px-3 py-2 text-sm text-indigo-700 disabled:opacity-50" onClick={()=>void suggest(x)}>Suggest customization options</button></div>
       <p className="text-xs text-slate-600">AI suggestions are not verified kitchen offerings. Review and approve each group, confirm all additional prices, and save the menu before guests see them. One AI request per item.</p>
       {suggestions[x.id]&&suggestions[x.id].source!==sourceKey(x)&&<p className="text-xs text-amber-700">Item details changed. Generate fresh suggestions.</p>}
       {suggestions[x.id]?.source===sourceKey(x)&&suggestions[x.id].groups.map((g,gi)=><div key={gi} className="border rounded p-3 space-y-2">
         <p className="font-medium text-sm">{g.question} <span className="text-xs text-slate-500">({g.required?'Suggested required':'Suggested optional'})</span></p>
         {g.options.map((option,oi)=><div key={oi} className="flex items-center gap-2"><span className="flex-1 text-sm">{option}</span><label className="w-36 text-xs">Extra ({menu.currency})<input className={input} type="number" min="0" max="10000" step=".01" placeholder="Verify price" value={draftPrices[x.id+':'+gi+':'+oi]??''} onChange={e=>setDraftPrices(p=>({...p,[x.id+':'+gi+':'+oi]:e.target.value}))}/></label></div>)}
         <div className="flex gap-2"><button type="button" className="bg-indigo-600 text-white rounded px-3 py-2 text-sm" onClick={()=>accept(x,gi)}>Approve group</button><button type="button" className="border rounded px-3 py-2 text-sm" onClick={()=>clearSuggestion(x.id,gi)}>Dismiss</button></div>
       </div>)}
     </div>
     <div className="border rounded-lg p-3 space-y-3">
       <div className="flex flex-wrap justify-between gap-2"><strong className="text-sm">Custom preparation and add-ons</strong><button type="button" disabled={(x.modifierGroups||[]).length>=10} className="border rounded px-2 py-1 text-xs" onClick={()=>item(x.id,{modifierGroups:[...(x.modifierGroups||[]),{id:crypto.randomUUID(),question:'',required:false,options:[{label:'',priceCents:0}]}]})}>Add choice group</button></div>
       <p className="text-xs text-slate-600">Choose minimum and maximum selections per group. Prices are additional per item.</p>
       {(x.modifierGroups||[]).map((g,gi)=>{
         const editGroup=(patch:Partial<typeof g>)=>item(x.id,{modifierGroups:(x.modifierGroups||[]).map((v,i)=>i===gi?{...v,...patch}:v)});
         return <div key={g.id} className="border rounded-lg p-3 space-y-2">
           <div className="flex gap-2 items-center"><label className="flex-1 text-sm">Question<input className={input} value={g.question} maxLength={150} onChange={e=>editGroup({question:e.target.value})} placeholder="How would you like it cooked?"/></label><button type="button" className="text-red-700 text-xs" onClick={()=>item(x.id,{modifierGroups:(x.modifierGroups||[]).filter((_,i)=>i!==gi)})}>Remove group</button></div>
           <div className="flex flex-wrap gap-3"><label className="text-sm">Minimum selections<input className={input} type="number" min="0" max={g.maxSelections??1} value={g.minSelections??(g.required?1:0)} onChange={e=>{const min=Math.max(0,Math.min(g.maxSelections??1,Math.floor(Number(e.target.value)||0)));editGroup({minSelections:min,required:min>0});}}/></label><label className="text-sm">Maximum selections<input className={input} type="number" min="1" max={g.options.length} value={g.maxSelections??1} onChange={e=>{const max=Math.max(1,Math.min(g.options.length,Math.floor(Number(e.target.value)||1)));const min=Math.min(g.minSelections??(g.required?1:0),max);editGroup({maxSelections:max,minSelections:min,required:min>0});}}/></label></div>
           <p className="text-xs text-slate-600">Set maximum to 1 for a single choice; use a larger maximum for toppings or multiple sides. Minimum 0 makes the group optional.</p>
           {g.options.map((o,oi)=><div key={oi} className="flex items-end gap-2"><label className="flex-1 text-xs">Option<input className={input} value={o.label} maxLength={100} onChange={e=>editGroup({options:g.options.map((v,i)=>i===oi?{...v,label:e.target.value}:v)})}/></label><label className="w-28 text-xs">Extra ({menu.currency})<input className={input} type="number" min="0" max="10000" step=".01" value={o.priceCents/100} onChange={e=>editGroup({options:g.options.map((v,i)=>i===oi?{...v,priceCents:Math.round(Number(e.target.value)*100)}:v)})}/></label><button type="button" disabled={g.options.length<=1} className="text-red-700 text-xs py-2" onClick={()=>{const options=g.options.filter((_,i)=>i!==oi);const max=Math.min(g.maxSelections??1,options.length);const min=Math.min(g.minSelections??(g.required?1:0),max);editGroup({options,maxSelections:max,minSelections:min,required:min>0});}}>Remove</button></div>)}
           <button type="button" disabled={g.options.length>=20} className="border rounded px-2 py-1 text-xs" onClick={()=>editGroup({options:[...g.options,{label:'',priceCents:0}]})}>Add option</button>
         </div>;
       })}
     </div>
     <label className="block text-sm">Suggested upsell items<select multiple className={input} value={x.upsells} onChange={e=>item(x.id,{upsells:Array.from(e.target.selectedOptions,o=>o.value).slice(0,10)})}>{menu.items.filter(y=>y.id!==x.id&&y.name).map(y=><option key={y.id} value={y.id}>{y.name}</option>)}</select></label>
     <label className="text-sm"><input type="checkbox" disabled={x.priceCents===null} checked={x.available} onChange={e=>item(x.id,{available:e.target.checked})}/> Approved for guest menu</label>
   </div>)}
   <button type="button" disabled={!dirty||busy} onClick={()=>void save()} className="bg-indigo-600 text-white px-5 py-3 rounded-lg font-semibold disabled:opacity-50">{busy?'Working…':'Save menu'}</button>{dirty&&<span className="ml-3 text-sm text-amber-700">Unsaved changes</span>}
   </fieldset>}
 </div></section>;
}
