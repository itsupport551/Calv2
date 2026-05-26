// ============================================================
// Supabase Auth middleware
// ============================================================
// Verifies a Supabase access-token JWT from the Authorization header,
// finds (or creates on first call) the corresponding row in our `users`
// table, and attaches the local user id + email + role to req.user.
//
// Using a Bearer token instead of a cookie sidesteps every cross-domain
// cookie quirk between the Vercel frontend and the Railway backend.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import config from '../config';
import getDatabase from '../database/client';
import { authLogger } from '../utils/logger';
import { UserRole } from '../types';

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  if (!config.supabase.url || !config.supabase.anonKey) return null;
  _supabase = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: {
        id: string;          // our internal user id (UUID)
        email: string;
        role: UserRole;
        supabaseUserId: string;
      };
    }
  }
}

export async function authenticateSupabase(req: Request, res: Response, next: NextFunction): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
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

  // Verify token by asking Supabase. Returns null if invalid/expired.
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or expired Supabase session' },
    });
    return;
  }

  const sbUser = data.user;
  const db = getDatabase();

  // Find-or-create our local user row. We key by supabaseUserId so the
  // same Supabase identity always maps to the same internal user, even
  // if the user later changes their email.
  let user = await db.user.findUnique({ where: { supabaseUserId: sbUser.id } });
  if (!user) {
    // Fall back to matching by email (in case the user was created via
    // the legacy OAuth login flow before Supabase Auth was added).
    if (sbUser.email) {
      user = await db.user.findUnique({ where: { email: sbUser.email } });
      if (user) {
        user = await db.user.update({
          where: { id: user.id },
          data: { supabaseUserId: sbUser.id },
        });
      }
    }
  }
  if (!user) {
    // First time we see this Supabase user — create the local row.
    user = await db.user.create({
      data: {
        email: sbUser.email || `${sbUser.id}@no-email.local`,
        displayName: (sbUser.user_metadata?.full_name as string) || sbUser.email || 'New user',
        role: 'USER',
        supabaseUserId: sbUser.id,
        isActive: true,
      },
    });
    authLogger.info({ userId: user.id, supabaseUserId: sbUser.id }, 'Provisioned local user from Supabase identity');
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
