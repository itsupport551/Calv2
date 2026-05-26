// ============================================================
// Supabase browser client + tiny helper around fetch()
// ============================================================
// One Supabase client for the whole app — handles email/password
// signup + login, persists the session in localStorage, refreshes
// access tokens automatically.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4400';

/**
 * fetch wrapper that automatically attaches the Supabase access-token
 * as a Bearer header. Use this for every call to our backend API.
 * Returns the JSON body directly.
 */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  return res.json() as Promise<T>;
}
