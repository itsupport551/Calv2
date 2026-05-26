// ============================================================
// Enterprise Calendar Sync — Configuration
// ============================================================
// Centralized config loaded from environment variables.
// NEVER import .env values directly elsewhere — always use this.
// ============================================================

import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error(`[FATAL] Missing required environment variable: ${key}`);
  }
  return value || '';
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  // ---- Server ----
  env: optionalEnv('NODE_ENV', 'development'),
  isDev: optionalEnv('NODE_ENV', 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: parseInt(optionalEnv('PORT', '4400'), 10),
  // Must bind 0.0.0.0 in containers (Railway/Docker) so the platform
  // healthcheck and router can reach the server. localhost is unreachable there.
  host: optionalEnv('HOST', '0.0.0.0'),

  // ---- Database ----
  database: {
    url: requireEnv('DATABASE_URL'),
  },

  // ---- Encryption ----
  encryption: {
    key: requireEnv('ENCRYPTION_KEY'),
    ivLength: parseInt(optionalEnv('ENCRYPTION_IV_LENGTH', '16'), 10),
    algorithm: 'aes-256-gcm' as const,
  },

  // ---- JWT ----
  jwt: {
    secret: requireEnv('JWT_SECRET'),
    expiresIn: optionalEnv('JWT_EXPIRES_IN', '24h'),
  },

  session: {
    secret: requireEnv('SESSION_SECRET'),
  },

  // ---- Google OAuth ----
  // Optional at boot — the server starts without them; Google login just
  // won't work until these are configured. Avoids crashing the deploy.
  google: {
    clientId: optionalEnv('GOOGLE_CLIENT_ID', ''),
    clientSecret: optionalEnv('GOOGLE_CLIENT_SECRET', ''),
    redirectUri: optionalEnv('GOOGLE_REDIRECT_URI', 'http://localhost:4400/auth/google/callback'),
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  // ---- Microsoft OAuth ----
  // Optional at boot — see Google note above.
  microsoft: {
    clientId: optionalEnv('MICROSOFT_CLIENT_ID', ''),
    clientSecret: optionalEnv('MICROSOFT_CLIENT_SECRET', ''),
    tenantId: optionalEnv('MICROSOFT_TENANT_ID', 'common'),
    redirectUri: optionalEnv('MICROSOFT_REDIRECT_URI', 'http://localhost:4400/auth/microsoft/callback'),
    scopes: [
      'Calendars.ReadWrite',
      'User.Read',
      'Mail.Send',
      'offline_access',
    ],
    authority: `https://login.microsoftonline.com/${optionalEnv('MICROSOFT_TENANT_ID', 'common')}`,
  },

  // ---- Webhooks ----
  webhook: {
    baseUrl: optionalEnv('WEBHOOK_BASE_URL', 'https://your-domain.com'),
    googleUrl: optionalEnv('GOOGLE_WEBHOOK_URL', ''),
    microsoftUrl: optionalEnv('MICROSOFT_WEBHOOK_URL', ''),
  },

  // ---- Security ----
  security: {
    allowedOrigins: optionalEnv('ALLOWED_ORIGINS', 'http://localhost:3000,http://localhost:4400').split(','),
    rateLimitWindowMs: parseInt(optionalEnv('RATE_LIMIT_WINDOW_MS', '900000'), 10),
    rateLimitMaxRequests: parseInt(optionalEnv('RATE_LIMIT_MAX_REQUESTS', '100'), 10),
  },

  // ---- Logging ----
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    format: optionalEnv('LOG_FORMAT', 'pretty'),
  },

  // ---- Email (SMTP) ----
  email: {
    host: optionalEnv('SMTP_HOST', ''),
    port: parseInt(optionalEnv('SMTP_PORT', '587'), 10),
    user: optionalEnv('SMTP_USER', ''),
    pass: optionalEnv('SMTP_PASS', ''),
    from: optionalEnv('SMTP_FROM', ''),
  },

  // ---- Admin Dashboard ----
  adminDashboard: {
    url: optionalEnv('ADMIN_DASHBOARD_URL', 'http://localhost:3000'),
  },

  // ---- Sync Settings ----
  sync: {
    maxRetries: 5,
    retryDelayMs: 1000,
    webhookRenewalIntervalMs: 6 * 24 * 60 * 60 * 1000, // 6 days (Google channels expire in 7)
    syncTimeoutMs: 30000,
    maxConcurrentSyncs: 10,
    fingerprintTtlSeconds: 86400, // 24 hours
    deduplicationWindowMs: 5000,  // 5 seconds
  },
} as const;

export type Config = typeof config;
export default config;
