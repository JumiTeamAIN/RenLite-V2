// Only explicitly supported candidate IDs; availability must be tested with deployment credentials.
export const MODEL_IDS=['gemini-2.5-flash','gemini-3.5-flash-lite','gemini-3.8-flash','gemini-3.1-flash-lite','gemini-4-hydrogen'] as const;
export type ModelId=typeof MODEL_IDS[number];
export type ModelPolicy={enabled:boolean;concierge:ModelId;search:ModelId;translation:ModelId;fallback:ModelId|null};
export const DEFAULT_MODEL_POLICY:ModelPolicy={enabled:true,concierge:'gemini-2.5-flash',search:'gemini-2.5-flash',translation:'gemini-2.5-flash',fallback:null};
export const validModel=(v:unknown):v is ModelId=>typeof v==='string'&&(MODEL_IDS as readonly string[]).includes(v);
export function parseModelPolicy(v:any):ModelPolicy|null{
 if(!v||typeof v.enabled!=='boolean'||!validModel(v.concierge)||!validModel(v.search)||!validModel(v.translation)||(v.fallback!==null&&!validModel(v.fallback)))return null;
 return {enabled:v.enabled,concierge:v.concierge,search:v.search,translation:v.translation,fallback:v.fallback};
}
export function candidateModels(p:ModelPolicy,operation:'concierge'|'search'|'translation',cooling:(m:ModelId)=>boolean):ModelId[]{
 if(!p.enabled)return [];
 return [...new Set([p[operation],...(p.fallback?[p.fallback]:[])])].filter(m=>!cooling(m));
}
export function courtesyReply(message:string):string|null{
 const m=message.trim().toLowerCase().replace(/[.!?]+$/,'').replace(/\s+/g,' ');
 return ['thank you','thanks','thanks so much','thank you very much','many thanks'].includes(m)?'You’re very welcome! Please let us know if you need anything else.':null;
}
