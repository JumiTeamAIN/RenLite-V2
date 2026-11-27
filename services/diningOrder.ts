import {orderable,type DiningMenu,type MenuItem} from './diningMenu.ts';
export function diningIntent(text:string,items:MenuItem[]=[]):'dining'|'ambiguous'|'other'{
 const t=text.toLowerCase().replace(/[’]/g,"'").trim();
 if(/\b(clean|make up|service) (my|our|the) room\b|\b(my|our) room (cleaned|serviced)\b|\bhousekeeping\b/.test(t))return 'other';
 if(/\b(service in (my|our|the) room|room needs service)\b/.test(t))return 'ambiguous';
 if(/\b(room service|in[- ]room dining|order (food|dinner|lunch|breakfast|a burger|a steak|a cheeseburger))\b|\bservicio a la habitaci[oó]n\b|\bservice en chambre\b/.test(t)){
   if(/\b(hours|time|open|close|available|number|phone|cost|charge|fee)\b/.test(t)&&!/\b(order|menu|i would like|i want|i'd like)\b/.test(t))return 'other';
   return 'dining';
 }
 if(/\b(i (want|would like)|i'd like|can i (have|get|order)|please bring|order)\b/.test(t)&&items.some(x=>x.available&&x.name.length>=3&&t.includes(x.name.toLowerCase())))return 'dining';
 if(/\b(i (want|would like)|i'd like|can i (have|get|order)|please bring)\b.*\b(burger|cheeseburger|steak|pizza)\b/.test(t))return 'dining';
 return 'other';
}
export function modifierGroups(item:MenuItem){
 return item.modifiers.map((m,i)=>{const [question,...options]=m.split('|').map(s=>s.trim());return {id:String(i),question,options:[...new Set(options.filter(Boolean))]};});
}
export type CartLine={itemId:string;quantity:number;choices:Record<string,string>};
export function reviewCart(menu:DiningMenu,lines:CartLine[],guestCount:number){
 if(!menu.enabled||!Number.isInteger(guestCount)||guestCount<1||guestCount>20||!Array.isArray(lines)||!lines.length||lines.length>30)return {error:'Select available items and enter a dining party of 1–20.'} as const;
 const output=[];let subtotalCents=0;
 for(const line of lines){
   const item=menu.items.find(x=>x.id===line?.itemId);
   if(!item||!orderable(item))return {error:'An item is no longer available. Update your cart.'} as const;
   if(!Number.isInteger(line.quantity)||line.quantity<1||line.quantity>20||!line.choices||typeof line.choices!=='object'||Array.isArray(line.choices))return {error:'Invalid quantity or preparation choices.'} as const;
   const groups=modifierGroups(item);
   if(Object.keys(line.choices).length!==groups.length||groups.some(g=>!g.options.length||!g.options.includes(line.choices[g.id])))return {error:'Complete the hotel-approved preparation choices for '+item.name+'.'} as const;
   const lineTotal=item.priceCents!*line.quantity;subtotalCents+=lineTotal;
   output.push({itemId:item.id,name:item.name,quantity:line.quantity,unitPriceCents:item.priceCents!,lineTotalCents:lineTotal,choices:groups.map(g=>({question:g.question,answer:line.choices[g.id]}))});
 }
 return {subtotalCents,currency:menu.currency,guestCount,lines:output};
}
export function diningReply(menu:DiningMenu,text:string){
 const requested=menu.items.find(x=>x.available&&text.toLowerCase().includes(x.name.toLowerCase()));
 if(!menu.enabled)return 'Online room service ordering is not currently available. Please contact the front desk to confirm dining options. No order has been placed.';
 if(requested?.soldOut)return 'I’m sorry, '+requested.name+' is currently sold out. Please browse Dining for available alternatives. No order has been placed.';
 return 'I can help you browse our in-room dining menu. Open Dining to select how many guests are dining, choose your items and preparation options, and review your order. No order has been placed.';
}
