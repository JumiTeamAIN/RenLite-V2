import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, Timestamp, serverTimestamp, query, where, runTransaction } from 'firebase/firestore';
let env;
const config = {name:'Test hotel',persona:'Helpful',faqs:[],slas:{housekeeping:15,maintenance:30,front_desk:5}};
const claims = {email_verified:true,firebase:{sign_in_provider:'password'}};
const db = (uid, token=claims) => env.authenticatedContext(uid,token).firestore();
before(async()=>{
  env=await initializeTestEnvironment({projectId:'demo-renlite-test',firestore:{rules:readFileSync('firestore.rules','utf8')}});
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx=>{
    const d=ctx.firestore();
    for(const h of ['ownerA','ownerB','test-hotel-001']){
      await setDoc(doc(d,'hotels',h),config);
      await setDoc(doc(d,'hotels',h,'sessions','session1'),{guestUid:'guestA',guestAccessStartedAt:Timestamp.now(),lastUpdatedAt:Timestamp.now(),previewText:'Test',isUnread:false,status:'active'});
    }
    for(const [uid,role,active] of [['agent','associate',true],['manager','manager',true],['inactive','associate',false]]){
      await setDoc(doc(d,'hotels','ownerA','members',uid),{uid,role,active});
    }
  });
});
after(async()=>{await env?.cleanup();});
test('staff reads own hotel sessions, not another hotel',async()=>{
  await assertSucceeds(getDocs(collection(db('agent'),'hotels','ownerA','sessions')));
  await assertFails(getDocs(collection(db('agent'),'hotels','ownerB','sessions')));
  await assertFails(getDoc(doc(db('agent'),'hotels','ownerB','sessions','session1')));
});
test('associate cannot change settings; manager can',async()=>{
  await assertFails(updateDoc(doc(db('agent'),'hotels','ownerA'),{name:'Changed'}));
  await assertSucceeds(updateDoc(doc(db('manager'),'hotels','ownerA'),{name:'Changed'}));
});
test('inactive and unverified members cannot read sessions',async()=>{
  await assertFails(getDoc(doc(db('inactive'),'hotels','ownerA','sessions','session1')));
  await assertFails(getDoc(doc(db('agent',{...claims,email_verified:false}),'hotels','ownerA','sessions','session1')));
});
test('client cannot create or promote membership',async()=>{
  await assertFails(setDoc(doc(db('agent'),'hotels','ownerA','members','agent'),{role:'admin',active:true}));
  await assertFails(setDoc(doc(db('ownerA'),'hotels','ownerA','members','new'),{role:'manager',active:true}));
});
test('guest can read own session but another guest cannot',async()=>{
  const guest={firebase:{sign_in_provider:'anonymous'}};
  await assertSucceeds(getDoc(doc(db('guestA',guest),'hotels','ownerA','sessions','session1')));
  await assertFails(getDoc(doc(db('guestB',guest),'hotels','ownerA','sessions','session1')));
});
test('sandbox operator cannot read private customer session',async()=>{
  const operator=db('operator',{...claims,email:'jumi@teamain.org'});
  await assertSucceeds(getDocs(collection(operator,'hotels','test-hotel-001','sessions')));
  await assertFails(getDoc(doc(operator,'hotels','ownerA','sessions','session1')));
});
test('anonymous user cannot provision a hotel',async()=>{
  await assertFails(setDoc(doc(db('anon',{firebase:{sign_in_provider:'anonymous'}}),'hotels','anon'),config));
});
test('owner can provision their own hotel',async()=>{
  await assertSucceeds(setDoc(doc(db('newOwner'),'hotels','newOwner'),config));
});

