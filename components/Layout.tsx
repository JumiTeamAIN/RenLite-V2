import React from 'react';
import { View } from '../types';

interface LayoutProps {
  currentView: View;
  onChangeView: (view: View) => void;
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ currentView, onChangeView, children }) => {
  const navItems = [
    { id: View.STAFF_DASHBOARD, label: 'Inbox', icon: '📥' },
    { id: View.ADMIN_PANEL, label: 'Team Management', icon: '👥' },
    { id: 'settings', label: 'Configuration', icon: '⚙️', view: View.ADMIN_PANEL }, // Simplified for demo
  ];

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-white flex flex-col">
        <div className="p-6">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-xl font-bold mb-2">
            R
          </div>
          <span className="font-semibold text-lg tracking-tight">Ren Spaces</span>
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onChangeView(item.view || item.id as View)}
              className={`w-full flex items-center px-4 py-3 rounded-lg transition-colors text-sm font-medium
                ${currentView === (item.view || item.id) 
                  ? 'bg-indigo-600 text-white' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
            >
              <span className="mr-3">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-800">
          <button 
             onClick={() => onChangeView(View.LANDING)}
             className="flex items-center text-red-400 hover:text-red-300 text-sm font-medium px-4 py-2"
          >
            <span className="mr-3">🚪</span>
            Exit
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
};
