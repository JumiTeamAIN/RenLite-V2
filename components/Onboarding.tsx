import React, { useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db, auth, OperationType, handleFirestoreError } from '../services/firebase';

export const Onboarding: React.FC = () => {
  const [hotelName, setHotelName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleFinish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;
    setLoading(true);

    const hotelId = auth.currentUser.uid;
    try {
      // Initialize Hotel Doc
      await setDoc(doc(db, 'hotels', hotelId), {
        id: hotelId,
        name: hotelName,
        persona: "Helpful, professional, and concise.",
        faqs: [],
        slas: { housekeeping: 15, maintenance: 30, front_desk: 5 }
      });

      // Redirect to Admin Panel
      window.location.hash = `#/admin/${hotelId}`;
    } catch (err) {
      setLoading(false);
      handleFirestoreError(err, OperationType.WRITE, `hotels/${hotelId}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-8 border border-gray-100">
        <h2 className="text-2xl font-bold text-gray-900 text-center mb-2">Setup Your Hotel</h2>
        <p className="text-gray-500 text-center mb-8 text-sm">Tell us about your property.</p>
        
        <form onSubmit={handleFinish} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Hotel Name</label>
            <input
              type="text"
              required
              value={hotelName}
              onChange={(e) => setHotelName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
              placeholder="e.g. The Grand Budapest"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-sm transition-colors"
          >
            {loading ? 'Setting up...' : 'Get Started'}
          </button>
        </form>
      </div>
    </div>
  );
};
