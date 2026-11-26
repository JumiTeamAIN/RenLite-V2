import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, Timestamp } from 'firebase/firestore';
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
      await setDoc(doc(d,'hotels',h,'sessions','session1'),{guestUid:'guestA',lastUpdatedAt:Timestamp.now(),previewText:'Test',isUnread:false,status:'active'});
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
