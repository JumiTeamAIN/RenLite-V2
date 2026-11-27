import {isOutstanding,priorityRank,compareRequests,outstandingPriorities,compareSessions,newUrgentIds} from '../services/priorityOperations';
import {extractFaqFile,reviewFaqs} from '../services/documentFaq';
import {hasInvalidFaqText,type FaqDraft} from '../services/faqImport';
import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { TeamManagement } from './TeamManagement';
import { Insights } from './Insights';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  getDoc,
  updateDoc,
  writeBatch,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth, db, OperationType, handleFirestoreError } from '../services/firebase';
import {
  translateText,
  translateMessagesBatchToEnglish,
  isTranslationBackedOff,
} from '../services/clientAi';
import {
  Session,
  Message,
  Request,
  HotelConfig,
  HotelLocation,
  LocationType,
} from '../types';

interface AdminPortalProps {
  hotelId: string;
}

const SESSION_STATUS_LABELS: Record<string, string> = {
  active: 'AI Active',
  awaiting_human: 'Waiting for Staff',
  staff_controlled: 'Staff Active',
  escalated: 'Escalated',
  completed: 'Resolved',
};

const REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In Progress',
  completed: 'Completed',
  escalated: 'Escalated',
  reopened: 'Reopened',
  cancelled: 'Cancelled',
};

const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English (No translation)' },
  { code: 'es', label: 'Spanish (ES)' },
  { code: 'fr', label: 'French (FR)' },
  { code: 'pt', label: 'Portuguese (PT)' },
  { code: 'de', label: 'German (DE)' },
  { code: 'it', label: 'Italian (IT)' },
  { code: 'zh', label: 'Chinese (ZH)' },
  { code: 'ja', label: 'Japanese (JA)' },
  { code: 'ko', label: 'Korean (KO)' },
  { code: 'ar', label: 'Arabic (AR)' },
  { code: 'ru', label: 'Russian (RU)' },
];

