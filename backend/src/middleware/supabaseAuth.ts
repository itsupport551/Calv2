// ============================================================
// Supabase Auth middleware (HTTP-only — no SDK)
// ============================================================
// Verifies a Supabase access-token JWT from the Authorization header
// by calling Supabase's /auth/v1/user endpoint directly. We deliberately
// do NOT use @supabase/supabase-js on the server — that SDK eagerly
// initializes a Realtime WebSocket client which on Node < 22 prints
// "no native WebSocket support" warnings and causes 20-second hangs
// before token verification returns.
//
// On a verified token we find-or-create the corresponding row in our
// `users` table and attach the local user id + email + role to
// req.authUser.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import config from '../config';
import getDatabase from '../database/client';
import { authLogger } from '../utils/logger';
import { UserRole } from '../types';

declare global {
  namespace Express {
    interface Request {
      authUser?: {
        id: string;
        email: string;
        role: UserRole;
        supabaseUserId: string;
      };
    }
  }
}

interface SupabaseUser {
  id: string;
  email?: string | null;
  user_metadata?: { full_name?: string };
}

/**
 * Verify a Supabase JWT by calling /auth/v1/user with it. Returns the
 * user object on success, null if the token is invalid/expired.
 */
async function verifySupabaseToken(token: string): Promise<SupabaseUser | null> {
  if (!config.supabase.url || !config.supabase.anonKey) return null;

  // 5s timeout — if Supabase Auth is slow, fail fast so the user sees
  // a clear error instead of staring at a spinner.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${config.supabase.url}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: config.supabase.anonKey,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as SupabaseUser;
  } catch (err) {
    authLogger.warn({ err: (err as Error).message }, 'Supabase token verification failed');
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function authenticateSupabase(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!config.supabase.url || !config.supabase.anonKey) {
    res.status(503).json({
      success: false,
      error: { code: 'AUTH_NOT_CONFIGURED', message: 'Supabase auth is not configured on the server (set SUPABASE_URL and SUPABASE_ANON_KEY)' },
    });
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (!token) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' },
    });
    return;
  }

  const sbUser = await verifySupabaseToken(token);
  if (!sbUser) {
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or expired Supabase session' },
    });
    return;
  }

  const db = getDatabase();

  // Find-or-create our local user row keyed by supabaseUserId. Fall back
  // to email match for legacy rows created via the old OAuth-login flow.
  let user = await db.user.findUnique({ where: { supabaseUserId: sbUser.id } });
  if (!user && sbUser.email) {
    const byEmail = await db.user.findUnique({ where: { email: sbUser.email } });
    if (byEmail) {
      user = await db.user.update({
        where: { id: byEmail.id },
        data: { supabaseUserId: sbUser.id },
      });
    }
  }
  if (!user) {
    // Concurrent requests (e.g. dashboard mount firing /api/me + /api/me/events
    // at the same time) can both reach here and race to create the same row.
    // Use upsert keyed on supabaseUserId to make it idempotent, and catch
    // any residual unique-violation (e.g. email collision with a pre-existing
    // row created before Supabase Auth was introduced) by falling back to
    // the email-keyed update.
    try {
      user = await db.user.upsert({
        where: { supabaseUserId: sbUser.id },
        create: {
          email: sbUser.email || `${sbUser.id}@no-email.local`,
          displayName: sbUser.user_metadata?.full_name || sbUser.email || 'New user',
          role: 'USER',
          supabaseUserId: sbUser.id,
          isActive: true,
        },
        update: {}, // nothing to change if it now exists
      });
      authLogger.info({ userId: user.id, supabaseUserId: sbUser.id }, 'Provisioned local user from Supabase identity');
    } catch (err: any) {
      if (err?.code === 'P2002' && sbUser.email) {
        // Another row already owns this email — link it to this supabase id.
        user = await db.user.update({
          where: { email: sbUser.email },
          data: { supabaseUserId: sbUser.id },
        });
      } else {
        throw err;
      }
    }
  }

  if (!user.isActive) {
    res.status(403).json({
      success: false,
      error: { code: 'USER_INACTIVE', message: 'Account is deactivated' },
    });
    return;
  }

  req.authUser = {
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    supabaseUserId: sbUser.id,
  };
  next();
}

/** Role gate for admin-only routes — must come AFTER authenticateSupabase. */
export function requireSupabaseRole(...allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    if (!allowed.includes(req.authUser.role)) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
      return;
    }
    next();
  };
}
