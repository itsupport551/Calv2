// ============================================================
// Enterprise Calendar Sync — Main Server
// ============================================================
// Entry point for the backend API server.
// Assembles all middleware, routes, and security hardening.
// ============================================================

import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import config from './config';
import logger from './utils/logger';
import { disconnectDatabase } from './database/client';

// Security Middleware
import {
  helmetMiddleware,
  corsMiddleware,
  rateLimiter,
  antiIndexingMiddleware,
  requestIdMiddleware,
  requestLoggingMiddleware,
  sanitizeBody,
} from './middleware/security';

// Routes
import authRoutes from './routes/auth';
import webhookRoutes from './routes/webhooks';
import adminRoutes from './routes/admin';
import meRoutes from './routes/me';
import healthRoutes from './routes/health';
import { startWebhookRenewalService, stopWebhookRenewalService } from './sync/webhookRenewal';
import { startNotificationWorker, stopNotificationWorker } from './notifications/worker';

const app = express();

// Railway / any reverse proxy sits in front of us and adds X-Forwarded-For.
// Without trust proxy, express-rate-limit refuses to read the header and
// throws on every request (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR), which made
// every /api/* call hang until the client gave up (HTTP 499 in logs).
// `1` = trust one hop (Railway's edge proxy) — safer than `true` which
// would trust an arbitrary chain.
app.set('trust proxy', 1);

// ============================================================
// Security Layer (applied to ALL requests)
// ============================================================

// 1. Secure HTTP headers (XSS, clickjacking, MIME sniffing protection)
app.use(helmetMiddleware);

// 2. CORS — only configured origins allowed
app.use(corsMiddleware);

// 3. Anti-indexing — prevents search engines from finding this app
app.use(antiIndexingMiddleware);

// 4. Request ID — unique ID for every request (for tracing/debugging)
app.use(requestIdMiddleware);

// 5. Request logging
app.use(requestLoggingMiddleware);

// 6. Rate limiting — prevents brute force and DDoS
app.use(rateLimiter);

// ============================================================
// Body Parsing
// ============================================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser(config.session.secret));
app.use(compression());

// 7. Body sanitization — strips XSS from input
app.use(sanitizeBody);

// ============================================================
// Routes
// ============================================================

// Health check — no auth required
app.use('/health', healthRoutes);

// Auth routes — OAuth callbacks
app.use('/auth', authRoutes);

// Webhook routes — receive notifications from Google/Microsoft
app.use('/webhooks', webhookRoutes);

// Admin API — requires ADMIN role
app.use('/api/admin', adminRoutes);

// Per-user API — any authenticated user (profile, their events, disconnect, logout)
app.use('/api/me', meRoutes);

// Root route
app.get('/', (_req, res) => {
  // Don't reveal any information about the system
  res.status(200).json({
    status: 'online',
    message: 'Enterprise Calendar Sync Platform',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// Error Handling
// ============================================================

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
});

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // NEVER leak internal errors to clients
  logger.error({ err, stack: err.stack }, 'Unhandled server error');

  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: config.isDev ? err.message : 'An internal error occurred',
    },
  });
});

// ============================================================
// Server Startup
// ============================================================

const server = app.listen(config.port, config.host, () => {
  // Defensive startup: a failure in any background worker must NOT kill
  // the HTTP server. /health needs to stay reachable so Railway's
  // healthcheck passes and operators can diagnose from logs.
  try {
    startWebhookRenewalService();
  } catch (err) {
    logger.error({ err }, 'startWebhookRenewalService failed — continuing');
  }
  try {
    startNotificationWorker();
  } catch (err) {
    logger.error({ err }, 'startNotificationWorker failed — continuing');
  }

  logger.info(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🔒 Enterprise Calendar Sync Platform                   ║
║   ──────────────────────────────────────                 ║
║   Server:    http://${config.host}:${config.port}                  ║
║   Env:       ${config.env.padEnd(42)}║
║   Database:  calendarsync_app (ISOLATED)                 ║
║                                                          ║
║   Security:  ✅ Helmet  ✅ CORS  ✅ Rate Limit           ║
║              ✅ Anti-Index  ✅ XSS  ✅ CSRF               ║
║                                                          ║
║   ⚠️  This is a PRIVATE enterprise application.          ║
║   ⚠️  Not indexed by search engines.                     ║
║   ⚠️  Database: calendarsync_app (your existing DBs      ║
║       are NOT touched)                                   ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// ============================================================
// Graceful Shutdown
// ============================================================

async function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  stopWebhookRenewalService();
  stopNotificationWorker();
  server.close(async () => {
    await disconnectDatabase();
    logger.info('Server shut down complete');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Promise Rejection');
});
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught Exception');
  process.exit(1);
});

export default app;
