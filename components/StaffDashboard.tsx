import React, { useState, useEffect, useRef } from 'react';
import { dbService } from '../services/db';
import { Session, Message, Request } from '../types';

interface StaffDashboardProps {
  hotelId: string;
}

export const StaffDashboard: React.FC<StaffDashboardProps> = ({ hotelId }) => {
  const [activeTab, setActiveTab] = useState<'active' | 'completed'>('active');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [staffInput, setStaffInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Subscribe to Hotel Data
  useEffect(() => {
    const unsubSessions = dbService.subscribeToHotelSessions(hotelId, (data) => {
      setSessions(data);
    });
    const unsubRequests = dbService.subscribeToRequests(hotelId, (data) => {
      setRequests(data);
    });
    return () => {
      unsubSessions();
      unsubRequests();
    };
  }, [hotelId]);

  // Subscribe to Selected Chat
  useEffect(() => {
    if (!selectedSessionId) {
      setChatMessages([]);
      return;
    }
    const unsub = dbService.subscribeToMessages(hotelId, selectedSessionId, (msgs) => {
      setChatMessages(msgs);
    });
    return unsub;
  }, [selectedSessionId, hotelId]);

  // Scroll
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  const handleSendMessage = async () => {
    if (!staffInput.trim() || !selectedSessionId) return;
    await dbService.sendMessage(hotelId, selectedSessionId, 'staff', staffInput, 'en');
    setStaffInput('');
  };

  const handleTakeOver = async () => {
     if (selectedSessionId) {
       await dbService.sendMessage(hotelId, selectedSessionId, 'staff', 'Staff has joined the chat.', 'en');
       // Logic to update session status to 'staff_controlled' would go here in dbService
     }
  };
  
  const handleResolveRequest = async (reqId: string) => {
    await dbService.updateRequestStatus(hotelId, reqId, 'completed');
  }

  const filteredSessions = sessions.filter(s => {
    if (activeTab === 'active') return s.status !== 'completed';
    return s.status === 'completed';
  });

  const selectedSession = sessions.find(s => s.id === selectedSessionId);
  const selectedSessionRequests = requests.filter(r => r.sessionId === selectedSessionId);

  return (
    <div className="flex h-full bg-white">
      {/* List Column */}
      <div className="w-96 border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200 flex justify-between items-center">
          <h2 className="text-lg font-bold text-gray-800">Inbox</h2>
          <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded-full">{filteredSessions.length} active</span>
        </div>
        
        <div className="flex border-b border-gray-200">
          <button 
            onClick={() => setActiveTab('active')}
            className={`flex-1 py-3 text-sm font-medium border-b-2 ${activeTab === 'active' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500'}`}
          >
            Active
          </button>
          <button 
            onClick={() => setActiveTab('completed')}
            className={`flex-1 py-3 text-sm font-medium border-b-2 ${activeTab === 'completed' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500'}`}
          >
            History
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredSessions.map(sess => {
            return (
              <div 
                key={sess.id}
                onClick={() => setSelectedSessionId(sess.id)}
                className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${selectedSessionId === sess.id ? 'bg-indigo-50 border-l-4 border-l-indigo-600' : ''}`}
              >
                <div className="flex justify-between items-start mb-1">
                  <div className="flex items-center gap-2">
                     {sess.isUnread && <div className="w-2 h-2 bg-blue-500 rounded-full"></div>}
                     <span className="font-semibold text-gray-900 text-sm">
                       {sess.roomNumber ? `Room ${sess.roomNumber}` : `Guest ${sess.id.substr(0,4)}`}
                     </span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {sess.lastUpdatedAt?.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                  </span>
                </div>
                <p className="text-xs text-gray-500 truncate">{sess.previewText}</p>
                <div className="flex gap-1 mt-2 flex-wrap">
                  {requests.filter(r => r.sessionId === sess.id && r.status !== 'completed').map(r => (
                    <span key={r.id} className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-medium border border-red-200">
                      {r.category}
                    </span>
                  ))}
                   <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px] font-medium border border-gray-200 uppercase">
                      {sess.guestLanguage}
                    </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail Column */}
      <div className="flex-1 flex flex-col bg-slate-50">
        {selectedSession ? (
          <>
            <div className="h-16 bg-white border-b border-gray-200 px-6 flex items-center justify-between shadow-sm">
              <div>
                <h3 className="font-bold text-gray-800">
                   {selectedSession.roomNumber ? `Room ${selectedSession.roomNumber}` : 'Guest Session'}
                </h3>
                <div className="flex items-center text-xs text-gray-500 gap-2">
                   <span className={`w-2 h-2 rounded-full ${selectedSession.status === 'staff_controlled' ? 'bg-purple-500' : 'bg-green-500'}`}></span>
                   {selectedSession.status === 'staff_controlled' ? 'You have control' : 'Ren (AI) responding'}
                </div>
              </div>
              <button onClick={handleTakeOver} className="bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold py-2 px-4 rounded uppercase tracking-wider transition-colors">
                Take Over
              </button>
            </div>

            <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 flex flex-col">
                    <div className="flex-1 overflow-y-auto p-6 space-y-6">
                      {chatMessages.map(msg => (
                        <div key={msg.id} className={`flex ${msg.sender === 'guest' ? 'justify-start' : 'justify-end'}`}>
                           {msg.sender === 'guest' && (
                             <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-xs font-bold mr-3 shrink-0">G</div>
                           )}
                           <div className={`max-w-xl`}>
                              <div className={`p-4 rounded-lg shadow-sm text-sm ${msg.sender === 'guest' ? 'bg-white text-gray-800 border border-gray-200 rounded-tl-none' : msg.sender === 'ai' ? 'bg-gray-100 text-gray-700 rounded-tr-none' : 'bg-purple-600 text-white rounded-tr-none'}`}>
                                {msg.text}
                              </div>
                              <div className={`text-[10px] text-gray-400 mt-1 ${msg.sender === 'guest' ? 'text-left' : 'text-right'}`}>
                                {msg.sender === 'guest' ? 'Guest' : msg.sender === 'ai' ? 'Ren (AI)' : 'Staff'} • {msg.timestamp?.toDate().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                              </div>
                           </div>
                           {msg.sender !== 'guest' && (
                             <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ml-3 shrink-0 ${msg.sender === 'ai' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'}`}>
                               {msg.sender === 'ai' ? 'R' : 'S'}
                             </div>
                           )}
                        </div>
                      ))}
                      <div ref={chatEndRef} />
                    </div>

                    <div className="p-4 bg-white border-t border-gray-200">
                      <div className="flex gap-2">
                        <input 
                          className="flex-1 bg-gray-50 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-purple-500 outline-none"
                          placeholder="Type your reply..."
                          value={staffInput}
                          onChange={(e) => setStaffInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                        />
                        <button onClick={handleSendMessage} className="w-10 h-10 bg-purple-600 rounded-lg flex items-center justify-center text-white hover:bg-purple-700">▲</button>
                      </div>
                    </div>
                </div>

                <div className="w-80 bg-white border-l border-gray-200 p-4 overflow-y-auto">
                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-4">Context</h4>
                    {selectedSessionRequests.length === 0 && <div className="text-center text-gray-400 text-sm py-8">No active requests</div>}
                    {selectedSessionRequests.map(req => (
                      <div key={req.id} className="bg-white border border-gray-200 rounded-lg p-3 mb-3 shadow-sm relative overflow-hidden">
                        {req.status === 'completed' && <div className="absolute inset-0 bg-gray-50/50 z-10"></div>}
                        <div className="flex justify-between items-start mb-2">
                           <span className="font-bold text-gray-800 text-sm capitalize">{req.category}</span>
                           <button 
                            onClick={() => handleResolveRequest(req.id)}
                            className={`text-[10px] font-bold border px-2 py-0.5 rounded ${req.status === 'completed' ? 'bg-green-100 text-green-700 border-transparent' : 'text-green-600 border-green-200 hover:bg-green-50'}`}
                           >
                             {req.status === 'completed' ? 'DONE' : 'Complete'}
                           </button>
                        </div>
                        <p className="text-xs text-gray-600 mb-2">{req.description}</p>
                        <div className="text-[10px] text-gray-400 flex justify-between">
                          <span>{req.createdAt?.toDate().toLocaleTimeString()}</span>
                          {req.priority === 'high' && <span className="text-red-500 font-bold">HIGH PRIORITY</span>}
                        </div>
                      </div>
                    ))}
                </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">Select a conversation</div>
        )}
      </div>
    </div>
  );
};