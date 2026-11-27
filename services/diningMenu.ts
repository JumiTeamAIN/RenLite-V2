export type MenuItem={id:string;name:string;category:string;description:string;priceCents:number|null;available:boolean;modifiers:string[];upsells:string[];allergens:string};
export type DiningMenu={currency:string;enabled:boolean;items:MenuItem[]};
export const EMPTY_MENU:DiningMenu={currency:'USD',enabled:false,items:[]};
const clean=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length<=max&&!/[\u0000-\u001f\u007f\ufffd]/u.test(v)?v.trim():null;
export function parseDiningMenu(raw:unknown):DiningMenu|null{
 const v=raw as any;
 if(!v||typeof v.enabled!=='boolean'||typeof v.currency!=='string'||!/^[A-Z]{3}$/.test(v.currency)||!Array.isArray(v.items)||v.items.length>150)return null;
 const items:MenuItem[]=[];const ids=new Set<string>();const names=new Set<string>();
 for(const x of v.items){
   if(!x||typeof x.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(x.id)||ids.has(x.id))return null;
   const name=clean(x.name,150),category=clean(x.category,80),description=clean(x.description,500),allergens=clean(x.allergens,300);
   if(!name||!category||description===null||allergens===null||typeof x.available!=='boolean'||(x.priceCents!==null&&(!Number.isSafeInteger(x.priceCents)||x.priceCents<0||x.priceCents>1000000))||(x.available&&x.priceCents===null))return null;
   const key=(category+'|'+name).toLowerCase().replace(/\s+/g,' ');if(names.has(key))return null;
   if(!Array.isArray(x.modifiers)||x.modifiers.length>10||x.modifiers.some((m:unknown)=>!clean(m,150))||!Array.isArray(x.upsells)||x.upsells.length>10||x.upsells.some((m:unknown)=>typeof m!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(m)))return null;
   ids.add(x.id);names.add(key);items.push({id:x.id,name,category,description,allergens,priceCents:x.priceCents,available:x.available,modifiers:x.modifiers.map((m:string)=>m.trim()),upsells:[...new Set<string>(x.upsells)]});
 }
 if(items.some(x=>x.upsells.some(id=>id===x.id||!ids.has(id))))return null;
 if(v.enabled&&!items.some(x=>x.available))return null;
 return {currency:v.currency,enabled:v.enabled,items};
}
export type ExtractedMenuItem={name:string;category:string;description:string;priceCents:number|null};
export function parseMenuExtraction(raw:unknown):ExtractedMenuItem[]|null{
 if(!Array.isArray(raw)||raw.length>150)return null;
 const items:ExtractedMenuItem[]=[];
 for(const x of raw){
   const name=clean(x?.name,150),category=clean(x?.category,80),description=clean(x?.description,500);
   if(!name||!category||description===null||(x.priceCents!==null&&(!Number.isSafeInteger(x.priceCents)||x.priceCents<0||x.priceCents>1000000)))return null;
   items.push({name,category,description,priceCents:x.priceCents});
 }
 return items;
}
export function appendMenuDraft(existing:MenuItem[],incoming:ExtractedMenuItem[],id:()=>string){
 const key=(x:{name:string;category:string})=>(x.category+'|'+x.name).toLowerCase().trim().replace(/\s+/g,' ');
 const known=new Set(existing.map(key));const items=[...existing];let skipped=0;
 for(const x of incoming){if(known.has(key(x))){skipped++;continue;}if(items.length>=150)throw Error('Menu limit is 150 items. No items imported.');known.add(key(x));items.push({...x,id:id(),available:false,modifiers:[],upsells:[],allergens:''});}
 return {items,skipped};
}
