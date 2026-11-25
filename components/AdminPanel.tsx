import React, { useState, useEffect } from 'react';
import { dbService } from '../services/db';
import { HotelConfig } from '../types';

interface AdminPanelProps {
  hotelId: string;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ hotelId }) => {
  const [config, setConfig] = useState<HotelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');

  useEffect(() => {
    dbService.getHotelConfig(hotelId).then(cfg => {
      setConfig(cfg);
      setLoading(false);
    });
  }, [hotelId]);

  const handleSaveConfig = async () => {
    if (config) {
      await dbService.updateHotelConfig(hotelId, config);
      alert("Configuration saved!");
    }
  };

  const updateSla = (key: keyof HotelConfig['slas'], value: string) => {
    if (config) {
      setConfig({
        ...config,
        slas: { ...config.slas, [key]: parseInt(value) || 0 }
      });
    }
  };

  if (loading || !config) return <div className="p-8">Loading configuration...</div>;

  return (
    <div className="p-8 bg-slate-50 h-full overflow-y-auto">
       <h1 className="text-2xl font-bold text-gray-900 mb-2">Team Management</h1>
       
       <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-6">Invite New Team Member</h2>
          <div className="flex gap-4 items-end">
             <div className="flex-1">
               <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Email Address</label>
               <input 
                 type="email" 
                 value={email}
                 onChange={e => setEmail(e.target.value)}
                 className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                 placeholder="colleague@hotel.com"
               />
             </div>
             <button onClick={() => alert('Invite sent')} className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-6 rounded-lg transition-colors">
               Send Invite
             </button>
          </div>
       </div>

       <h1 className="text-2xl font-bold text-gray-900 mb-2 mt-12">Configuration</h1>
       
       <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
             <div className="flex items-center mb-4">
                <span className="text-xl mr-2">🏨</span>
                <h3 className="font-semibold text-gray-800">Property Details</h3>
             </div>
             <div className="grid grid-cols-2 gap-8">
                <div>
                   <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Hotel ID</label>
                   <div className="bg-gray-100 px-3 py-2 rounded text-sm font-mono text-gray-600">{hotelId}</div>
                </div>
                <div>
                   <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Hotel Name</label>
                   <input 
                      value={config.name}
                      onChange={(e) => setConfig({...config, name: e.target.value})}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                   />
                </div>
             </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center mb-4">
                <span className="text-xl mr-2">🕒</span>
                <h3 className="font-semibold text-gray-800">Service Level Agreements (SLAs)</h3>
             </div>
             <div className="grid grid-cols-4 gap-4">
                {Object.entries(config.slas).map(([key, val]) => (
                   <div key={key} className="bg-gray-50 p-4 rounded-lg">
                      <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">{key.replace('_', ' ')}</label>
                      <input 
                        type="number"
                        value={val}
                        onChange={(e) => updateSla(key as any, e.target.value)}
                        className="text-lg font-bold text-gray-800 bg-transparent w-full border-b border-gray-300 focus:border-indigo-500 outline-none"
                      />
                   </div>
                ))}
             </div>
          </div>

          <div className="flex justify-end">
             <button onClick={handleSaveConfig} className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-8 rounded-lg shadow-sm transition-colors">
                Save Configuration
             </button>
          </div>
       </div>
    </div>
  );
};