import React, { useState } from 'react';
import { auth } from '../services/firebase';
import { sendEmailVerification } from 'firebase/auth';

export const TeamManagement: React.FC<{hotelId: string}> = ({hotelId}) => {
  const [email,setEmail] = useState('');
  const [role,setRole] = useState('associate');
  const [department,setDepartment] = useState('Front Desk');
  const [link,setLink] = useState('');
  const [expires,setExpires] = useState('');
  const [message,setMessage] = useState('');
  const [busy,setBusy] = useState(false);
  const generate = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setLink(''); setMessage('');
    try {
      const user = auth.currentUser;
      if (!user || user.isAnonymous) throw new Error('Sign in as a hotel administrator.');
      await user.reload();
      if (!user.emailVerified) throw new Error('Verify your email before inviting team members.');
      const response = await fetch('/api/team/invitations', {
        method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+await user.getIdToken(true)},
        body:JSON.stringify({hotelId,email,role,department})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to generate invitation.');
      setLink(window.location.origin + window.location.pathname + '#/invite?token=' + encodeURIComponent(data.token));
      setExpires(new Date(data.expiresAt).toLocaleString());
    } catch(e:any) {setMessage(e?.message || 'Unable to generate invitation.');}
    finally {setBusy(false);}
  };
  return <section className="flex-1 overflow-auto p-6">
    <h1 className="text-2xl font-bold">Team Management</h1>
    <p className="text-slate-600 mt-1">Invite associates when you are ready. No additional setup is required to use Ren.</p>
    <form onSubmit={generate} className="bg-white border rounded-xl p-5 max-w-xl mt-5 space-y-4">
      <h2 className="font-semibold">Invite a team member</h2>
      <label className="block text-sm">Work email<input required type="email" value={email} onChange={e=>{setEmail(e.target.value);setLink('');}} className="block w-full border rounded-lg p-2" /></label>
      <label className="block text-sm">Access<select value={role} onChange={e=>{setRole(e.target.value);setLink('');}} className="block w-full border rounded-lg p-2"><option value="associate">Associate — guest conversations and requests</option><option value="manager">Manager — operations and hotel configuration</option></select></label>
      <label className="block text-sm">Department<select value={department} onChange={e=>{setDepartment(e.target.value);setLink('');}} className="block w-full border rounded-lg p-2">{['Front Desk','Housekeeping','Engineering','Food & Beverage','Management','Other'].map(d=><option key={d}>{d}</option>)}</select></label>
      <button type="submit" disabled={busy} className="bg-indigo-600 text-white rounded-lg px-4 py-2">Generate invitation link</button>
      {link && <div className="space-y-2"><p className="text-sm">Share privately with the invited email address. Expires {expires}.</p><input readOnly value={link} onFocus={e=>e.target.select()} className="w-full border rounded-lg p-2 text-sm"/><button type="button" className="border rounded-lg p-2" onClick={async()=>{try{await navigator.clipboard.writeText(link);setMessage('Link copied.');}catch{setMessage('Select and copy the link manually.');}}}>Copy invitation link</button></div>}
      <button type="button" disabled={busy} className="block text-sm text-indigo-600" onClick={async()=>{try{const user=auth.currentUser;if(!user||user.isAnonymous)throw new Error('Sign in first.');await sendEmailVerification(user);setMessage('Verification email sent.');}catch(e:any){setMessage(e?.message||'Unable to send verification email.');}}}>Send my email verification</button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
  </section>;
};
