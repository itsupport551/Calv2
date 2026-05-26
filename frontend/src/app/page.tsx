'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // If user is already signed in, jump to dashboard.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) window.location.href = '/dashboard';
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) window.location.href = '/dashboard';
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setInfo('Check your email to confirm your account, then sign in.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange handles the redirect
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const isSignIn = mode === 'signin';

  return (
    <div className="login-container">
      <div className="login-card animate-in">
        <div style={{ marginBottom: '24px' }}>
          <div style={{
            width: 64, height: 64,
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            borderRadius: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, margin: '0 auto 16px',
            boxShadow: '0 0 30px rgba(102, 126, 234, 0.3)',
          }}>🔄</div>
        </div>

        <h1 className="login-title">CalendarSync Enterprise</h1>
        <p className="login-subtitle">
          {isSignIn ? 'Sign in to your account' : 'Create your account'}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Password (min 8 chars)"
            value={password}
            onChange={e => setPassword(e.target.value)}
            style={inputStyle}
          />

          {error && (
            <div style={{ color: '#ff6b6b', fontSize: 13, padding: '8px 0' }}>⚠️ {error}</div>
          )}
          {info && (
            <div style={{ color: '#51cf66', fontSize: 13, padding: '8px 0' }}>✓ {info}</div>
          )}

          <button type="submit" className="login-btn" disabled={busy} style={{ marginTop: 8 }}>
            {busy ? 'Please wait…' : isSignIn ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div style={{ marginTop: 18, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
          {isSignIn ? (
            <>
              Don't have an account?{' '}
              <button onClick={() => { setMode('signup'); setError(null); setInfo(null); }} style={linkButton}>
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button onClick={() => { setMode('signin'); setError(null); setInfo(null); }} style={linkButton}>
                Sign in
              </button>
            </>
          )}
        </div>

        <div className="login-security-note" style={{ marginTop: 24 }}>
          <span>🔒</span>
          <span>
            Login is handled by Supabase Auth. Calendar accounts (Google / Outlook)
            are connected separately from inside the dashboard.
          </span>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '12px 14px',
  background: 'var(--surface-2, #1e2130)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: 14,
  outline: 'none',
};

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent-primary)',
  cursor: 'pointer',
  fontSize: 13,
  padding: 0,
  textDecoration: 'underline',
};
