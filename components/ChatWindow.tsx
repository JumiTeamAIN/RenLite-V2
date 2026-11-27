import {GuestDining} from './GuestDining';
import React, { useState, useEffect, useRef } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  serverTimestamp,
  doc,
  getDoc,
  updateDoc,
  writeBatch,
  runTransaction,
} from 'firebase/firestore';
import { auth, db, signInGuest, OperationType, handleFirestoreError } from '../services/firebase';
import { sendMessageToAI, translateMessageToEnglish } from '../services/clientAi';
import {
  QUICK_REQUEST_TEMPLATES,
  detectDeterministicSafetySignal,
  QuickRequestTemplate,
  normalizeLocationMatch,
} from '../services/hotelLogic';
import { submitServiceRequest, reopenGuestRequest } from '../services/requestService';
import { HotelConfig, Message, Request, Session } from '../types';

// Explicit opt-in after a conversation closing, rather than a survey after every reply.
const closingText = (text:string) => /^(?:thanks(?: so much| for your help)?|thank you(?: so much| for your help)?|no[, ]+thank you|no[, ]+that['’]s all(?:[, ]+thank you)?|that['’]s all(?:[, ]+thanks)?|all set|gracias(?: por tu ayuda)?|merci(?: beaucoup)?)[.!\s]*$/iu.test(text.trim());
const ResponseFeedback: React.FC<{hotelId:string;sessionId:string;messageId:string}> = ({hotelId,sessionId,messageId}) => {
  const [rating,setRating]=useState(0);
  const [status,setStatus]=useState<'idle'|'sending'|'saved'|'unavailable'|'error'>('unavailable');
  const [offered,setOffered]=useState(false);
  useEffect(()=>{
    let cancelled=false;
    const key='renlite-feedback:'+hotelId+':'+sessionId;
    let stored=0;
    try{stored=Number(localStorage.getItem(key)||0);}catch{}
    if(Date.now()-stored<86400000)return;
    // A session-level server reservation prevents repeated prompts across refreshes/devices.
    (async()=>{
      try{
        const user=auth.currentUser;if(!user)return;
        const res=await fetch('/api/insights/feedback-offer',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await user.getIdToken()},body:JSON.stringify({hotelId,sessionId,guestMessageId:messageId.slice(3)})});
        if(res.ok&&!cancelled){try{localStorage.setItem(key,String(Date.now()));}catch{}setOffered(true);setStatus('idle');}
      }catch{}
    })();
    return()=>{cancelled=true;};
  },[hotelId,sessionId,messageId]);
  const submit=async()=>{
    if(!rating||status==='sending')return;
    setStatus('sending');
    try{
      const user=auth.currentUser;
      if(!user)throw new Error();
      const res=await fetch('/api/insights/feedback',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await user.getIdToken()},body:JSON.stringify({hotelId,sessionId,guestMessageId:messageId.slice(3),rating})});
      setStatus(res.ok||res.status===409?'saved':res.status===403?'unavailable':'error');
    }catch{setStatus('error');}
  };
  if(!offered||status==='unavailable')return null;
  if(status==='saved')return <p role="status" className="text-xs text-slate-500 mt-2">Thank you for your feedback.</p>;
  return <div className="mt-3 pt-2 border-t border-slate-200 text-xs space-y-2">
    <p className="text-slate-600">How helpful was Ren during this conversation? (Optional)</p>
    <div className="flex flex-wrap gap-1" role="group" aria-label="Rate Ren from 1 to 5">
      {[1,2,3,4,5].map(n=><button key={n} type="button" aria-label={n+' out of 5 stars'} aria-pressed={rating===n} disabled={status==='sending'} onClick={()=>setRating(n)} className={'p-2 rounded text-lg '+(n<=rating?'text-amber-600':'text-slate-400')}>{n<=rating?'★':'☆'}</button>)}
    </div>
    {rating>0&&<button type="button" disabled={status==='sending'} onClick={()=>void submit()} className="text-indigo-700 font-semibold">{status==='sending'?'Sending…':'Submit rating'}</button>}
    <button type="button" disabled={status==='sending'} onClick={()=>setStatus('unavailable')} className="text-slate-500 ml-2">Not now</button>
    {status==='error'&&<p role="alert" className="text-red-700">Feedback could not be saved. Try again.</p>}
  </div>;
};

interface ChatWindowProps {
  hotelId: string;
  locationCode?: string;
}

const GUEST_STATUS_LABELS: Record<string, string> = {
  pending: 'Request received',
  acknowledged: 'Team notified',
  in_progress: 'In progress',
  completed: 'Completed',
  escalated: 'Escalated to management',
  reopened: 'Reopened for follow-up',
  cancelled: 'Cancelled',
};

