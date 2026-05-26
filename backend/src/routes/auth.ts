// ============================================================
// Enterprise Calendar Sync — Auth Routes
// ============================================================

import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { ConfidentialClientApplication } from '@azure/msal-node';
import jwt from 'jsonwebtoken';
import config from '../config';
import getDatabase from '../database/client';
import { encrypt } from '../crypto/encryption';
import { generateJWT } from '../middleware/auth';
import { logAuditEvent } from '../audit/logger';
import { authLogger } from '../utils/logger';
import { AuditAction, AuditResourceType, AuditSource, JwtPayload } from '../types';
import { authRateLimiter } from '../middleware/security';

/**
 * If the request already carries a valid JWT cookie, return its user id.
 * Used by OAuth callbacks so that connecting a second provider links to
 * the existing logged-in account instead of creating a parallel user
 * (which used to happen when the user's Google and Microsoft emails differ).
 */
function getExistingUserIdFromCookie(req: Request): string | null {
  const token = req.cookies?.token;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    return decoded.sub || null;
  } catch {
    return null;
  }
}

const router = Router();

// ---- Google OAuth ----

const googleOAuth = new OAuth2Client(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

/** Redirect user to Google consent screen */
router.get('/google', authRateLimiter, (_req: Request, res: Response) => {
  const authUrl = googleOAuth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...config.google.scopes],
  });
  res.redirect(authUrl);
});

/** Handle Google OAuth callback */
router.get('/google/callback', async (req: Request, res: Response) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') {
      res.status(400).json({ success: false, error: { code: 'MISSING_CODE', message: 'Authorization code missing' } });
      return;
    }

    const { tokens } = await googleOAuth.getToken(code);
    googleOAuth.setCredentials(tokens);

    // Get user info
    const oauth2 = (await import('googleapis')).google.oauth2({ version: 'v2', auth: googleOAuth });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email!;
    const name = userInfo.data.name || email;

    const db = getDatabase();

    // If user is already logged in (has a valid JWT cookie), LINK the new
    // Google connection to that existing account instead of creating /
    // upserting a separate user by email. This lets a single user connect
    // both their Google AND Microsoft accounts even when the emails differ.
    const existingUserId = getExistingUserIdFromCookie(req);

    const googleData = {
      googleAccessToken: encrypt(tokens.access_token!),
      googleRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
      googleTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      googleConnected: true,
    };

    let user;
    if (existingUserId) {
      user = await db.user.update({
        where: { id: existingUserId },
        data: googleData,
      });
    } else {
      user = await db.user.upsert({
        where: { email },
        update: { ...googleData, displayName: name },
        create: {
          email,
          displayName: name,
          role: 'USER',
          ...googleData,
          googleRefreshToken: encrypt(tokens.refresh_token || ''),
          isActive: true,
        },
      });
    }

    // Generate JWT
    const jwt = generateJWT({ id: user.id, email: user.email, role: user.role });

    // Audit log
    await logAuditEvent({
      userId: user.id,
      action: AuditAction.LOGIN_SUCCESS,
      resourceType: AuditResourceType.USER,
      resourceId: user.id,
      newValue: { provider: 'google', email },
      ipAddress: req.ip || '0.0.0.0',
      userAgent: req.headers['user-agent'] || '',
      source: AuditSource.USER,
    });

    authLogger.info({ userId: user.id, email }, 'Google OAuth login successful');

    // Set secure cookie and redirect to dashboard
    // Cookie must be SameSite=None + Secure so the browser sends it on
    // cross-origin fetches from the Vercel frontend back to the Railway
    // backend. `lax` would silently block all our /api/* calls.
    // In local dev (NODE_ENV=development) Secure is dropped so the cookie
    // works over plain http://localhost.
    res.cookie('token', jwt, {
      httpOnly: true,
      secure: config.isProd,
      sameSite: config.isProd ? 'none' : 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.redirect(`${config.adminDashboard.url}/dashboard?login=success&provider=google`);
  } catch (error) {
    authLogger.error({ error }, 'Google OAuth callback failed');
    res.redirect(`${config.adminDashboard.url}/login?error=google_auth_failed`);
  }
});

// ---- Microsoft OAuth ----

