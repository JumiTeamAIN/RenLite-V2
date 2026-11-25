import React, { useState, useEffect } from 'react';
import {
  signInUser,
  resetPassword,
  verifyResetCode,
  confirmResetPassword,
} from '../services/firebase';

interface LoginPageProps {
  initialMode?: 'login' | 'forgot' | 'confirm-reset';
  oobCode?: string;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  initialMode = 'login',
  oobCode,
}) => {
  const [mode, setMode] = useState<'login' | 'forgot' | 'confirm-reset'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // In-app oobCode verification state
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [codeVerified, setCodeVerified] = useState(false);
  const [codeEmail, setCodeEmail] = useState('');
  const [resetCompleted, setResetCompleted] = useState(false);

  useEffect(() => {
    setMode(initialMode);
    setError('');
    setResetSent(false);
    setLoading(false);
    setResetCompleted(false);
  }, [initialMode]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((prev) => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (initialMode !== 'confirm-reset' || !oobCode) return;

    let cancelled = false;
    setVerifyingCode(true);
    setCodeVerified(false);
    setError('');

    verifyResetCode(oobCode)
      .then((verifiedEmail) => {
        if (cancelled) return;
        setCodeEmail(verifiedEmail);
        setEmail(verifiedEmail);
        setCodeVerified(true);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error(err);
        if (err?.code === 'auth/operation-not-allowed') {
          setError(
            'Email/Password sign-in is disabled in Firebase Console. Enable it under Authentication → Sign-in method.'
          );
        } else if (err?.code === 'auth/expired-action-code') {
          setError('This password reset link has expired. Please request a new one.');
        } else if (err?.code === 'auth/invalid-action-code') {
          setError(
            'This reset link has already been used or was replaced by a newer reset email.'
          );
        } else {
          setError('Unable to verify this password reset link. Please request a new one.');
        }
      })
      .finally(() => {
        if (!cancelled) setVerifyingCode(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialMode, oobCode]);

  const clearUrlActionParams = () => {
    if (window.location.search) {
      window.history.replaceState({}, '', `${window.location.pathname}#/login`);
    }
  };

  const switchMode = (nextMode: 'login' | 'forgot') => {
    clearUrlActionParams();
    setError('');
    setResetSent(false);
    setResetCompleted(false);
    setLoading(false);
    setMode(nextMode);
    window.location.hash = nextMode === 'forgot' ? '#/forgot-password' : '#/login';
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // DEV MODE CHECK
      if (email.toLowerCase() === 'jumi@teamain.org') {
        await signInUser(email, password);
        window.location.hash = '#/simulate/test-hotel-001';
        return;
      }

      const cred = await signInUser(email, password);
      window.location.hash = `#/admin/${cred.user.uid}`;
    } catch (err: any) {
      console.error(err);
      if (err?.code === 'auth/operation-not-allowed') {
        setError('Email/password login is not enabled yet in Firebase Console.');
      } else {
        setError('Invalid email or password.');
      }
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      await resetPassword(trimmedEmail);
      setResetSent(true);
      setResendCooldown(60);
    } catch (err: any) {
      console.error(err);
      if (err?.code === 'auth/invalid-email') {
        setError('Please enter a valid email address.');
      } else if (err?.code === 'auth/user-not-found') {
        setError('No account found with that email address.');
      } else if (err?.code === 'auth/operation-not-allowed') {
        setError('Email/password sign-in is not enabled yet in Firebase Console.');
      } else if (err?.code === 'auth/too-many-requests') {
        setError('Too many requests. Please wait a few minutes before trying again.');
      } else {
        setError('Unable to send password reset email. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oobCode) return;

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('Passwords do not match.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      await confirmResetPassword(oobCode, newPassword);
      setResetCompleted(true);
      setNewPassword('');
      setConfirmNewPassword('');
      clearUrlActionParams();
    } catch (err: any) {
      console.error(err);
      if (err?.code === 'auth/expired-action-code') {
        setError('This reset link has expired. Please request a new one.');
        setCodeVerified(false);
      } else if (err?.code === 'auth/invalid-action-code') {
        setError('This reset link has already been used or replaced. Please request a new one.');
        setCodeVerified(false);
      } else if (err?.code === 'auth/weak-password') {
        setError('Please choose a stronger password (at least 6 characters).');
      } else {
        setError('Failed to update password. Please request a new reset link.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <header className="bg-white border-b border-gray-200 py-4 shadow-sm text-center relative">
         <div className="flex items-center justify-center gap-2">
            <div className="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center text-white text-xs font-bold">R</div>
            <h1 className="text-gray-900 font-bold tracking-tight">Ren Spaces Access</h1>
         </div>
         <a href="#/" className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
           <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
         </a>
      </header>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-8 border border-gray-100">
          {mode === 'login' && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 text-center mb-8">Log In</h2>
              
              <form onSubmit={handleLogin} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    placeholder="name@hotel.com"
                  />
                </div>
                
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-gray-700">Password</label>
                    <button
                      type="button"
                      onClick={() => switchMode('forgot')}
                      className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    placeholder="••••••••"
                  />
                </div>

                {error && (
                  <div className="text-red-500 text-sm text-center bg-red-50 py-2 px-3 rounded">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-sm transition-colors disabled:opacity-70"
                >
                  {loading ? 'Logging in...' : 'Log In'}
                </button>
              </form>

              <div className="mt-8 text-center">
                <a href="#/signup" className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
                  Need an account? Sign Up
                </a>
              </div>
            </>
          )}

          {mode === 'forgot' && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 text-center mb-2">Reset Password</h2>
              <p className="text-sm text-gray-500 text-center mb-8">
                Enter your email address and we&apos;ll send you a link to reset your password.
              </p>

              {resetSent ? (
                <div className="space-y-6">
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-center">
                    <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </div>
                    <h3 className="text-sm font-semibold text-emerald-900 mb-1">Check your email</h3>
                    <p className="text-sm text-emerald-800">
                      We sent a password reset link to <span className="font-medium">{email.trim()}</span>. Check your inbox and spam folder, then return here to log in with your new password.
                    </p>
                    <p className="text-xs text-emerald-700 mt-2">
                      If you request another link later, only the most recent email link will work.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-sm transition-colors"
                  >
                    Back to Log In
                  </button>

                  <div className="text-center">
                    <button
                      type="button"
                      disabled={resendCooldown > 0}
                      onClick={() => setResetSent(false)}
                      className="text-sm font-medium text-indigo-600 hover:text-indigo-800 disabled:text-gray-400 disabled:cursor-not-allowed"
                    >
                      {resendCooldown > 0
                        ? `Resend available in ${resendCooldown}s`
                        : 'Try a different email or resend'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <form onSubmit={handleResetPassword} className="space-y-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                        placeholder="name@hotel.com"
                      />
                    </div>

                    {error && (
                      <div className="text-red-500 text-sm text-center bg-red-50 py-2 px-3 rounded">
                        {error}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-sm transition-colors disabled:opacity-70"
                    >
                      {loading ? 'Sending Reset Link...' : 'Send Reset Link'}
                    </button>
                  </form>

                  <div className="mt-8 text-center">
                    <button
                      type="button"
                      onClick={() => switchMode('login')}
                      className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
                    >
                      Back to Log In
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {mode === 'confirm-reset' && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 text-center mb-2">
                Set New Password
              </h2>

              {verifyingCode ? (
                <div className="py-10 flex flex-col items-center gap-3 text-sm text-gray-500">
                  <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo-600" />
                  Verifying reset link...
                </div>
              ) : resetCompleted ? (
                <div className="space-y-6 mt-6">
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-center">
                    <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </div>
                    <h3 className="text-sm font-semibold text-emerald-900 mb-1">Password updated</h3>
                    <p className="text-sm text-emerald-800">
                      Your password has been reset. You can now log in with your new password.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-sm transition-colors"
                  >
                    Continue to Log In
                  </button>
                </div>
              ) : !codeVerified ? (
                <div className="space-y-6 mt-6">
                  <div className="text-red-600 text-sm text-center bg-red-50 border border-red-200 py-3 px-4 rounded-lg">
                    {error || 'This password reset link is invalid or has expired.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-sm transition-colors"
                  >
                    Request a New Reset Link
                  </button>
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => switchMode('login')}
                      className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
                    >
                      Back to Log In
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-500 text-center mb-8">
                    Create a new password for <span className="font-medium text-gray-700">{codeEmail}</span>.
                  </p>
                  <form onSubmit={handleConfirmNewPassword} className="space-y-5">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                        placeholder="At least 6 characters"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={confirmNewPassword}
                        onChange={(e) => setConfirmNewPassword(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                        placeholder="Re-enter new password"
                      />
                    </div>

                    {error && (
                      <div className="text-red-500 text-sm text-center bg-red-50 py-2 px-3 rounded">
                        {error}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg shadow-sm transition-colors disabled:opacity-70"
                    >
                      {loading ? 'Updating Password...' : 'Save New Password'}
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
