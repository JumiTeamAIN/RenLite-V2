import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateROI, elapsed, mean, inPeriod, responseCompliance } from '../services/insightsMath';
const t=(n:number)=>({toMillis:()=>n});
test('ROI counts only displaced intake time and prorates expense',()=>{
 const r=estimateROI(120,2,50,24,120,30);
 assert.deepEqual(r,{hours:2,value:48,expense:120,net:-72,roi:-60});
 assert.equal(estimateROI(120,2,50,24,120,7).expense,28);
});
test('zero costs and zero activity do not produce infinity',()=>{
 assert.equal(estimateROI(0,2,50,22,149,30).roi,-100);
 assert.equal(estimateROI(100,2,50,22,0,30).roi,null);
 assert.equal(estimateROI(100,2,0,22,149,30).hours,0);
});
test('invalid assumptions rejected',()=>{
 assert.throws(()=>estimateROI(1,2,101,22,149,30));
 assert.throws(()=>estimateROI(1,2,50,22,149,0));
 assert.throws(()=>estimateROI(NaN,2,50,22,149,30));
});
test('missing and reversed timestamps excluded; zero duration retained',()=>{
 assert.equal(elapsed(t(0),t(60000)),1);
 assert.equal(elapsed(t(60000),t(0)),null);
 assert.equal(elapsed(undefined,t(0)),null);
 assert.equal(mean([null,0,4]),2);
 assert.equal(mean([null]),null);
});
test('period boundaries inclusive; future and missing excluded',()=>{
 const now=10*86400000;
 assert.equal(inPeriod(t(now-7*86400000),now,7),true);
 assert.equal(inPeriod(t(now-7*86400000-1),now,7),false);
 assert.equal(inPeriod(t(now+1),now,7),false);
 assert.equal(inPeriod(undefined,now,7),false);
});

test('response targets distinguish late, overdue, missing evidence and excluded departments',()=>{
 const base={department:'Housekeeping',createdAt:t(0),status:'pending'};
 const rows=[{...base,acknowledgedAt:t(600000)},{...base,acknowledgedAt:t(960000)},base,{...base,createdAt:t(1140000)},{...base,status:'completed'},{...base,department:'Security'},{...base,status:'cancelled'}];
 const r=responseCompliance(rows,{housekeeping:15,maintenance:30,front_desk:5},1200000);
 assert.deepEqual(r,{met:1,late:1,overdue:1,pending:1,unknown:1,excluded:2,rate:100/3});
 assert.equal(responseCompliance([base],null,1200000).rate,null);
});

import { directFaqAnswer } from '../services/directFaq.ts';
test('exact configured FAQ bypass only for unambiguous informational questions',()=>{
 const f=[{question:'What time is breakfast?',answer:'6:30 AM to 10 AM.'}];
 assert.equal(directFaqAnswer('WHAT time is breakfast!',f),'6:30 AM to 10 AM.');
 assert.equal(directFaqAnswer('What time is breakfast? I need towels',f),null);
 assert.equal(directFaqAnswer('What time is breakfast?', [...f,...f]),null);
 assert.equal(directFaqAnswer('Where is the fire exit?',[{question:'Where is the fire exit?',answer:'Lobby'}]),null);
 assert.equal(directFaqAnswer('¿A qué hora es el desayuno?',f),null);
});

import { DEFAULT_MODEL_POLICY, parseModelPolicy, candidateModels, courtesyReply } from '../services/modelPolicy.ts';
test('model policy defaults to only tested model and never retries a cooling candidate',()=>{
 assert.deepEqual(candidateModels(DEFAULT_MODEL_POLICY,'concierge',()=>false),['gemini-2.5-flash']);
 assert.deepEqual(candidateModels(DEFAULT_MODEL_POLICY,'search',()=>true),[]);
 assert.deepEqual(candidateModels({...DEFAULT_MODEL_POLICY,enabled:false},'translation',()=>false),[]);
 assert.deepEqual(candidateModels({...DEFAULT_MODEL_POLICY,fallback:'gemini-3.5-flash-lite'},'concierge',m=>m==='gemini-2.5-flash'),['gemini-3.5-flash-lite']);
 assert.equal(parseModelPolicy({...DEFAULT_MODEL_POLICY,search:'arbitrary-model'}),null);
 assert.equal(parseModelPolicy({...DEFAULT_MODEL_POLICY,enabled:'false'}),null);
 assert.ok(courtesyReply('Thank you!'));
 assert.equal(courtesyReply('Thanks, but I need a towel'),null);
});

