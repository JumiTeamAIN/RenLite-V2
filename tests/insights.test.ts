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
