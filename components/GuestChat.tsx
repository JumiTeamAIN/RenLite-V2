import React, { useState, useEffect, useRef } from 'react';
import { signInAnonymously } from 'firebase/auth';
import { auth } from '../services/firebase';
import { dbService } from '../services/db';
import { generateRenResponse } from '../services/geminiService';
import { Message, Session, HotelConfig } from '../types';

interface GuestChatProps {
  onExit: () => void;
  hotelId: string;
}

export const GuestChat: React.FC<GuestChatProps> = ({ onExit, hotelId }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [hotelConfig, setHotelConfig] = useState<HotelConfig | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Auth & Session Init
  useEffect(() => {
    const init = async () => {
      // 1. Authenticate
      const userCred = await signInAnonymously(auth);
      const uid = userCred.user.uid;

      // 2. Fetch Config
      const config = await dbService.getHotelConfig(hotelId);
      if (!config) {
          // Initialize if missing (simulating backend setup)
          await dbService.initHotel(hotelId, 'Ren Spaces Hotel');
          const newConfig = await dbService.getHotelConfig(hotelId);
          setHotelConfig(newConfig);
      } else {
          setHotelConfig(config);
      }

      // 3. Find or Create Session
      const savedSessionId = localStorage.getItem(`ren_session_${hotelId}`);
      if (savedSessionId) {
        const existing = await dbService.getSession(hotelId, savedSessionId);
        if (existing) {
          setSession(existing);
          return;
        }
      }
      
      const newSession = await dbService.createSession(hotelId, uid, 'en');
      localStorage.setItem(`ren_session_${hotelId}`, newSession.id);
      setSession(newSession);
    };

    init();
  }, [hotelId]);

  // Listeners
  useEffect(() => {
    if (!session) return;

    // Listen to Session Status
    const unsubSession = dbService.subscribeToSession(hotelId, session.id, (updated) => {
      if (updated) setSession(updated);
    });

    // Listen to Messages
    const unsubMessages = dbService.subscribeToMessages(hotelId, session.id, (msgs) => {
      setMessages(msgs);
    });

    return () => {
      unsubSession();
      unsubMessages();
    };
  }, [session?.id, hotelId]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // "Ghost in the Machine" - Simulating Cloud Function trigger for AI
  useEffect(() => {
    if (!session || messages.length === 0 || isProcessing || !hotelConfig) return;

    const lastMsg = messages[messages.length - 1];

    // Only respond if last message is from guest and reasonably recent (prevent responding to old history on load)
    // In a real app, backend checks 'processed' flag. Here we check if it's new.
    const isRecent = Math.abs(Date.now() - lastMsg.timestamp.toMillis()) < 10000;
    
    if (lastMsg.sender === 'guest' && isRecent) {
       triggerRenAI(messages);
    }
  }, [messages, session, hotelConfig]);

  const triggerRenAI = async (currentHistory: Message[]) => {
      if (!session || !hotelConfig) return;
      setIsProcessing(true);
      setIsTyping(true);

      try {
        const response = await generateRenResponse(currentHistory, hotelConfig);
        
        // Write AI response
        if (response.text) {
          await dbService.sendMessage(hotelId, session.id, 'ai', response.text, 'en');
        }

        // Handle Tools
        if (response.toolCalls) {
           for (const call of response.toolCalls) {
             if (call.name === 'createRequest') {
                const args = call.args as any;
                const reqId = await dbService.createRequest(
                  hotelId,
                  session.id,
                  args.category,
                  args.description,
                  session.roomNumber || 'Unknown',
                  args.priority || 'normal'
                );
                await dbService.sendMessage(hotelId, session.id, 'ai', `(System: Ticket #${reqId.substr(0,4)} created)`, 'en');
             }
           }
        }
      } catch (e) {
        console.error("AI Error", e);
      } finally {
        setIsTyping(false);
        setIsProcessing(false);
      }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !session) return;
    const text = inputText;
    setInputText('');
    await dbService.sendMessage(hotelId, session.id, 'guest', text, 'en');
  };

  if (!session) return (
    <div className="flex items-center justify-center h-screen bg-slate-50 text-indigo-600">
       <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mr-2"></div>
       Connecting...
    </div>
  );

  return (
    <div className="flex flex-col h-screen bg-white max-w-md mx-auto shadow-2xl overflow-hidden relative">
      <header className="bg-white border-b border-gray-100 p-4 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center">
           <div className="w-10 h-10 bg-indigo-600 rounded-full flex items-center justify-center text-white mr-3">
             <span className="font-bold">R</span>
           </div>
           <div>
             <h1 className="font-bold text-gray-800">{hotelConfig?.name || 'Hotel Concierge'}</h1>
             <div className="flex items-center">
                <span className={`w-2 h-2 rounded-full mr-1 ${session.status === 'staff_controlled' ? 'bg-purple-500' : 'bg-green-500'}`}></span>
                <p className="text-xs text-gray-500 font-medium">
                   {session.status === 'staff_controlled' ? 'Staff Live' : 'Ren (AI) Active'}
                </p>
             </div>
           </div>
        </div>
        <button onClick={onExit} className="text-gray-400 hover:text-gray-600">✕</button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
        <div className="flex justify-center my-4">
           <div className="bg-gray-200 text-gray-600 text-xs px-3 py-1 rounded-full">
             Session ID: {session.id.substr(0, 6)}
           </div>
        </div>

        {messages.map((msg) => (
          <div key={msg.id} className={`flex flex-col max-w-[85%] ${msg.sender === 'guest' ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
             <div className="flex items-end gap-2">
                {msg.sender !== 'guest' && (
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs text-white shrink-0 mb-1 ${msg.sender === 'ai' ? 'bg-indigo-400' : 'bg-purple-600'}`}>
                    {msg.sender === 'ai' ? 'R' : 'S'}
                  </div>
                )}
                <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm ${msg.sender === 'guest' ? 'bg-indigo-600 text-white rounded-br-none' : msg.sender === 'staff' ? 'bg-purple-600 text-white rounded-bl-none' : 'bg-white text-gray-800 border border-gray-100 rounded-bl-none'}`}>
                  {msg.text}
                </div>
             </div>
             <span className="text-[10px] text-gray-400 mt-1 px-1">
               {msg.sender === 'ai' ? 'Ren' : msg.sender === 'staff' ? 'Staff' : 'You'} • {msg.timestamp?.toDate().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
             </span>
          </div>
        ))}

        {isTyping && (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-indigo-400 flex items-center justify-center text-xs text-white">R</div>
            <div className="bg-white border border-gray-100 px-4 py-3 rounded-2xl rounded-bl-none shadow-sm">
               <div className="flex space-x-1">
                 <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce"></div>
                 <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce delay-75"></div>
                 <div className="w-2 h-2 bg-gray-300 rounded-full animate-bounce delay-150"></div>
               </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-4 bg-white border-t border-gray-100">
        <div className="relative">
          <input
            type="text"
            className="w-full bg-gray-100 border-none rounded-full py-3 px-5 pr-12 text-sm focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none"
            placeholder="Type your message..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
          <button 
            onClick={handleSend}
            disabled={!inputText.trim()}
            className="absolute right-2 top-1/2 transform -translate-y-1/2 w-8 h-8 bg-indigo-500 rounded-full flex items-center justify-center text-white hover:bg-indigo-600 disabled:opacity-50 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};