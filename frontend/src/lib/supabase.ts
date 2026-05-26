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
 * Returns the JSON body directly. Throws with a meaningful message on
 * network failure or non-2xx responses so the UI surfaces real errors
 * instead of getting stuck in a loading state.
 */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not authenticated — please sign in again');

  // 15s timeout so a hung backend doesn't leave the UI stuck on
  // "Working..." forever — user gets a clear error instead.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
  } catch (networkErr) {
    const e = networkErr as Error;
    if (e.name === 'AbortError') {
      throw new Error(`Request to ${path} timed out after 15s — backend not responding`);
    }
    throw new Error(`Network error reaching ${API_BASE}: ${e.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  // Always try to parse JSON; backend always returns JSON on errors too.
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }

  if (!res.ok) {
    const msg = body?.error?.message
      || body?.message
      || `HTTP ${res.status} from ${path}`;
    const err = new Error(msg);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body as T;
}
