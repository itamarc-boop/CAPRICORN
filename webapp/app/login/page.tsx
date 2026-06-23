'use client';
import { useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase/browser';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setLoading('google');
    setError(null);
    const supabase = getBrowserSupabase();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
    if (error) {
      setError(error.message);
      setLoading(null);
    }
  }

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading('email');
    setError(null);
    const supabase = getBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(null);
    } else {
      window.location.href = '/';
    }
  }

  return (
    <div className="mx-auto max-w-sm mt-20">
      <div className="text-center mb-10">
        <h1
          className="font-display text-[36px] leading-none"
          style={{ color: 'var(--navy-deep)' }}
        >
          Capricorn
        </h1>
        <p
          className="font-display italic text-[15px] mt-1"
          style={{ color: 'var(--ink-3)' }}
        >
          Lead Ops
        </p>
        <p className="text-[12.5px] mt-5" style={{ color: 'var(--ink-3)' }}>
          Sign in to your Capricorn account.
        </p>
      </div>

      <form onSubmit={signInWithEmail} className="space-y-3 mb-6">
        <input
          type="email"
          placeholder="Email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full rounded px-3 py-2.5 text-[13.5px] border"
          style={{ borderColor: 'var(--line-strong)' }}
        />
        <input
          type="password"
          placeholder="Password"
          required
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full rounded px-3 py-2.5 text-[13.5px] border"
          style={{ borderColor: 'var(--line-strong)' }}
        />
        <button
          type="submit"
          disabled={loading !== null}
          className="btn-primary w-full"
        >
          {loading === 'email' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="flex items-center gap-3 my-6" aria-hidden>
        <div className="h-px flex-1" style={{ background: 'var(--line)' }} />
        <span className="text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--ink-4)' }}>
          or
        </span>
        <div className="h-px flex-1" style={{ background: 'var(--line)' }} />
      </div>

      <button
        onClick={signInWithGoogle}
        disabled={loading !== null}
        className="btn-ghost w-full"
      >
        {loading === 'google' ? 'Redirecting…' : 'Sign in with Google'}
      </button>

      {error && (
        <p
          className="text-[12.5px] mt-5 text-center rounded px-3 py-2"
          style={{ color: 'var(--warn-ink)', background: 'var(--warn-bg)' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
