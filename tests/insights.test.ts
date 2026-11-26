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
