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
      const email=label==='developer'?'jumi@teamain.org':label+suffix+'@example.test', password='Test-password-123!';
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
    const dev=await account('developer');
    async function policyCall(a,path,body){
      const r=await fetch(base+'/api/developer/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      return {status:r.status,data:await r.json()};
    }
    assert.equal((await policyCall(owner,'model-policy')).status,403);
    assert.equal((await policyCall(owner,'ai-budget')).status,403);
    assert.equal((await policyCall(owner,'ai-budget',{monthlyCents:0,searchEnabled:false})).status,403);
    assert.equal((await policyCall(dev,'ai-budget',{monthlyCents:501,searchEnabled:true})).status,400);
    assert.equal((await policyCall(dev,'ai-budget',{monthlyCents:0,searchEnabled:false})).status,200);
    assert.equal((await policyCall(dev,'ai-budget')).data.policy.monthlyCents,0);
    assert.equal((await policyCall(dev,'ai-budget',{monthlyCents:475,searchEnabled:true})).status,200);
    const initial=await policyCall(dev,'model-policy');
    assert.equal(initial.status,200);
    assert.equal(initial.data.policy.concierge,'gemini-2.5-flash');
    assert.equal((await policyCall(owner,'model-policy',initial.data.policy)).status,403);
    assert.equal((await policyCall(dev,'model-policy',{...initial.data.policy,search:'unknown'})).status,400);
    assert.equal((await policyCall(dev,'model-policy',{...initial.data.policy,enabled:false})).status,200);
    assert.equal((await policyCall(dev,'model-policy')).data.policy.enabled,false);
    assert.equal((await policyCall(dev,'model-probe',{model:'gemini-2.5-flash',operation:'search'})).status,409);
    assert.equal((await policyCall(owner,'model-probe',{model:'gemini-2.5-flash',operation:'search'})).status,403);
    // Exercise actual translation routes, not the independent developer probe.
    for(const [route,body] of [
      ['translate',{text:'How many bottles of water?',targetLanguage:'es'}],
      ['translate-batch',{items:[{id:'sample',text:'Necesito agua'}],targetLanguage:'en'}]
    ]){
      const response=await fetch(base+'/api/gemini/'+route,{method:'POST',headers:{Authorization:'Bearer '+owner.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,503);
      assert.equal((await response.json()).error,'AI translation is temporarily unavailable.');
    }
    // Real guest endpoint must serve trusted exact FAQs with provider disabled.
    const outageGuest=await account('outageguest');
    const outageHotel=db.collection('hotels').doc(owner.uid);
    const outageSession=outageHotel.collection('sessions').doc('outage-session');
    await outageHotel.update({faqs:[{question:'How much is parking?',answer:'$15 plus tax'}]});
    await outageSession.set({guestUid:outageGuest.uid,status:'active',guestAccessStartedAt:Timestamp.now()});
    async function outageTurn(id,message){
      await outageSession.collection('messages').doc(id).set({sender:'guest',guestUid:outageGuest.uid,text:message,timestamp:Timestamp.now()});
      const response=await fetch(base+'/api/gemini/concierge',{method:'POST',headers:{Authorization:'Bearer '+outageGuest.token,'Content-Type':'application/json'},body:JSON.stringify({hotelId:owner.uid,sessionId:'outage-session',guestMessageId:id,hotelName:'Test hotel',persona:'',transcript:'Guest: '+message,latestGuestMessage:message,faqs:[{question:'How much is parking?',answer:'Free'}]})});
      return {status:response.status,data:await response.json()};
    }
    const faq=await outageTurn('faq','How much is parking?');
    assert.equal(faq.status,200);assert.equal(faq.data.text,'$15 plus tax');
    const failed=await outageTurn('unknown','Can you recommend a restaurant nearby?');
    assert.equal(failed.status,503);
    // Clean up assistance events to avoid affecting later aggregate assertions.
    for(const id of ['faq','unknown'])await outageHotel.collection('assistanceEvents').doc(createHash('sha256').update('outage-session|'+id).digest('hex')).delete();
    assert.equal((await policyCall(dev,'model-policy',initial.data.policy)).status,200);
    // Safety detection is independent of provider and preserves staff ownership.
    const safetySession=outageHotel.collection('sessions').doc('safety-session');
    await safetySession.set({guestUid:outageGuest.uid,status:'awaiting_human',roomNumber:'101',guestAccessStartedAt:Timestamp.now()});
    await policyCall(dev,'model-policy',{...initial.data.policy,enabled:false});
    async function safetyCall(account,id){
      const response=await fetch(base+'/api/guest/safety-check',{method:'POST',headers:{Authorization:'Bearer '+account.token,'Content-Type':'application/json'},body:JSON.stringify({hotelId:owner.uid,sessionId:'safety-session',guestMessageId:id})});
      return {status:response.status,data:await response.json()};
    }
    async function safetyMessage(id,text){await safetySession.collection('messages').doc(id).set({sender:'guest',guestUid:outageGuest.uid,text,timestamp:Timestamp.now()});}
    await safetyMessage('bedbugs','I found bed bugs in my room.');
    assert.equal((await safetyCall(other,'bedbugs')).status,403);
    const safety=await safetyCall(outageGuest,'bedbugs');
    assert.equal(safety.status,200);assert.equal(safety.data.triggered,true);
    assert.equal((await safetySession.get()).data().status,'escalated');
    assert.equal((await safetyCall(outageGuest,'bedbugs')).data.referenceCode,safety.data.referenceCode);
    assert.equal((await outageHotel.collection('requests').where('sessionId','==','safety-session').get()).size,1);
    await safetySession.update({status:'staff_controlled'});
    await safetyMessage('fire','There is a fire in my room.');
    assert.equal((await safetyCall(outageGuest,'fire')).status,200);
    assert.equal((await safetySession.get()).data().status,'staff_controlled');
    assert.equal((await safetySession.get()).data().escalationSeverity,'critical');
    await safetyMessage('manager','I want a manager.');
    assert.equal((await safetyCall(outageGuest,'manager')).status,200);
    assert.equal((await safetySession.get()).data().escalationSeverity,'critical');
    await safetyMessage('ordinary','Thanks for the towels.');
    assert.equal((await safetyCall(outageGuest,'ordinary')).data.triggered,false);
    await safetySession.update({guestEndedAt:Timestamp.now()});
    assert.equal((await safetyCall(outageGuest,'fire')).status,403);
    await policyCall(dev,'model-policy',initial.data.policy);
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
    await session.set({guestUid:guest.uid,status:'active',guestAccessStartedAt:Timestamp.now()});
    const msgs=session.collection('messages'), now=Date.now();
    await msgs.doc('prior-question').set({sender:'guest',guestUid:guest.uid,text:'When does breakfast start?',timestamp:Timestamp.fromMillis(now-3000)});
    await msgs.doc('ai-prior-question').set({sender:'ai',guestUid:guest.uid,text:'Breakfast starts at seven.',timestamp:Timestamp.fromMillis(now-2000)});
    await events.doc(createHash('sha256').update(sessionId+'|prior-question').digest('hex')).set({kind:'configured_faq_match',createdAt:Timestamp.now(),version:1});
    await msgs.doc(guestMessageId).set({sender:'guest',guestUid:guest.uid,text:'Thank you!',timestamp:Timestamp.fromMillis(now-1000)});
    await msgs.doc('ai-'+guestMessageId).set({sender:'ai',guestUid:guest.uid,text:'You are welcome!',timestamp:Timestamp.fromMillis(now)});
    await events.doc(createHash('sha256').update(sessionId+'|'+guestMessageId).digest('hex')).set({kind:'reply_generated',createdAt:Timestamp.now(),version:1});
    // Separate room-move fixture keeps feedback tests independent.
    const moveSession=db.collection('hotels').doc(owner.uid).collection('sessions').doc('move-session');
    const property=db.collection('hotels').doc(owner.uid);
    await property.update({locations:[{id:'room205',code:'205',label:'Room 205',type:'room',active:true}]});
    await moveSession.set({guestUid:guest.uid,status:'active',roomNumber:'101',guestAccessStartedAt:Timestamp.now()});
    const towels=property.collection('requests').doc('move-towels'), ac=property.collection('requests').doc('move-ac');
    await towels.set({sessionId:'move-session',roomNumber:'101',status:'pending',item:'Towels'});
    await ac.set({sessionId:'move-session',roomNumber:'101',status:'in_progress',item:'AC'});
    const movePayload={hotelId:owner.uid,sessionId:'move-session',moveId:'test-move',fromRoom:'101',destinationId:'room205',decisions:[{id:'move-towels',room:'101',status:'pending',action:'move'},{id:'move-ac',room:'101',status:'in_progress',action:'keep'}]};
    assert.equal((await call(other,'room-move',movePayload)).status,403);
    assert.equal((await call(owner,'room-move',{...movePayload,decisions:[]})).status,409);
    assert.equal((await call(owner,'room-move',movePayload)).status,200);
    assert.equal((await moveSession.get()).data().roomNumber,'205');
    assert.equal((await towels.get()).data().roomNumber,'205');
    assert.equal((await ac.get()).data().roomNumber,'101');
    assert.equal((await property.collection('roomMoves').doc('test-move').get()).data().staffUid,owner.uid);
    assert.equal((await call(owner,'room-move',movePayload)).status,200);
    const feedbackPayload={hotelId:owner.uid,sessionId,guestMessageId,rating:5};
    async function vote(a,body){
      const r=await fetch(base+'/api/insights/feedback',{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      return r.status;
    }
    assert.equal(await vote(other,feedbackPayload),403);
    assert.equal(await vote(guest,{...feedbackPayload,rating:6}),400);
    assert.equal(await vote(guest,{...feedbackPayload,guestMessageId:'missing'}),403);
    async function offer(a,body){
      const r=await fetch(base+'/api/insights/feedback-offer',{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      return r.status;
    }
    assert.equal(await vote(guest,feedbackPayload),403);
    assert.equal(await offer(other,feedbackPayload),409);
    assert.equal(await offer(guest,{...feedbackPayload,guestMessageId:'prior-question'}),409);
    const openRequest=db.collection('hotels').doc(owner.uid).collection('requests').doc('feedback-open');
    await openRequest.set({sessionId,status:'pending'});
    assert.equal(await offer(guest,feedbackPayload),409);
    await openRequest.update({status:'completed'});
    assert.equal(await offer(guest,feedbackPayload),200);
    assert.equal(await offer(guest,feedbackPayload),409);
    assert.equal(await vote(guest,feedbackPayload),200);
    assert.equal(await vote(guest,feedbackPayload),409);
    const rated=await insights(owner,owner.uid);
    assert.deepEqual(rated.data.feedback,{count:0,average:null});
    assert.deepEqual(rated.data.conversationFeedback,{count:1,average:5});
    assert.deepEqual((await insights(other,other.uid)).data.feedback,{count:0,average:null});
    const assumptions={hotelId:owner.uid,minutes:3,wage:25,cost:99,displacement:60};
    async function settings(a,hotelId,body){
      const r=await fetch(base+'/api/insights/settings'+(body?'':'/'+hotelId),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      return {status:r.status,data:await r.json()};
    }
    assert.equal((await settings(other,owner.uid,assumptions)).status,403);
    assert.equal((await settings(agent,owner.uid)).status,403);
    assert.equal((await settings(owner,owner.uid,{...assumptions,displacement:101})).status,400);
    assert.equal((await settings(owner,owner.uid,assumptions)).status,200);
    assert.deepEqual((await settings(owner,owner.uid)).data.settings,{minutes:3,wage:25,cost:99,displacement:60});
    assert.equal((await settings(other,other.uid)).data.settings,null);
    assert.equal((await call(owner,'member',{hotelId:owner.uid,uid:agent.uid,role:'manager',active:true})).status,200);
    assert.equal((await settings(agent,owner.uid)).status,200);
    assert.equal((await settings(agent,owner.uid,{...assumptions,cost:129})).status,200);
    assert.equal((await settings(owner,owner.uid)).data.settings.cost,129);
    assert.equal((await call(owner,'member',{hotelId:owner.uid,uid:agent.uid,role:'manager',active:false})).status,200);
    assert.equal((await settings(agent,owner.uid,assumptions)).status,403);
    // Staff transitions are recorded once, even with repeated replies and retries.
    const staffPayload={hotelId:owner.uid,sessionId,action:'takeover',messageId:'takeover-test'};
    async function staffAction(a,body){
      const r=await fetch(base+'/api/insights/staff-action',{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      return r.status;
    }
    assert.equal(await staffAction(guest,staffPayload),403);
    assert.equal(await staffAction(other,staffPayload),403);
    assert.equal(await staffAction(agent,staffPayload),403);
    assert.equal(await staffAction(owner,staffPayload),200);
    assert.equal(await staffAction(owner,staffPayload),200);
    assert.equal((await session.get()).data().status,'staff_controlled');
    assert.equal(await staffAction(owner,{...staffPayload,action:'reply',messageId:'staff-reply-test',text:'Happy to help'}),200);
    assert.equal((await insights(owner,owner.uid)).data.counts.staff_takeover,1);
    await session.update({status:'active'});
    assert.equal(await staffAction(owner,{...staffPayload,action:'reply',messageId:'new-takeover-test',text:'Welcome back'}),200);
    assert.equal((await insights(owner,owner.uid)).data.counts.staff_takeover,2);
    await session.update({status:'completed'});
    assert.equal(await staffAction(owner,{...staffPayload,messageId:'closed-test'}),409);
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
