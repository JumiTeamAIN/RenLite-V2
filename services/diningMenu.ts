export type ModifierOption={label:string;priceCents:number};
export type ModifierGroup={id:string;question:string;required:boolean;minSelections?:number;maxSelections?:number;options:ModifierOption[]};
export type MenuItem={id:string;name:string;category:string;description:string;priceCents:number|null;available:boolean;soldOut?:boolean;modifiers:string[];modifierGroups?:ModifierGroup[];upsells:string[];allergens:string};
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
   if(!name||!category||description===null||allergens===null||typeof x.available!=='boolean'||(x.soldOut!==undefined&&typeof x.soldOut!=='boolean')||(x.priceCents!==null&&(!Number.isSafeInteger(x.priceCents)||x.priceCents<0||x.priceCents>1000000))||(x.available&&x.priceCents===null))return null;
   const key=(category+'|'+name).toLowerCase().replace(/\s+/g,' ');if(names.has(key))return null;
   if(!Array.isArray(x.modifiers)||x.modifiers.length>10||x.modifiers.some((m:unknown)=>!clean(m,150))||!Array.isArray(x.upsells)||x.upsells.length>10||x.upsells.some((m:unknown)=>typeof m!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(m)))return null;
   const groups:ModifierGroup[]=[];
   if(x.modifierGroups!==undefined){
     if(!Array.isArray(x.modifierGroups)||x.modifierGroups.length>10)return null;
     const groupIds=new Set<string>();
     for(const g of x.modifierGroups){
       if(!g||typeof g.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(g.id)||groupIds.has(g.id)||typeof g.required!=='boolean'||!Array.isArray(g.options)||!g.options.length||g.options.length>20)return null;
       const question=clean(g.question,150);if(!question)return null;
       const options:ModifierOption[]=[];const labels=new Set<string>();
       for(const o of g.options){
         const label=clean(o?.label,100);
         if(!label||labels.has(label.toLowerCase())||!Number.isSafeInteger(o.priceCents)||o.priceCents<0||o.priceCents>1000000)return null;
         labels.add(label.toLowerCase());options.push({label,priceCents:o.priceCents});
       }
       const min=g.minSelections===undefined?(g.required?1:0):g.minSelections;
       const max=g.maxSelections===undefined?1:g.maxSelections;
       if(!Number.isInteger(min)||!Number.isInteger(max)||min<0||max<1||min>max||max>options.length||g.required!==(min>0))return null;
       groupIds.add(g.id);groups.push({id:g.id,question,required:g.required,options,...(g.minSelections!==undefined||g.maxSelections!==undefined?{minSelections:min,maxSelections:max}:{})});
     }
   }
   ids.add(x.id);names.add(key);items.push({id:x.id,name,category,description,allergens,priceCents:x.priceCents,available:x.available,soldOut:x.soldOut===true,modifiers:x.modifiers.map((m:string)=>m.trim()),upsells:[...new Set<string>(x.upsells)],...(groups.length?{modifierGroups:groups}:{})});
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

export const orderable=(item:MenuItem)=>item.available&&!item.soldOut&&item.priceCents!==null;

export type ModifierSuggestion={question:string;required:boolean;options:string[]};
// Suggestions are deliberately separate from published modifiers: no price or availability claims.
export function parseModifierSuggestions(raw:unknown):ModifierSuggestion[]|null{
 if(!Array.isArray(raw)||raw.length>6)return null;
 const result:ModifierSuggestion[]=[],questions=new Set<string>();
 for(const g of raw){
   const question=clean(g?.question,150);
   if(!question||questions.has(question.toLowerCase())||typeof g.required!=='boolean'||!Array.isArray(g.options)||!g.options.length||g.options.length>12)return null;
   const options:string[]=[],seen=new Set<string>();
   for(const value of g.options){const label=clean(value,100);if(!label||seen.has(label.toLowerCase()))return null;seen.add(label.toLowerCase());options.push(label);}
   questions.add(question.toLowerCase());result.push({question,required:g.required,options});
 }
 return result;
}

// These are review-only drafts, never guest-visible or saved automatically.
export type LocalModifierDraft=ModifierSuggestion & {origin:'menu-text'|'template';evidence:string};
export function scanMenuChoices(item:Pick<MenuItem,'name'|'description'|'modifiers'|'modifierGroups'>):LocalModifierDraft[]{
 const drafts:LocalModifierDraft[]=[];
 const normalize=(s:string)=>s.toLowerCase().trim().replace(/\s+/g,' ');
 const existing=[...item.modifiers.map(m=>m.split('|').slice(1).map(normalize)),...(item.modifierGroups||[]).map(g=>g.options.map(o=>normalize(o.label)))];
 const add=(g:LocalModifierDraft)=>{
   const opts=g.options.map(normalize);
   if(existing.some(e=>opts.every(o=>e.includes(o)))||drafts.some(e=>opts.every(o=>e.options.map(normalize).includes(o))))return;
   drafts.push(g);
 };
 // Only short, literal alternatives inside a single comma/semicolon-delimited clause.
 // More complex prose and prices are left for AI or manual review.
 for(const clause of item.description.split(/[,;\n]/)){
   const evidence=clause.trim();
   if(!/\bor\b/i.test(evidence)||/[$€£\d]/.test(evidence))continue;
   const parts=evidence.replace(/^(?:served with|choice of|choose|with)\s+/i,'').split(/\s+or\s+/i).map(s=>s.trim().replace(/[.!?]$/,''));
   if(parts.length<2||parts.length>6||parts.some(s=>!s||s.length>70||s.split(/\s+/).length>7||! /^[\p{L}\p{M}\s&'-]+$/u.test(s)))continue;
   if(new Set(parts.map(normalize)).size!==parts.length)continue;
   add({question:parts.every(s=>/sauce|mustard|bbq|barbecue|ranch|ketchup|aioli/i.test(s))?'Which sauce would you prefer?':'Which option would you prefer?',required:true,options:parts,origin:'menu-text',evidence});
 }
 if(/\b(?:burger|steak|ribeye|sirloin|new york strip|filet mignon)\b/i.test(item.name)&&!/\b(?:vegan|vegetarian|plant[- ]based|chicken|turkey|fish|salmon|tuna|pork|ham|black bean|veggie)\b/i.test(item.name+' '+item.description)&&!existing.some(e=>e.some(o=>/\b(?:medium|rare|well done)\b/.test(o)))){
   add({question:'How would you like it cooked?',required:true,options:['Rare','Medium rare','Medium','Medium well','Well done'],origin:'template',evidence:'Suggested cooking temperatures; verify the kitchen policy and available options.'});
 }
 return drafts.slice(0,6);
}
export function verifiedModifierPrice(value:string):number|null{
 if(!/^\d{1,5}(?:\.\d{1,2})?$/.test(value)||Number(value)>10000)return null;
 return Math.round(Number(value)*100);
}