import {DEFAULT_BUDGET,parseBudget,attemptDebit,estimateTokenDollars} from '../services/aiBudget.ts';
test('attempt allowance rejects exhausted budgets and disabled search',()=>{
 assert.equal(attemptDebit(DEFAULT_BUDGET,'concierge',474),1);
 assert.equal(attemptDebit(DEFAULT_BUDGET,'concierge',475),null);
 assert.equal(attemptDebit(DEFAULT_BUDGET,'probe-search',471),null);
 assert.equal(attemptDebit({...DEFAULT_BUDGET,searchEnabled:false},'search',0),null);
 assert.equal(attemptDebit({...DEFAULT_BUDGET,monthlyCents:0},'translate',0),null);
 assert.equal(attemptDebit(DEFAULT_BUDGET,'search',NaN),null);
 assert.equal(parseBudget({monthlyCents:501,searchEnabled:true}),null);
 assert.equal(estimateTokenDollars({model:'unknown'}),null);
 assert.ok(Math.abs(estimateTokenDollars({model:'gemini-3.5-flash-lite',inputTokens:1000000,outputTokens:1000000,thinkingTokens:1000000})!-5.3)<1e-9);
});

import {parseUploadedFaqs} from '../services/faqImport.ts';
test('FAQ imports reject unsupported and binary files',()=>{
 assert.throws(()=>parseUploadedFaqs('Q: Parking?\nA: $15','FAQ.docx'));
 assert.throws(()=>parseUploadedFaqs('PK\u0003\u0004bad','FAQ.txt'));
 assert.throws(()=>parseUploadedFaqs('bad\ufffd|answer','FAQ.csv'));
 assert.deepEqual(parseUploadedFaqs('[{"question":"How much is parking?","answer":"$15 plus tax"}]','FAQ.JSON'),[{question:'How much is parking?',answer:'$15 plus tax'}]);
 assert.deepEqual(parseUploadedFaqs('question,answer\nPool?,Sunup to Sundown','FAQ.csv'),[{question:'Pool?',answer:'Sunup to Sundown'}]);
 assert.deepEqual(parseUploadedFaqs('Q: Breakfast?\nA: $25 plus tax and gratuity','FAQ.txt'),[{question:'Breakfast?',answer:'$25 plus tax and gratuity'}]);
});

import {structuredTextFaqs,reviewFaqs,extractFaqFile} from '../services/documentFaq.ts';
test('structured document questions preserve exact answers and skip duplicate or conflicting questions',()=>{
 const pairs=structuredTextFaqs('FAQ’s\nHow much is parking?\n$15 plus tax\nHow much is breakfast?\n$25 plus tax and gratuity\nWhat are the hours for the pool?\nSunup to Sundown');
 assert.equal(pairs.length,3);assert.equal(pairs[2].answer,'Sunup to Sundown');
 const review=reviewFaqs([pairs[0]], [...pairs,{question:'HOW MUCH IS PARKING',answer:'Free'}]);
 assert.equal(review.accepted.length,2);assert.equal(review.duplicates,1);assert.equal(review.conflicts,1);
});
test('Excel FAQ extraction reads question and answer columns',async()=>{
 const excel=await import('exceljs');const Workbook=excel.Workbook||excel.default?.Workbook;const wb=new Workbook();const sheet=wb.addWorksheet('FAQs');sheet.addRow(['Question','Answer']);sheet.addRow(['Parking?','$15 plus tax']);const bytes=await wb.xlsx.writeBuffer();
 const pairs=await extractFaqFile(new File([new Uint8Array(bytes)],'FAQ.xlsx'));
 assert.deepEqual(pairs,[{question:'Parking?',answer:'$15 plus tax'}]);
});

