import {
  collection,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  query,
  where,
  getDocs,
  getDoc,
} from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from './firebase';
import { Request } from '../types';
import {
  findMatchingOpenRequest,
  generateRequestRef,
  resolveDepartment,
} from './hotelLogic';

export interface CreateRequestInput {
  hotelId: string;
  sessionId: string;
  guestUid?: string;
  item: string;
  quantity?: number;
  category: string;
  department?: string;
  roomNumber?: string;
  description?: string;
  originalMessage?: string;
  priority?: 'normal' | 'high' | 'urgent';
  status?: 'pending' | 'escalated';
  source: 'ai' | 'structured' | 'staff';
  openRequests?: Request[];
}

export interface CreateRequestOutcome {
  outcome: 'created' | 'duplicate_updated' | 'duplicate_existing';
  requestId: string;
  referenceCode: string;
  department: string;
  item: string;
  quantity: number;
}

export async function fetchSessionOpenRequests(
  hotelId: string,
  sessionId: string,
  guestUid?: string
): Promise<Request[]> {
  const requestsPath = `hotels/${hotelId}/requests`;
  try {
    const reqRef = collection(db, requestsPath);
    const q = guestUid ? query(reqRef, where('guestUid', '==', guestUid), where('sessionId','==',sessionId)) : query(reqRef);
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() } as Request))
      .filter((r) => r.sessionId === sessionId);
  } catch (err) {
    console.warn('Unable to fetch session requests for deduplication:', err);
    return [];
  }
}

export async function submitServiceRequest(
  input: CreateRequestInput
): Promise<CreateRequestOutcome> {
  const requestsPath = `hotels/${input.hotelId}/requests`;
  const cleanItem = (input.item || 'Guest Assistance').trim().slice(0, 200);
  const cleanCategory = (input.category || 'General').trim().slice(0, 100);
  const department = (input.department || resolveDepartment(cleanCategory, cleanItem))
    .trim()
    .slice(0, 100);
  const quantity = Math.max(1, Math.min(50, Math.round(input.quantity || 1)));
  const session=await getDoc(doc(db,'hotels',input.hotelId,'sessions',input.sessionId));
  if(!session.exists())throw Error('Conversation unavailable');
  const current=session.data();
  const roomNumber = (input.roomNumber?.trim() || 'Pending room #').slice(0, 50);
  if(current.roomMoveAt && current.roomNumber!==roomNumber)throw Error('Room assignment changed. Please review the request again.');
  const priority =
    input.priority === 'urgent' || input.priority === 'high' ? input.priority : 'normal';
  const status = input.status === 'escalated' ? 'escalated' : 'pending';

  const existingList =
    input.openRequests ??
    (await fetchSessionOpenRequests(input.hotelId, input.sessionId, input.guestUid));

  const duplicate = findMatchingOpenRequest(existingList.filter(r=>r.roomNumber===roomNumber || (!current.roomMoveAt && ['Pending room #','Location needed',''].includes(r.roomNumber))), {
    item: cleanItem,
    category: cleanCategory,
  });

  if (duplicate) {
    const refCode = duplicate.referenceCode || `R-${duplicate.id.slice(0, 4).toUpperCase()}`;
    if (duplicate.status === 'pending' && input.quantity && input.quantity !== duplicate.quantity) {
      const updatedQty = Math.max(1, Math.min(50, (duplicate.quantity || 1) + quantity));
      const updatedDesc = (
        input.description
          ? `${duplicate.description || duplicate.item} (+${quantity})`
          : duplicate.description || cleanItem
      ).slice(0, 1000);
      try {
        await updateDoc(doc(db, requestsPath, duplicate.id), {
          quantity: updatedQty,
          description: updatedDesc,
          lastUpdated: serverTimestamp(),
        });
        return {
          outcome: 'duplicate_updated',
          requestId: duplicate.id,
          referenceCode: refCode,
          department: duplicate.department || department,
          item: duplicate.item,
          quantity: updatedQty,
        };
      } catch {
        // If update fails (e.g., status changed concurrently), still return duplicate reference
      }
    }
    return {
      outcome: 'duplicate_existing',
      requestId: duplicate.id,
      referenceCode: refCode,
      department: duplicate.department || department,
      item: duplicate.item,
      quantity: duplicate.quantity || 1,
    };
  }

  const referenceCode = generateRequestRef();
  const displayDesc = (
    input.description?.trim() ||
    `${quantity > 1 ? `${quantity}x ` : ''}${cleanItem}${roomNumber !== 'Pending room #' ? ` — ${roomNumber}` : ''}`
  ).slice(0, 1000);

  try {
    const docRef = await addDoc(collection(db, requestsPath), {
      referenceCode,
      sessionId: input.sessionId,
      ...(input.guestUid ? { guestUid: input.guestUid } : {}),
      item: cleanItem,
      quantity,
      category: cleanCategory,
      department,
      roomNumber,
      status,
      description: displayDesc,
      ...(input.originalMessage
        ? { originalMessage: input.originalMessage.trim().slice(0, 1000) }
        : {}),
      priority,
      source: input.source,
      createdAt: serverTimestamp(),
      lastUpdated: serverTimestamp(),
    });

    return {
      outcome: 'created',
      requestId: docRef.id,
      referenceCode,
      department,
      item: cleanItem,
      quantity,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, requestsPath);
  }
}

export async function reopenGuestRequest(
  hotelId: string,
  requestId: string
): Promise<void> {
  const path = `hotels/${hotelId}/requests/${requestId}`;
  try {
    await updateDoc(doc(db, path), {
      status: 'reopened',
      priority: 'high',
      lastUpdated: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}