export const AdminPortal: React.FC<AdminPortalProps> = ({ hotelId }) => {
  const [activeTab, setActiveTab] = useState<'inbox' | 'requests' | 'locations' | 'config' | 'team' | 'insights'>('inbox');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [requestsReady, setRequestsReady] = useState(false);
  const [sessionsError, setSessionsError] = useState('');
  const [requestsError, setRequestsError] = useState('');
  const [soundEnabled,setSoundEnabled]=useState(false);
  const [soundError,setSoundError]=useState('');
  const audioRef=useRef<AudioContext|null>(null);
  const seenUrgent=useRef<Set<string>|null>(null);
  const [focusedRequest,setFocusedRequest]=useState<string|null>(null);
  const playAlert=()=>{
    const audio=audioRef.current;
    if(!audio||audio.state!=='running')return false;
    try{
      for(let i=0;i<2;i++){
        const tone=audio.createOscillator(),gain=audio.createGain(),at=audio.currentTime+i*.32;
        tone.type='sine';tone.frequency.value=660;gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(.16,at+.025);gain.gain.linearRampToValueAtTime(0,at+.22);tone.connect(gain);gain.connect(audio.destination);tone.start(at);tone.stop(at+.23);
      }
      return true;
    }catch{return false;}
  };
  const toggleSound=async()=>{
    if(soundEnabled){setSoundEnabled(false);return;}
    try{const audio=audioRef.current||new AudioContext();audioRef.current=audio;await audio.resume();if(!playAlert())throw Error();setSoundEnabled(true);setSoundError('');}
    catch{setSoundEnabled(false);setSoundError('Sound unavailable in this browser. Keep visual alerts in view.');}
  };
  useEffect(()=>()=>{audioRef.current?.close().catch(()=>{});audioRef.current=null;},[]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState('');
  const [replyTargetLang, setReplyTargetLang] = useState<string>('auto');
  const [sendingStaffReply, setSendingStaffReply] = useState(false);
  const [staffReplyError, setStaffReplyError] = useState<string | null>(null);
  const [expandedStaffOriginals, setExpandedStaffOriginals] = useState<Record<string, boolean>>({});
  const translatedAttemptedRef = useRef<Set<string>>(new Set());
  const [hotelConfig, setHotelConfig] = useState<HotelConfig | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [staffIdentity, setStaffIdentity] = useState('');
  const [signOutError, setSignOutError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const handleSignOut = async () => {
    setSigningOut(true); setSignOutError('');
    try { await signOut(auth); window.location.hash = '#/login'; }
    catch { setSignOutError('Unable to sign out. Please try again.'); }
    finally { setSigningOut(false); }
  };
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [staffRole, setStaffRole] = useState<'admin' | 'manager' | 'associate' | 'legacy' | null>(null);

  // Filters
  const [inboxFilter, setInboxFilter] = useState<
    'all' | 'attention' | 'ai' | 'staff' | 'resolved'
  >('all');
  const [requestStatusFilter, setRequestStatusFilter] = useState<'open' | 'completed' | 'all'>('open');
  const [departmentFilter, setDepartmentFilter] = useState<string>('All');

  // Editable configuration state
  const [configName, setConfigName] = useState('');
  const [configEmergencyPhone, setConfigEmergencyPhone] = useState('');
  const [configPersona, setConfigPersona] = useState('');
  const [configFaqs, setConfigFaqs] = useState<FaqDraft[]>([]);
  const [configSlas, setConfigSlas] = useState({
    housekeeping: 15,
    maintenance: 30,
    front_desk: 5,
  });
  const [savingConfig, setSavingConfig] = useState(false);
  const [searchTest, setSearchTest] = useState('What are some dining options for a couple? We’re looking for happy hour.');
  const [searchTesting, setSearchTesting] = useState(false);
  const [searchReport, setSearchReport] = useState<{ intentDetected?: boolean; area?: string; attempts?: { model: string; outcome: string; elapsedMs: number; sourceCount?: number; status?: number }[]; text?: string; error?: string } | null>(null);
  const runSearchTest = async () => {
    if (searchTesting || !searchTest.trim() || !hotelConfig || !auth.currentUser) return;
    setSearchTesting(true);
    setSearchReport(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const token = await auth.currentUser.getIdToken();
      const response = await fetch('/api/gemini/concierge', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: controller.signal, body: JSON.stringify({ hotelName: hotelConfig.name, persona: hotelConfig.persona, faqs: hotelConfig.faqs || [], latestGuestMessage: searchTest.trim(), transcript: `Guest: ${searchTest.trim()}` }) });
      const data = await response.json();
      setSearchReport({ ...data.searchDiagnostics, text: data.text, error: response.ok ? undefined : (data.error || `HTTP ${response.status}`) });
    } catch (err) {
      setSearchReport({ error: err instanceof Error ? err.message : 'Search test failed' });
    } finally {
      clearTimeout(timer);
      setSearchTesting(false);
    }
  };
  const [configFeedback, setConfigFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const faqFileInputRef = useRef<HTMLInputElement>(null);
  const [faqImportBusy,setFaqImportBusy]=useState(false);
  const [faqReview,setFaqReview]=useState<{name:string;items:FaqDraft[];duplicates:number;conflicts:number}|null>(null);

  // Locations & QR Codes state
  const [locations, setLocations] = useState<HotelLocation[]>([]);
  const [qrPreviews, setQrPreviews] = useState<Record<string, string>>({});
  const [newLocCode, setNewLocCode] = useState('');
  const [newLocLabel, setNewLocLabel] = useState('');
  const [newLocType, setNewLocType] = useState<LocationType>('room');
  const [rangeStart, setRangeStart] = useState('101');
  const [rangeEnd, setRangeEnd] = useState('105');
  const [savingLocations, setSavingLocations] = useState(false);
  const [locationsFeedback, setLocationsFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribeMember: (() => void) | undefined;
    let generation = 0;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      generation++;
      unsubscribeMember?.();
      setIsAuthReady(false);
      setIsAuthenticated(false);
      setStaffRole(null);
      setSessionsReady(false); setRequestsReady(false); setSessionsError(''); setRequestsError('');
      setStaffIdentity(user?.displayName || user?.email || '');
      setSessions([]);
      setRequests([]);
      setChatMessages([]);
      setSelectedSessionId(null);
      setHotelConfig(null);
      setActiveTab('inbox');
      const grant = (role: 'admin' | 'manager' | 'associate' | 'legacy' | null) => {
        setStaffRole(role);
        setIsAuthenticated(Boolean(role));
        setIsAuthReady(true);
        if (!role) {
          setSessions([]); setRequests([]); setChatMessages([]); setSelectedSessionId(null);
          setHotelConfig(null); setLocations([]); setConfigFaqs([]); setActiveTab('inbox');
        }
      };
      if (!user || user.isAnonymous) { grant(null); return; }
      if (user.uid === hotelId) { grant('admin'); return; }
      // Preserve the existing verified sandbox operator only; never grant a new global role.
      if (hotelId === 'test-hotel-001' && user.emailVerified && user.email === 'jumi@teamain.org') { grant('legacy'); return; }
      if (!user.emailVerified) { grant(null); return; }
      const current = generation;
      unsubscribeMember = onSnapshot(doc(db, 'hotels', hotelId, 'members', user.uid), snap => {
        if (current !== generation) return;
        const data = snap.data();
        const role = data?.role;
        grant(data?.active === true && ['admin','manager','associate'].includes(role) ? role : null);
      }, () => { if (current === generation) grant(null); });
    });
    return () => { generation++; unsubscribeMember?.(); unsubscribe(); };
  }, [hotelId]);

  const canConfigure = staffRole === 'admin' || staffRole === 'manager' || staffRole === 'legacy';
  const canManageTeam = staffRole === 'admin' || staffRole === 'legacy';

  useEffect(() => {
    if ((!canConfigure && ['locations','config','insights'].includes(activeTab)) || (!canManageTeam && activeTab === 'team')) setActiveTab('inbox');
  }, [activeTab, canConfigure, canManageTeam]);

  // Load Config
  useEffect(() => {
    if (!isAuthReady || !isAuthenticated) return;
    const fetchConfig = async () => {
      const path = `hotels/${hotelId}`;
      try {
        const snap = await getDoc(doc(db, 'hotels', hotelId));
        if (snap.exists()) {
          const data = snap.data() as HotelConfig;
          setHotelConfig(data);
          setConfigName(data.name || '');
          setConfigEmergencyPhone(data.emergencyPhone || '');
          setConfigPersona(data.persona || '');
          setConfigFaqs(Array.isArray(data.faqs) ? data.faqs : []);
          setLocations(Array.isArray(data.locations) ? data.locations : []);
          setConfigSlas({
            housekeeping: data.slas?.housekeeping ?? 15,
            maintenance: data.slas?.maintenance ?? 30,
            front_desk: data.slas?.front_desk ?? 5,
          });
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, path);
      }
    };
    fetchConfig();
  }, [hotelId, isAuthReady, isAuthenticated]);

  // Generate QR data URLs whenever locations change
  useEffect(() => {
    let cancelled = false;
    const generateQrs = async () => {
      const origin = window.location.origin;
      const next: Record<string, string> = {};
      for (const loc of locations) {
        const url = `${origin}/#/g/${hotelId}?loc=${encodeURIComponent(loc.code)}`;
        try {
          next[loc.id] = await QRCode.toDataURL(url, {
            width: 180,
            margin: 1,
            color: { dark: '#0f172a', light: '#ffffff' },
          });
        } catch {
          // Skip broken code generation
        }
      }
      if (!cancelled) setQrPreviews(next);
    };
    if (locations.length > 0) {
      generateQrs();
    } else {
      setQrPreviews({});
    }
    return () => {
      cancelled = true;
    };
  }, [locations, hotelId]);

  useEffect(()=>{
    if(!isAuthenticated){seenUrgent.current=null;setSoundEnabled(false);return;}
    if(!requestsReady||requestsError)return;
    const current=new Set(requests.filter(r=>isOutstanding(r)&&priorityRank(r)===2).map(r=>r.id));
    const added=seenUrgent.current===null?[]:newUrgentIds(seenUrgent.current,requests);
    seenUrgent.current=current;
    if(soundEnabled&&added.length&&!playAlert())setSoundError('Alert sound could not play. Check browser audio and keep visual alerts in view.');
  },[requests,requestsReady,requestsError,isAuthenticated,soundEnabled]);
  useEffect(()=>{
    if(activeTab!=='requests'||!focusedRequest)return;
    document.getElementById('request-card-'+focusedRequest)?.scrollIntoView({block:'center',behavior:'smooth'});
    document.getElementById('request-card-'+focusedRequest)?.focus({preventScroll:true});
  },[activeTab,focusedRequest,requestStatusFilter,departmentFilter]);

  // Load Sessions
  useEffect(() => {
    if (!isAuthReady || !isAuthenticated) return;
    const path = `hotels/${hotelId}/sessions`;
    const q = query(collection(db, path), orderBy('lastUpdatedAt', 'desc'));
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        setSessions(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Session)));
        setSessionsReady(!snap.metadata.fromCache); setSessionsError('');
      },
      (error) => {
        setSessionsReady(false); setSessionsError('Unable to load sessions. Check connection and hotel access.');
      }
    );
  }, [hotelId, isAuthReady, isAuthenticated]);

  // Load Requests
  useEffect(() => {
    if (!isAuthReady || !isAuthenticated) return;
    const path = `hotels/${hotelId}/requests`;
    const q = query(collection(db, path), orderBy('createdAt', 'desc'));
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Request)));
        setRequestsReady(!snap.metadata.fromCache); setRequestsError('');
      },
      (error) => {
        setRequestsReady(false); setRequestsError('Unable to load requests. Check connection and hotel access.');
      }
    );
  }, [hotelId, isAuthReady, isAuthenticated]);

  // Load Chat Messages
  useEffect(() => {
    if (!isAuthReady || !isAuthenticated || !selectedSessionId) return;
    const path = `hotels/${hotelId}/sessions/${selectedSessionId}/messages`;
    const q = query(collection(db, path), orderBy('timestamp', 'asc'));
    return onSnapshot(
      q,
      (snap) => {
        setChatMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Message)));
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );
  }, [selectedSessionId, hotelId, isAuthReady, isAuthenticated]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) || null;
  const selectedSessionRequests = requests.filter((r) => r.sessionId === selectedSessionId);
  const [moveReview,setMoveReview]=useState<{sessionId:string;fromRoom:string;moveId:string;requests:Request[]}|null>(null);
  const [moveDestination,setMoveDestination]=useState('');
  const [moveDecisions,setMoveDecisions]=useState<Record<string,string>>({});
  const [moveBusy,setMoveBusy]=useState(false);
  const [moveError,setMoveError]=useState('');
  const beginMove=()=>{
    if(!selectedSession?.roomNumber)return;
    setMoveReview({sessionId:selectedSession.id,fromRoom:selectedSession.roomNumber,moveId:crypto.randomUUID(),requests:selectedSessionRequests.filter(r=>!['completed','cancelled'].includes(r.status))});
    setMoveDestination('');setMoveDecisions({});setMoveError('');
  };
  const confirmMove=async()=>{
    if(!moveReview||!moveDestination||!auth.currentUser||moveBusy)return;
    setMoveBusy(true);setMoveError('');
    try{
      const response=await fetch('/api/team/room-move',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()},body:JSON.stringify({hotelId,sessionId:moveReview.sessionId,moveId:moveReview.moveId,fromRoom:moveReview.fromRoom,destinationId:moveDestination,decisions:moveReview.requests.map(r=>({id:r.id,room:r.roomNumber,status:r.status,action:moveDecisions[r.id]}))})});
      if(!response.ok)throw Error((await response.json()).error||'Room move failed.');
      setMoveReview(null);
    }catch(e:any){setMoveError(e.message||'Unable to confirm room move.');}finally{setMoveBusy(false);}
  };

  const detectedGuestLang = (selectedSession?.guestLanguage || 'en').trim().toLowerCase();
  const effectiveReplyTargetLang =
    replyTargetLang === 'auto' ? detectedGuestLang || 'en' : replyTargetLang;
  const shouldTranslateStaffReply =
    Boolean(effectiveReplyTargetLang) &&
    effectiveReplyTargetLang !== 'en' &&
    !effectiveReplyTargetLang.startsWith('en-');

  useEffect(() => {
    setReplyTargetLang('auto');
    setStaffReplyError(null);
  }, [selectedSessionId]);

  // Backfill English staffText for existing/incoming non-English guest or AI messages in a single batch
  useEffect(() => {
    if (
      !isAuthReady ||
      !isAuthenticated ||
      !selectedSessionId ||
      chatMessages.length === 0 ||
      isTranslationBackedOff()
    ) {
      return;
    }

    const sessionIsNonEnglish =
      Boolean(detectedGuestLang) && !detectedGuestLang.startsWith('en');

    const candidates = chatMessages
      .filter((m) => {
        if (m.sender !== 'guest' && m.sender !== 'ai') return false;
        if (m.staffText) return false;
        if (translatedAttemptedRef.current.has(m.id)) return false;
        const looksNonAscii = /[^\x00-\x7F]|[¿¡]/.test(m.text);
        return sessionIsNonEnglish || looksNonAscii;
      })
      .slice(-10);

    if (candidates.length === 0) return;

    for (const msg of candidates) {
      translatedAttemptedRef.current.add(msg.id);
    }

    let cancelled = false;
    const translateMissing = async () => {
      const updated = await translateMessagesBatchToEnglish(
        hotelId,
        selectedSessionId,
        candidates.map((m) => ({ id: m.id, text: m.text }))
      );
      if (cancelled || updated.length === 0) return;

      const latestMsgId = chatMessages[chatMessages.length - 1]?.id;
      const latestTranslated = updated.find((u) => u.id === latestMsgId);
      const firstDetectedLang = updated.find(
        (u) => u.detectedLanguage && !u.detectedLanguage.startsWith('en')
      )?.detectedLanguage;

      const needsLangUpdate =
        Boolean(firstDetectedLang) &&
        (!selectedSession?.guestLanguage || selectedSession.guestLanguage === 'en');

      if (latestTranslated || needsLangUpdate) {
        try {
          await updateDoc(doc(db, `hotels/${hotelId}/sessions/${selectedSessionId}`), {
            lastUpdatedAt: serverTimestamp(),
            ...(latestTranslated
              ? { previewStaffText: latestTranslated.staffText.slice(0, 5000) }
              : {}),
            ...(needsLangUpdate && firstDetectedLang ? { guestLanguage: firstDetectedLang } : {}),
          });
        } catch {
          // Non-blocking preview sync
        }
      }
    };

    translateMissing();
    return () => {
      cancelled = true;
    };
  }, [
    chatMessages,
    selectedSessionId,
    detectedGuestLang,
    selectedSession?.guestLanguage,
    hotelId,
    isAuthReady,
    isAuthenticated,
  ]);

  const handleStaffReply = async () => {
    if (!selectedSessionId || !selectedSession?.guestUid || !replyText.trim() || !auth.currentUser || sendingStaffReply) return;
    const path = `hotels/${hotelId}/sessions/${selectedSessionId}/messages`;
    const sessionPath = `hotels/${hotelId}/sessions/${selectedSessionId}`;
    const trimmed = replyText.trim().slice(0, 5000);

    setSendingStaffReply(true);
    setStaffReplyError(null);

    try {
      let guestTranslated = '';
      if (shouldTranslateStaffReply) {
        try {
          const translated = await translateText(trimmed, effectiveReplyTargetLang, 'en');
          guestTranslated = translated.translatedText.trim().slice(0, 5000);
        } catch (transErr) {
          const errMessage =
            transErr instanceof Error ? transErr.message : 'Translation failed.';
          setStaffReplyError(
            `Could not translate reply to ${effectiveReplyTargetLang.toUpperCase()} (${errMessage}). Retry or switch language to English.`
          );
          setSendingStaffReply(false);
          return;
        }
      }

      const hasGuestTranslation = Boolean(
        shouldTranslateStaffReply && guestTranslated && guestTranslated !== trimmed
      );

      const messageId=doc(collection(db,path)).id;
      const response=await fetch('/api/insights/staff-action',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()},body:JSON.stringify({hotelId,sessionId:selectedSessionId,action:'reply',messageId,text:trimmed,...(hasGuestTranslation?{guestText:guestTranslated,targetLanguage:effectiveReplyTargetLang}: {})})});
      if(!response.ok)throw new Error('Staff reply could not be confirmed.');
      setReplyText('');
    } catch (err) {
      console.error('Staff reply failed:', err);
      setStaffReplyError('Reply could not be confirmed. Check your connection and conversation before retrying.');
    } finally {
      setSendingStaffReply(false);
    }
  };

  const handleTakeOver = async (sess: Session) => {
    if (!auth.currentUser) return;
    const sessionPath = `hotels/${hotelId}/sessions/${sess.id}`;
    const msgsPath = `hotels/${hotelId}/sessions/${sess.id}/messages`;
    try {
      const messageId=doc(collection(db,msgsPath)).id;
      const response=await fetch('/api/insights/staff-action',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()},body:JSON.stringify({hotelId,sessionId:sess.id,action:'takeover',messageId})});
      if(!response.ok)throw new Error('Takeover could not be confirmed.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, sessionPath);
    }
  };

  const handleReturnToAI = async (sess: Session) => {
    if (!auth.currentUser) return;
    const sessionPath = `hotels/${hotelId}/sessions/${sess.id}`;
    const msgsPath = `hotels/${hotelId}/sessions/${sess.id}/messages`;
    try {
      await updateDoc(doc(db, sessionPath), {
        lastUpdatedAt: serverTimestamp(),
        isUnread: false,
        status: 'active',
      });
      await addDoc(collection(db, msgsPath), {
        sender: 'system',
        ...(sess.guestUid ? { guestUid: sess.guestUid } : {}),
        staffUid: auth.currentUser.uid,
        text: 'The hotel associate has returned this conversation to Ren Concierge. If automated assistance is unavailable, your message will be routed to staff.',
        timestamp: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, sessionPath);
    }
  };

  const handleResolveSession = async (sess: Session) => {
    const sessionPath = `hotels/${hotelId}/sessions/${sess.id}`;
    try {
      await updateDoc(doc(db, sessionPath), {
        lastUpdatedAt: serverTimestamp(),
        isUnread: false,
        status: 'completed',
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, sessionPath);
    }
  };

  const handleRequestTransition = async (
    req: Request,
    nextStatus: 'acknowledged' | 'in_progress' | 'completed' | 'escalated'
  ) => {
    const path = `hotels/${hotelId}/requests/${req.id}`;
    try {
      await updateDoc(doc(db, path), {
        status: nextStatus,
        lastUpdated: serverTimestamp(),
        ...(nextStatus === 'acknowledged' ? { acknowledgedAt: serverTimestamp() } : {}),
        ...(nextStatus === 'completed' ? { completedAt: serverTimestamp() } : {}),
        ...(nextStatus === 'escalated' ? { priority: 'urgent' } : {}),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const handleAddFaq = () => {
    if (configFaqs.length >= 100) {
      setConfigFeedback({ type: 'error', text: 'Maximum of 100 FAQs reached.' });
      return;
    }
    setConfigFaqs([...configFaqs, { question: '', answer: '' }]);
  };

  const handleUpdateFaq = (index: number, field: 'question' | 'answer', value: string) => {
    setConfigFaqs((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, [field]: value } : item))
    );
  };

  const handleRemoveFaq = (index: number) => {
    setConfigFaqs((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleFaqFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setConfigFeedback(null);

    try {
      setFaqImportBusy(true);setFaqReview(null);
      const parsed=await extractFaqFile(file);
      if(!parsed.length)throw Error('No structured Q&A pairs found. Use questions ending in ? followed by answers, or Excel Question and Answer columns. Scanned PDFs require OCR.');
      const review=reviewFaqs(configFaqs,parsed);
      setFaqReview({name:file.name,items:review.accepted,duplicates:review.duplicates,conflicts:review.conflicts});
    } catch (err) {
      setConfigFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not read that file. Please check the file format and try again.',
      });
    } finally {
      setFaqImportBusy(false);
      if (faqFileInputRef.current) {
        faqFileInputRef.current.value = '';
      }
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if(faqImportBusy||faqReview){setConfigFeedback({type:'error',text:'Finish or discard the FAQ import review before saving.'});return;}
    const trimmedName = configName.trim();
    if (!trimmedName) {
      setConfigFeedback({ type: 'error', text: 'Hotel name cannot be empty.' });
      return;
    }

    if(configFaqs.some(f=>hasInvalidFaqText(f.question)||hasInvalidFaqText(f.answer))){setConfigFeedback({type:'error',text:'Remove corrupted FAQ entries before saving.'});return;}
    const cleanedFaqs = configFaqs
      .map((f) => ({
        question: f.question.trim().slice(0, 500),
        answer: f.answer.trim().slice(0, 1000),
      }))
      .filter((f) => f.question && f.answer)
      .slice(0, 100);

    const payload = {
      name: trimmedName.slice(0, 200),
      persona: configPersona.trim().slice(0, 4000),
      faqs: cleanedFaqs,
      emergencyPhone: configEmergencyPhone.trim().slice(0, 50),
      slas: {
        housekeeping: Math.max(0, Math.min(1440, Math.round(Number(configSlas.housekeeping) || 0))),
        maintenance: Math.max(0, Math.min(1440, Math.round(Number(configSlas.maintenance) || 0))),
        front_desk: Math.max(0, Math.min(1440, Math.round(Number(configSlas.front_desk) || 0))),
      },
    };

    setSavingConfig(true);
    setConfigFeedback(null);

    try {
      await updateDoc(doc(db, 'hotels', hotelId), payload);
      setConfigFaqs(cleanedFaqs);
      setHotelConfig((prev) =>
        prev ? { ...prev, ...payload } : { id: hotelId, ...payload }
      );
      setConfigFeedback({
        type: 'success',
        text: 'Configuration saved! Ren will immediately use the updated instructions and FAQs.',
      });
    } catch (err: any) {
      console.error('Failed to save hotel config:', err);
      setConfigFeedback({
        type: 'error',
        text:
          err?.code === 'permission-denied'
            ? 'Permission denied while saving. Make sure you are signed in as the hotel owner (or verified admin).'
            : 'Unable to save configuration. Please try again.',
      });
    } finally {
      setSavingConfig(false);
    }
  };

  const persistLocations = async (nextLocations: HotelLocation[]) => {
    setSavingLocations(true);
    setLocationsFeedback(null);
    const trimmed = nextLocations.slice(0, 500);
    try {
      await updateDoc(doc(db, 'hotels', hotelId), { locations: trimmed });
      setLocations(trimmed);
      setHotelConfig((prev) => (prev ? { ...prev, locations: trimmed } : prev));
      setLocationsFeedback({
        type: 'success',
        text: `Saved ${trimmed.length} property location${trimmed.length === 1 ? '' : 's'}.`,
      });
    } catch (err: any) {
      console.error('Failed to save locations:', err);
      setLocationsFeedback({
        type: 'error',
        text:
          err?.code === 'permission-denied'
            ? 'Permission denied while saving locations.'
            : 'Unable to save locations right now.',
      });
    } finally {
      setSavingLocations(false);
    }
  };

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = newLocCode.trim().slice(0, 50);
    if (!code) return;
    const label = (newLocLabel.trim() || (/^\d/.test(code) ? `Room ${code}` : code)).slice(0, 100);
    const id = code.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `loc-${Date.now()}`;
    if (locations.some((l) => l.code.toLowerCase() === code.toLowerCase())) {
      setLocationsFeedback({ type: 'error', text: `Location "${code}" already exists.` });
      return;
    }
    const next = [...locations, { id, code, label, type: newLocType, active: true }];
    setNewLocCode('');
    setNewLocLabel('');
    await persistLocations(next);
  };

  const handleGenerateRoomRange = async () => {
    const start = parseInt(rangeStart, 10);
    const end = parseInt(rangeEnd, 10);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start || end - start > 100) {
      setLocationsFeedback({
        type: 'error',
        text: 'Enter a valid numeric range (up to 100 rooms at a time).',
      });
      return;
    }
    const existingCodes = new Set(locations.map((l) => l.code.toLowerCase()));
    const added: HotelLocation[] = [];
    for (let n = start; n <= end; n++) {
      const code = String(n);
      if (!existingCodes.has(code)) {
        added.push({
          id: `room-${code}`,
          code,
          label: `Room ${code}`,
          type: 'room',
          active: true,
        });
      }
    }
    if (added.length === 0) {
      setLocationsFeedback({ type: 'error', text: 'All rooms in that range already exist.' });
      return;
    }
    await persistLocations([...locations, ...added]);
  };

  const handleToggleLocation = async (locId: string) => {
    const next = locations.map((l) => (l.id === locId ? { ...l, active: !l.active } : l));
    await persistLocations(next);
  };

  const handleDeleteLocation = async (locId: string) => {
    const next = locations.filter((l) => l.id !== locId);
    await persistLocations(next);
  };

  const openUrgent=requests.filter(r=>isOutstanding(r)&&priorityRank(r)===2).sort(compareRequests);
  const openHigh=requests.filter(r=>isOutstanding(r)&&priorityRank(r)===1);
  const priorities=outstandingPriorities(requests);
  const goToRequest=(id:string)=>{setRequestStatusFilter('open');setDepartmentFilter('All');setFocusedRequest(id);setActiveTab('requests');requestAnimationFrame(()=>{const node=document.getElementById('request-card-'+id);node?.scrollIntoView({block:'center'});node?.focus({preventScroll:true});});};
  const needsAttention=(s:Session)=>(priorities.get(s.id)||0)>0||s.status==='awaiting_human'||s.status==='escalated'||s.isUnread;
  const filteredSessions = sessions.filter((s) => {
    if (inboxFilter === 'attention') {
      return needsAttention(s);
    }
    if (inboxFilter === 'ai') return s.status === 'active';
    if (inboxFilter === 'staff') return s.status === 'staff_controlled';
    if (inboxFilter === 'resolved') return s.status === 'completed';
    return true;
  }).sort((a,b)=>compareSessions(a,b,priorities));

  const attentionCount = sessions.filter(needsAttention).length;

  const openRequestsCount = requests.filter(
    (r) => !['completed', 'cancelled'].includes(r.status)
  ).length;

  const filteredRequests = requests.filter((r) => {
    const isCompleted = r.status === 'completed' || r.status === 'cancelled';
    if (requestStatusFilter === 'open' && isCompleted) return false;
    if (requestStatusFilter === 'completed' && !isCompleted) return false;
    if (departmentFilter !== 'All') {
      const dept = r.department || r.category || 'General';
      if (dept !== departmentFilter) return false;
    }
    return true;
  }).sort(compareRequests);

  const departments = [
    'All',
    'Housekeeping',
    'Engineering',
    'Front Desk',
    'Management',
    'Security',
    'Food & Beverage',
  ];

  if (!isAuthReady || !isAuthenticated) return <main className="h-full min-h-[240px] flex items-center justify-center bg-slate-50 p-6"><div className="max-w-md bg-white border rounded-xl p-6 text-slate-700"><h1 className="text-xl font-bold">{!isAuthReady ? 'Checking hotel access…' : 'Access denied'}</h1>{isAuthReady && <><p className="mt-2">Sign in with an authorized hotel account to continue.</p><a href="#/login" className="block text-indigo-600 mt-4">Go to login / choose hotel</a><a href="#/" className="block text-indigo-600 mt-2">Home</a>{auth.currentUser && <button disabled={signingOut} onClick={handleSignOut} className="mt-4 text-indigo-600 underline">Sign out</button>}{signOutError && <p role="alert">{signOutError}</p>}</>}</div></main>;

  return (
    <div className="flex h-full bg-slate-50 font-sans text-slate-900">
      {/* Sidebar */}
      <aside className="w-60 bg-slate-900 text-slate-100 flex flex-col shrink-0">
        <div className="p-5 border-b border-slate-800">
          <h2 className="font-display text-base font-bold tracking-tight text-white">Ren Operations</h2>
          <p className="text-xs text-slate-400 mt-0.5 truncate">{hotelConfig?.name || hotelId}</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <button
            type="button"
            onClick={() => setActiveTab('inbox')}
            className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'inbox'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span>Live Inbox</span>
            {attentionCount > 0 && (
              <span className="font-mono text-xs tabular-nums text-amber-300 font-semibold">
                {attentionCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('requests')}
            className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'requests'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span>Service Requests</span>
            {openRequestsCount > 0 && (
              <span className="font-mono text-xs tabular-nums text-indigo-200 font-semibold">
                {openRequestsCount}
              </span>
            )}
          </button>
          {canConfigure && <>
          <button
            type="button"
            onClick={() => setActiveTab('locations')}
            className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'locations'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <span>Locations &amp; QR</span>
            <span className="font-mono text-xs tabular-nums text-slate-400">
              {locations.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('config')}
            className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'config'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            Configuration
          </button>
          </>}
          {canConfigure && <button type="button" onClick={()=>setActiveTab('insights')} className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-medium ${activeTab==='insights'?'bg-indigo-600 text-white':'text-slate-300 hover:bg-slate-800'}`}>Insights</button>}
          {canManageTeam && <button type="button" onClick={()=>setActiveTab('team')} className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-medium ${activeTab==='team'?'bg-indigo-600 text-white':'text-slate-300 hover:bg-slate-800'}`}>Team Management</button>}
        </nav>
        <div className="p-4 border-t border-slate-800 text-xs space-y-2">
          <p className="truncate" title={staffIdentity}>{staffIdentity || 'Signed-in staff'}</p>
          <p className="text-slate-400">{staffRole === 'legacy' ? 'Sandbox operator' : staffRole === 'admin' ? 'Hotel administrator' : staffRole === 'manager' ? 'Manager' : 'Associate'}</p>
          <a href="#/" className="block text-slate-300 hover:text-white">Home</a>
          <button type="button" disabled={signingOut} onClick={handleSignOut} className="w-full text-left text-slate-200 hover:text-white">{signingOut ? 'Signing out…' : 'Sign out'}</button>
          {signOutError && <p role="alert" className="text-red-300">{signOutError}</p>}
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="shrink-0 border-b bg-white px-4 py-2 flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold">Priority operations</span>
          <span className="text-red-700 font-semibold">{openUrgent.length} urgent</span>
          <span className="text-amber-800">{openHigh.length} high priority</span>
          <span className="text-slate-600">{openRequestsCount-openUrgent.length-openHigh.length} routine</span>
          <button type="button" aria-pressed={soundEnabled} onClick={toggleSound} className="ml-auto border rounded px-2 py-1">{soundEnabled?'Alert sound on':'Enable alert sound'}</button>
          {soundError&&<span role="status" className="text-amber-800">{soundError}</span>}
        </div>
        {(!requestsReady||requestsError)&&<div role="status" className="shrink-0 bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2 text-xs">Request data not confirmed live. Check connection; do not rely on this console for emergency notification.</div>}
        {openUrgent.length>0&&<section aria-label="Unresolved urgent requests" className="shrink-0 bg-red-50 border-b-2 border-red-600 px-4 py-3 text-red-900">
          <h3 className="font-bold text-sm" role="status">{openUrgent.length} unresolved urgent {openUrgent.length===1?'request':'requests'} — immediate staff attention required</h3>
          <div className="max-h-28 overflow-y-auto mt-1 space-y-1">{openUrgent.map(r=><button key={r.id} type="button" onClick={()=>goToRequest(r.id)} className="block text-left text-xs underline font-medium">#{r.referenceCode||r.id.slice(0,8)} · {r.roomNumber||'Location needed'} · {r.item||r.category} · {r.department||r.category} · {REQUEST_STATUS_LABELS[r.status]||r.status}</button>)}</div>
          <p className="text-xs mt-1">Follow hotel emergency procedures; this is not an emergency dispatch system.</p>
        </section>}
        <div className="flex-1 flex overflow-hidden min-w-0 min-h-0">
        {canConfigure && activeTab === 'insights' && <Insights key={hotelId} hotelId={hotelId} targets={hotelConfig?.slas || null} requests={requests} sessions={sessions} ready={sessionsReady && requestsReady} error={sessionsError || requestsError} />}
        {canManageTeam && activeTab === 'team' && <TeamManagement key={hotelId} hotelId={hotelId} />}
        {/* TAB 1: LIVE INBOX */}
        {activeTab === 'inbox' && (
          <>
            <div className="w-80 border-r border-slate-200 bg-white flex flex-col shrink-0">
              <div className="p-4 border-b border-slate-200 space-y-3">
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  Guest Conversations
                </h3>
                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      ['all', 'All'],
                      ['attention', 'Attention'],
                      ['ai', 'AI'],
                      ['staff', 'Staff'],
                      ['resolved', 'Resolved'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setInboxFilter(id)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        inboxFilter === id
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {filteredSessions.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">
                    No conversations match this filter.
                  </div>
                ) : (
                  filteredSessions.map((s) => {
                    const isSelected = selectedSessionId === s.id;
                    const statusLabel = SESSION_STATUS_LABELS[s.status] || s.status;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSessionId(s.id)}
                        className={`w-full text-left p-4 transition-colors hover:bg-slate-50 ${
                          isSelected ? 'bg-indigo-50/70' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-semibold text-sm text-slate-900 truncate">
                            {s.locationLabel ||
                              (s.roomNumber ? `Room ${s.roomNumber}` : `Guest ${s.id.slice(0, 5)}`)}
                          </span>
                          <span className="text-[11px] text-slate-400 font-mono tabular-nums shrink-0">
                            {s.lastUpdatedAt
                              ?.toDate()
                              .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 truncate mb-1.5">
                          {s.previewStaffText || s.previewText}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span
                            className={`font-medium ${
                              s.status === 'escalated'
                                ? 'text-red-700'
                                : s.status === 'awaiting_human'
                                  ? 'text-amber-700'
                                  : s.status === 'staff_controlled'
                                    ? 'text-indigo-700'
                                    : 'text-slate-500'
                            }`}
                          >
                            {statusLabel}
                          </span>
                          {(priorities.get(s.id)||0)>0&&<span className={`font-semibold ${(priorities.get(s.id)||0)===2?'text-red-700':'text-amber-800'}`}>{(priorities.get(s.id)||0)===2?'Urgent alert':'Priority alert'}</span>}
                          <span className="font-mono" title={s.id}>#{s.id.slice(0, 8)}</span>
                          {s.guestLanguage && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="uppercase">{s.guestLanguage}</span>
                            </>
                          )}
                          {s.isUnread && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-semibold text-indigo-600">Unread</span>
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Conversation Workspace */}
            <div className="flex-1 flex flex-col bg-slate-50 min-w-0">
              {selectedSession ? (
                <>
                  {/* Workspace Control Header */}
                  <div className="bg-white border-b border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 shrink-0">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <span>
                          {selectedSession.locationLabel ||
                            (selectedSession.roomNumber
                              ? `Room ${selectedSession.roomNumber}`
                              : `Guest Session ${selectedSession.id.slice(0, 6)}`)}
                        </span>
                        <span className="text-slate-300" aria-hidden="true">·</span>
                        <span
                          className={`text-xs font-medium ${
                            selectedSession.status === 'escalated'
                              ? 'text-red-700'
                              : selectedSession.status === 'awaiting_human'
                                ? 'text-amber-700'
                                : selectedSession.status === 'staff_controlled'
                                  ? 'text-indigo-700'
                                  : 'text-slate-600'
                          }`}
                        >
                          {SESSION_STATUS_LABELS[selectedSession.status] || selectedSession.status}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        <span className="font-mono" title={selectedSession.id}>#{selectedSession.id.slice(0, 8)} · </span>
                        {selectedSessionRequests.length} linked request
                        {selectedSessionRequests.length === 1 ? '' : 's'}
                        {selectedSession.assignedStaffEmail
                          ? ` · Assigned to ${selectedSession.assignedStaffEmail}`
                          : ''}
                        {(priorities.get(selectedSession.id)||0)>0 ? ` · ${priorities.get(selectedSession.id)===2?'Urgent':'High-priority'} request outstanding` : ''}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {selectedSession.status!=='completed'&&selectedSession.roomNumber&&!selectedSession.guestEndedAt&&<button type="button" disabled={!requestsReady||!!requestsError} onClick={beginMove} className="px-3 py-2 border rounded-lg text-xs font-semibold disabled:opacity-50">Move Guest</button>}
                      {selectedSession.status !== 'staff_controlled' ? (
                        <button
                          type="button"
                          onClick={() => handleTakeOver(selectedSession)}
                          className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors whitespace-nowrap"
                        >
                          Take Over Conversation
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleReturnToAI(selectedSession)}
                          className="px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 transition-colors whitespace-nowrap"
                        >
                          Return to Ren AI
                        </button>
                      )}
                      {selectedSession.status !== 'completed' && (
                        <button
                          type="button"
                          onClick={() => handleResolveSession(selectedSession)}
                          className="px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 transition-colors whitespace-nowrap"
                        >
                          Mark Resolved
                        </button>
                      )}
                    </div>
                  </div>

                  {moveReview&&<div role="dialog" aria-label="Move guest" className="bg-white border-b p-4 space-y-3 max-h-[55vh] overflow-auto">
                    <h3 className="font-semibold">Move guest from {moveReview.fromRoom}</h3>
                    <p className="text-xs">Confirm the room move in your PMS first. This updates only this conversation, not the hotel reservation.</p>
                    <select aria-label="Destination room" className="border rounded p-2" value={moveDestination} onChange={e=>setMoveDestination(e.target.value)} disabled={moveBusy}><option value="">Select destination room</option>{(hotelConfig?.locations||[]).filter(l=>l.active&&['room','suite'].includes(l.type)&&l.code!==moveReview.fromRoom).map(l=><option key={l.id} value={l.id}>{l.label}</option>)}</select>
                    {moveReview.requests.map(r=><div key={r.id} className="border rounded p-2 flex flex-wrap items-center gap-2"><div className="flex-1"><strong>{r.item}</strong><div className="text-xs">{r.department||r.category} · {r.roomNumber} · {r.status}</div></div><select aria-label={'Action for '+r.item} className="border rounded p-1" disabled={moveBusy} value={moveDecisions[r.id]||''} onChange={e=>setMoveDecisions(p=>({...p,[r.id]:e.target.value}))}><option value="">Choose action</option><option value="move">Transfer to new room</option><option value="keep">Keep at current location</option><option value="cancel">Cancel request</option></select></div>)}
                    {!moveReview.requests.length&&<p>No outstanding requests.</p>}
                    {moveError&&<p role="alert" className="text-red-700">{moveError}</p>}
                    <button disabled={moveBusy||!moveDestination||moveReview.requests.some(r=>!moveDecisions[r.id])} onClick={confirmMove} className="bg-indigo-600 text-white rounded px-3 py-2 disabled:opacity-50">Confirm room move</button>
                    <button disabled={moveBusy} onClick={()=>setMoveReview(null)} className="ml-2 border rounded px-3 py-2">Close</button>
                  </div>}
                  {/* Messages Feed */}
                  <div className="flex-1 overflow-y-auto p-6 space-y-3">
                    {chatMessages.map((m) => {
                      if (m.sender === 'system') {
                        return (
                          <div key={m.id} className="flex justify-center">
                            <div className="text-xs text-slate-600 bg-white border border-slate-200 px-3.5 py-1.5 rounded-lg">
                              {m.text}
                            </div>
                          </div>
                        );
                      }
                      const isGuest = m.sender === 'guest';
                      const isStaff = m.sender === 'staff';
                      const hasStaffTranslation =
                        !isStaff && Boolean(m.staffText && m.staffText !== m.text);
                      const hasGuestDelivery =
                        isStaff && Boolean(m.guestText && m.guestText !== m.text);
                      const displayBody = hasStaffTranslation ? m.staffText! : m.text;
                      const showOriginal = Boolean(expandedStaffOriginals[m.id]);

                      return (
                        <div
                          key={m.id}
                          className={`flex ${isGuest ? 'justify-start' : 'justify-end'}`}
                        >
                          <div
                            className={`max-w-lg px-4 py-2.5 rounded-xl text-sm whitespace-pre-line leading-relaxed ${
                              isGuest
                                ? 'bg-white border border-slate-200 text-slate-900'
                                : m.sender === 'ai'
                                  ? 'bg-slate-200 text-slate-900'
                                  : 'bg-indigo-600 text-white'
                            }`}
                          >
                            <div className="text-[11px] opacity-75 mb-1 font-semibold">
                              {m.sender === 'ai'
                                ? 'Ren Concierge'
                                : isStaff
                                  ? 'Staff Associate'
                                  : 'Guest'}
                            </div>
                            <div>{displayBody}</div>
                            {hasStaffTranslation && (
                              <div className="mt-1.5 pt-1.5 border-t border-slate-300/60 text-[11px] text-slate-500 flex items-center justify-between gap-3">
                                <span>
                                  Translated from{' '}
                                  {(m.originalLanguage || detectedGuestLang || 'guest').toUpperCase()}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedStaffOriginals((prev) => ({
                                      ...prev,
                                      [m.id]: !prev[m.id],
                                    }))
                                  }
                                  className="underline hover:text-slate-800 font-medium"
                                >
                                  {showOriginal ? 'Hide original' : 'Original'}
                                </button>
                              </div>
                            )}
                            {hasStaffTranslation && showOriginal && (
                              <div className="mt-1 text-xs text-slate-600 italic">{m.text}</div>
                            )}
                            {hasGuestDelivery && (
                              <div className="mt-1.5 pt-1.5 border-t border-white/20 text-[11px] text-indigo-100">
                                Sent in {(m.translatedToLanguage || 'guest').toUpperCase()}:{' '}
                                <span className="italic">{m.guestText}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Staff Composer */}
                  <div className="p-4 bg-white border-t border-slate-200 space-y-2 shrink-0">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-slate-600">
                        {shouldTranslateStaffReply ? (
                          <>
                            Type in <strong className="text-slate-800">English</strong> — guest
                            receives{' '}
                            <strong className="text-indigo-700 uppercase">
                              {effectiveReplyTargetLang}
                            </strong>
                          </>
                        ) : (
                          'Sending directly in English (no translation)'
                        )}
                      </span>
                      <label className="flex items-center gap-1.5 text-slate-600">
                        <span>Guest language:</span>
                        <select
                          value={replyTargetLang}
                          onChange={(e) => setReplyTargetLang(e.target.value)}
                          className="border border-slate-300 bg-white rounded-md px-2 py-1 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="auto">
                            Auto ({detectedGuestLang.toUpperCase()})
                          </option>
                          {LANGUAGE_OPTIONS.map((opt) => (
                            <option key={opt.code} value={opt.code}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {staffReplyError && (
                      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                        {staffReplyError}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <input
                        className="flex-1 border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                        placeholder={
                          shouldTranslateStaffReply
                            ? `Reply in English (auto-translated to ${effectiveReplyTargetLang.toUpperCase()})...`
                            : 'Reply as Staff (automatically enables Staff Takeover)...'
                        }
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleStaffReply()}
                        disabled={sendingStaffReply}
                      />
                      <button
                        type="button"
                        onClick={handleStaffReply}
                        disabled={!replyText.trim() || sendingStaffReply}
                        className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
                      >
                        {sendingStaffReply
                          ? shouldTranslateStaffReply
                            ? 'Translating...'
                            : 'Sending...'
                          : 'Send'}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-slate-400 text-sm">
                  Select a guest conversation to inspect messages or take over.
                </div>
              )}
            </div>
          </>
        )}

        {/* TAB 2: SERVICE REQUESTS */}
        {activeTab === 'requests' && (
          <div className="flex-1 p-8 overflow-y-auto">
            <div className="max-w-5xl space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="font-display text-xl font-bold text-slate-900">
                    Service Requests
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Track, acknowledge, route, and fulfill guest requests across departments.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
                    {(['open', 'completed', 'all'] as const).map((statusKey) => (
                      <button
                        key={statusKey}
                        type="button"
                        onClick={() => setRequestStatusFilter(statusKey)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                          requestStatusFilter === statusKey
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {statusKey}
                      </button>
                    ))}
                  </div>

                  <select
                    value={departmentFilter}
                    onChange={(e) => setDepartmentFilter(e.target.value)}
                    aria-label="Filter by department"
                    className="border border-slate-300 bg-white rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {departments.map((d) => (
                      <option key={d} value={d}>
                        {d === 'All' ? 'All Departments' : d}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {filteredRequests.length === 0 ? (
                <div className="bg-white p-8 rounded-xl border border-slate-200 text-center text-sm text-slate-500">
                  No matching service requests. Requests submitted in any language or via Quick Request appear here automatically.
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredRequests.map((req) => {
                    const isPendingRoom =
                      !req.roomNumber ||
                      req.roomNumber === 'Pending room #' ||
                      req.roomNumber === 'Location needed' ||
                      req.roomNumber === 'Unknown';
                    const refCode =
                      req.referenceCode || `R-${req.id.slice(0, 4).toUpperCase()}`;
                    const statusLabel = REQUEST_STATUS_LABELS[req.status] || req.status;

                    return (
                      <div
                        key={req.id}
                        id={'request-card-'+req.id}
                        tabIndex={-1}
                        className={`bg-white p-4 rounded-xl border flex flex-wrap justify-between items-start gap-4 ${isOutstanding(req)&&priorityRank(req)===2?'border-red-500 border-l-4':isOutstanding(req)&&priorityRank(req)===1?'border-amber-400 border-l-4':'border-slate-200'} ${focusedRequest===req.id?'ring-2 ring-indigo-400':''}`}
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-mono font-semibold text-slate-800 tabular-nums">
                              #{refCode}
                            </span>
                            <span aria-hidden="true">·</span>
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
                            <span aria-hidden="true">·</span>
                            <span>{req.department || req.category}</span>
                            {req.priority && req.priority !== 'normal' && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-semibold text-red-700 uppercase">
                                  {req.priority === 'urgent' ? 'Urgent' : 'High Priority'}
                                </span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {req.createdAt?.toDate().toLocaleString()}
                            </span>
                          </div>

                          <div className="text-base font-semibold text-slate-900">
                            {req.quantity && req.quantity > 1 ? `${req.quantity}x ` : ''}
                            {req.item || req.category}
                          </div>

                          {req.description && (
                            <div className="text-xs text-slate-600">{req.description}</div>
                          )}

                          {req.originalMessage && req.originalMessage !== req.description && (
                            <div className="text-xs text-slate-500">
                              Guest message: &ldquo;{req.originalMessage}&rdquo;
                            </div>
                          )}

                          <div className="text-xs pt-0.5">
                            <span className="text-slate-500">Location: </span>
                            <span
                              className={
                                isPendingRoom
                                  ? 'text-amber-700 font-semibold'
                                  : 'text-slate-900 font-semibold'
                              }
                            >
                              {req.roomNumber || 'Pending room #'}
                            </span>
                          </div>
                        </div>

                        {req.status !== 'completed' && req.status !== 'cancelled' && (
                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            {req.status === 'pending' && (
                              <button
                                type="button"
                                onClick={() => handleRequestTransition(req, 'acknowledged')}
                                className="border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                              >
                                Acknowledge
                              </button>
                            )}
                            {(req.status === 'pending' ||
                              req.status === 'acknowledged' ||
                              req.status === 'reopened' ||
                              req.status === 'escalated') && (
                              <button
                                type="button"
                                onClick={() => handleRequestTransition(req, 'in_progress')}
                                className="border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                              >
                                Start Work
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleRequestTransition(req, 'completed')}
                              className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                            >
                              Mark Complete
                            </button>
                            {req.status !== 'escalated' && (
                              <button
                                type="button"
                                onClick={() => handleRequestTransition(req, 'escalated')}
                                className="border border-red-200 text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                              >
                                Escalate
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: LOCATIONS & QR CODES */}
        {canConfigure && activeTab === 'locations' && (
          <div className="flex-1 p-8 overflow-y-auto">
            <div className="max-w-4xl space-y-6">
              <div>
                <h2 className="font-display text-xl font-bold text-slate-900">
                  Property Locations &amp; QR Codes
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  Generate location-aware QR links so guests never have to re-type their room number or venue.
                </p>
              </div>

              {locationsFeedback && (
                <div
                  className={`text-sm rounded-lg px-4 py-3 border ${
                    locationsFeedback.type === 'success'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-red-50 border-red-200 text-red-700'
                  }`}
                >
                  {locationsFeedback.text}
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-6">
                {/* Add Single Location */}
                <form
                  onSubmit={handleAddLocation}
                  className="bg-white p-5 rounded-xl border border-slate-200 space-y-4"
                >
                  <h3 className="text-sm font-semibold text-slate-900">Add Single Location</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Code
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={50}
                        value={newLocCode}
                        onChange={(e) => setNewLocCode(e.target.value)}
                        placeholder="412 or POOL"
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Type
                      </label>
                      <select
                        value={newLocType}
                        onChange={(e) => setNewLocType(e.target.value as LocationType)}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                      >
                        <option value="room">Room</option>
                        <option value="suite">Suite</option>
                        <option value="lobby">Lobby</option>
                        <option value="pool">Pool</option>
                        <option value="restaurant">Restaurant</option>
                        <option value="bar">Bar</option>
                        <option value="fitness">Fitness Center</option>
                        <option value="meeting">Meeting Room</option>
                        <option value="public">Public Area</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Display Label (Optional)
                    </label>
                    <input
                      type="text"
                      maxLength={100}
                      value={newLocLabel}
                      onChange={(e) => setNewLocLabel(e.target.value)}
                      placeholder="e.g. Room 412 or Poolside Cabana"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={savingLocations}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold py-2 rounded-lg transition-colors disabled:opacity-60"
                  >
                    Add Location &amp; Generate QR
                  </button>
                </form>

                {/* Bulk Room Range */}
                <div className="bg-white p-5 rounded-xl border border-slate-200 space-y-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Bulk Generate Room Range
                  </h3>
                  <p className="text-xs text-slate-500">
                    Quickly populate sequential room numbers and downloadable QR codes.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        From Room
                      </label>
                      <input
                        type="number"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        To Room
                      </label>
                      <input
                        type="number"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={savingLocations}
                    onClick={handleGenerateRoomRange}
                    className="w-full border border-slate-300 bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold py-2 rounded-lg transition-colors disabled:opacity-60"
                  >
                    Generate Room Range
                  </button>
                </div>
              </div>

              {/* Location QR List */}
              {locations.length === 0 ? (
                <div className="bg-white p-8 rounded-xl border border-slate-200 text-center text-sm text-slate-500">
                  No locations configured yet. Add a room or venue above to generate scannable QR codes.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {locations.map((loc) => {
                    const guestUrl = `${window.location.origin}/#/g/${hotelId}?loc=${encodeURIComponent(
                      loc.code
                    )}`;
                    const qrSrc = qrPreviews[loc.id];
                    return (
                      <div
                        key={loc.id}
                        className={`bg-white p-4 rounded-xl border border-slate-200 flex flex-col gap-3 ${
                          loc.active === false ? 'opacity-60' : ''
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold text-sm text-slate-900">
                              {loc.label}
                            </div>
                            <div className="text-xs text-slate-500">
                              Code: <span className="font-mono">{loc.code}</span> · {loc.type}
                            </div>
                          </div>
                          <span className="text-[11px] font-medium text-slate-500">
                            {loc.active === false ? 'Disabled' : 'Active'}
                          </span>
                        </div>

                        {qrSrc && (
                          <div className="bg-slate-50 border border-slate-100 rounded-lg p-3 flex justify-center">
                            <img
                              src={qrSrc}
                              alt={`QR code for ${loc.label}`}
                              className="w-32 h-32"
                            />
                          </div>
                        )}

                        <div className="flex flex-wrap gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(guestUrl);
                              setCopiedCode(loc.id);
                              setTimeout(() => setCopiedCode(null), 1500);
                            }}
                            className="flex-1 border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium py-1.5 px-2 rounded-lg"
                          >
                            {copiedCode === loc.id ? 'Copied' : 'Copy URL'}
                          </button>
                          {qrSrc && (
                            <a
                              href={qrSrc}
                              download={`ren-qr-${loc.code}.png`}
                              className="flex-1 text-center border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium py-1.5 px-2 rounded-lg"
                            >
                              PNG
                            </a>
                          )}
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-xs">
                          <button
                            type="button"
                            onClick={() => handleToggleLocation(loc.id)}
                            className="text-slate-600 hover:text-slate-900 font-medium"
                          >
                            {loc.active === false ? 'Enable' : 'Disable'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteLocation(loc.id)}
                            className="text-red-600 hover:text-red-800 font-medium"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: CONFIGURATION */}
        {canConfigure && activeTab === 'config' && (
          <div className="flex-1 p-8 overflow-y-auto">
            <div className="max-w-3xl">
              <h2 className="font-display text-xl font-bold mb-1">Hotel &amp; AI Configuration</h2>
              <p className="text-sm text-slate-500 mb-6">
                Customize how Ren responds to guests, local area recommendations, and hotel FAQs.
              </p>

              <section className="bg-white p-6 rounded-xl border border-slate-200 space-y-3 mb-6">
                <h3 className="font-semibold text-sm">Google Search Diagnostics</h3>
                <p className="text-xs text-slate-500">Tests the same concierge API with the saved hotel configuration. Consumes runtime AI quota but does not create a guest conversation or service request.</p>
                <input aria-label="Search test query" maxLength={500} value={searchTest} onChange={e => setSearchTest(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
                <button type="button" disabled={searchTesting || !hotelConfig || !searchTest.trim()} onClick={runSearchTest} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50">{searchTesting ? 'Testing search…' : 'Test Google Search'}</button>
                {searchReport && <div className="bg-slate-50 p-3 rounded-lg text-xs space-y-2" role="status">
                  <p>Local intent: {searchReport.intentDetected === undefined ? 'Unknown' : searchReport.intentDetected ? 'Detected' : 'Not detected'}</p>
                  <p>Property area: {searchReport.area || 'Not detected'}</p>
                  {searchReport.attempts?.map((attempt, i) => <div key={i} className="border-t pt-2"><strong>{attempt.model}</strong> — {attempt.outcome} · {attempt.elapsedMs} ms · {attempt.sourceCount ?? 0} sources{attempt.status ? ' · HTTP ' + attempt.status : ''}</div>)}
                  {searchReport.error && <p className="text-red-700">{searchReport.error}</p>}
                  {searchReport.text && <p className="whitespace-pre-wrap break-words">{searchReport.text}</p>}
                </div>}
              </section>
              <form onSubmit={handleSaveConfig} className="space-y-6">
                <div className="bg-white p-6 rounded-xl border border-slate-200 space-y-5">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-1">
                        Hotel Name
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={200}
                        value={configName}
                        onChange={(e) => setConfigName(e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-3.5 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                        placeholder="Ren Hotel"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-1">
                        Front Desk / Emergency Phone
                      </label>
                      <input
                        type="text"
                        maxLength={50}
                        value={configEmergencyPhone}
                        onChange={(e) => setConfigEmergencyPhone(e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-3.5 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                        placeholder="+1 (555) 019-2834"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-sm font-semibold text-slate-700">
                        AI Prompt &amp; Instructions
                      </label>
                      <span className="text-xs text-slate-400 font-mono tabular-nums">
                        {configPersona.length}/4000
                      </span>
                    </div>
                    <textarea
                      rows={4}
                      maxLength={4000}
                      value={configPersona}
                      onChange={(e) => setConfigPersona(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder='e.g. You are a guest service rep for the Ren Hotel area code 33324, so whenever guests ask for recommendations of things to do in the area, propose places and activities in the 33324 area code.'
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Include property tone, location/zip code, local recommendation rules, or special policies. Platform safety rules always apply first.
                    </p>
                  </div>
                </div>

                {/* FAQs Knowledge Base */}
                <div className="bg-white p-6 rounded-xl border border-slate-200 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">
                        Hotel FAQs (<span className="font-mono tabular-nums">{configFaqs.length}/100</span>)
                      </h3>
                      <p className="text-xs text-slate-500">
                        Upload Word, Excel, PDF, JSON, CSV or TXT files (up to 5 MB), or add Q&amp;As manually.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        ref={faqFileInputRef}
                        type="file"
                        accept=".docx,.xlsx,.pdf,.json,.csv,.txt"
                        onChange={handleFaqFileUpload}
                        className="hidden"
                      />
                      <button
                        type="button"
                        disabled={faqImportBusy||!!faqReview}
                        onClick={() => faqFileInputRef.current?.click()}
                        className="border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                      >
                        {faqImportBusy?'Reading document…':'Upload FAQs'}
                      </button>
                      <button
                        type="button"
                        onClick={handleAddFaq}
                        className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                      >
                        + Add FAQ
                      </button>
                    </div>
                  </div>

                  {faqReview&&<div className="border rounded-lg p-4 space-y-3 bg-slate-50">
                    <h4 className="font-semibold">Review import: {faqReview.name}</h4>
                    <p className="text-xs">{faqReview.items.length} new FAQs · {faqReview.duplicates} duplicates skipped · {faqReview.conflicts} conflicting answers skipped (existing knowledge retained). Review extracted text for accuracy.</p>
                    <div className="max-h-80 overflow-auto space-y-2">{faqReview.items.map((f,i)=><div className="border rounded p-2 bg-white space-y-2" key={i}><input aria-label="Imported question" className="border rounded p-2 w-full" value={f.question} onChange={e=>setFaqReview(p=>p?{...p,items:p.items.map((x,j)=>j===i?{...x,question:e.target.value}:x)}:p)}/><textarea aria-label="Imported answer" className="border rounded p-2 w-full" value={f.answer} onChange={e=>setFaqReview(p=>p?{...p,items:p.items.map((x,j)=>j===i?{...x,answer:e.target.value}:x)}:p)}/><button type="button" className="text-red-700 text-xs" onClick={()=>setFaqReview(p=>p?{...p,items:p.items.filter((_,j)=>j!==i)}:p)}>Exclude FAQ</button></div>)}</div>
                    <button type="button" disabled={!faqReview.items.length} className="bg-indigo-600 text-white rounded p-2 disabled:opacity-50" onClick={()=>{try{const review=reviewFaqs(configFaqs,faqReview.items);if(configFaqs.length+review.accepted.length>100)throw Error('Import exceeds 100 FAQ limit. Exclude entries first.');setConfigFaqs([...configFaqs,...review.accepted]);setFaqReview(null);setConfigFeedback({type:'success',text:'Added '+review.accepted.length+' FAQs to draft. '+(review.duplicates+review.conflicts)+' duplicates or conflicts skipped. Click Save Configuration to publish.'});}catch(err){setConfigFeedback({type:'error',text:err instanceof Error?err.message:'Import failed'});}}}>Add reviewed FAQs</button>
                    <button type="button" className="ml-2 border rounded p-2" onClick={()=>setFaqReview(null)}>Discard import</button>
                  </div>}
                  {configFaqs.length === 0 ? (
                    <div className="border border-dashed border-slate-300 rounded-lg p-6 text-center text-xs text-slate-500">
                      No FAQs added yet. Click <strong>Upload FAQs</strong> or <strong>+ Add FAQ</strong> to teach Ren about check-in times, Wi-Fi, parking, or amenities.
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                      {configFaqs.map((faq, idx) => (
                        <div key={idx} className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              maxLength={500}
                              value={faq.question}
                              onChange={(e) => handleUpdateFaq(idx, 'question', e.target.value)}
                              placeholder="Question (e.g. What time is check-out?)"
                              className="flex-1 bg-white border border-slate-300 rounded px-3 py-1.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveFaq(idx)}
                              className="text-xs text-red-600 hover:text-red-800 font-medium px-2 py-1"
                            >
                              Remove
                            </button>
                          </div>
                          <textarea
                            rows={2}
                            maxLength={1000}
                            value={faq.answer}
                            onChange={(e) => handleUpdateFaq(idx, 'answer', e.target.value)}
                            placeholder="Answer (e.g. Check-out is at 11:00 AM. Late check-out is available on request.)"
                            className="w-full bg-white border border-slate-300 rounded px-3 py-1.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* SLAs */}
                <div className="bg-white p-6 rounded-xl border border-slate-200">
                  <h3 className="text-sm font-semibold text-slate-800 mb-3">
                    Response Targets (SLAs in minutes)
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        Housekeeping
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={configSlas.housekeeping}
                        onChange={(e) =>
                          setConfigSlas({ ...configSlas, housekeeping: Number(e.target.value) })
                        }
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        Maintenance
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={configSlas.maintenance}
                        onChange={(e) =>
                          setConfigSlas({ ...configSlas, maintenance: Number(e.target.value) })
                        }
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        Front Desk
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={configSlas.front_desk}
                        onChange={(e) =>
                          setConfigSlas({ ...configSlas, front_desk: Number(e.target.value) })
                        }
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                  </div>
                </div>

                {configFeedback && (
                  <div
                    className={`text-sm rounded-lg px-4 py-3 border ${
                      configFeedback.type === 'success'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-red-50 border-red-200 text-red-700'
                    }`}
                  >
                    {configFeedback.text}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={savingConfig}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-70"
                  >
                    {savingConfig ? 'Saving...' : 'Save Configuration'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
};
