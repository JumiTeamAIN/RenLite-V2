// Narrow deterministic fallback for ordinary water requests; not an authorization for charges.
export function waterRequest(text:string){
 const t=text.toLowerCase().trim().replace(/[.!?]+$/,'').trim();
 const en=t.match(/^(?:(?:i (?:want|need|would like)|(?:please )?(?:bring|send|deliver)(?: me)?|(?:can|could|may) i (?:have|get)|(?:can|could) you bring me)\s+)(?:(\d{1,2}|a|one|two|three|four|five|six)\s+)?(?:bottles? of water|bottled water|water)(?:\s+(?:please|to my room))?$/);
 const ceb=t.match(/^(?:gusto ko og|gusto ko ug|gusto ko'g|palihog)\s+(?:(duha|doha|usa)\s+(?:ka\s+)?botelya sa\s+)?tubig(?:\s+palihog)?$/);
 const es=t.match(/^(?:quiero|necesito|(?:me )?puede traer|(?:me )?podría traer)\s+(?:(una|dos|tres|\d{1,2})\s+botellas? de\s+)?agua(?:\s+por favor)?$/);
 if(!en&&!ceb&&!es)return null;
 const raw=(en||ceb||es)![1]||'one';
 const nums:Record<string,number>={a:1,one:1,two:2,three:3,four:4,five:5,six:6,usa:1,duha:2,doha:2,una:1,dos:2,tres:3};
 const quantity=nums[raw]??Number(raw);if(!Number.isInteger(quantity)||quantity<1||quantity>50)return null;
 const language=ceb?'ceb':es?'es':'en';
 return {language,quantity,item:'Bottled water',category:'Housekeeping',department:'Housekeeping',description:'Guest requested '+quantity+' bottle(s) of water. Staff confirms availability and any charges.',priority:'normal' as const};
}
export const OPEN_SERVICE_STATES=['pending','acknowledged','in_progress','escalated','reopened'];
export type ServiceTarget={id:string;referenceCode?:string;item:string;status:string;category?:string;diningOrder?:unknown;priority?:string};
const norm=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function serviceFollowup(text:string){
 const t=text.trim();
 // First clause can be a follow-up while the remaining clause is a separate request.
 const m=t.match(/^(?:where (?:is|are)|what(?:'s| is) the status of|any update on|when (?:will|can) (?:i|we) (?:get|receive)|(?:i am|i'm|we are|we're) still waiting for|(?:i|we) (?:still )?haven't (?:received|gotten))\s+(?:my |our |the )?([^?!.]+)([?!.]?)(.*)$/i);
 if(!m)return null;
 const target=m[1].trim().replace(/\s+(?:yet|arrive|be delivered)$/i,'');
 return target?{target,pure:!m[3].trim()}:null;
}
export function matchServiceTarget<T extends ServiceTarget>(rows:T[],target:string):T[]{
 const q=norm(target);if(!q)return [];
 const exact=rows.filter(r=>norm(r.referenceCode||'')===q||norm(r.item)===q);if(exact.length)return exact;
 if(/^(?:order|room service(?: order)?|in room dining(?: order)?|food(?: order)?|meal(?: order)?)$/.test(q))return rows.filter(r=>Boolean(r.diningOrder));
 const words=q.split(' ').filter(w=>!['my','our','the','fresh','extra','additional','some','bottles','bottle','of','room','request','service','sets','set','two','a','an'].includes(w));
 if(!words.length)return [];
 return rows.filter(r=>{const n=' '+norm(r.item)+' ';return words.every(w=>n.includes(' '+w+' ')||n.includes(' '+w.replace(/s$/,'')+' ')||n.includes(' '+w+'s '));});
}
export function serviceStatus(status:string,dining:boolean){
 if(status==='pending')return 'awaiting staff acknowledgment';
 if(status==='acknowledged')return 'acknowledged by staff';
 if(status==='in_progress')return dining?'entered into the hotel ordering system; delivery is not yet confirmed':'in progress';
 if(status==='completed')return 'marked complete by staff';
 if(status==='cancelled')return 'cancelled';
 return status==='escalated'||status==='reopened'?'flagged for staff attention':'status not confirmed';
}