import {compareRequests,outstandingPriorities,compareSessions,newUrgentIds} from '../services/priorityOperations.ts';
test('priority operations keep unresolved urgent requests ahead of newer routine requests and completed history',()=>{
 const make=(id:string,priority:string,status:string,time:number,sessionId='s')=>({id,priority,status,sessionId,createdAt:{toMillis:()=>time}} as any);
 const records=[make('normal','normal','pending',1),make('high-new','high','pending',8),make('urgent-done','urgent','completed',9),make('urgent','urgent','in_progress',7),make('high-old','high','acknowledged',2),make('cancelled','urgent','cancelled',10)];
 assert.deepEqual([...records].sort(compareRequests).map(r=>r.id),['urgent','high-old','high-new','normal','cancelled','urgent-done']);
 assert.equal(outstandingPriorities(records).get('s'),2);
 assert.equal(outstandingPriorities(records.filter(r=>r.id!=='urgent')).get('s'),1);
 assert.deepEqual(newUrgentIds(new Set(['urgent']),records),[]);
 assert.deepEqual(newUrgentIds(new Set(),records),['urgent']);
 const read={id:'s',status:'staff_controlled',isUnread:false,lastUpdatedAt:{toMillis:()=>1}} as any;
 const recent={id:'other',status:'active',isUnread:true,lastUpdatedAt:{toMillis:()=>99}} as any;
 assert.ok(compareSessions(read,recent,outstandingPriorities(records))<0);
 assert.ok(compareSessions(read,recent,outstandingPriorities([]))>0);
});

import {parseDiningMenu,parseMenuExtraction,appendMenuDraft,EMPTY_MENU} from '../services/diningMenu.ts';
test('menu extraction rejects guessed invalid prices and imports disabled drafts without overwriting',()=>{
 const source=[{name:'Burger',category:'Entrees',description:'With fries',priceCents:2200},{name:'Steak',category:'Entrees',description:'',priceCents:null}];
 assert.deepEqual(parseMenuExtraction(source),source);
 assert.equal(parseMenuExtraction([{...source[0],priceCents:22.2}]),null);
 const result=appendMenuDraft([],source,(()=>{let n=0;return()=>String(++n)})());
 assert.equal(result.items.length,2);assert.ok(result.items.every(x=>!x.available));
 const again=appendMenuDraft(result.items,[{...source[0],priceCents:100}],()=> 'new');
 assert.equal(again.skipped,1);assert.equal(again.items[0].priceCents,2200);
 assert.ok(parseDiningMenu({...EMPTY_MENU,items:result.items}));
 assert.equal(parseDiningMenu({...EMPTY_MENU,enabled:true,items:result.items}),null);
 assert.equal(parseDiningMenu({...EMPTY_MENU,items:[{...result.items[1],available:true}]}),null);
 assert.equal(parseDiningMenu({...EMPTY_MENU,items:[{...result.items[0],upsells:['unknown']}]}),null);
});

import {diningIntent,diningReply,reviewCart} from '../services/diningOrder.ts';
test('dining entry is separate from housekeeping and cart review rejects unavailable or incomplete items',()=>{
 const burger={id:'burger',name:'Angus Burger',category:'Entrees',description:'',priceCents:2200,available:true,modifiers:['Cooking temperature | Medium | Well done'],upsells:[],allergens:''};
 const menu={currency:'USD',enabled:true,items:[burger]};
 assert.equal(diningIntent('I would like room service.'),'dining');
 assert.equal(diningIntent('Can you service my room?'),'other');
 assert.equal(diningIntent('I need service in my room.'),'ambiguous');
 assert.equal(diningIntent('What time does room service open?'),'other');
 assert.equal(diningIntent('I would like an Angus Burger',menu.items),'dining');
 assert.match(diningReply({...menu,enabled:false},'room service'),/No order has been placed/);
 assert.match(diningReply({...menu,items:[{...burger,soldOut:true}]},'Angus Burger'),/sold out/);
 const line={itemId:'burger',quantity:2,choices:{'0':'Medium'}};
 assert.equal(reviewCart(menu,[line],2).subtotalCents,4400);
 assert.ok('error' in reviewCart(menu,[{...line,choices:{}}],2));
 assert.ok('error' in reviewCart(menu,[{...line,choices:{'0':'Raw'}}],2));
 assert.ok('error' in reviewCart({...menu,items:[{...burger,soldOut:true}]},[line],2));
 assert.ok('error' in reviewCart(menu,[line],0));
});
