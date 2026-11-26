import React, { useState, useEffect, useCallback } from 'react';
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
  const [members,setMembers] = useState<{uid:string;email:string;role:string;department:string;active:boolean}[]>([]);
  const [invitations,setInvitations] = useState<{id:string;email:string;role:string;department:string;expiresAt:string}[]>([]);
  const [directoryError,setDirectoryError] = useState('');
  const [directoryBusy,setDirectoryBusy] = useState(false);
  const api = useCallback(async (url:string, body?:object) => {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) throw new Error('Sign in first.');
    const response = await fetch(url, { method:body?'POST':'GET', headers:{'Content-Type':'application/json',Authorization:'Bearer '+await user.getIdToken(true)}, ...(body?{body:JSON.stringify(body)}:{}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to complete team action.');
    return data;
  }, []);
  const refresh = useCallback(async () => {
    setDirectoryBusy(true); setDirectoryError('');
    try {
      const data = await api('/api/team/directory/'+encodeURIComponent(hotelId));
      setMembers(data.members); setInvitations(data.invitations);
    } catch(e:any) {setMembers([]);setInvitations([]);setDirectoryError(e?.message || 'Unable to load team.');}
    finally {setDirectoryBusy(false);}
  }, [hotelId,api]);
  useEffect(()=>{void refresh();},[refresh]);
  const change = async (endpoint:string,body:object,confirmation:string) => {
    if (!window.confirm(confirmation)) return;
    setDirectoryBusy(true);setDirectoryError('');
    try {await api(endpoint,{hotelId,...body});setLink('');await refresh();}
    catch(e:any){setDirectoryError(e?.message||'Unable to save change.');setDirectoryBusy(false);}
  };
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
      await refresh();
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
    <div className="max-w-3xl mt-6 space-y-4">
      <div className="flex items-center justify-between"><h2 className="font-semibold text-lg">Your team</h2><button disabled={directoryBusy} onClick={()=>void refresh()} className="border rounded-lg px-3 py-1">Refresh</button></div>
      {directoryError && <p role="alert" className="text-sm text-red-600">{directoryError}</p>}
      {directoryBusy && <p role="status" className="text-sm text-slate-500">Updating team…</p>}
      <div className="bg-white border rounded-xl divide-y">
        {!members.length && !directoryBusy && <p className="p-4 text-sm text-slate-600">No invited staff yet. The original hotel owner is not listed here.</p>}
        {members.map(m=><div key={m.uid} className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0"><p className="font-medium break-all">{m.email}</p><p className="text-xs text-slate-500">{m.department} · {m.active?'Active':'Deactivated'}</p></div>
          {['manager','associate'].includes(m.role) && m.uid!==auth.currentUser?.uid ? <>
            <select aria-label={'Access for '+m.email} disabled={directoryBusy} value={m.role} onChange={e=>void change('/api/team/member',{uid:m.uid,role:e.target.value,active:m.active},'Change this team member’s access level?')} className="border rounded p-2"><option value="associate">Associate</option><option value="manager">Manager</option></select>
            <button disabled={directoryBusy} className="border rounded p-2" onClick={()=>void change('/api/team/member',{uid:m.uid,role:m.role,active:!m.active},m.active?'Deactivate this member’s hotel access?':'Restore this member’s hotel access?')}>{m.active?'Deactivate':'Reactivate'}</button>
          </>:<span className="text-sm">{m.role}</span>}
        </div>)}
      </div>
      <h2 className="font-semibold text-lg">Pending invitations</h2>
      <div className="bg-white border rounded-xl divide-y">
        {!invitations.length && !directoryBusy && <p className="p-4 text-sm text-slate-600">No pending invitations.</p>}
        {invitations.map(i=><div key={i.id} className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0"><p className="font-medium break-all">{i.email}</p><p className="text-xs text-slate-500">{i.role} · {i.department} · Expires {new Date(i.expiresAt).toLocaleString()}</p></div>
          <button disabled={directoryBusy} className="border rounded p-2 text-red-600" onClick={()=>void change('/api/team/revoke',{id:i.id},'Revoke this invitation? The link will stop working.')}>Revoke</button>
        </div>)}
      </div>
    </div>
  </section>;
};
