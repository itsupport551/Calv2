// ============================================================
// Enterprise Calendar Sync — Calendar Connection Routes
// ============================================================
// Authentication itself is handled by Supabase Auth on the frontend.
// These routes EXCLUSIVELY handle linking a calendar provider (Google
// Calendar / Microsoft Graph) to the already-logged-in user.
//
// Flow:
//   1. Frontend (already authenticated with Supabase) requests
//      GET /auth/{provider}/url with the Supabase JWT in Authorization.
//      Backend signs a short-lived `state` containing the user id and
//      returns the OAuth consent URL.
//   2. Browser navigates to the consent URL.
//   3. Provider redirects to /auth/{provider}/callback?code=...&state=...
//      Backend verifies the state, exchanges the code for tokens, and
//      stores them encrypted against the user identified by state.uid.
//   4. Browser is redirected back to the dashboard.
//
// No cookie is set, no JWT issued — login is handled separately by
// Supabase.
// ============================================================

import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { buildMicrosoftAuthUrl, exchangeCodeForTokens } from '../connectors/microsoft/oauth';
import config from '../config';
import getDatabase from '../database/client';
import { encrypt } from '../crypto/encryption';
import { logAuditEvent } from '../audit/logger';
import { authLogger } from '../utils/logger';
import { AuditAction, AuditResourceType, AuditSource } from '../types';
import { authRateLimiter } from '../middleware/security';
import { authenticateSupabase } from '../middleware/supabaseAuth';
import { bootstrapGoogleConnection, bootstrapMicrosoftConnection } from '../sync/bootstrapConnection';

const router = Router();

interface OAuthStatePayload {
  uid: string;
  provider: 'google' | 'microsoft';
  iat: number;
  exp: number;
}

function signOAuthState(uid: string, provider: 'google' | 'microsoft'): string {
  return jwt.sign({ uid, provider }, config.jwt.secret, { expiresIn: '10m' });
}

function verifyOAuthState(state: string, expectedProvider: 'google' | 'microsoft'): string | null {
  try {
    const decoded = jwt.verify(state, config.jwt.secret) as OAuthStatePayload;
    if (decoded.provider !== expectedProvider) return null;
    return decoded.uid;
  } catch {
    return null;
  }
}

// ---- Google ----

const googleOAuth = new OAuth2Client(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri,
);

/** Authenticated frontend asks for the consent URL with a signed state. */
router.get('/google/url', authenticateSupabase, (req: Request, res: Response) => {
  if (!config.google.clientId) {
    res.status(503).json({ success: false, error: { code: 'GOOGLE_NOT_CONFIGURED', message: 'Google OAuth credentials are not set on the server' } });
    return;
  }
  const state = signOAuthState(req.authUser!.id, 'google');
  const url = googleOAuth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...config.google.scopes],
    state,
  });
  res.json({ success: true, data: { url } });
});

/** Google redirects here with code + state. We link Google to the user. */
router.get('/google/callback', authRateLimiter, async (req: Request, res: Response) => {
  const dashboard = config.adminDashboard.url;
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code || !state) {
      res.redirect(`${dashboard}/dashboard?connect_error=missing_code_or_state`);
      return;
    }

    const userId = verifyOAuthState(state, 'google');
    if (!userId) {
      res.redirect(`${dashboard}/dashboard?connect_error=invalid_state`);
      return;
    }

    const { tokens } = await googleOAuth.getToken(code);

    const db = getDatabase();
    await db.user.update({
      where: { id: userId },
      data: {
        googleAccessToken: encrypt(tokens.access_token!),
        googleRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
        googleTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        googleConnected: true,
      },
    });

    await logAuditEvent({
      userId,
      action: AuditAction.LOGIN_SUCCESS,
      resourceType: AuditResourceType.USER,
      resourceId: userId,
      newValue: { provider: 'google', linked: true },
      ipAddress: req.ip || '0.0.0.0',
      userAgent: req.headers['user-agent'] || '',
      source: AuditSource.USER,
    });

    authLogger.info({ userId }, 'Google calendar linked');

    // Pull existing events + subscribe to webhook in the background so the
    // OAuth callback responds immediately. Errors are swallowed inside
    // bootstrapGoogleConnection — they log but never throw.
    bootstrapGoogleConnection(userId).catch(err =>
      authLogger.error({ userId, err }, 'Background bootstrap (google) failed'),
    );

    res.redirect(`${dashboard}/dashboard?connected=google`);
  } catch (error) {
    authLogger.error({ error }, 'Google OAuth callback failed');
    res.redirect(`${dashboard}/dashboard?connect_error=google_oauth_failed`);
  }
});

// ---- Microsoft ----
// Direct OAuth (no MSAL) — see connectors/microsoft/oauth.ts for why.

router.get('/microsoft/url', authenticateSupabase, (req: Request, res: Response) => {
  if (!config.microsoft.clientId || !config.microsoft.clientSecret) {
    res.status(503).json({
      success: false,
      error: { code: 'MS_NOT_CONFIGURED', message: 'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.' },
    });
    return;
  }
  const state = signOAuthState(req.authUser!.id, 'microsoft');
  const url = buildMicrosoftAuthUrl(state);
  res.json({ success: true, data: { url } });
});

router.get('/microsoft/callback', authRateLimiter, async (req: Request, res: Response) => {
  const dashboard = config.adminDashboard.url;
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code || !state) {
      res.redirect(`${dashboard}/dashboard?connect_error=missing_code_or_state`);
      return;
    }

    const userId = verifyOAuthState(state, 'microsoft');
    if (!userId) {
      res.redirect(`${dashboard}/dashboard?connect_error=invalid_state`);
      return;
    }

    // Exchange code → tokens via direct POST to Microsoft Identity. This
    // returns refresh_token explicitly (unlike MSAL which keeps it private),
    // so getMicrosoftGraphClient can use it later to silently refresh.
    const tokens = await exchangeCodeForTokens(code);

    const db = getDatabase();
    await db.user.update({
      where: { id: userId },
      data: {
        microsoftAccessToken: encrypt(tokens.accessToken),
        microsoftRefreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : undefined,
        microsoftTokenExpiresAt: tokens.expiresAt,
        microsoftConnected: true,
      },
    });

    await logAuditEvent({
      userId,
      action: AuditAction.LOGIN_SUCCESS,
      resourceType: AuditResourceType.USER,
      resourceId: userId,
      newValue: { provider: 'microsoft', linked: true },
      ipAddress: req.ip || '0.0.0.0',
      userAgent: req.headers['user-agent'] || '',
      source: AuditSource.USER,
    });

    authLogger.info({ userId }, 'Microsoft calendar linked');

    bootstrapMicrosoftConnection(userId).catch(err =>
      authLogger.error({ userId, err }, 'Background bootstrap (microsoft) failed'),
    );

    res.redirect(`${dashboard}/dashboard?connected=microsoft`);
  } catch (error) {
    authLogger.error({ error }, 'Microsoft OAuth callback failed');
    res.redirect(`${dashboard}/dashboard?connect_error=microsoft_oauth_failed`);
  }
});

export default router;
