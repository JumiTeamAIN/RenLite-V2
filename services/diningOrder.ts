import {orderable,type DiningMenu,type MenuItem} from './diningMenu.ts';
// Match a full item name or an unambiguous menu-name phrase; never invent menu entries.
export function matchDiningItem(text:string,items:MenuItem[]):MenuItem|undefined{
 const normalize=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const query=' '+normalize(text)+' ';
 const candidates=items.filter(x=>x.available&&query.includes(' '+normalize(x.name)+' '));
 if(candidates.length===1)return candidates[0];
 if(candidates.length>1)return undefined;
 const words=normalize(text).split(' ').filter(w=>w.length>=4&&!['want','would','like','order','please','have','bring','food','breakfast','lunch','dinner','room','service'].includes(w));
 const partial=items.filter(x=>x.available&&words.some(w=>normalize(x.name).split(' ').includes(w)));
 return partial.length===1?partial[0]:undefined;
}
export function diningIntent(text:string,items:MenuItem[]=[]):'dining'|'ambiguous'|'other'{
 const t=text.toLowerCase().replace(/[’]/g,"'").trim();
 if(/\b(clean|make up|service) (my|our|the) room\b|\b(my|our) room (cleaned|serviced)\b|\bhousekeeping\b/.test(t))return 'other';
 if(/\b(service in (my|our|the) room|room needs service)\b/.test(t))return 'ambiguous';
 if(/\b(room service|in[- ]room dining|order (food|dinner|lunch|breakfast|a burger|a steak|a cheeseburger))\b|\bservicio a la habitaci[oó]n\b|\bservice en chambre\b/.test(t)){
   if(/\b(hours|time|open|close|available|number|phone|cost|charge|fee)\b/.test(t)&&!/\b(order|menu|i would like|i want|i'd like)\b/.test(t))return 'other';
   return 'dining';
 }
 if(/\b(something to drink|what (drinks|beverages)|drink options)\b/.test(t))return 'dining';
 if(/\b(i (want|would like|will take)|i'd like|i'll (take|have)|can i (have|get|order)|please bring|order)\b/.test(t)&&Boolean(matchDiningItem(t,items)))return 'dining';
 if(/\b(i (want|would like)|i'd like|can i (have|get|order)|please bring)\b.*\b(burger|cheeseburger|steak|pizza)\b/.test(t))return 'dining';
 return 'other';
}
export function modifierGroups(item:MenuItem){
 const legacy=item.modifiers.map((m,i)=>{const [question,...options]=m.split('|').map(s=>s.trim());return {id:String(i),question,required:true,minSelections:1,maxSelections:1,options:[...new Set(options.filter(Boolean))],prices:Object.fromEntries(options.filter(Boolean).map(o=>[o,0]))};});
 const advanced=(item.modifierGroups||[]).map(g=>({id:'custom-'+g.id,question:g.question,required:g.required,minSelections:g.minSelections??(g.required?1:0),maxSelections:g.maxSelections??1,options:g.options.map(o=>o.label),prices:Object.fromEntries(g.options.map(o=>[o.label,o.priceCents]))}));
 return [...legacy,...advanced];
}
export type ModifierChoice=string|string[];
export type CartLine={itemId:string;quantity:number;choices:Record<string,ModifierChoice>};
export function selectedOptions(value:unknown):string[]{return typeof value==='string'?(value?[value]:[]):Array.isArray(value)?value:[];}
export function validGroupChoice(group:ReturnType<typeof modifierGroups>[number],value:unknown){
 if(value!==undefined&&typeof value!=='string'&&!Array.isArray(value))return false;
 const options=selectedOptions(value);
 return options.length>=group.minSelections&&options.length<=group.maxSelections&&new Set(options).size===options.length&&options.every(o=>typeof o==='string'&&group.options.includes(o));
}
export function estimatedUnitCents(item:MenuItem,line:CartLine){
 return (item.priceCents??0)+modifierGroups(item).reduce((n,g)=>n+[...new Set(selectedOptions(line.choices[g.id]))].filter(o=>g.options.includes(o)).reduce((sum,o)=>sum+(g.prices[o]||0),0),0);
}
export function reviewCart(menu:DiningMenu,lines:CartLine[],guestCount:number){
 if(!menu.enabled||!Number.isInteger(guestCount)||guestCount<1||guestCount>20||!Array.isArray(lines)||!lines.length||lines.length>30)return {error:'Select available items and enter a dining party of 1–20.'} as const;
 const output=[];let subtotalCents=0;
 for(const line of lines){
   const item=menu.items.find(x=>x.id===line?.itemId);
   if(!item||!orderable(item))return {error:'An item is no longer available. Update your cart.'} as const;
   if(!Number.isInteger(line.quantity)||line.quantity<1||line.quantity>20||!line.choices||typeof line.choices!=='object'||Array.isArray(line.choices))return {error:'Invalid quantity or preparation choices.'} as const;
   const groups=modifierGroups(item);
   if(Object.keys(line.choices).some(k=>!groups.some(g=>g.id===k))||groups.some(g=>!validGroupChoice(g,line.choices[g.id])))return {error:'Complete the hotel-approved preparation choices for '+item.name+'.'} as const;
   const unitPriceCents=estimatedUnitCents(item,line);
   const lineTotal=unitPriceCents*line.quantity;subtotalCents+=lineTotal;
   output.push({itemId:item.id,name:item.name,quantity:line.quantity,unitPriceCents,lineTotalCents:lineTotal,choices:groups.filter(g=>selectedOptions(line.choices[g.id]).length>0).map(g=>{const selected=selectedOptions(line.choices[g.id]);const priceCents=selected.reduce((n,o)=>n+(g.prices[o]||0),0);return {question:g.question,answer:selected.join(', '),...(priceCents?{priceCents}:{})};})});
 }
 return {subtotalCents,currency:menu.currency,guestCount,lines:output};
}
export function diningReply(menu:DiningMenu,text:string){
 const requested=matchDiningItem(text,menu.items);
 const drinkInquiry=/\b(something to drink|what (drinks|beverages)|drink options)\b/i.test(text);
 if(!menu.enabled)return 'Online room service ordering is not currently available. Please contact the front desk to confirm dining options. No order has been placed.';
 if(requested?.soldOut)return 'I’m sorry, '+requested.name+' is currently sold out. Please browse Dining for available alternatives. No order has been placed.';
 const price=(item:MenuItem)=>menu.currency+' '+((item.priceCents??0)/100).toFixed(2);
 if(requested&&orderable(requested)){
   const groups=modifierGroups(requested);
   const options=groups.filter(g=>g.options.length).map(g=>g.question+(g.maxSelections>1?' (choose '+g.minSelections+'–'+g.maxSelections+')':g.required?' (required)':' (optional)')+': '+g.options.map(o=>o+(g.prices[o]?' (+'+menu.currency+' '+(g.prices[o]/100).toFixed(2)+')':'')).join(' or ')).join('; ');
   const extra=menu.items.find(x=>requested.upsells.includes(x.id)&&orderable(x));
   return 'Certainly! Our '+requested.name+' is '+price(requested)+'. '+(requested.description?requested.description+' ':'')+(options?'We offer these preparation choices: '+options+'. ':'')+(extra?'Would '+extra.name+' ('+price(extra)+') go well with your meal? ':'')+'Use the Add to cart button below, or open Dining to customize your selections and confirm your order when ready. No order has been placed.';
 }
 if(drinkInquiry){const drinks=menu.items.filter(x=>orderable(x)&&/drink|beverage|juice|coffee|tea/i.test(x.category)).slice(0,6);if(drinks.length)return 'Certainly! We have '+drinks.map(x=>x.name+' ('+price(x)+')').join(', ')+'. Which would you prefer?';}
 const categories=[...new Set(menu.items.filter(orderable).map(x=>x.category))].slice(0,5);
 return 'Of course! I’d be happy to help with in-room dining. '+(categories.length?'We have '+categories.join(', ')+'. ':'')+'What are you in the mood for? You can also browse Dining and confirm your order there. No order has been placed.';
}

// Model output is a proposal, never a cart mutation or order confirmation.
export type DiningProposal={itemId:string;name:string;quantity:number;choices:Record<string,ModifierChoice>};
export function validateDiningProposals(menu:DiningMenu,raw:unknown):DiningProposal[]|null{
 if(!menu.enabled||!Array.isArray(raw)||raw.length<1||raw.length>5)return null;
 const proposals:DiningProposal[]=[];
 for(const line of raw){
   const item=menu.items.find(x=>x.id===line?.itemId&&orderable(x));
   if(!item||!Number.isInteger(line.quantity)||line.quantity<1||line.quantity>20||!line.choices||typeof line.choices!=='object'||Array.isArray(line.choices))return null;
   const groups=modifierGroups(item),choices:Record<string,ModifierChoice>={};
   for(const [id,value] of Object.entries(line.choices)){
     const group=groups.find(g=>g.id===id);
     if(!group||!validGroupChoice(group,value))return null;
     const selected=selectedOptions(value);
     if(selected.length)choices[id]=group.maxSelections>1?selected:selected[0];
   }
   proposals.push({itemId:item.id,name:item.name,quantity:line.quantity,choices});
 }
 return proposals;
}
export function contextualDiningIntent(text:string,transcript:string,items:MenuItem[]){
 const t=text.toLowerCase().replace(/’/g,"'").trim();
 if(/\b(?:help|emergency|allerg(?:y|ic|ies|en)|chok(?:e|ing)|manager|staff|front desk|complaint|refund|towel|housekeeping|clean|repair|broken|not working|cancel|remove|change|replace|instead|no longer|don't|do not|without)\b/i.test(t))return false;
 if(diningIntent(text,items)==='dining')return true;
 const normalize=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const exact=items.some(x=>orderable(x)&&(' '+normalize(text)+' ').includes(' '+normalize(x.name)+' '));
 const explicit=/\b(?:i(?:'d| would) like|i want|i'll (?:take|have)|can i (?:have|get|order)|please bring|order|add)\b/.test(t);
 if(exact&&explicit)return true;
 const prior=transcript.split('\n').filter(l=>l.startsWith('Guest: ')).slice(-4,-1);
 return Boolean(exact&&prior.some(l=>diningIntent(l.slice(7),items)==='dining')&&t.length<=120&&!/[?]/.test(t));
}
export function diningProposalReply(menu:DiningMenu,proposals:DiningProposal[]){
 const parts=proposals.map(p=>{
   const item=menu.items.find(x=>x.id===p.itemId)!;
   const groups=modifierGroups(item);
   const selected=groups.flatMap(g=>selectedOptions(p.choices[g.id]));
   const price=estimatedUnitCents(item,{itemId:p.itemId,quantity:p.quantity,choices:p.choices})*p.quantity;
   return p.quantity+' × '+item.name+(selected.length?' ('+selected.join(', ')+')':'')+' — '+menu.currency+' '+(price/100).toFixed(2);
 });
 return 'Certainly! Here are the selections I understood: '+parts.join('; ')+'. Review each selection below and complete any remaining preparation choices. Nothing has been added or submitted yet.';
}
