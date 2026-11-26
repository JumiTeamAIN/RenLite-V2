import React, { useState } from 'react';
import { auth, signInUser, signUpUser } from '../services/firebase';
import { sendEmailVerification } from 'firebase/auth';

export const InvitePage: React.FC<{ token: string }> = ({ token }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: 'signup' | 'login' | 'accept' | 'verify') => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid invitation link.');
      if (action === 'signup') {
        const cred = await signUpUser(email.trim(), password);
        await sendEmailVerification(cred.user);
        setNotice('Check your email, verify your address, then return here and select Accept invitation.');
        return;
      }
      if (action === 'login') await signInUser(email.trim(), password);
      const user = auth.currentUser;
      if (!user || user.isAnonymous) throw new Error('Sign in with your invited email first.');
      await user.reload();
      if (action === 'verify') {
        await sendEmailVerification(user);
        setNotice('Verification email sent. Return here after verifying.');
        return;
      }
      if (!user.emailVerified) {
        setNotice('Verify your email before accepting. Use Send verification email if needed.');
        return;
      }
      const response = await fetch('/api/team/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await user.getIdToken(true) },
        body: JSON.stringify({ token })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to accept invitation.');
      window.location.replace(window.location.pathname + '#/admin/' + encodeURIComponent(data.hotelId));
    } catch (e: any) {
      setError(e?.code === 'auth/email-already-in-use' ? 'This email already has an account. Choose Sign in and accept.' : e?.message || 'Unable to continue.');
    } finally { setBusy(false); }
  };
  return <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
    <div className="bg-white rounded-xl shadow p-6 max-w-md w-full space-y-4">
      <h1 className="text-2xl font-bold">Join your hotel on RenLite</h1>
      <p className="text-sm text-slate-600">Use the email address your hotel administrator invited. Already have an account? Sign in instead.</p>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run('login'); }}>
        <label className="block text-sm">Invited email<input required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} className="block w-full border rounded-lg p-2" /></label>
        <label className="block text-sm">Password<input required type="password" minLength={6} value={password} onChange={e=>setPassword(e.target.value)} className="block w-full border rounded-lg p-2" /></label>
        <button disabled={busy} type="submit" className="w-full bg-indigo-600 text-white rounded-lg p-3">Sign in and accept</button>
        <button disabled={busy || !email || password.length < 6} type="button" onClick={()=>void run('signup')} className="w-full border rounded-lg p-3">Create staff account</button>
      </form>
      <button disabled={busy} onClick={()=>void run('accept')} className="w-full border rounded-lg p-3">Accept invitation after verification</button>
      <button disabled={busy} onClick={()=>void run('verify')} className="text-indigo-600 text-sm">Send verification email</button>
      {notice && <p role="status" className="text-sm text-slate-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  </main>;
};