export const ChatWindow: React.FC<ChatWindowProps> = ({ hotelId, locationCode }) => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [guestUid, setGuestUid] = useState<string | null>(null);
  const [hotelConfig, setHotelConfig] = useState<HotelConfig | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [guestRequests, setGuestRequests] = useState<Request[]>([]);

  const [activeView, setActiveView] = useState<'chat' | 'quick' | 'requests' | 'dining'>('chat');
  const [inputText, setInputText] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [pendingGuestMessages, setPendingGuestMessages] = useState<
    { localId: string; text: string }[]
  >([]);

  // Location editor state
  const [showLocationEditor, setShowLocationEditor] = useState(false);
  const [locationDraft, setLocationDraft] = useState('');
  const [savingLocation, setSavingLocation] = useState(false);

  // Quick request state
  const [selectedTemplate, setSelectedTemplate] = useState<QuickRequestTemplate | null>(null);
  const [quickQty, setQuickQty] = useState(1);
  const [quickLocationInput, setQuickLocationInput] = useState('');
  const [quickNotes, setQuickNotes] = useState('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [quickFeedback, setQuickFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [expandedOriginals, setExpandedOriginals] = useState<Record<string, boolean>>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const [isSending, setIsSending] = useState(false);

  // Watchdog: If thinking for > 48s, stop spinner.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (isThinking) {
      timer = setTimeout(() => {
        setIsThinking(false);
        setChatError('This is taking longer than expected. Your message may still be processing. Please avoid sending it again; contact the front desk directly if urgent.');
      }, 48000);
    }
    return () => clearTimeout(timer);
  }, [isThinking]);

  const storageKey = 'ren_guest_tab_v2:'+hotelId+':'+encodeURIComponent((locationCode||'').trim().toLowerCase());
  const rememberSession = (id:string) => {
    try { sessionStorage.setItem(storageKey,JSON.stringify({id,at:Date.now()})); } catch {}
  };
  const forgetSession = () => {
    try { sessionStorage.removeItem(storageKey); localStorage.removeItem('ren_session_'+hotelId); } catch {}
  };
  const [resumeId,setResumeId]=useState<string|null>(null);
  const [ended,setEnded]=useState(false);
  // Only guest interaction extends the local idle window; staff replies do not.
  useEffect(()=>{
    if(!sessionId||ended)return;
    const touch=()=>{try{const v=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(v?.id===sessionId&&Date.now()-v.at<1800000)rememberSession(sessionId);}catch{}};
    const idle=()=>{if(session?.guestAccessStartedAt && Date.now()-session.guestAccessStartedAt.toMillis()>=86400000){forgetSession();setEnded(true);setSessionId(null);setMessages([]);setGuestRequests([]);setSession(null);setInputText('');return;}try{const v=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(v?.id===sessionId&&Date.now()-v.at>=1800000){setResumeId(sessionId);setSessionId(null);setMessages([]);setGuestRequests([]);setSession(null);setInputText('');}}catch{}};
    const timer=setInterval(idle,15000);
    window.addEventListener('pointerdown',touch);
    window.addEventListener('keydown',touch);
    document.addEventListener('visibilitychange',idle);
    return()=>{clearInterval(timer);window.removeEventListener('pointerdown',touch);window.removeEventListener('keydown',touch);document.removeEventListener('visibilitychange',idle);};
  },[sessionId,storageKey,ended,session?.guestAccessStartedAt]);

  // 1. Initialize Auth, Hotel Config, and Session
  useEffect(() => {
    let cancelled = false;

    const waitForInitialUser = (): Promise<User | null> =>
      new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
          unsubscribe();
          resolve(user);
        });
      });

    const initSession = async () => {
      setInitError(null);
      let user: User | null = null;
      try {
        user = (await waitForInitialUser()) || (await signInGuest());
      } catch (err: any) {
        if (cancelled) return;
        if (err?.code === 'auth/admin-restricted-operation' || err?.code === 'auth/operation-not-allowed') {
          setInitError(
            'Anonymous guest sign-in is disabled in Firebase Console. Enable the Anonymous provider under Authentication → Sign-in method.'
          );
        } else {
          setInitError('Unable to connect to guest concierge. Please refresh and try again.');
        }
        return;
      }

      if (cancelled || !user) return;
      setGuestUid(user.uid);

      // Load hotel configuration
      let loadedConfig: HotelConfig | null = null;
      try {
        const hotelSnap = await getDoc(doc(db, 'hotels', hotelId));
        if (hotelSnap.exists()) {
          loadedConfig = hotelSnap.data() as HotelConfig;
          if (!cancelled) setHotelConfig(loadedConfig);
        }
      } catch (err) {
        console.warn('Could not read hotel config during init:', err);
      }

      const matchedLoc = locationCode
        ? normalizeLocationMatch(locationCode, loadedConfig?.locations)
        : null;
      const initialRoom = (matchedLoc?.code || locationCode || '').trim().slice(0, 50);
      const initialLabel = (
        matchedLoc?.label || (locationCode ? `Location ${locationCode}` : '')
      ).slice(0, 100);
      const initialType = (matchedLoc?.type || (locationCode ? 'other' : '')).slice(0, 50);

      // Never restore legacy hotel-wide localStorage sessions. Tab storage is scoped to the QR location.
      let storedSession:string|null=null;
      let age=Infinity;
      try {
        localStorage.removeItem('ren_session_'+hotelId);
        const v=JSON.parse(sessionStorage.getItem(storageKey)||'null');
        if(typeof v?.id==='string'&&Number.isFinite(v.at)){storedSession=v.id;age=Date.now()-v.at;}
      }catch{}
      if(storedSession&&age>=0&&age<86400000){
        if(age>=1800000){if(!cancelled)setResumeId(storedSession);return;}
        try{
          const snap=await getDoc(doc(db,'hotels',hotelId,'sessions',storedSession));
          if(snap.exists()&&snap.data()?.guestUid===user.uid&&(!initialRoom||snap.data()?.roomNumber===initialRoom||snap.data()?.roomMoveAt)){
            if(!cancelled){rememberSession(storedSession);setResumeId(null);setSessionId(storedSession);}return;
          }
        }catch(err:any){
          if(err?.code!=='permission-denied'&&err?.code!=='not-found'){if(!cancelled)setInitError('Unable to reconnect. Please refresh when your connection is restored.');return;}
        }
      }
      forgetSession();
      if(!cancelled)setResumeId(null);

      const sessionsPath = `hotels/${hotelId}/sessions`;
      try {
        if (cancelled) return;
        const sessionRef = await addDoc(collection(db, sessionsPath), {
          guestUid: user.uid,
          guestAccessStartedAt: serverTimestamp(),
          lastUpdatedAt: serverTimestamp(),
          previewText: 'Started conversation',
          isUnread: false,
          status: 'active',
          ...(initialRoom ? { roomNumber: initialRoom } : {}),
          ...(matchedLoc?.id ? { locationId: matchedLoc.id } : {}),
          ...(initialLabel ? { locationLabel: initialLabel } : {}),
          ...(initialType ? { locationType: initialType } : {}),
        });

        rememberSession(sessionRef.id);
        if (!cancelled) setSessionId(sessionRef.id);
      } catch (err) {
        if (!cancelled) {
          setInitError('Unable to start guest session for this property.');
        }
        handleFirestoreError(err, OperationType.CREATE, sessionsPath);
      }
    };

    void initSession().catch((err) => {
      console.error('Guest initialization failed:', err);
      if (!cancelled) setInitError('Unable to connect. Please refresh and try again.');
    });
    return () => {
      cancelled = true;
    };
  }, [hotelId,locationCode]);

  // 2. Listen to Session Document (for real-time Human Takeover & Location status)
  useEffect(() => {
    if (!sessionId || !guestUid) return;
    const sessionPath = `hotels/${hotelId}/sessions/${sessionId}`;
    return onSnapshot(
      doc(db, sessionPath),
      (snap) => {
        if (snap.exists()) {
          const data = { id: snap.id, ...snap.data() } as Session;
          setSession(data);
          if (data.status === 'staff_controlled') {
            setIsThinking(false);
          }
        }
      },
      (error) => {
        console.error(`Session listener error (${sessionPath}):`, error);
        setChatError('Conversation updates were interrupted. Please refresh to reconnect.');
      }
    );
  }, [sessionId, guestUid, hotelId]);

  // 3. Listen for Messages
  useEffect(() => {
    if (!sessionId || !guestUid) return;

    const msgsPath = `hotels/${hotelId}/sessions/${sessionId}/messages`;
    const q = query(collection(db, msgsPath), where('guestUid', '==', guestUid));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const fallbackNow = Date.now();
        const msgs = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() } as Message))
          .sort(
            (a, b) =>
              (a.timestamp?.toMillis() ?? fallbackNow) - (b.timestamp?.toMillis() ?? fallbackNow)
          );
        setMessages(msgs);

        if (msgs.length > 0) {
          setPendingGuestMessages((prev) =>
            prev.filter(
              (pending) => !msgs.some((m) => m.sender === 'guest' && m.id === pending.localId)
            )
          );
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg.sender === 'ai' || lastMsg.sender === 'staff') {
            setIsThinking(false);
          }
        }
      },
      (error) => {
        console.error(`Messages listener error (${msgsPath}):`, error);
        setChatError('Live chat connection was interrupted. Please refresh the page to reconnect.');
      }
    );

    return () => unsubscribe();
  }, [sessionId, guestUid, hotelId]);

  // 4. Listen for Guest's Requests in this Session
  useEffect(() => {
    if (!sessionId || !guestUid) return;
    const requestsPath = `hotels/${hotelId}/requests`;
    const q = query(collection(db, requestsPath), where('guestUid', '==', guestUid), where('sessionId','==',sessionId));

    return onSnapshot(
      q,
      (snapshot) => {
        const fallbackNow = Date.now();
        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() } as Request))
          .filter((r) => r.sessionId === sessionId)
          .sort(
            (a, b) =>
              (b.createdAt?.toMillis() ?? fallbackNow) - (a.createdAt?.toMillis() ?? fallbackNow)
          );
        setGuestRequests(list);
      },
      (error) => {
        console.error(`Requests listener error (${requestsPath}):`, error);
      }
    );
  }, [sessionId, guestUid, hotelId]);

  // Scroll to bottom
  useEffect(() => {
    if (scrollRef.current && activeView === 'chat') {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isThinking, activeView]);

  const sendGuestMessage = async (rawText: string) => {
    if (!rawText.trim() || !sessionId || !guestUid || !session || sendingRef.current) return;
    sendingRef.current = true;
    setIsSending(true);

    const text = rawText.trim().slice(0, 5000);
    const msgRef = doc(collection(db, `hotels/${hotelId}/sessions/${sessionId}/messages`));
    const localId = msgRef.id;
    setInputText('');
    setChatError(null);
    setPendingGuestMessages((prev) => [...prev, { localId, text }]);

    const isStaffControlled = session?.status === 'staff_controlled' || session?.status === 'awaiting_human';
    const wasCompleted = session?.status === 'completed';
    if (!isStaffControlled) {
      setIsThinking(true);
    }

    const sessionPath = `hotels/${hotelId}/sessions/${sessionId}`;

    let messageSaved = false;
    try {
      const batch = writeBatch(db);
      batch.set(msgRef, {
        sender: 'guest',
        guestUid,
        text,
        timestamp: serverTimestamp(),
      });

      batch.update(doc(db, sessionPath), {
        lastUpdatedAt: serverTimestamp(),
        previewText: text,
        previewStaffText: text,
        isUnread: true,
        ...(wasCompleted ? { status: 'active' } : {}),
      });

      await batch.commit();
      messageSaved = true;
      setPendingGuestMessages((prev) => prev.filter((p) => p.localId !== localId));

      // Safety check precedes both normal AI and staff-owned paths.
      if(detectDeterministicSafetySignal(text).triggered){
        try{
          const token=await auth.currentUser?.getIdToken();
          const response=await fetch('/api/guest/safety-check',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({hotelId,sessionId,guestMessageId:msgRef.id}),signal:AbortSignal.timeout(10000)});
          if(!response.ok||!(await response.json()).triggered)throw Error('Safety alert not confirmed');
        }catch{
          setChatError('Your message was saved, but we could not confirm an urgent alert. Contact the front desk directly; in immediate danger contact local emergency services now.');
        }
        return;
      }
      if (!isStaffControlled) {
        await sendMessageToAI(hotelId, sessionId, msgRef.id);
      } else {
        // Translate guest message to English for staff even during active human takeover
        const translated = await translateMessageToEnglish(
          hotelId,
          sessionId,
          msgRef.id,
          text,
          session?.guestLanguage
        );
        if (translated) {
          await updateDoc(doc(db, sessionPath), {
            lastUpdatedAt: serverTimestamp(),
            previewStaffText: translated.staffText.slice(0, 5000),
            ...(translated.detectedLanguage && translated.detectedLanguage !== 'en'
              ? { guestLanguage: translated.detectedLanguage }
              : {}),
          });
        }
      }
    } catch (e) {
      console.error('Failed to send guest message:', e);
      setPendingGuestMessages((prev) => prev.filter((p) => p.localId !== localId));
      if (!messageSaved) setInputText(text);
      setChatError(
        messageSaved
          ? 'Your message was saved, but Ren could not finish responding. Please use Speak with Staff or contact the front desk if urgent.'
          : 'Your message could not be confirmed. Check your connection and conversation before trying again.'
      );
    } finally {
      sendingRef.current = false;
      setIsSending(false);
      setIsThinking(false);
    }
  };

  const handleStartNewSession = async () => {
    if (!guestUid) return;
    const matchedLoc = locationCode
      ? normalizeLocationMatch(locationCode, hotelConfig?.locations)
      : null;
    const initialRoom = (matchedLoc?.code || locationCode || session?.roomNumber || '').trim().slice(0, 50);
    const initialLabel = (
      matchedLoc?.label ||
      session?.locationLabel ||
      (initialRoom ? `Room ${initialRoom}` : '')
    ).slice(0, 100);
    const initialType = (matchedLoc?.type || session?.locationType || (initialRoom ? 'room' : '')).slice(0, 50);

    const sessionsPath = `hotels/${hotelId}/sessions`;
    try {
      const sessionRef = await addDoc(collection(db, sessionsPath), {
        guestUid,
        guestAccessStartedAt: serverTimestamp(),
        lastUpdatedAt: serverTimestamp(),
        previewText: 'Started conversation',
        isUnread: false,
        status: 'active',
        ...(initialRoom ? { roomNumber: initialRoom } : {}),
        ...(matchedLoc?.id ? { locationId: matchedLoc.id } : {}),
        ...(initialLabel ? { locationLabel: initialLabel } : {}),
        ...(initialType ? { locationType: initialType } : {}),
      });
      rememberSession(sessionRef.id);
      setMessages([]);
      setSessionId(sessionRef.id);
      setActiveView('chat');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, sessionsPath);
    }
  };

  const handleSend = () => {
    sendGuestMessage(inputText);
  };

  const handleSaveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionId || !guestUid || !locationDraft.trim()) return;
    if(session?.roomMoveAt){setChatError('Your room was updated by hotel staff. Please contact staff for another room move.');return;}
    setSavingLocation(true);
    const raw = locationDraft.trim();
    const matched = normalizeLocationMatch(raw, hotelConfig?.locations);
    const nextRoom = (matched?.code || raw).slice(0, 50);
    const nextLabel = (matched?.label || (/^\d/.test(nextRoom) ? `Room ${nextRoom}` : nextRoom)).slice(0, 100);
    const nextType = (matched?.type || 'room').slice(0, 50);

    const sessionPath = `hotels/${hotelId}/sessions/${sessionId}`;
    try {
      if (session?.status !== 'completed') {
        await updateDoc(doc(db, sessionPath), {
          lastUpdatedAt: serverTimestamp(),
          roomNumber: nextRoom,
          locationLabel: nextLabel,
          locationType: nextType,
          ...(matched?.id ? { locationId: matched.id } : {}),
        });
      }

      // Backfill any open requests that were waiting for a room number
      for (const req of guestRequests) {
        if (
          ['pending', 'acknowledged', 'in_progress', 'escalated'].includes(req.status) &&
          (!req.roomNumber || req.roomNumber === 'Pending room #' || req.roomNumber === 'Location needed')
        ) {
          await updateDoc(doc(db, `hotels/${hotelId}/requests`, req.id), {
            roomNumber: nextRoom,
            lastUpdated: serverTimestamp(),
          });
        }
      }

      setShowLocationEditor(false);
      setLocationDraft('');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, sessionPath);
    } finally {
      setSavingLocation(false);
    }
  };

  const handleRequestStaff = async () => {
    if (!sessionId || !guestUid || session?.status === 'staff_controlled') return;
    const sessionPath = `hotels/${hotelId}/sessions/${sessionId}`;
    const msgsPath = `hotels/${hotelId}/sessions/${sessionId}/messages`;

    try {
      const sessionRef=doc(db,sessionPath);
      const notice=doc(collection(db,msgsPath));
      await runTransaction(db,async tx=>{
        const current=await tx.get(sessionRef);
        if(!current.exists()||['staff_controlled','completed','awaiting_human','escalated'].includes(current.data().status))return;
        tx.update(sessionRef,{lastUpdatedAt:serverTimestamp(),previewText:'Guest requested a hotel associate',isUnread:true,status:'awaiting_human'});
        tx.set(notice,{sender:'system',guestUid,text:'Your request for a hotel associate is in the staff inbox. For urgent help, contact the front desk directly.',timestamp:serverTimestamp()});
      });
      setActiveView('chat');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, sessionPath);
    }
  };

  const handleSelectTemplate = (tpl: QuickRequestTemplate) => {
    setSelectedTemplate(tpl);
    setQuickQty(tpl.defaultQuantity);
    setQuickLocationInput(session?.roomNumber || '');
    setQuickNotes('');
    setQuickFeedback(null);
  };

  const handleSubmitQuickRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate || !sessionId || !guestUid) return;

    const rawLoc = (session?.roomMoveAt ? session.roomNumber || '' : quickLocationInput || session?.roomNumber || '').trim();
    if (!rawLoc) {
      setQuickFeedback({
        type: 'error',
        text: 'Please enter your room number or hotel location so staff knows where to fulfill this request.',
      });
      return;
    }

    const matched = normalizeLocationMatch(rawLoc, hotelConfig?.locations);
    const roomNumber = (matched?.code || rawLoc).slice(0, 50);
    const locationLabel = (matched?.label || (/^\d/.test(roomNumber) ? `Room ${roomNumber}` : roomNumber)).slice(0, 100);

    setQuickSubmitting(true);
    setQuickFeedback(null);

    try {
      // Save location onto session if not set
      if (session?.status !== 'completed' && session?.roomNumber !== roomNumber) {
        await updateDoc(doc(db, `hotels/${hotelId}/sessions/${sessionId}`), {
          lastUpdatedAt: serverTimestamp(),
          roomNumber,
          locationLabel,
          ...(matched?.id ? { locationId: matched.id } : {}),
          ...(matched?.type ? { locationType: matched.type } : {}),
        });
      }

      const result = await submitServiceRequest({
        hotelId,
        sessionId,
        guestUid,
        item: selectedTemplate.item,
        quantity: selectedTemplate.supportsQuantity ? quickQty : 1,
        category: selectedTemplate.category,
        department: selectedTemplate.department,
        roomNumber,
        description: quickNotes.trim() || selectedTemplate.description,
        priority: selectedTemplate.priority,
        status: 'pending',
        source: 'structured',
        openRequests: guestRequests,
      });

      const confirmationMsg =
        result.outcome === 'created'
          ? `Request #${result.referenceCode} submitted to ${result.department}: ${result.quantity > 1 ? `${result.quantity}x ` : ''}${result.item} for ${locationLabel}.`
          : result.outcome === 'duplicate_updated'
            ? `Updated open request #${result.referenceCode}: ${result.quantity}x ${result.item} (${result.department}).`
            : `Your existing request #${result.referenceCode} for ${result.item} is already with ${result.department}.`;

      await addDoc(collection(db, `hotels/${hotelId}/sessions/${sessionId}/messages`), {
        sender: 'system',
        guestUid,
        text: confirmationMsg,
        timestamp: serverTimestamp(),
      });

      setQuickFeedback({ type: 'success', text: confirmationMsg });
      setSelectedTemplate(null);
      setQuickNotes('');
    } catch (err: any) {
      console.error('Quick request failed:', err);
      setQuickFeedback({
        type: 'error',
        text: 'We could not submit your request just now. Please try again or tap Speak with Staff.',
      });
    } finally {
      setQuickSubmitting(false);
    }
  };

  const handleReopenRequest = async (req: Request) => {
    if (!sessionId || !guestUid) return;
    try {
      await reopenGuestRequest(hotelId, req.id);
      await addDoc(collection(db, `hotels/${hotelId}/sessions/${sessionId}/messages`), {
        sender: 'system',
        guestUid,
        text: `Request #${req.referenceCode || req.id.slice(0, 4).toUpperCase()} (${req.item}) was reopened and escalated to staff.`,
        timestamp: serverTimestamp(),
      });
    } catch (err) {
      console.error('Failed to reopen request:', err);
    }
  };

  if (ended || resumeId) {
    return <main className="flex items-center justify-center h-full bg-slate-50 p-6"><div className="max-w-sm bg-white border rounded-2xl p-6 space-y-4 text-center">
      <h1 className="font-semibold text-lg">{ended?'Chat ended':'Conversation paused'}</h1>
      <p className="text-sm text-slate-600">{ended?'This conversation is no longer available to you. Outstanding service requests remain with the hotel team.':'For privacy, your previous conversation is hidden after inactivity. Resume only if this is your conversation.'}</p>
      {!ended&&<button className="w-full bg-indigo-600 text-white rounded-lg p-3" onClick={()=>{try{const v=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(v?.id===resumeId&&Date.now()-v.at<86400000)rememberSession(resumeId!);else forgetSession();}catch{forgetSession();}window.location.reload();}}>Resume my conversation</button>}
      <button className="w-full border rounded-lg p-3" onClick={()=>{forgetSession();window.location.reload();}}>Start a new chat</button>
    </div></main>;
  }

  if (initError) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-50 p-6 text-center">
        <div className="bg-white border border-red-200 rounded-2xl p-6 shadow-sm max-w-xs">
          <p className="text-sm font-semibold text-slate-900 mb-1">Guest Concierge Unavailable</p>
          <p className="text-xs text-red-700 leading-relaxed">{initError}</p>
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  const openRequestsCount = guestRequests.filter(
    (r) => !['completed', 'cancelled'].includes(r.status)
  ).length;

  const statusText =
    session?.status === 'staff_controlled'
      ? 'Staff Connected'
      : session?.status === 'awaiting_human'
        ? 'Associate Notified'
        : session?.status === 'escalated'
          ? 'Priority Review'
          : 'Ren Concierge';

  const currentLocationText =
    session?.locationLabel || (session?.roomNumber ? `Room ${session.roomNumber}` : 'Set room / location');

  return (
    <div className="flex flex-col h-full bg-slate-50 text-slate-900">
      {/* Compact Sticky Mobile Header */}
      <header className="bg-white border-b border-slate-200 px-4 py-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-display font-semibold text-slate-900 text-sm truncate">
              {hotelConfig?.name || 'Hotel Concierge'}
            </h1>
            <div className="flex items-center gap-1.5 text-xs text-slate-500 truncate">
              <button
                type="button"
                disabled={!!session?.roomMoveAt}
                onClick={() => {
                  setLocationDraft(session?.roomNumber || '');
                  setShowLocationEditor((v) => !v);
                }}
                className="text-indigo-600 hover:text-indigo-800 font-medium underline underline-offset-2 truncate"
              >
                {currentLocationText}
              </button>
              <span aria-hidden="true">·</span>
              <span className="whitespace-nowrap">{statusText}</span>
              <span className="font-mono shrink-0" title={sessionId || undefined}>#{sessionId.slice(0, 8)}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleRequestStaff}
            disabled={session?.status === 'staff_controlled' || session?.status === 'awaiting_human'}
            className="min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-60 whitespace-nowrap shrink-0 transition-colors"
          >
            {session?.status === 'staff_controlled'
              ? 'Staff Active'
              : session?.status === 'awaiting_human'
                ? 'Staff Notified'
                : 'Speak with Staff'}
          </button>
        </div>

        <div className="flex justify-end mt-1"><button type="button" disabled={isSending||isThinking||quickSubmitting} onClick={async()=>{if(!window.confirm('End this chat? Outstanding requests will remain with the hotel team.'))return;try{await updateDoc(doc(db,'hotels',hotelId,'sessions',sessionId),{guestEndedAt:serverTimestamp(),lastUpdatedAt:serverTimestamp()});}catch{setChatError('Could not confirm that this conversation ended. Please reconnect and try again.');return;}forgetSession();setEnded(true);setResumeId(null);setSessionId(null);setMessages([]);setGuestRequests([]);setSession(null);setInputText('');setPendingGuestMessages([]);}} className="text-xs text-slate-600 underline disabled:opacity-50">End Chat</button></div>

        {/* Inline Location Selector */}
        {showLocationEditor && (
          <form onSubmit={handleSaveLocation} className="mt-2.5 pt-2.5 border-t border-slate-100 flex gap-2">
            <input
              type="text"
              value={locationDraft}
              onChange={(e) => setLocationDraft(e.target.value)}
              placeholder="Enter room # or location (e.g. 412, Pool)"
              maxLength={50}
              className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              type="submit"
              disabled={savingLocation || !locationDraft.trim()}
              className="min-h-[36px] px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
            >
              {savingLocation ? 'Saving...' : 'Save'}
            </button>
          </form>
        )}

        {/* Segmented Companion Tabs */}
        <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-lg mt-2.5">
          <button
            type="button"
            onClick={() => setActiveView('chat')}
            className={`min-h-[36px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeView === 'chat'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Chat
          </button>
          <button
            type="button"
            onClick={() => setActiveView('quick')}
            className={`min-h-[36px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeView === 'quick'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Quick Request
          </button>
          <button
            type="button"
            onClick={() => setActiveView('requests')}
            className={`min-h-[36px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
              activeView === 'requests'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            My Requests ({openRequestsCount})
          </button>
          <button type="button" onClick={()=>setActiveView('dining')} className={`min-h-[36px] px-2 py-1.5 text-xs font-medium rounded-md ${activeView==='dining'?'bg-white text-slate-900 shadow-sm':'text-slate-600'}`}>Dining</button>
        </div>
      </header>

      {/* VIEW 1: CHAT */}
      {sessionId&&<GuestDining key={sessionId} hotelId={hotelId} sessionId={sessionId} visible={activeView==='dining'}/>}

      {activeView === 'chat' && (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {hotelConfig?.emergencyPhone && (
              <div className="text-[11px] text-slate-500 text-center pb-1">
                Front Desk &amp; Urgent Assistance: <span className="font-mono font-medium text-slate-700">{hotelConfig.emergencyPhone}</span>
              </div>
            )}

            {messages.length === 0 && pendingGuestMessages.length === 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
                <p className="text-sm font-medium text-slate-900">
                  Welcome to {hotelConfig?.name || 'our hotel'}.
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Ask about hotel hours, local recommendations, or request items for your stay in any language.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {[
                    'What time is breakfast?',
                    'I need 2 fresh towels',
                    'Things to do nearby',
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      disabled={isSending || !session}
                      onClick={() => sendGuestMessage(prompt)}
                      className="min-h-[36px] text-left text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-50 text-slate-700 transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => {
              if (msg.sender === 'system') {
                return (
                  <div key={msg.id} className="flex justify-center my-1">
                    <div className="bg-slate-100 border border-slate-200 text-slate-700 text-xs px-3.5 py-2 rounded-xl max-w-[92%] text-center leading-relaxed">
                      {msg.text}
                    </div>
                  </div>
                );
              }

              const isGuest = msg.sender === 'guest';
              const isStaff = msg.sender === 'staff';
              const hasGuestTranslation = isStaff && Boolean(msg.guestText && msg.guestText !== msg.text);
              const displayMsgText = hasGuestTranslation ? msg.guestText! : msg.text;
              const showOriginal = Boolean(expandedOriginals[msg.id]);

              return (
                <div key={msg.id} className={`flex ${isGuest ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-line leading-relaxed ${
                      isGuest
                        ? 'bg-indigo-600 text-white rounded-br-sm'
                        : isStaff
                          ? 'bg-slate-900 text-white rounded-bl-sm'
                          : 'bg-white text-slate-800 border border-slate-200 rounded-bl-sm'
                    }`}
                  >
                    {!isGuest && (
                      <div
                        className={`text-[10px] font-semibold mb-1 ${
                          isStaff ? 'text-indigo-200' : 'text-slate-400'
                        }`}
                      >
                        {isStaff ? 'Hotel Associate' : 'Ren Concierge'}
                      </div>
                    )}
                    <div>{displayMsgText.split(/(https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=[^\s<]+)/g).map((part, i) => part.startsWith('https://www.google.com/maps/search/?api=1&query=') && !isGuest ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline font-medium break-all">Explore nearby options on Google Maps</a> : <React.Fragment key={i}>{part}</React.Fragment>)}</div>
                    {hasGuestTranslation && (
                      <div className="mt-1.5 pt-1.5 border-t border-white/15 text-[11px] text-indigo-200 flex items-center justify-between gap-2">
                        <span>Translated from English</span>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedOriginals((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))
                          }
                          className="underline hover:text-white"
                        >
                          {showOriginal ? 'Hide' : 'Original'}
                        </button>
                      </div>
                    )}
                    {hasGuestTranslation && showOriginal && (
                      <div className="mt-1 text-xs text-slate-300 italic">{msg.text}</div>
                    )}
                    {sessionId && session?.status==='active' && !isThinking && !isSending && msg.sender==='ai' && msg.id.startsWith('ai-') && msg.id===messages[messages.length-1]?.id && messages.some(m=>m.sender==='guest'&&m.id===msg.id.slice(3)&&closingText(m.text)) && guestRequests.every(r=>['completed','cancelled'].includes(r.status)) && <ResponseFeedback key={sessionId+':'+msg.id} hotelId={hotelId} sessionId={sessionId} messageId={msg.id} />}
                  </div>
                </div>
              );
            })}

            {pendingGuestMessages.map((pending) => (
              <div key={pending.localId} className="flex justify-end">
                <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-sm text-sm whitespace-pre-line leading-relaxed bg-indigo-600/80 text-white">
                  <div>{pending.text}</div>
                  <div className="text-[10px] text-indigo-100 mt-1">Sending...</div>
                </div>
              </div>
            ))}

            {chatError && (
              <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3">
                <span>{chatError}</span>
                <button
                  type="button"
                  onClick={() => setChatError(null)}
                  className="text-red-700 hover:text-red-900 font-semibold shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            {isThinking && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-bl-sm flex gap-1.5 items-center">
                  <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" />
                  <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:120ms]" />
                  <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:240ms]" />
                </div>
              </div>
            )}
          </div>

          <div className="bg-white p-3 border-t border-slate-200 shrink-0">
            {session?.status === 'staff_controlled' && (
              <div className="text-[11px] text-slate-500 mb-2 px-1">
                Direct staff chat is active — a hotel associate is replying here.
              </div>
            )}
            {session?.status === 'completed' && (
              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 mb-2">
                <span>This conversation was marked resolved. Send a message to reopen, or</span>
                <button
                  type="button"
                  onClick={handleStartNewSession}
                  className="font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
                >
                  New Chat
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                className="flex-1 min-h-[44px] bg-slate-100 text-slate-900 text-sm rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder={
                  session?.status === 'staff_controlled'
                    ? 'Message our hotel associate...'
                    : 'Ask Ren or request a service...'
                }
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                disabled={isThinking}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!inputText.trim() || isSending || !session}
                aria-label="Send message"
                className="min-w-[44px] min-h-[44px] bg-indigo-600 rounded-xl flex items-center justify-center text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                  <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}

      {/* VIEW 2: DETERMINISTIC QUICK REQUESTS */}
      {activeView === 'quick' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Direct Service Requests</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Submit common requests directly to hotel staff with instant confirmation.
            </p>
          </div>

          {quickFeedback && (
            <div
              className={`p-3 rounded-xl border text-xs leading-relaxed ${
                quickFeedback.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {quickFeedback.text}
            </div>
          )}

          {selectedTemplate ? (
            <form
              onSubmit={handleSubmitQuickRequest}
              className="bg-white border border-slate-200 rounded-2xl p-4 space-y-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs text-slate-500">{selectedTemplate.department}</div>
                  <h3 className="text-base font-semibold text-slate-900">
                    {selectedTemplate.item}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTemplate(null)}
                  className="text-xs font-medium text-slate-500 hover:text-slate-800 min-h-[36px] px-2"
                >
                  Change
                </button>
              </div>

              {selectedTemplate.supportsQuantity && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Quantity
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setQuickQty((q) => Math.max(1, q - 1))}
                      className="min-w-[44px] min-h-[44px] rounded-xl border border-slate-300 bg-white text-slate-900 font-semibold hover:bg-slate-50"
                    >
                      -
                    </button>
                    <span className="font-mono text-base font-semibold w-8 text-center tabular-nums">
                      {quickQty}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQuickQty((q) => Math.min(10, q + 1))}
                      className="min-w-[44px] min-h-[44px] rounded-xl border border-slate-300 bg-white text-slate-900 font-semibold hover:bg-slate-50"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Room or Delivery Location
                </label>
                <input
                  type="text"
                  required
                  maxLength={50}
                  value={session?.roomMoveAt ? session.roomNumber || '' : quickLocationInput}
                  readOnly={!!session?.roomMoveAt}
                  onChange={(e) => setQuickLocationInput(e.target.value)}
                  placeholder="e.g. Room 412 or Pool Deck"
                  className="w-full min-h-[44px] border border-slate-300 rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Additional Details (Optional)
                </label>
                <textarea
                  rows={2}
                  maxLength={300}
                  value={quickNotes}
                  onChange={(e) => setQuickNotes(e.target.value)}
                  placeholder="Any helpful notes for our team..."
                  className="w-full border border-slate-300 rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <button
                type="submit"
                disabled={quickSubmitting}
                className="w-full min-h-[46px] bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60"
              >
                {quickSubmitting ? 'Submitting Request...' : 'Submit Request'}
              </button>
            </form>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {QUICK_REQUEST_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => handleSelectTemplate(tpl)}
                  className="min-h-[76px] text-left bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 rounded-xl p-3.5 transition-colors flex flex-col justify-between"
                >
                  <span className="text-xs font-semibold text-slate-900 leading-snug">
                    {tpl.item}
                  </span>
                  <span className="text-[11px] text-slate-500 mt-1.5">
                    {tpl.department}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* VIEW 3: MY REQUESTS TRACKER */}
      {activeView === 'requests' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Your Session Requests</h2>
            <button
              type="button"
              onClick={() => setActiveView('quick')}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              + New Request
            </button>
          </div>

          {guestRequests.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center space-y-3">
              <p className="text-xs text-slate-600">
                You have not submitted any service requests in this session yet.
              </p>
              <button
                type="button"
                onClick={() => setActiveView('quick')}
                className="min-h-[40px] px-4 py-2 bg-indigo-600 text-white text-xs font-medium rounded-xl hover:bg-indigo-700"
              >
                Browse Quick Requests
              </button>
            </div>
          ) : (
            guestRequests.map((req) => {
              const refCode = req.referenceCode || `R-${req.id.slice(0, 4).toUpperCase()}`;
              const statusLabel = GUEST_STATUS_LABELS[req.status] || req.status;
              return (
                <div
                  key={req.id}
                  className="bg-white border border-slate-200 rounded-xl p-4 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-700 tabular-nums">
                      #{refCode}
                    </span>
                    <span className="tabular-nums">
                      {req.createdAt?.toDate().toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-slate-900">
                    {req.quantity && req.quantity > 1 ? `${req.quantity}x ` : ''}
                    {req.item}
                  </div>
                  {req.description && req.description !== req.item && (
                    <p className="text-xs text-slate-600">{req.description}</p>
                  )}
                  <div className="flex items-center justify-between gap-2 pt-1 text-xs">
                    <div className="text-slate-500">
                      <span>{req.department || req.category}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{req.roomNumber}</span>
                    </div>
                    <span
                      className={`font-semibold ${
                        req.status === 'completed'
                          ? 'text-emerald-700'
                          : req.status === 'escalated' || req.status === 'reopened'
                            ? 'text-red-700'
                            : 'text-indigo-700'
                      }`}
                    >
                      {statusLabel}
                    </span>
                  </div>

                  {req.status === 'completed' && (
                    <div className="pt-2 border-t border-slate-100 flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleReopenRequest(req)}
                        className="text-xs font-medium text-amber-700 hover:text-amber-900 min-h-[36px] px-2"
                      >
                        Still need assistance? Reopen
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
