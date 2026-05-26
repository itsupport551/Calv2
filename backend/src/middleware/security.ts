// ============================================================
// Enterprise Calendar Sync — Security Middleware
// ============================================================
// Comprehensive security hardening — prevents:
// - XSS, CSRF, clickjacking, MIME sniffing
// - SQL injection (handled by Prisma)
// - Rate limiting / brute force
// - Search engine indexing (private app)
// - Social engineering via headers
// ============================================================

import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import config from '../config';
import { securityLogger } from '../utils/logger';
import { generateSecureToken } from '../crypto/encryption';

/**
 * Helmet — sets secure HTTP headers.
 * Prevents XSS, clickjacking, MIME sniffing, and more.
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],     // Needed for inline styles
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      mediaSrc: ["'none'"],
      frameSrc: ["'none'"],                         // Prevent framing (clickjacking)
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' },                   // Prevent iframing
  hidePoweredBy: true,                               // Don't reveal Express
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ieNoOpen: true,
  noSniff: true,                                     // Prevent MIME sniffing
  originAgentCluster: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
});

/**
 * CORS — only allow requests from configured origins.
 */
export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, webhooks)
    if (!origin) return callback(null, true);
    if (config.security.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    securityLogger.warn({ origin }, 'Blocked CORS request from unauthorized origin');
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID'],
  maxAge: 86400, // 24 hour preflight cache
});

/**
 * Rate limiter — prevents brute force and DDoS.
 */
export const rateLimiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
  },
  handler: (req, res, next, options) => {
    securityLogger.warn({
      ip: req.ip,
      path: req.path,
      method: req.method,
    }, 'Rate limit exceeded');
    res.status(429).json(options.message);
  },
  skip: (req) => {
    // Don't rate-limit health checks (Railway probe + browser polls) or
    // OPTIONS preflight (CORS preflight is free).
    if (req.method === 'OPTIONS') return true;
    if (req.path === '/health' || req.path.startsWith('/health/')) return true;
    return false;
  },
});

/** Stricter rate limit for auth endpoints */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per 15 min
  message: {
    success: false,
    error: { code: 'AUTH_RATE_LIMITED', message: 'Too many login attempts. Account temporarily locked.' },
  },
});

/**
 * Anti-indexing headers — prevents search engines from indexing this private app.
 * Also blocks social engineering via Open Graph / meta tags.
 */
export function antiIndexingMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Tell search engines to NEVER index this application
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, nosnippet, noarchive, noimageindex');
  
  // Prevent caching of sensitive responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  
  next();
}

/**
 * Request ID middleware — adds unique ID to every request for tracing.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers['x-request-id'] as string || generateSecureToken(16);
  (req as any).requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}

/**
 * Request logging middleware — logs every request (without sensitive data).
 */
export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      requestId: (req as any).requestId,
    };

    if (res.statusCode >= 500) {
      securityLogger.error(logData, 'Request failed');
    } else if (res.statusCode >= 400) {
      securityLogger.warn(logData, 'Client error');
    } else {
      securityLogger.info(logData, 'Request completed');
    }
  });

  next();
}

/**
 * JSON body sanitizer — strips potential XSS from string values.
 */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
}

function sanitizeObject(obj: any): any {
  if (typeof obj === 'string') {
    // Strip HTML tags and dangerous characters
    return obj
      .replace(/<[^>]*>/g, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
      .trim();
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (obj && typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObject(value);
    }
    return sanitized;
  }
  return obj;
}
