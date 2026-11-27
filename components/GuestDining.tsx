import React,{useEffect,useState,useRef} from 'react';
import {auth} from '../services/firebase';
import {EMPTY_MENU,orderable,type DiningMenu,type MenuItem} from '../services/diningMenu';
import {modifierGroups,reviewCart,estimatedUnitCents,selectedOptions,validGroupChoice,resolveCartEdit,simpleDiningProposal,cartPreparationReply,diningTargetMatches,missingDiningTarget,diningFollowup,type CartCommand,type ModifierChoice,type CartLine} from '../services/diningOrder';
export type ChatDiningItem={name:string;id:string;groups:ReturnType<typeof modifierGroups>;currency:string};
export type ChatCartSnapshot={count:number;guestCount:number;room:string;currency:string;subtotal:number;lines:{name:string;quantity:number;choices:string[];total:number}[];review:ReturnType<typeof reviewCart>|null;quoteId:string;receipt:string;uncertain:boolean;busy:boolean;error:string};
export type GuestDiningHandle={nextChatOffer:()=>string;tryMissingItem:(text:string)=>Promise<string>;dismissMissingItem:()=>string;tryExplicitAdd:(text:string)=>Promise<string|null>;tryPreparationEdit:(text:string)=>Promise<string|null>;chatCommand:(command:CartCommand)=>Promise<string>;addFromChat:(itemId:string)=>Promise<string>;getChatItem:(itemId:string)=>Promise<ChatDiningItem>;addCustomizedFromChat:(item:ChatDiningItem,choices:Record<string,ModifierChoice>,quantity?:number)=>Promise<string>};
export const GuestDining=React.forwardRef<GuestDiningHandle,{hotelId:string;sessionId:string;visible:boolean;onSubmitted?:()=>void;onCartSnapshot?:(snapshot:ChatCartSnapshot)=>void}>(({hotelId,sessionId,visible,onSubmitted,onCartSnapshot},ref)=>{
 const [menu,setMenu]=useState<DiningMenu>(EMPTY_MENU),[room,setRoom]=useState(''),[guestCount,setGuestCount]=useState(0),[lines,setLines]=useState<CartLine[]>([]),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[review,setReview]=useState<ReturnType<typeof reviewCart>|null>(null);
 const generation=useRef(0);
 const offered=useRef<string[]>([]);
 const offerState=useRef<{menu:DiningMenu;lines:CartLine[]}>({menu:EMPTY_MENU,lines:[]});
 const missing=useRef('');
 useEffect(()=>{offerState.current={menu,lines};},[menu,lines]);
 const [quoteId,setQuoteId]=useState(''),[receipt,setReceipt]=useState(''),[uncertain,setUncertain]=useState(false);
 const submitting=useRef(false);
 const chatAdding=useRef(false);
 const pendingKey='ren_dining_pending:'+hotelId+':'+sessionId;
 useEffect(()=>{try{const saved=sessionStorage.getItem(pendingKey);if(saved){setQuoteId(saved);setUncertain(true);}}catch{}},[pendingKey]);
 const [category,setCategory]=useState(''),[cartOpen,setCartOpen]=useState(false),[notice,setNotice]=useState('');
 const scrollRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(visible)scrollRef.current?.scrollTo({top:0});},[cartOpen,category,visible]);
 const count=lines.reduce((n,l)=>n+l.quantity,0);
 const subtotal=lines.reduce((n,l)=>{const item=menu.items.find(x=>x.id===l.itemId);return n+(item?estimatedUnitCents(item,l)*l.quantity:0);},0);
 useEffect(()=>{onCartSnapshot?.({count,guestCount,room,currency:menu.currency,subtotal,lines:lines.map(l=>{const item=menu.items.find(x=>x.id===l.itemId);return {name:item?.name||'Unavailable item',quantity:l.quantity,choices:item?modifierGroups(item).flatMap(g=>selectedOptions(l.choices[g.id]).length?[g.question+': '+selectedOptions(l.choices[g.id]).join(', ')]:[]):[],total:item?estimatedUnitCents(item,l)*l.quantity:0};}),review,quoteId,receipt,uncertain,busy,error});},[onCartSnapshot,count,guestCount,room,menu,subtotal,lines,review,quoteId,receipt,uncertain,busy,error]);
 const hasUnavailable=lines.some(l=>!menu.items.some(x=>x.id===l.itemId&&orderable(x)));
 const categories=[...new Set(menu.items.map(x=>x.category))];
 const money=(n:number)=>menu.currency+' '+(n/100).toFixed(2);
 async function api(body:object){
   const user=auth.currentUser;if(!user)throw Error('Sign in again.');
   const r=await fetch('/api/dining/guest/'+encodeURIComponent(hotelId),{method:'POST',headers:{Authorization:'Bearer '+await user.getIdToken(),'Content-Type':'application/json'},body:JSON.stringify({sessionId,...body}),signal:AbortSignal.timeout(15000)});
   const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Dining unavailable.');return data;
 }
 async function refresh(){
   const g=++generation.current;setBusy(true);setReady(false);setReview(null);setError('');
   try{const r=await api({});if(g===generation.current){setMenu(r.menu);setRoom(r.roomNumber);setCategory(c=>r.menu.items.some((x:MenuItem)=>x.category===c)?c:'');setReady(true);}}
   catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Menu unavailable.');}
   finally{if(g===generation.current)setBusy(false);}
 }
 useEffect(()=>{return()=>{generation.current++;};},[hotelId,sessionId]);
 useEffect(()=>{if(visible&&!submitting.current&&!chatAdding.current)void refresh();},[visible,hotelId,sessionId]);
 const change=(next:CartLine[])=>{offerState.current={...offerState.current,lines:next};setLines(next);setReview(null);setQuoteId('');};
 const [configuring,setConfiguring]=useState<CartLine|null>(null);
 const add=(item:MenuItem)=>{if(lines.length<30&&orderable(item)){
   const line={itemId:item.id,quantity:1,choices:{}};
   if(modifierGroups(item).length){setConfiguring(line);setNotice('');setCartOpen(false);}
   else {change([...lines,line]);setNotice(item.name+' added to your cart.');}
 }};
 const configItem=configuring?menu.items.find(x=>x.id===configuring.itemId):undefined;
 const configValid=Boolean(configuring&&configItem&&orderable(configItem)&&modifierGroups(configItem).every(g=>validGroupChoice(g,configuring.choices[g.id])));
 function choiceControls(item:MenuItem,line:CartLine,onChange:(choices:CartLine['choices'])=>void){
   return modifierGroups(item).map(group=>{
     const selected=selectedOptions(line.choices[group.id]);
     return <div key={group.id} className="space-y-1 text-sm"><p className="font-medium">{group.question} {group.maxSelections>1?'(choose '+group.minSelections+'–'+group.maxSelections+')':group.required?'(required)':'(optional)'}</p>
       {group.options.length===0?<p className="text-amber-800">Contact staff for preparation options.</p>:group.maxSelections>1?group.options.map(o=><label key={o} className="flex gap-2 items-center py-1"><input type="checkbox" checked={selected.includes(o)} disabled={!selected.includes(o)&&selected.length>=group.maxSelections} onChange={e=>onChange({...line.choices,[group.id]:e.target.checked?[...selected,o]:selected.filter(v=>v!==o)})}/>{o}{group.prices[o]?' (+'+money(group.prices[o])+')':''}</label>):<select aria-label={group.question} className="block border rounded p-2 w-full" value={selected[0]||''} onChange={e=>onChange({...line.choices,[group.id]:e.target.value})}><option value="">{group.required?'Choose an option':'No extra / none'}</option>{group.options.map(o=><option key={o} value={o}>{o}{group.prices[o]?' (+'+money(group.prices[o])+')':''}</option>)}</select>}
     </div>;
   });
 }
 const edit=(index:number,patch:Partial<CartLine>)=>change(lines.map((l,i)=>i===index?{...l,...patch}:l));
 async function getChatItem(itemId:string):Promise<ChatDiningItem>{
   const r=await api({});
   const item=(r.menu as DiningMenu).items.find(x=>x.id===itemId);
   if(!r.menu.enabled||!item||!orderable(item))throw Error('This item is no longer available.');
   return {name:item.name,id:item.id,groups:modifierGroups(item),currency:r.menu.currency};
 }
 async function addChatItem(itemId:string,choices:Record<string,ModifierChoice>={},expected?:ChatDiningItem,quantity=1){
   if(busy||uncertain||submitting.current||chatAdding.current)throw Error('Please finish the current dining action first.');
   if(lines.length>=30)throw Error('Your cart is full. Review your selections first.');
   chatAdding.current=true;setBusy(true);const g=generation.current;
   try{
     const r=await api({});
     if(g!==generation.current)throw Error('Dining session changed. Please try again.');
     const item=(r.menu as DiningMenu).items.find(x=>x.id===itemId);
     if(!r.menu.enabled||!item||!orderable(item))throw Error('This item is no longer available.');
     if(expected&&JSON.stringify(expected.groups)!==JSON.stringify(modifierGroups(item)))throw Error('Preparation options changed. Please select the item again.');
     const checked=reviewCart(r.menu,[{itemId:item.id,quantity,choices}],1);
     if('error' in checked)throw Error(checked.error);
     setMenu(r.menu);setRoom(r.roomNumber);setReady(true);
     change([...lines,{itemId:item.id,quantity,choices}]);offerState.current.menu=r.menu;
     if(missing.current&&diningTargetMatches(r.menu,missing.current).some(x=>x.id===item.id))missing.current='';
     setCartOpen(true);setNotice(item.name+' added to your cart.');
     return item.name;
   }finally{chatAdding.current=false;if(g===generation.current)setBusy(false);}
 }
 async function chatCommand(command:CartCommand):Promise<string>{
   if(busy||submitting.current||chatAdding.current)throw Error('Please finish the current dining action first.');
   if(command.kind==='show')return lines.length?'Here are your current selections. Nothing has been submitted.':'Your dining cart is empty.';
   if(command.kind==='retry'){if(!uncertain||!quoteId)throw Error('There is no pending confirmation to retry.');return confirm();}
   if(uncertain)throw Error('Please retry the same confirmation or contact Front Desk before changing your order.');
   if(command.kind==='confirm'){if(missing.current)throw Error('Resolve the missing item before confirming.');if(!review||'error' in review||!quoteId)throw Error('Review your order and confirm the displayed subtotal first.');return confirm();}
   if(command.kind==='guests'){
     if(!Number.isInteger(command.count)||command.count<1||command.count>20)throw Error('Choose a dining party of 1–20.');
     setGuestCount(command.count);setReview(null);setQuoteId('');return 'Dining party updated to '+command.count+'.';
   }
   if(!lines.length)throw Error('Your dining cart is empty. Add a menu item first.');
   if(command.kind==='review'){
     if(missing.current)return 'Please resolve the missing item: '+missing.current+'. Tell me which item to add, or say “continue without it”.';
     if(!guestCount)return 'How many guests are dining? Enter a number of guests below or say “2 guests”.';
     return preview();
   }
   if(command.kind==='quantity'||command.kind==='remove'||command.kind==='choice'){
     const next=resolveCartEdit(menu,lines,command);
     if('error' in next)throw Error(next.error);
     change(next);return 'Your cart has been updated. Review the new subtotal before ordering.';
   }
   return 'Review your cart.';
 }
 async function tryExplicitAdd(text:string):Promise<string|null>{
   if(busy||uncertain||submitting.current||chatAdding.current)throw Error('Please finish the current dining action first.');
   const g=generation.current;
   const r=await api({});
   if(g!==generation.current)throw Error('Dining session changed. Please try again.');
   const p=simpleDiningProposal(r.menu,text);
   if(!p)return null;
   const item=(r.menu as DiningMenu).items.find(x=>x.id===p.itemId);
   if(!item||modifierGroups(item).length)return null;
   const name=await addChatItem(p.itemId,{},undefined,p.quantity);
   return p.quantity+' × '+name+' added to your cart. No order has been submitted.';
 }
 function nextChatOffer(){
   if(missing.current)return '';
   const offer=diningFollowup(offerState.current.menu,offerState.current.lines,offered.current);
   if(!offer)return 'Would you like anything else, or are you ready to review your order?';
   offered.current.push(offer.kind);return offer.text;
 }
 async function tryMissingItem(text:string):Promise<string>{
   if(busy||uncertain||submitting.current||chatAdding.current)throw Error('Please finish the current dining action first.');
   const target=missingDiningTarget(text);if(!target)return 'Please tell me which item is missing.';
   setReview(null);setQuoteId('');missing.current=target;
   const g=generation.current;const r=await api({});if(g!==generation.current)throw Error('Dining session changed.');
   const matches=diningTargetMatches(r.menu,target);
   const absent=matches.filter(x=>!lines.some(l=>l.itemId===x.id));
   if(matches.length===1&&absent.length===0){missing.current='';return matches[0].name+' is already in your cart. Please review your updated order.';}
   if(matches.length===1&&absent.length===1&&!modifierGroups(absent[0]).length){const name=await addChatItem(absent[0].id);missing.current='';return name+' added to your cart. Please review the updated order.';}
   return 'I have not added the missing item yet. '+(matches.length?'Which would you like? '+matches.map(x=>x.name).join(' / ')+'. Tell me “add” followed by the item name. ':'I could not find that exact item on the menu. Please check Dining or speak with staff. ')+'You can also say “continue without it”.';
 }
 function dismissMissingItem(){missing.current='';setReview(null);setQuoteId('');return 'Okay, we can continue with the items currently in your cart. Please review the order again.';}
 async function tryPreparationEdit(text:string):Promise<string|null>{
   if(busy||uncertain||submitting.current||chatAdding.current||!lines.length)return null;
   const command=cartPreparationReply(menu,lines,text);
   if(!command)return null;
   return chatCommand(command);
 }
 React.useImperativeHandle(ref,()=>({nextChatOffer,tryMissingItem,dismissMissingItem,tryExplicitAdd,tryPreparationEdit,chatCommand,addFromChat:(id)=>addChatItem(id),getChatItem,addCustomizedFromChat:(item,choices,quantity)=>addChatItem(item.id,choices,item,quantity)}));
 async function preview(){
   if(uncertain||submitting.current)return 'Please resolve the pending confirmation first.';
   if(missing.current){setError('Resolve the missing item before reviewing the order. Return to Chat.');return 'Please resolve the missing item before reviewing the order.';}
   const g=generation.current;setBusy(true);setError('');setReview(null);setQuoteId('');
   try{const r=await api({lines,guestCount});if(g===generation.current){setReview(r.review);setQuoteId(r.quoteId);setRoom(r.roomNumber);return 'Please review the order below. Confirm only if everything is correct.';}return 'Dining session changed.';}
   catch(e){const message=e instanceof Error?e.message:'Unable to review.';if(g===generation.current)setError(message);return message;}
   finally{if(g===generation.current)setBusy(false);}
 }
 async function confirm(){
   if(missing.current&&!uncertain)return 'Resolve the missing item before confirming.';
   if(!quoteId||submitting.current||(!review&&!uncertain))return 'Review your order before confirming.';
   submitting.current=true;setBusy(true);setError('');
   try{sessionStorage.setItem(pendingKey,quoteId);}catch{}
   setUncertain(true);
   try{
     const user=auth.currentUser;if(!user)throw Error('Sign in again.');
     const r=await fetch('/api/dining/guest/'+encodeURIComponent(hotelId),{method:'POST',headers:{Authorization:'Bearer '+await user.getIdToken(),'Content-Type':'application/json'},body:JSON.stringify({sessionId,confirmQuoteId:quoteId}),signal:AbortSignal.timeout(15000)});
     const data=await r.json().catch(()=>({}));
     if(!r.ok){
       if([400,409].includes(r.status)){setUncertain(false);setQuoteId('');setReview(null);try{sessionStorage.removeItem(pendingKey);}catch{}}
       throw Error(r.status===403?'Unable to verify order status. Contact the Front Desk before placing another order. Reference: D-'+quoteId.slice(0,12).toUpperCase():data.error||'Order submission could not be confirmed.');
     }
     if(!data.referenceCode)throw Error('Order confirmation unavailable.');
     setReceipt(data.referenceCode);offered.current=[];missing.current='';offerState.current.lines=[];setLines([]);setConfiguring(null);setReview(null);setQuoteId('');setUncertain(false);setNotice('Order submitted to Front Desk.');onSubmitted?.();try{sessionStorage.removeItem(pendingKey);}catch{}return 'Order #'+data.referenceCode+' submitted to Front Desk for processing. Staff will confirm final charges and delivery.';
   }catch(e){const message=e instanceof Error?e.message:'Submission could not be confirmed. Retry the same confirmation.';setError(message);return message;}
   finally{submitting.current=false;setBusy(false);}
 }
 return <section className={visible?"flex-1 min-h-0 flex flex-col":"hidden"}><div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
 <h2 className="text-lg font-bold">In-room dining</h2>
 <p className="text-sm text-slate-600">Choose your meal and confirm your order to send it to the Front Desk for processing.</p>
 {room&&<p className="text-xs text-slate-500">Current location: {room}</p>}
 <button type="button" disabled={busy||uncertain} onClick={()=>void refresh()} className="border rounded-lg px-3 py-2 text-xs">Refresh menu availability</button>
 {error&&<p role="alert" className="text-red-700 text-sm">{error}</p>}{receipt&&<div role="status" className="border border-emerald-300 bg-emerald-50 rounded p-3 text-sm">Order #{receipt} submitted to Front Desk. Staff will confirm final charges and delivery.</div>}{uncertain&&<div className="border border-amber-300 rounded p-3 text-sm">Submission needs confirmation. Do not create another order. <button type="button" disabled={busy} onClick={()=>void confirm()} className="underline font-bold">Retry same confirmation</button></div>}
 {!ready?<p>{busy?'Loading…':'Menu not confirmed. Refresh or contact staff.'}</p>:!menu.enabled?<p>Online room service is not currently available. Please contact the front desk.</p>:<fieldset disabled={busy||uncertain} className="space-y-4">
 <div className="flex flex-wrap gap-2">{['',...categories].map(c=><button key={c} type="button" onClick={()=>{setCategory(c);setCartOpen(false);setConfiguring(null);}} className={'border rounded-full px-3 py-1 text-xs '+(category===c?'bg-indigo-600 text-white':'bg-white')}>{c||'All'}</button>)}</div>
 {!cartOpen&&!configuring&&menu.items.filter(item=>!category||item.category===category).map(item=><div key={item.id} className="border rounded-xl p-3 bg-white space-y-1"><p className="text-xs text-slate-500">{item.category}</p><div className="flex justify-between gap-2"><strong>{item.name}</strong><span>{item.priceCents===null?'':money(item.priceCents)}</span></div><p className="text-sm">{item.description}</p>{item.allergens&&<p className="text-xs">Hotel-provided allergen information: {item.allergens}</p>}<button type="button" disabled={!orderable(item)||lines.length>=30} onClick={()=>add(item)} className="border rounded px-3 py-2 text-sm disabled:opacity-50">{item.soldOut?'Sold out':modifierGroups(item).length?'Customize & add':'Add to order'}</button>{lines.some(l=>l.itemId===item.id)&&<span className="ml-2 text-xs font-semibold text-indigo-700">{lines.filter(l=>l.itemId===item.id).reduce((n,l)=>n+l.quantity,0)} in cart</span>}</div>)}
 {configuring&&configItem&&!cartOpen&&<div className="border rounded-xl bg-white p-4 space-y-4">
 <div className="flex justify-between"><h3 className="font-bold">{configItem.name}</h3><button type="button" className="underline text-sm" onClick={()=>setConfiguring(null)}>Cancel</button></div>
 {choiceControls(configItem,configuring,choices=>setConfiguring({...configuring,choices}))}
 <label className="block text-sm">Quantity<select className="ml-2 border rounded p-1" value={configuring.quantity} onChange={e=>setConfiguring({...configuring,quantity:Number(e.target.value)})}>{Array.from({length:20},(_,i)=><option key={i}>{i+1}</option>)}</select></label>
 <button type="button" disabled={!configValid||lines.length>=30} onClick={()=>{if(!configValid)return;change([...lines,configuring]);setConfiguring(null);setNotice(configItem.name+' added to your cart.');}} className="w-full bg-indigo-600 text-white rounded-lg p-3 disabled:opacity-50">Add to order — {money(estimatedUnitCents(configItem,configuring)*configuring.quantity)}</button>
 </div>}
 {cartOpen&&<div className="space-y-3"><h3 className="font-bold">Your selections</h3><button type="button" onClick={()=>setCartOpen(false)} className="text-indigo-700 underline text-sm">Back to menu</button>{!lines.length&&<p>Your cart is empty.</p>}
 {lines.map((line,index)=>{const item=menu.items.find(x=>x.id===line.itemId);return <div key={index} className="border rounded-xl p-3 space-y-2"><div className="flex justify-between"><strong>{item?.name||'Unavailable item'}</strong><button type="button" className="text-red-700 text-sm" onClick={()=>change(lines.filter((_,i)=>i!==index))}>Remove</button></div>{(!item||!orderable(item))&&<p className="text-red-700 text-xs">No longer available. Remove or replace.</p>}<label className="block text-sm">Quantity<select className="ml-2 border rounded p-1" value={line.quantity} onChange={e=>edit(index,{quantity:Number(e.target.value)})}>{Array.from({length:20},(_,i)=><option key={i}>{i+1}</option>)}</select></label>{item&&choiceControls(item,line,choices=>edit(index,{choices}))}</div>})}
 <label className="block text-sm font-medium">How many guests are dining?<select value={guestCount} onChange={e=>{setGuestCount(Number(e.target.value));setReview(null);setQuoteId('');}} className="block w-full border rounded p-2 mt-1"><option value={0}>Select guest count</option>{Array.from({length:20},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</select></label>
 {!guestCount&&<p className="text-xs text-amber-800">Select the number of guests before reviewing your order.</p>}
 <p className="text-xs text-slate-600">For allergies or dietary concerns, confirm directly with hotel staff. Do not rely on this menu as a guarantee of allergen safety.</p>
 <button type="button" disabled={!lines.length||!guestCount} onClick={()=>void preview()} className="bg-indigo-600 text-white rounded-lg px-4 py-3 disabled:opacity-50">Review order</button>
 {review&&'subtotalCents' in review&&<div className="border rounded-xl p-4 space-y-2"><h3 className="font-bold">Confirm your order</h3><p>{review.guestCount} guests · {room||'Location not confirmed'}</p>{review.lines.map((l,i)=><div key={i} className="text-sm">{l.quantity} × {l.name} — {money(l.lineTotalCents)}{l.choices.map(c=><div key={c.question} className="text-xs">{c.question}: {c.answer}</div>)}</div>)}<p className="font-bold">Subtotal: {money(review.subtotalCents)}</p><p className="text-xs">Taxes, charges, availability and delivery subject to staff confirmation. No payment is collected here.</p><button type="button" disabled={busy||!quoteId} onClick={()=>void confirm()} className="w-full bg-indigo-600 text-white rounded-lg px-4 py-3 font-semibold">Confirm &amp; Place Order</button></div>}
 </div>}
 </fieldset>}
 </div>{ready&&menu.enabled&&<div className="shrink-0 border-t bg-white p-3 space-y-1"><p role="status" className="text-xs text-emerald-700 min-h-4">{notice}</p><button type="button" onClick={()=>{setConfiguring(null);setCartOpen(v=>!v);}} className="w-full bg-indigo-600 text-white rounded-lg px-4 py-3 flex justify-between font-semibold"><span>{cartOpen?"Back to menu":"View cart"} ({count})</span><span>{hasUnavailable?"Review items":money(subtotal)}</span></button><p className="text-xs text-slate-500">{hasUnavailable?"An item is unavailable. Review your cart.":"Estimated subtotal · not submitted"}</p></div>}
 </section>;
});