// Lazy-init the MSAL client so an empty MICROSOFT_CLIENT_SECRET at boot
// (e.g. before the operator has filled in OAuth creds on Railway) doesn't
// crash the entire process at module-import time. The client is created
// on first request; until then the rest of the app boots fine.
let _msalApp: ConfidentialClientApplication | null = null;
function getMsalApp(): ConfidentialClientApplication {
  if (_msalApp) return _msalApp;
  if (!config.microsoft.clientId || !config.microsoft.clientSecret) {
    throw new Error(
      'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in your environment.'
    );
  }
  _msalApp = new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: config.microsoft.authority,
    },
  });
  return _msalApp;
}

/** Redirect user to Microsoft consent screen */
router.get('/microsoft', authRateLimiter, async (_req: Request, res: Response) => {
  try {
    const authUrl = await getMsalApp().getAuthCodeUrl({
      scopes: [...config.microsoft.scopes],
      redirectUri: config.microsoft.redirectUri,
    });
    res.redirect(authUrl);
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: 'MS_OAUTH_NOT_CONFIGURED', message: (err as Error).message },
    });
  }
});

/** Handle Microsoft OAuth callback */
router.get('/microsoft/callback', async (req: Request, res: Response) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') {
      res.status(400).json({ success: false, error: { code: 'MISSING_CODE', message: 'Authorization code missing' } });
      return;
    }

    const result = await getMsalApp().acquireTokenByCode({
      code,
      scopes: [...config.microsoft.scopes],
      redirectUri: config.microsoft.redirectUri,
    });

    // Get user info from token claims
    const email = result.account?.username || '';
    const name = result.account?.name || email;

    const db = getDatabase();

    // Link to existing logged-in user if there's a valid JWT cookie —
    // so a user can connect both Google + Microsoft to one account.
    const existingUserId = getExistingUserIdFromCookie(req);

    const msData = {
      microsoftAccessToken: encrypt(result.accessToken),
      microsoftTokenExpiresAt: result.expiresOn || null,
      microsoftConnected: true,
    };

    let user;
    if (existingUserId) {
      user = await db.user.update({
        where: { id: existingUserId },
        data: msData,
      });
    } else {
      user = await db.user.upsert({
        where: { email },
        update: { ...msData, displayName: name },
        create: {
          email,
          displayName: name,
          role: 'USER',
          ...msData,
          isActive: true,
        },
      });
    }

    const jwt = generateJWT({ id: user.id, email: user.email, role: user.role });

    await logAuditEvent({
      userId: user.id,
      action: AuditAction.LOGIN_SUCCESS,
      resourceType: AuditResourceType.USER,
      resourceId: user.id,
      newValue: { provider: 'microsoft', email },
      ipAddress: req.ip || '0.0.0.0',
      userAgent: req.headers['user-agent'] || '',
      source: AuditSource.USER,
    });

    authLogger.info({ userId: user.id, email }, 'Microsoft OAuth login successful');

    // Cookie must be SameSite=None + Secure so the browser sends it on
    // cross-origin fetches from the Vercel frontend back to the Railway
    // backend. `lax` would silently block all our /api/* calls.
    // In local dev (NODE_ENV=development) Secure is dropped so the cookie
    // works over plain http://localhost.
    res.cookie('token', jwt, {
      httpOnly: true,
      secure: config.isProd,
      sameSite: config.isProd ? 'none' : 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.redirect(`${config.adminDashboard.url}/dashboard?login=success&provider=microsoft`);
  } catch (error) {
    authLogger.error({ error }, 'Microsoft OAuth callback failed');
    res.redirect(`${config.adminDashboard.url}/login?error=microsoft_auth_failed`);
  }
});

// ---- Session Management ----

router.get('/session', async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.token;
    if (!token) {
      res.json({ success: true, data: { authenticated: false } });
      return;
    }

    const jwt = await import('jsonwebtoken');
    const decoded = jwt.default.verify(token, config.jwt.secret) as any;
    const db = getDatabase();
    const user = await db.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true, email: true, displayName: true, role: true,
        googleConnected: true, microsoftConnected: true,
        lastSyncAt: true, isActive: true,
      },
    });

    if (!user || !user.isActive) {
      res.json({ success: true, data: { authenticated: false } });
      return;
    }

    res.json({ success: true, data: { authenticated: true, user } });
  } catch {
    res.json({ success: true, data: { authenticated: false } });
  }
});

router.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('token');
  res.json({ success: true, data: { message: 'Logged out successfully' } });
});

export default router;
