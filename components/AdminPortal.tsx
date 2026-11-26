import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { TeamManagement } from './TeamManagement';
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
import { onAuthStateChanged } from 'firebase/auth';
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

interface FaqDraft {
  question: string;
  answer: string;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseUploadedFaqs(content: string, fileName: string): FaqDraft[] {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith('.json')) {
    const parsed = JSON.parse(content);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.faqs) ? parsed.faqs : [];
    return items
      .map((item: any) => ({
        question: String(item?.question ?? item?.q ?? '').trim(),
        answer: String(item?.answer ?? item?.a ?? '').trim(),
      }))
      .filter((f: FaqDraft) => f.question && f.answer);
  }

  if (lowerName.endsWith('.csv')) {
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const rows = lines.map(parseCsvLine);
    const startIdx =
      rows.length > 0 &&
      rows[0][0]?.toLowerCase().includes('question') &&
      rows[0][1]?.toLowerCase().includes('answer')
        ? 1
        : 0;
    return rows
      .slice(startIdx)
      .map((cols) => ({
        question: (cols[0] || '').trim(),
        answer: (cols[1] || '').trim(),
      }))
      .filter((f) => f.question && f.answer);
  }

  const qaMatches: FaqDraft[] = [];
  const blockRegex = /Q:\s*([\s\S]*?)\nA:\s*([\s\S]*?)(?=\nQ:|\s*$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    const question = match[1].trim();
    const answer = match[2].trim();
    if (question && answer) {
      qaMatches.push({ question, answer });
    }
  }
  if (qaMatches.length > 0) return qaMatches;

  return content
    .split(/\r?\n/)
    .map((line) => line.split(/\s*\|\s*|\t/))
    .map((parts) => ({
      question: (parts[0] || '').trim(),
      answer: parts.slice(1).join(' ').trim(),
    }))
    .filter((f) => f.question && f.answer);
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
  const [activeTab, setActiveTab] = useState<'inbox' | 'requests' | 'locations' | 'config' | 'team'>('inbox');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
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
  const canManageTeam = staffRole === 'admin';

  useEffect(() => {
    if ((!canConfigure && ['locations','config'].includes(activeTab)) || (!canManageTeam && activeTab === 'team')) setActiveTab('inbox');
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

  // Load Sessions
  useEffect(() => {
    if (!isAuthReady || !isAuthenticated) return;
    const path = `hotels/${hotelId}/sessions`;
    const q = query(collection(db, path), orderBy('lastUpdatedAt', 'desc'));
    return onSnapshot(
      q,
      (snap) => {
        setSessions(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Session)));
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, path);
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
      (snap) => {
        setRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Request)));
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, path);
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

      const batch = writeBatch(db);
      batch.set(doc(collection(db, path)), {
        sender: 'staff',
        guestUid: selectedSession.guestUid,
        staffUid: auth.currentUser.uid,
        text: trimmed,
        ...(hasGuestTranslation
          ? {
              guestText: guestTranslated,
              originalLanguage: 'en',
              translatedToLanguage: effectiveReplyTargetLang,
            }
          : {}),
        timestamp: serverTimestamp(),
      });

      // Automatically switch to staff_controlled when an associate replies
      batch.update(doc(db, sessionPath), {
        lastUpdatedAt: serverTimestamp(),
        previewText: hasGuestTranslation ? guestTranslated : trimmed,
        previewStaffText: trimmed,
        isUnread: false,
        status: 'staff_controlled',
        assignedStaffUid: auth.currentUser.uid,
        ...(auth.currentUser.email ? { assignedStaffEmail: auth.currentUser.email } : {}),
        ...(shouldTranslateStaffReply && selectedSession?.guestLanguage !== effectiveReplyTargetLang
          ? { guestLanguage: effectiveReplyTargetLang }
          : {}),
      });

      await batch.commit();
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
      await updateDoc(doc(db, sessionPath), {
        lastUpdatedAt: serverTimestamp(),
        isUnread: false,
        status: 'staff_controlled',
        assignedStaffUid: auth.currentUser.uid,
        ...(auth.currentUser.email ? { assignedStaffEmail: auth.currentUser.email } : {}),
      });
      await addDoc(collection(db, msgsPath), {
        sender: 'system',
        ...(sess.guestUid ? { guestUid: sess.guestUid } : {}),
        staffUid: auth.currentUser.uid,
        text: 'A hotel associate has taken over this conversation to assist you directly.',
        timestamp: serverTimestamp(),
      });
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
        text: 'Ren Concierge is back online to assist you. You may continue chatting anytime.',
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
      const content = await file.text();
      const parsed = parseUploadedFaqs(content, file.name);
      if (parsed.length === 0) {
        setConfigFeedback({
          type: 'error',
          text: 'No valid Q&A pairs found. Use JSON ([{question, answer}]), 2-column CSV, or "Q: ... / A: ..." text.',
        });
        return;
      }

      const combined = [...configFaqs, ...parsed].slice(0, 100);
      setConfigFaqs(combined);
      setConfigFeedback({
        type: 'success',
        text: `Imported ${parsed.length} FAQ${parsed.length === 1 ? '' : 's'} from ${file.name}. Click Save Configuration to publish.`,
      });
    } catch {
      setConfigFeedback({
        type: 'error',
        text: 'Could not read that file. Please check the file format and try again.',
      });
    } finally {
      if (faqFileInputRef.current) {
        faqFileInputRef.current.value = '';
      }
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = configName.trim();
    if (!trimmedName) {
      setConfigFeedback({ type: 'error', text: 'Hotel name cannot be empty.' });
      return;
    }

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

  const filteredSessions = sessions.filter((s) => {
    if (inboxFilter === 'attention') {
      return s.status === 'awaiting_human' || s.status === 'escalated' || s.isUnread;
    }
    if (inboxFilter === 'ai') return s.status === 'active';
    if (inboxFilter === 'staff') return s.status === 'staff_controlled';
    if (inboxFilter === 'resolved') return s.status === 'completed';
    return true;
  });

  const attentionCount = sessions.filter(
    (s) => s.status === 'awaiting_human' || s.status === 'escalated' || s.isUnread
  ).length;

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
  });

  const departments = [
    'All',
    'Housekeeping',
    'Engineering',
    'Front Desk',
    'Management',
    'Security',
    'Food & Beverage',
  ];

  if (!isAuthReady || !isAuthenticated) return <div className="p-6 text-slate-700">{!isAuthReady ? 'Checking hotel access…' : 'Sign in with an authorized hotel account to continue.'}{isAuthReady && <a href="#/login" className="block text-indigo-600 mt-2">Go to login</a>}</div>;

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
          {canManageTeam && <button type="button" onClick={()=>setActiveTab('team')} className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-medium ${activeTab==='team'?'bg-indigo-600 text-white':'text-slate-300 hover:bg-slate-800'}`}>Team Management</button>}
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden min-w-0">
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
                        {selectedSession.escalationReason
                          ? ` · Alert: ${selectedSession.escalationReason}`
                          : ''}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
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
                        className="bg-white p-4 rounded-xl border border-slate-200 flex flex-wrap justify-between items-start gap-4"
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
                        Upload a <code>.json</code>, <code>.csv</code>, or <code>.txt</code> FAQ file or add Q&amp;As manually.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        ref={faqFileInputRef}
                        type="file"
                        accept=".json,.csv,.txt"
                        onChange={handleFaqFileUpload}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => faqFileInputRef.current?.click()}
                        className="border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                      >
                        Upload FAQs
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
  );
};
