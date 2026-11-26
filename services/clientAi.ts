import {
  collection,
  addDoc,
  serverTimestamp,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  runTransaction,
} from 'firebase/firestore';
import { auth, db, OperationType, handleFirestoreError } from './firebase';
import { Message, HotelConfig, Session } from '../types';
import {
  detectDeterministicSafetySignal,
  normalizeLocationMatch,
} from './hotelLogic';
import {
  fetchSessionOpenRequests,
  submitServiceRequest,
} from './requestService';

interface ServerConciergeRequest {
  item: string;
  quantity: number;
  category: string;
  department: string;
  description: string;
  priority: 'normal' | 'high' | 'urgent';
}

interface ServerConciergeResponse {
  text?: string;
  replyEnglish?: string;
  latestGuestEnglish?: string;
  guestLanguage?: string;
  roomNumber?: string;
  humanHandoffRequested?: boolean;
  escalation?: {
    triggered: boolean;
    severity: 'none' | 'high' | 'critical';
    reason: string;
  };
  requests?: ServerConciergeRequest[];
  error?: string;
}

let translationBackoffUntil = 0;

export function isTranslationBackedOff(): boolean {
  return Date.now() < translationBackoffUntil;
}

export async function translateText(
  text: string,
  targetLanguage: string,
  sourceLanguage?: string
): Promise<{ translatedText: string; detectedLanguage: string }> {
  const callApi = async (forceRefresh: boolean) => {
    const idToken = await auth.currentUser?.getIdToken(forceRefresh);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Translation timed out')), 25000);
    try {
      return await fetch('/api/gemini/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({ text, targetLanguage, sourceLanguage }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await callApi(false);
  if (res.status === 401 && auth.currentUser) {
    res = await callApi(true);
  }
  const data = (await res.json().catch(() => ({}))) as {
    translatedText?: string;
    detectedLanguage?: string;
    error?: string;
  };
  if (!res.ok) {
    if (res.status === 429 || res.status === 503) {
      translationBackoffUntil = Date.now() + 300_000;
    }
    throw new Error(data?.error || `Translation failed (${res.status})`);
  }
  return {
    translatedText: data.translatedText || text,
    detectedLanguage: data.detectedLanguage || sourceLanguage || 'en',
  };
}

export async function translateMessageToEnglish(
  hotelId: string,
  sessionId: string,
  messageId: string,
  text: string,
  sourceLanguage?: string
): Promise<{ staffText: string; detectedLanguage: string } | null> {
  if (isTranslationBackedOff()) return null;
  try {
    const result = await translateText(text, 'en', sourceLanguage);
    const isEnglish =
      result.detectedLanguage === 'en' ||
      result.detectedLanguage.startsWith('en-') ||
      result.translatedText.trim().toLowerCase() === text.trim().toLowerCase();

    if (isEnglish) return null;

    const msgRef = doc(db, `hotels/${hotelId}/sessions/${sessionId}/messages`, messageId);
    await updateDoc(msgRef, {
      staffText: result.translatedText.slice(0, 5000),
      originalLanguage: result.detectedLanguage.slice(0, 20),
      translatedToLanguage: 'en',
    });

    return {
      staffText: result.translatedText,
      detectedLanguage: result.detectedLanguage,
    };
  } catch {
    return null;
  }
}

export async function translateMessagesBatchToEnglish(
  hotelId: string,
  sessionId: string,
  items: { id: string; text: string }[]
): Promise<{ id: string; staffText: string; detectedLanguage: string }[]> {
  if (items.length === 0 || isTranslationBackedOff()) return [];

  try {
    const callApi = async (forceRefresh: boolean) => {
      const idToken = await auth.currentUser?.getIdToken(forceRefresh);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Batch translation timed out')), 30000);
      try {
        return await fetch('/api/gemini/translate-batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({ items: items.slice(0, 10), targetLanguage: 'en' }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await callApi(false);
    if (res.status === 401 && auth.currentUser) {
      res = await callApi(true);
    }

    if (!res.ok) {
      if (res.status === 429 || res.status === 503) {
        translationBackoffUntil = Date.now() + 300_000;
      }
      return [];
    }

    const data = (await res.json().catch(() => ({}))) as {
      results?: { id: string; detectedLanguage: string; translatedText: string }[];
    };
    const results = Array.isArray(data.results) ? data.results : [];
    const byId = new Map(items.map((item) => [item.id, item.text]));
    const updated: { id: string; staffText: string; detectedLanguage: string }[] = [];

    for (const r of results) {
      const originalText = byId.get(r.id);
      if (!originalText || !r.translatedText) continue;
      const isEnglish =
        r.detectedLanguage === 'en' ||
        r.detectedLanguage.startsWith('en-') ||
        r.translatedText.trim().toLowerCase() === originalText.trim().toLowerCase();
      if (isEnglish) continue;

      try {
        const msgRef = doc(db, `hotels/${hotelId}/sessions/${sessionId}/messages`, r.id);
        await updateDoc(msgRef, {
          staffText: r.translatedText.slice(0, 5000),
          originalLanguage: r.detectedLanguage.slice(0, 20),
          translatedToLanguage: 'en',
        });
        updated.push({
          id: r.id,
          staffText: r.translatedText,
          detectedLanguage: r.detectedLanguage,
        });
      } catch {
        // Ignore individual doc update conflicts
      }
    }

    return updated;
  } catch {
    return [];
  }
}

export const sendMessageToAI = async (
  hotelId: string,
  sessionId: string,
  latestGuestMessageId?: string
) => {
  const guestUid = auth.currentUser?.uid;
  const msgsPath = `hotels/${hotelId}/sessions/${sessionId}/messages`;
  const sessionPath = `hotels/${hotelId}/sessions/${sessionId}`;

  let sessionData: Session | null = null;
  let hotelConfig: HotelConfig | null = null;
  let lastGuestText = '';

  try {
    // 1. Fetch Hotel Config
    const hotelRef = doc(db, 'hotels', hotelId);
    let hotelSnap;
    try {
      hotelSnap = await getDoc(hotelRef);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `hotels/${hotelId}`);
    }
    hotelConfig = hotelSnap.exists() ? (hotelSnap.data() as HotelConfig) : null;
    if (!hotelConfig) throw new Error('Hotel config not found');

    // 2. Fetch Session State (Human Takeover & Location Gate)
    try {
      const sessionSnap = await getDoc(doc(db, sessionPath));
      if (sessionSnap.exists()) {
        sessionData = sessionSnap.data() as Session;
      }
    } catch (err) {
      throw new Error('Could not verify conversation state');
    }
    if (!sessionData) throw new Error('Conversation not found');

    // Explicit Human Takeover / Completed Gate: never call AI while staff controls the chat
    if (sessionData?.status === 'staff_controlled' || sessionData?.status === 'completed') {
      return;
    }

    // 3. Fetch Messages History
    const msgsRef = collection(db, msgsPath);
    const q = guestUid ? query(msgsRef, where('guestUid', '==', guestUid)) : query(msgsRef);
    let snapshot;
    try {
      snapshot = await getDocs(q);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, msgsPath);
    }

    const fallbackNow = Date.now();
    const historyDocs = snapshot.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<Message, 'id'>) }))
      .filter((m) => m.sender !== 'system')
      .sort(
        (a, b) =>
          (a.timestamp?.toMillis() ?? fallbackNow) - (b.timestamp?.toMillis() ?? fallbackNow)
      )
      .slice(-15);

    const history = historyDocs as Message[];
    const lastMessage = history[history.length - 1];
    if (!lastMessage || lastMessage.sender !== 'guest' || (latestGuestMessageId && lastMessage.id !== latestGuestMessageId)) return;
    lastGuestText = lastMessage.text;
    const targetGuestMsgId = latestGuestMessageId || lastMessage.id;

    const transcript = history
      .map((m) => `${m.sender === 'guest' ? 'Guest' : m.sender === 'staff' ? 'Staff' : 'Ren'}: ${m.text}`)
      .join('\n');

    // 4. Fetch existing session requests for deduplication & AI context
    const existingRequests = await fetchSessionOpenRequests(hotelId, sessionId, guestUid);
    const openRequestsSummary = existingRequests
      .filter((r) => ['pending', 'acknowledged', 'in_progress', 'escalated', 'reopened'].includes(r.status))
      .map((r) => ({
        referenceCode: r.referenceCode || '',
        item: r.item,
        category: r.category,
        status: r.status,
        roomNumber: r.roomNumber,
      }));

    // 5. Call server-side Gemini concierge endpoint (with token refresh retry on 401 & timeout)
    const callConciergeApi = async (forceRefreshToken: boolean) => {
      const idToken = await auth.currentUser?.getIdToken(forceRefreshToken);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('Concierge request timed out after 45s')),
        45000
      );
      try {
        return await fetch('/api/gemini/concierge', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({
            hotelId, sessionId, guestMessageId: targetGuestMsgId,
            hotelName: hotelConfig!.name,
            persona: hotelConfig!.persona,
            faqs: hotelConfig!.faqs || [],
            knownRoomNumber: sessionData?.roomNumber || '',
            knownGuestLanguage: sessionData?.guestLanguage || '',
            locationLabel: sessionData?.locationLabel || '',
            locationType: sessionData?.locationType || '',
            emergencyPhone: hotelConfig!.emergencyPhone || '',
            openRequests: openRequestsSummary,
            latestGuestMessage: lastMessage.text,
            transcript,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await callConciergeApi(false);
    if (res.status === 401 && auth.currentUser) {
      res = await callConciergeApi(true);
    }

    const data = (await res.json().catch(() => ({}))) as ServerConciergeResponse;
    if (!res.ok) {
      throw new Error(data?.error || `Server error (${res.status})`);
    }

    let responseText: string = (
      typeof data?.text === 'string' && data.text.trim()
        ? data.text.trim()
        : "I apologize, I didn't quite catch that."
    ).slice(0, 4500);

    const rawDetectedRoom = (typeof data.roomNumber === 'string' && data.roomNumber.trim()) || '';
    const matchedLocation = normalizeLocationMatch(
      rawDetectedRoom || sessionData?.roomNumber || '',
      hotelConfig.locations
    );
    const resolvedRoomNumber = (
      matchedLocation?.code ||
      rawDetectedRoom ||
      sessionData?.roomNumber ||
      ''
    ).slice(0, 50);

    const resolvedLocationLabel = (
      matchedLocation?.label ||
      sessionData?.locationLabel ||
      (resolvedRoomNumber ? `Location ${resolvedRoomNumber}` : '')
    ).slice(0, 100);

    const guestLanguage =
      typeof data.guestLanguage === 'string' && data.guestLanguage.trim()
        ? data.guestLanguage.trim().slice(0, 20)
        : undefined;

    // 6. Backfill any pending requests waiting for a room/location FIRST
    if (resolvedRoomNumber && guestUid) {
      const requestsPath = `hotels/${hotelId}/requests`;
      for (const reqDoc of existingRequests) {
        if (
          ['pending', 'acknowledged', 'in_progress', 'escalated'].includes(reqDoc.status) &&
          (!reqDoc.roomNumber ||
            reqDoc.roomNumber === 'Pending room #' ||
            reqDoc.roomNumber === 'Location needed')
        ) {
          try {
            await updateDoc(doc(db, requestsPath, reqDoc.id), {
              roomNumber: resolvedRoomNumber,
              lastUpdated: serverTimestamp(),
            });
          } catch (err) {
            console.warn('Could not backfill room number on pending request:', err);
          }
        }
      }
    }

    // 7. Persist all detected Service Requests BEFORE posting confirmation message
    const confirmedNotes: string[] = [];
    const failedNotes: string[] = [];
    const reqCandidates = Array.isArray(data.requests) ? data.requests : [];

    for (const candidate of reqCandidates) {
      try {
        const result = await submitServiceRequest({
          hotelId,
          sessionId,
          guestUid,
          item: candidate.item,
          quantity: candidate.quantity,
          category: candidate.category,
          department: candidate.department,
          roomNumber: resolvedRoomNumber || 'Pending room #',
          description: candidate.description,
          originalMessage: lastMessage.text,
          priority: candidate.priority,
          status:
            data.escalation?.triggered && candidate.priority !== 'normal'
              ? 'escalated'
              : 'pending',
          source: 'ai',
          openRequests: existingRequests,
        });

        if (result.outcome === 'created') {
          confirmedNotes.push(
            `Logged #${result.referenceCode}: ${result.quantity > 1 ? `${result.quantity}x ` : ''}${result.item} (${result.department})`
          );
        } else if (result.outcome === 'duplicate_updated') {
          confirmedNotes.push(
            `Updated #${result.referenceCode}: ${result.quantity}x ${result.item} (${result.department})`
          );
        } else {
          confirmedNotes.push(
            `Already open as #${result.referenceCode}: ${result.item} (${result.department})`
          );
        }
      } catch (reqErr) {
        console.error('Failed to persist service request:', reqErr);
        failedNotes.push(candidate.item);
      }
    }

    const baseReplyEnglish =
      typeof data.replyEnglish === 'string' && data.replyEnglish.trim()
        ? data.replyEnglish.trim().slice(0, 4500)
        : '';
    const guestEnglish =
      typeof data.latestGuestEnglish === 'string' && data.latestGuestEnglish.trim()
        ? data.latestGuestEnglish.trim().slice(0, 4500)
        : '';

    // 7b. Attach English translation to the guest message if non-English
    if (
      targetGuestMsgId &&
      guestEnglish &&
      guestLanguage &&
      guestLanguage !== 'en' &&
      guestEnglish.toLowerCase() !== lastMessage.text.trim().toLowerCase()
    ) {
      try {
        await updateDoc(doc(db, msgsPath, targetGuestMsgId), {
          staffText: guestEnglish,
          originalLanguage: guestLanguage,
          translatedToLanguage: 'en',
        });
      } catch (transErr) {
        console.warn('Could not attach staffText to guest message:', transErr);
      }
    }

    let staffResponseText = baseReplyEnglish;
    if (confirmedNotes.length > 0) {
      responseText = `${responseText}\n\n${confirmedNotes.join('\n')}`.slice(0, 5000);
      if (staffResponseText) {
        staffResponseText = `${staffResponseText}\n\n${confirmedNotes.join('\n')}`.slice(0, 5000);
      }
    }
    if (failedNotes.length > 0) {
      responseText = `${responseText}\n\nNote: Could not automatically save (${failedNotes.join(', ')}). Please use Quick Request or tap Speak with Staff.`.slice(
        0,
        5000
      );
    }

    // 8. Persist AI Response AFTER requests succeed/fail cleanly
    const replyRef = doc(collection(db, msgsPath), `ai-${targetGuestMsgId}`);
    const sessionRef = doc(db, sessionPath);
    await runTransaction(db, async (tx) => {
      const current = await tx.get(sessionRef);
      const existingReply = await tx.get(replyRef);
      if (!current.exists() || existingReply.exists() || ['staff_controlled', 'completed'].includes(current.data().status)) return;
      tx.set(replyRef, {
      sender: 'ai',
      ...(guestUid ? { guestUid } : {}),
      text: responseText,
      ...(staffResponseText && guestLanguage && guestLanguage !== 'en'
        ? {
            staffText: staffResponseText,
            originalLanguage: guestLanguage,
            translatedToLanguage: 'en',
          }
        : {}),
      timestamp: serverTimestamp(),
    });

    // 9. Update Session Metadata (including escalation or handoff state)
    const nextStatus =
      data.escalation?.triggered
        ? 'escalated'
        : data.humanHandoffRequested
          ? 'awaiting_human'
          : undefined;

    tx.update(sessionRef, {
      lastUpdatedAt: serverTimestamp(),
      previewText: responseText,
      ...(staffResponseText
        ? { previewStaffText: staffResponseText }
        : { previewStaffText: responseText }),
      isUnread: Boolean(data.escalation?.triggered || data.humanHandoffRequested),
      ...(resolvedRoomNumber ? { roomNumber: resolvedRoomNumber } : {}),
      ...(matchedLocation?.id ? { locationId: matchedLocation.id } : {}),
      ...(resolvedLocationLabel ? { locationLabel: resolvedLocationLabel } : {}),
      ...(matchedLocation?.type ? { locationType: matchedLocation.type } : {}),
      ...(guestLanguage ? { guestLanguage } : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(data.escalation?.triggered && data.escalation.reason
        ? {
            escalationReason: data.escalation.reason.slice(0, 500),
            escalationSeverity:
              data.escalation.severity === 'critical' ? 'critical' : 'high',
          }
        : {}),
    });
    });
  } catch (error) {
    console.error('Ren AI Error:', error);
    // Do not post an outage message into a staff-controlled or closed chat.
    const latestSession = await getDoc(doc(db, sessionPath));
    if (!latestSession.exists() || ['staff_controlled', 'completed'].includes(latestSession.data().status)) return;
    sessionData = latestSession.data() as Session;

    // Deterministic AI-outage fallback: never drop emergencies or silence guest messages
    const safetySignal = detectDeterministicSafetySignal(lastGuestText);
    if (safetySignal.triggered && hotelConfig) {
      try {
        const res = await submitServiceRequest({
          hotelId,
          sessionId,
          guestUid,
          item: safetySignal.item,
          quantity: 1,
          category: safetySignal.category,
          department: safetySignal.department,
          roomNumber: sessionData?.roomNumber || 'Pending room #',
          description: safetySignal.reason,
          originalMessage: lastGuestText,
          priority: safetySignal.severity === 'critical' ? 'urgent' : 'high',
          status: 'escalated',
          source: 'structured',
        });

        await updateDoc(doc(db, sessionPath), {
          lastUpdatedAt: serverTimestamp(),
          previewText: lastGuestText.slice(0, 500),
          isUnread: true,
          ...(sessionData?.status !== 'staff_controlled'
            ? {
                status: 'escalated',
                escalationReason: safetySignal.reason.slice(0, 500),
                escalationSeverity: safetySignal.severity === 'critical' ? 'critical' : 'high',
              }
            : {}),
        });

        const phoneNote = hotelConfig.emergencyPhone
          ? ` or call ${hotelConfig.emergencyPhone}`
          : '';
        const guidance =
          safetySignal.severity === 'critical'
            ? `If you are in immediate danger, please call local emergency services (911) immediately${phoneNote}. I have logged an urgent alert (#${res.referenceCode}) for hotel management.`
            : `I'm very sorry you're experiencing this. I have logged a high-priority case (#${res.referenceCode}) for our management team and flagged this conversation for immediate review.`;

        await addDoc(collection(db, msgsPath), {
          sender: 'ai',
          ...(guestUid ? { guestUid } : {}),
          text: guidance.slice(0, 5000),
          timestamp: serverTimestamp(),
        });
        return;
      } catch (fallbackErr) {
        console.error('Deterministic safety fallback write failed:', fallbackErr);
      }
    }

    const rawErr = error instanceof Error && error.message ? error.message : '';
    const isActionableConfigErr =
      rawErr.includes('Settings > Secrets') ||
      rawErr.includes('Authentication') ||
      rawErr.includes('authentication token');

    const fallbackMsg = !isActionableConfigErr && rawErr.includes('Rate limit')
        ? 'Ren AI is momentarily busy, but your message was saved for our hotel team. Please try again in a moment, or use Quick Request above or tap Speak with Staff.'
        : 'Ren AI is temporarily unavailable, but your message was saved for our hotel team. You can use Quick Request above or tap Speak with Staff for immediate help.';

    try {
      const sessionRef = doc(db, sessionPath);
      const replyRef = latestGuestMessageId ? doc(collection(db, msgsPath), `ai-${latestGuestMessageId}`) : doc(collection(db, msgsPath));
      await runTransaction(db, async (tx) => {
        const current = await tx.get(sessionRef);
        const reply = await tx.get(replyRef);
        if (!current.exists() || reply.exists() || ['staff_controlled', 'completed'].includes(current.data().status)) return;
        tx.set(replyRef, {
          sender: 'ai',
          ...(guestUid ? { guestUid } : {}),
          text: fallbackMsg.slice(0, 5000),
          timestamp: serverTimestamp(),
        });
      });
    } catch (writeErr) {
      handleFirestoreError(writeErr, OperationType.CREATE, msgsPath);
    }
  }
};