test('expired and ended guest sessions deny messages and requests while staff retains access',async()=>{
 const guest=db('guestA',{firebase:{sign_in_provider:'anonymous'}}), staff=db('agent');
 await env.withSecurityRulesDisabled(async ctx=>{
   const d=ctx.firestore();
   for(const id of ['expired','ended','fresh','legacy']){
     const session={guestUid:'guestA',lastUpdatedAt:Timestamp.now(),previewText:'Private',isUnread:false,status:'active'};
     if(id!=='legacy')session.guestAccessStartedAt=Timestamp.fromMillis(Date.now()-(id==='expired'?25*3600000:1000));
     if(id==='ended')session.guestEndedAt=Timestamp.now();
     await setDoc(doc(d,'hotels','ownerA','sessions',id),session);
     await setDoc(doc(d,'hotels','ownerA','sessions',id,'messages','msg'),{guestUid:'guestA',sender:'guest',text:'Private',timestamp:Timestamp.now()});
     await setDoc(doc(d,'hotels','ownerA','requests',id),{guestUid:'guestA',sessionId:id,status:'pending'});
   }
 });
 for(const id of ['expired','ended','legacy']){
   await assertFails(getDoc(doc(guest,'hotels','ownerA','sessions',id)));
   await assertFails(getDoc(doc(guest,'hotels','ownerA','sessions',id,'messages','msg')));
   await assertFails(getDocs(query(collection(guest,'hotels','ownerA','sessions',id,'messages'),where('guestUid','==','guestA'))));
   await assertFails(getDoc(doc(guest,'hotels','ownerA','requests',id)));
   await assertSucceeds(getDoc(doc(staff,'hotels','ownerA','requests',id)));
   await assertSucceeds(getDoc(doc(staff,'hotels','ownerA','sessions',id,'messages','msg')));
 }
 await assertSucceeds(getDocs(query(collection(guest,'hotels','ownerA','requests'),where('guestUid','==','guestA'),where('sessionId','==','fresh'))));
 await assertFails(updateDoc(doc(guest,'hotels','ownerA','sessions','fresh'),{guestAccessStartedAt:serverTimestamp(),lastUpdatedAt:serverTimestamp()}));
 await assertSucceeds(updateDoc(doc(guest,'hotels','ownerA','sessions','fresh'),{guestEndedAt:serverTimestamp(),lastUpdatedAt:serverTimestamp()}));
 await assertFails(getDoc(doc(guest,'hotels','ownerA','sessions','fresh')));
});

test('staff-moved room cannot be overwritten and stale guest delivery is rejected',async()=>{
 const guest=db('guestA',{firebase:{sign_in_provider:'anonymous'}});
 await env.withSecurityRulesDisabled(async ctx=>{
   await setDoc(doc(ctx.firestore(),'hotels','ownerA','sessions','moved'),{guestUid:'guestA',guestAccessStartedAt:Timestamp.now(),roomMoveAt:Timestamp.now(),roomNumber:'205',lastUpdatedAt:Timestamp.now(),previewText:'Moved',isUnread:false,status:'active'});
 });
 const session=doc(guest,'hotels','ownerA','sessions','moved');
 await assertFails(updateDoc(session,{roomNumber:'101',lastUpdatedAt:serverTimestamp()}));
 await assertSucceeds(updateDoc(session,{previewText:'Hello',lastUpdatedAt:serverTimestamp()}));
 const request=(roomNumber)=>({guestUid:'guestA',sessionId:'moved',item:'Towels',category:'Housekeeping',roomNumber,status:'pending',createdAt:serverTimestamp(),lastUpdated:serverTimestamp()});
 await assertFails(setDoc(doc(guest,'hotels','ownerA','requests','stale-room'),request('101')));
 await assertSucceeds(setDoc(doc(guest,'hotels','ownerA','requests','new-room'),request('205')));
 await assertFails(getDoc(doc(db('guestB',{firebase:{sign_in_provider:'anonymous'}}),'hotels','ownerA','sessions','moved')));
});

test('guest outage handoff and fallback notice can commit together; staff sees unread conversation',async()=>{
 const guest=db('guestA',{firebase:{sign_in_provider:'anonymous'}});
 const session=doc(guest,'hotels','ownerA','sessions','session1');
 const reply=doc(guest,'hotels','ownerA','sessions','session1','ai-outage');
 await assertSucceeds(runTransaction(guest,async tx=>{
   await tx.get(session);await tx.get(reply);
   tx.update(session,{status:'awaiting_human',isUnread:true,previewText:'Need assistance',previewStaffText:'Need assistance',lastUpdatedAt:serverTimestamp()});
   tx.set(reply,{guestUid:'guestA',sender:'ai',text:'Provider unavailable',timestamp:serverTimestamp()});
 }));
 const staff=db('agent');const snap=await getDoc(doc(staff,'hotels','ownerA','sessions','session1'));
 if(snap.data().status!=='awaiting_human'||!snap.data().isUnread)throw Error('Missing handoff');
 await assertSucceeds(getDoc(doc(staff,'hotels','ownerA','sessions','session1','ai-outage')));
});
