import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

test('invitation and membership HTTP lifecycle', {timeout:90000}, async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
  const projectId='demo-renlite-test';
  const app=initializeApp({projectId},'team-api-tests');
  const auth=getAuth(app), db=getFirestore(app);
  const port=19387, base='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['--import','tsx','server.ts'],{env:{...process.env,RENLITE_EMULATOR_TEST:'1',GCLOUD_PROJECT:projectId,NODE_ENV:'production',PORT:String(port)},stdio:['ignore','inherit','inherit']});
  try {
    let ready=false;
    for(let i=0;i<100;i++){
      if(child.exitCode!==null) throw new Error('Test server exited');
      try{ready=(await fetch(base+'/healthz')).ok;}catch{}
      if(ready)break;
      await delay(200);
    }
    assert.ok(ready,'test server available');
    const suffix=Date.now();
    async function account(label,verified=true){
      const email=label+suffix+'@example.test', password='Test-password-123!';
      const u=await auth.createUser({email,password,emailVerified:verified});
      const r=await fetch('http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST+'/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
      assert.equal(r.status,200);
      return {uid:u.uid,email,token:(await r.json()).idToken};
    }
    const owner=await account('owner'), other=await account('other'), agent=await account('agent'), unverified=await account('unverified',false);
    for(const a of [owner,other])await db.collection('hotels').doc(a.uid).set({name:'Test hotel'});
    async function call(a,path,body){
      const response=await fetch(base+'/api/team/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      return {status:response.status,data:await response.json()};
    }
    const payload={hotelId:owner.uid,email:agent.email,role:'associate',department:'Front Desk'};
    assert.equal((await call(other,'invitations',payload)).status,403);
    assert.equal((await call(unverified,'invitations',payload)).status,401);
    assert.equal((await call(owner,'invitations',{...payload,role:'admin'})).status,400);
    const issued=await call(owner,'invitations',payload);
    assert.equal(issued.status,201);
    assert.match(issued.data.token,/^[a-f0-9]{64}$/);
    assert.equal((await call(other,'accept',{token:issued.data.token})).status,403);
    assert.equal((await call(agent,'accept',{token:issued.data.token})).status,200);
    assert.equal((await call(agent,'accept',{token:issued.data.token})).status,403);
    assert.equal((await call(agent,'hotels')).data.hotels[0].hotelId,owner.uid);
    assert.equal((await call(agent,'directory/'+owner.uid)).status,403);
    assert.equal((await call(owner,'directory/'+owner.uid)).data.members.length,1);
    assert.equal((await call(other,'member',{hotelId:owner.uid,uid:agent.uid,role:'manager',active:true})).status,403);
    assert.equal((await call(owner,'member',{hotelId:owner.uid,uid:agent.uid,role:'manager',active:true})).status,200);
    assert.equal((await call(agent,'hotels')).data.hotels[0].role,'manager');
    assert.equal((await call(owner,'member',{hotelId:owner.uid,uid:agent.uid,role:'manager',active:false})).status,200);
    assert.equal((await call(agent,'hotels')).data.hotels.length,0);
    // Insights aggregate endpoint: enforce hotel and management role boundaries.
    const events=db.collection('hotels').doc(owner.uid).collection('assistanceEvents');
    await events.doc('current').set({kind:'grounded_recommendation',createdAt:Timestamp.now(),version:1});
    await events.doc('old').set({kind:'failed',createdAt:Timestamp.fromMillis(Date.now()-40*86400000),version:1});
    await db.collection('hotels').doc(other.uid).collection('assistanceEvents').doc('other').set({kind:'reply_generated',createdAt:Timestamp.now(),version:1});
    async function insights(a,hotelId,days=30){
      const response=await fetch(base+'/api/insights/'+hotelId+'?days='+days,{headers:{Authorization:'Bearer '+a.token}});
      return {status:response.status,data:await response.json()};
    }
    assert.equal((await insights(other,owner.uid)).status,403);
    assert.equal((await insights(unverified,owner.uid)).status,401);
    assert.equal((await insights(agent,owner.uid)).status,403);
    assert.equal((await insights(owner,owner.uid,15)).status,400);
    const report=await insights(owner,owner.uid);
    assert.equal(report.status,200);
    assert.equal(report.data.counts.grounded_recommendation,1);
    assert.equal(report.data.counts.failed,0);
    assert.equal(report.data.counts.reply_generated,0);
    assert.equal((await insights(owner,owner.uid,90)).data.counts.failed,1);
    assert.equal((await call(owner,'member',{hotelId:owner.uid,uid:agent.uid,role:'associate',active:true})).status,200);
    assert.equal((await insights(agent,owner.uid)).status,403);
    assert.equal((await call(owner,'member',{hotelId:owner.uid,uid:agent.uid,role:'manager',active:true})).status,200);
    assert.equal((await insights(agent,owner.uid)).status,200);
    assert.equal((await insights(agent,other.uid)).status,403);
    assert.equal((await call(owner,'member',{hotelId:owner.uid,uid:agent.uid,role:'manager',active:false})).status,200);
    assert.equal((await insights(agent,owner.uid)).status,403);
    const guest=await account('feedbackguest');
    const sessionId='feedback-session', guestMessageId='feedback-turn';
    const session=db.collection('hotels').doc(owner.uid).collection('sessions').doc(sessionId);
    await session.set({guestUid:guest.uid,status:'active'});
    await session.collection('messages').doc('ai-'+guestMessageId).set({sender:'ai',guestUid:guest.uid});
    await events.doc(createHash('sha256').update(sessionId+'|'+guestMessageId).digest('hex')).set({kind:'reply_generated',createdAt:Timestamp.now(),version:1});
    const feedbackPayload={hotelId:owner.uid,sessionId,guestMessageId,rating:5};
    async function vote(a,body){
      const r=await fetch(base+'/api/insights/feedback',{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      return r.status;
    }
    assert.equal(await vote(other,feedbackPayload),403);
    assert.equal(await vote(guest,{...feedbackPayload,rating:6}),400);
    assert.equal(await vote(guest,{...feedbackPayload,guestMessageId:'missing'}),403);
    assert.equal(await vote(guest,feedbackPayload),200);
    assert.equal(await vote(guest,feedbackPayload),409);
    const rated=await insights(owner,owner.uid);
    assert.deepEqual(rated.data.feedback,{count:1,average:5});
    assert.deepEqual((await insights(other,other.uid)).data.feedback,{count:0,average:null});
    const pending=await call(owner,'invitations',{...payload,email:other.email});
    assert.equal(pending.status,201);
    const id=createHash('sha256').update(pending.data.token).digest('hex');
    assert.equal((await call(other,'revoke',{hotelId:owner.uid,id})).status,403);
    assert.equal((await call(owner,'revoke',{hotelId:owner.uid,id})).status,200);
    assert.equal((await call(other,'accept',{token:pending.data.token})).status,403);
    const expired=await call(owner,'invitations',{...payload,email:other.email});
    assert.equal(expired.status,201);
    await db.collection('teamInvitations').doc(createHash('sha256').update(expired.data.token).digest('hex')).update({expiresAt:Timestamp.fromMillis(Date.now()-1000)});
    assert.equal((await call(other,'accept',{token:expired.data.token})).status,403);
  } finally {
    child.kill();
    await deleteApp(app);
  }
});
