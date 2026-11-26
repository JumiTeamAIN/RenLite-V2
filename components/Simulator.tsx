import React, { useEffect, useState } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import { DeveloperUsage } from './DeveloperUsage';
import { ChatWindow } from './ChatWindow';
import { AdminPortal } from './AdminPortal';
import { auth, db, OperationType, handleFirestoreError } from '../services/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

interface SimulatorProps {
  hotelId: string;
  initialLocationCode?: string;
}

export const Simulator: React.FC<SimulatorProps> = (props) => {
  const [access, setAccess] = useState<'loading' | 'allowed' | 'denied'>('loading');
  useEffect(() => onIdTokenChanged(auth, user => {
    setAccess(user && !user.isAnonymous && user.emailVerified &&
      user.email === 'jumi@teamain.org' ? 'allowed' : 'denied');
  }), []);
  if (access !== 'allowed' || props.hotelId !== 'test-hotel-001') {
    return <main className="min-h-screen flex items-center justify-center bg-slate-50 p-6"><div className="max-w-md bg-white border rounded-xl p-6"><h1 className="text-xl font-bold">{access === 'loading' ? 'Checking developer access…' : 'Access denied'}</h1><p className="mt-2">The simulator is reserved for the authorized sandbox operator.</p><a className="block mt-4 text-indigo-600" href="#/login">Go to login</a><a className="block mt-2 text-indigo-600" href="#/">Home</a></div></main>;
  }
  return <AuthorizedSimulator {...props} />;
};

const AuthorizedSimulator: React.FC<SimulatorProps> = ({ hotelId, initialLocationCode }) => {
  const [showUsage,setShowUsage]=useState(false);
  const [simLocationCode, setSimLocationCode] = useState<string | undefined>(initialLocationCode);

  // Ensure Test Hotel Exists (Self-Correction for Dev Mode)
  useEffect(() => {
    return onIdTokenChanged(auth, async (user) => {
      if (!user || user.isAnonymous || !user.emailVerified || user.email !== 'jumi@teamain.org' || hotelId !== 'test-hotel-001') return;
      const path = `hotels/${hotelId}`;
      try {
        const ref = doc(db, 'hotels', hotelId);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            name: 'Ren Sandbox Hotel',
            persona: 'Warm, attentive hospitality professional for Ren Sandbox Hotel.',
            faqs: [
              { question: 'Check-out time?', answer: 'Check-out is at 11:00 AM.' },
              { question: 'Breakfast hours?', answer: '7:00 AM to 10:00 AM in the lobby restaurant.' },
            ],
            slas: { housekeeping: 15, maintenance: 30, front_desk: 5 },
            locations: [
              { id: 'room-412', code: '412', label: 'Room 412', type: 'room', active: true },
              { id: 'pool', code: 'POOL', label: 'Pool Deck', type: 'pool', active: true },
              { id: 'lobby', code: 'LOBBY', label: 'Main Lobby', type: 'lobby', active: true },
            ],
            emergencyPhone: '+1 (555) 019-2834',
          });
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, path);
      }
    });
  }, [hotelId]);

  if(showUsage)return <main className="min-h-screen bg-slate-100 p-4"><button className="mb-3 border rounded px-3 py-2" onClick={()=>setShowUsage(false)}>Back to sandbox</button><DeveloperUsage/></main>;
  return (
    <div className="flex flex-col lg:flex-row h-screen bg-slate-900 p-4 lg:p-6 gap-6 overflow-hidden">
      {/* Left: Guest View (Mobile Simulator) */}
      <div className="w-full lg:w-[390px] shrink-0 flex flex-col items-center">
        <div className="w-full flex items-center justify-between mb-3 px-1">
          <h3 className="text-slate-200 text-xs font-semibold tracking-wide">
            Guest Experience Sandbox
          </h3>
          <div className="flex items-center gap-1.5 text-xs">
            <label htmlFor="sim-loc" className="text-slate-400">
              QR Context:
            </label>
            <select
              id="sim-loc"
              value={simLocationCode || ''}
              onChange={(e) => setSimLocationCode(e.target.value || undefined)}
              className="bg-slate-800 text-slate-100 border border-slate-700 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">General URL (No Room)</option>
              <option value="412">Room 412 QR</option>
              <option value="POOL">Pool Deck QR</option>
              <option value="LOBBY">Lobby QR</option>
            </select>
          </div>
        </div>
        <div className="w-full max-w-[380px] flex-1 bg-slate-950 rounded-[38px] border-[10px] border-slate-950 shadow-2xl overflow-hidden relative min-h-[520px]">
          <div className="w-full h-full bg-white rounded-[28px] overflow-hidden">
            <ChatWindow hotelId={hotelId} locationCode={simLocationCode} />
          </div>
        </div>
      </div>

      {/* Right: Staff View */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-200 text-xs font-semibold tracking-wide">
            Staff Operations Console
          </h3><button className="text-white text-xs border rounded px-2 py-1" onClick={()=>setShowUsage(true)}>Command Center</button>
        </div>
        <div className="flex-1 bg-white rounded-xl shadow-2xl overflow-hidden min-h-0">
          <AdminPortal hotelId={hotelId} />
        </div>
      </div>
    </div>
  );
};
