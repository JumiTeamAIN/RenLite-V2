// Deliberately conservative: only complete, unambiguous English informational questions.
// No fuzzy match, no service fulfillment, no inferred translation.
export function directFaqAnswer(message:string,faqs:{question:string;answer:string}[]):string|null{
 const normalize=(v:string)=>v.toLowerCase().trim().replace(/[?!.]+$/,'').replace(/\s+/g,' ');
 if(typeof message!=='string'||message.length>300||!/^\s*(what|when|where|which|how much|how long|is|are|does|do)\b/i.test(message)||!/^[\x20-\x7e]+$/.test(message.trim()))return null;
 if(/\b(emergency|fire|hurt|injury|allerg\w*|unsafe|help|request|send|bring|deliver|need|complaint|refund|cancel|book|reserve|staff|manager|password|code|key)\b/i.test(message))return null;
 const matches=faqs.filter(f=>typeof f.question==='string'&&typeof f.answer==='string'&&normalize(f.question)===normalize(message)&&f.answer.trim());
 if(matches.length!==1)return null;
 return matches[0].answer.trim();
}
