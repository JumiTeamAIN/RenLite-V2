import React, { useState, useEffect } from 'react';
import { Simulator } from './components/Simulator';
import { ChatWindow } from './components/ChatWindow';
import { AdminPortal } from './components/AdminPortal';
import { LandingPage } from './components/LandingPage';
import { LoginPage } from './components/LoginPage';
import { SignUpPage } from './components/SignUpPage';
import { Onboarding } from './components/Onboarding';
import { InvitePage } from './components/InvitePage';

function parseHashRoute(hash: string): { path: string; params: URLSearchParams } {
  const normalized = hash || '#/';
  const qIndex = normalized.indexOf('?');
  if (qIndex === -1) {
    return { path: normalized, params: new URLSearchParams(window.location.search) };
  }
  const path = normalized.slice(0, qIndex);
  const hashParams = new URLSearchParams(normalized.slice(qIndex + 1));
  return { path, params: hashParams };
}

const App: React.FC = () => {
  const [route, setRoute] = useState(window.location.hash || '#/');

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const { path, params } = parseHashRoute(route);
  const locationCode = params.get('loc') || undefined;

  if (path === '#/invite') return <InvitePage token={params.get('token') || ''} />;

  // --- DEV / SIMULATOR ---
  if (path.startsWith('#/simulate/')) {
    const hotelId = path.split('/')[2] || 'test-hotel-001';
    return <Simulator hotelId={hotelId} initialLocationCode={locationCode} />;
  }

  // --- GUEST ---
  if (path.startsWith('#/g/')) {
    const hotelId = path.split('/')[2];
    if (!hotelId) {
      return <LandingPage />;
    }
    return (
      <div className="min-h-screen bg-slate-100 md:py-4">
        <div className="h-screen md:h-[calc(100vh-2rem)] w-full max-w-2xl mx-auto bg-white md:rounded-2xl md:border md:border-slate-200 md:shadow-sm overflow-hidden">
          <ChatWindow hotelId={hotelId} locationCode={locationCode} />
        </div>
      </div>
    );
  }

  // --- ADMIN ---
  if (path.startsWith('#/admin/')) {
    const hotelId = path.split('/')[2];
    return (
      <div className="h-screen">
        <AdminPortal hotelId={hotelId} />
      </div>
    );
  }

  // --- AUTH FLOW ---
  const searchParams = new URLSearchParams(window.location.search);
  const actionMode = searchParams.get('mode');
  const oobCode = searchParams.get('oobCode');

  if (actionMode === 'resetPassword' && oobCode) {
    return <LoginPage initialMode="confirm-reset" oobCode={oobCode} />;
  }

  if (path === '#/login' || path === '#/forgot-password') {
    return <LoginPage initialMode={path === '#/forgot-password' ? 'forgot' : 'login'} />;
  }

  if (path === '#/signup') {
    return <SignUpPage />;
  }

  if (path === '#/onboarding') {
    return <Onboarding />;
  }

  // --- LANDING ---
  return <LandingPage />;
};

export default App;
