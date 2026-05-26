# CalendarSync Enterprise

Two-way, real-time calendar synchronization between **Google Calendar** and **Microsoft Outlook 365**.

- Events sync instantly in both directions
- Conflicts are detected and auto-rejected with an email
- Runs 24/7 on the cloud — no laptop needed
- Full admin dashboard to monitor everything

---

## Project Structure

```
CalendarSYNCAPP/
│
├── backend/                          ← Node.js / Express API (port 4400)
│   ├── src/
│   │   ├── audit/
│   │   │   └── logger.ts             ← Immutable audit trail (append-only)
│   │   │
│   │   ├── config/
│   │   │   └── index.ts              ← All env vars in one place
│   │   │
│   │   ├── conflict/
│   │   │   ├── detector.ts           ← Checks both calendars for overlaps,
│   │   │   │                            OOF blocks, and Focus Time
│   │   │   └── autoReject.ts         ← Auto-declines conflicting invites
│   │   │                                and queues rejection email
│   │   │
│   │   ├── connectors/
│   │   │   ├── google/calendar.ts    ← Google Calendar API v3 wrapper
│   │   │   └── microsoft/calendar.ts ← Microsoft Graph API wrapper
│   │   │
│   │   ├── crypto/
│   │   │   └── encryption.ts         ← AES-256-GCM encryption for tokens
│   │   │
│   │   ├── database/
│   │   │   ├── client.ts             ← Prisma singleton
│   │   │   └── prisma/
│   │   │       ├── schema.prisma     ← Database models
│   │   │       └── migrations/       ← SQL migration history
│   │   │
│   │   ├── middleware/
│   │   │   ├── auth.ts               ← JWT + role-based access control
│   │   │   └── security.ts           ← Helmet, CORS, rate limiting, XSS
│   │   │
│   │   ├── notifications/
│   │   │   ├── dispatcher.ts         ← Queues notifications in database
│   │   │   ├── emailSender.ts        ← SMTP sender (Gmail / SendGrid)
│   │   │   └── worker.ts             ← Polls DB every 30s, sends emails
│   │   │
│   │   ├── routes/
│   │   │   ├── auth.ts               ← OAuth login/callback endpoints
│   │   │   ├── webhooks.ts           ← Receives Google & Microsoft webhooks
│   │   │   ├── admin.ts              ← Admin dashboard API
│   │   │   └── health.ts             ← GET /health (Railway health check)
│   │   │
│   │   ├── sync/
│   │   │   ├── orchestrator.ts       ← Core sync engine (the brain)
│   │   │   ├── fingerprint.ts        ← Loop prevention via SHA-256
│   │   │   ├── recurringEvents.ts    ← RRULE ↔ Microsoft recurrence converter
│   │   │   └── webhookRenewal.ts     ← Auto-renews expiring webhooks every 6h
│   │   │
│   │   ├── tests/
│   │   │   ├── encryption.test.ts    ← 10 tests
│   │   │   ├── fingerprint.test.ts   ← 9 tests
│   │   │   └── recurringEvents.test.ts ← 11 tests
│   │   │
│   │   ├── types/                    ← TypeScript interfaces and enums
│   │   ├── utils/                    ← Logger, retry, date helpers
│   │   └── server.ts                 ← Express entry point
│   │
│   ├── .env                          ← YOUR secrets (never commit this)
│   ├── .env.example                  ← Template with instructions (covers local + Supabase)
│   ├── railway.toml                  ← Railway deployment config
│   ├── Dockerfile                    ← Docker build
│   ├── docker-compose.yml            ← Local Docker stack
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts              ← Test configuration
│
├── frontend/                         ← Next.js admin dashboard (port 3000)
│   ├── src/
│   │   └── app/
│   │       ├── page.tsx              ← Login page
│   │       ├── dashboard/page.tsx    ← Admin dashboard (7 panels)
│   │       ├── layout.tsx
│   │       └── globals.css
│   ├── next.config.js                ← Proxies /api/* to backend
│   ├── vercel.json                   ← Vercel deployment config
│   └── package.json
│
├── .gitignore
└── README.md                         ← This file
```

---

## How It Works

```
User's Google Calendar
        │
        │  (event created/updated/deleted)
        ▼
Google sends webhook ──► POST /webhooks/google
                                │
                        Verify token (spoofing check)
                                │
                        Queue sync job
                                │
                     ┌── orchestrator.ts ──┐
                     │                     │
              Check fingerprint      Check conflicts
              (loop prevention)      (OOF, Focus Time,
                     │                time overlap)
                     │                     │
                     │              Conflict found?
                     │              YES → auto-reject
                     │                  + send email
                     │              NO  ↓
                     │        Create mirror event
                     │        on Microsoft Outlook
                     │              │
                     └──────────────┘
                              │
                     Save to database
                     Write audit log
                     Update sync token

Microsoft Outlook ◄── mirror event appears
```

---

## Features

| Feature | Status |
|---------|--------|
| Two-way Google ↔ Outlook sync | ✅ |
| Loop prevention (SHA-256 fingerprint) | ✅ |
| Conflict detection (time overlap) | ✅ |
| Out-of-Office conflict detection | ✅ |
| Focus Time conflict detection | ✅ |
| Auto-reject conflicting invites | ✅ |
| Rejection email sent to organizer | ✅ |
| Recurring event sync (RRULE ↔ MS) | ✅ |
| Webhook auto-renewal (never expires) | ✅ |
| AES-256-GCM encryption at rest | ✅ |
| Immutable audit logs | ✅ |
| Role-based access (ADMIN/USER/VIEWER) | ✅ |
| Admin dashboard with 7 panels | ✅ |
| 30 automated tests | ✅ |
| Railway + Vercel deployment | ✅ |

---

## Prerequisites

Install these before starting:

- [Node.js 20+](https://nodejs.org) — `node --version` should show v20+
- [PostgreSQL 14+](https://www.postgresql.org/download/) — running locally
- [Git](https://git-scm.com)

---

## Local Setup (Step by Step)

### Step 1 — Clone the repo

```bash
git clone https://github.com/itsupport551/Calv2.git
cd Calv2
```

### Step 2 — Get Google OAuth credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown (top-left) → **New Project**
   - Name: `CalendarSync` → click **Create**
3. Select your new project from the dropdown
4. Hamburger menu (☰) → **APIs & Services** → **Library**
   - Search `Google Calendar API` → click it → **Enable**
5. Left sidebar → **OAuth consent screen**
   - Select **External** → **Create**
   - App name: `CalendarSync`
   - User support email: your Gmail address
   - Developer contact email: your Gmail address
   - Click **Save and Continue** three times → **Back to Dashboard**
6. Left sidebar → **Credentials** → **+ Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Name: `CalendarSync Backend`
   - Under **Authorized redirect URIs** → **+ Add URI**:
     - Type: `http://localhost:4400/auth/google/callback`
   - Click **Create**
7. A popup appears — copy these two values:
   - **Client ID** → you will paste this as `GOOGLE_CLIENT_ID`
   - **Client Secret** → you will paste this as `GOOGLE_CLIENT_SECRET`

### Step 3 — Get Microsoft Azure credentials

1. Go to [portal.azure.com](https://portal.azure.com) — sign in with any Microsoft account
2. In the top search bar type `App registrations` → click it
3. Click **+ New registration**
   - Name: `CalendarSync`
   - Supported account types: select **"Accounts in any organizational directory and personal Microsoft accounts"**
   - Redirect URI: Platform = **Web** | URI = `http://localhost:4400/auth/microsoft/callback`
   - Click **Register**
4. On the overview page, copy:
   - **Application (client) ID** → this is your `MICROSOFT_CLIENT_ID`
5. Left sidebar → **API permissions** → **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**
   - Search and tick each of these four:
     - `Calendars.ReadWrite`
     - `User.Read`
     - `Mail.Send`
     - `offline_access`
   - Click **Add permissions**
   - Click **Grant admin consent for [your name]** → **Yes**
6. Left sidebar → **Certificates & secrets** → **+ New client secret**
   - Description: `CalendarSync`
   - Expires: **24 months**
   - Click **Add**
   - **Copy the VALUE column immediately** (it disappears when you leave)
   - This is your `MICROSOFT_CLIENT_SECRET`

### Step 4 — Get Gmail App Password (for sending emails)

1. Go to [myaccount.google.com/security](https://myaccount.google.com/security)
2. Make sure **2-Step Verification** is turned ON
3. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
4. In the "App name" box type `CalendarSync` → click **Create**
5. Copy the 16-character password shown (no spaces)
   - This is your `SMTP_PASS`

### Step 5 — Configure environment variables

```bash
cd backend
cp .env.example .env
```

Open `backend/.env` in any text editor and fill in these values (everything else is already set):

```env
# From Step 2 (Google)
GOOGLE_CLIENT_ID=paste_your_google_client_id_here
GOOGLE_CLIENT_SECRET=paste_your_google_client_secret_here

# From Step 3 (Microsoft)
MICROSOFT_CLIENT_ID=paste_your_azure_app_id_here
MICROSOFT_CLIENT_SECRET=paste_your_azure_secret_value_here

# Your PostgreSQL password (whatever you set when installing Postgres)
DATABASE_URL=postgresql://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/calendarsync_app

# From Step 4 (Gmail)
SMTP_USER=your.email@gmail.com
SMTP_PASS=your16charapppassword
SMTP_FROM=your.email@gmail.com
```

> The encryption key, JWT secret, and session secret are **already generated** in the `.env` file — do not change them.

### Step 6 — Install dependencies and create the database

```bash
# Backend
cd backend
npm install
npx prisma migrate dev --name init
```

This creates a new database called `calendarsync_app`. It does **not** touch any existing databases.

```bash
# Frontend (open a new terminal)
cd frontend
npm install
```

### Step 7 — Run the app

**Terminal 1 — Backend:**
```bash
cd backend
npm run dev
```
You should see:
```
Server listening on http://localhost:4400
Webhook renewal service running — checks every 6 hours
Notification worker starting — polling every 30s
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
```
You should see:
```
ready on http://localhost:3000
```

### Step 8 — Connect your calendars

1. Open [http://localhost:3000](http://localhost:3000)
2. Click **Continue with Google** — sign in and allow calendar access
3. Click **Continue with Microsoft** — sign in and allow calendar access
4. Both must be connected for sync to work

### Step 9 — Verify everything works

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

You should see the admin dashboard with:
- **Overview** — user count, events synced, failed syncs, conflicts today
- **Sync Monitor** — live transaction history
- **Users** — connected accounts
- **Conflicts** — auto-rejections with reasons
- **Audit Logs** — immutable security trail
- **Webhooks** — active subscriptions and expiry dates
- **Security** — live threat indicators

Create a test event in Google Calendar — within seconds it should appear in Outlook.

### Step 10 — Run tests

```bash
cd backend
npm test
```

Expected output:
```
✓ src/tests/recurringEvents.test.ts  (11 tests)
✓ src/tests/fingerprint.test.ts      (9 tests)
✓ src/tests/encryption.test.ts       (10 tests)

Test Files  3 passed (3)
Tests      30 passed (30)
```

---

## Cloud Deployment (24/7, no laptop required)

### Deploy Backend → Railway

1. **Set up Supabase first** (the database) — see [SETUP.md §7b](./SETUP.md) for the 5-minute walkthrough. You'll come away with two URLs: `DATABASE_URL` (pooled, port 6543) and `DIRECT_URL` (direct, port 5432).
2. Create account at [railway.app](https://railway.app) — sign up with GitHub
3. Click **New Project** → **Deploy from GitHub repo** → select **`Calv2`**
4. Set **Root Directory** to `backend`
5. In your project → **New** → **Database** → **Add Redis** (Railway sets the Redis vars automatically — reference them in the backend service)
6. Go to your backend service → **Variables** tab → add:
   - `DATABASE_URL` and `DIRECT_URL` from Supabase
   - `ENCRYPTION_KEY`, `JWT_SECRET`, `SESSION_SECRET` from your local `backend/.env`
   - `NODE_ENV=production`
   - All Google/Microsoft/SMTP credentials (see SETUP.md §7 for the full list)
7. Railway gives you a permanent URL like `https://calv2-production.up.railway.app`
8. Go back to **Google Cloud Console** → Credentials → your OAuth client → add redirect URI:
   - `https://calv2-production.up.railway.app/auth/google/callback`
9. Go back to **Azure Portal** → App registrations → Authentication → add redirect URI:
   - `https://calv2-production.up.railway.app/auth/microsoft/callback`

### Deploy Frontend → Vercel

1. Create account at [vercel.com](https://vercel.com)
2. Click **New Project** → import `Calv2` from GitHub
3. Set **Root Directory** to `frontend`
4. Add environment variable:
   - Key: `NEXT_PUBLIC_API_URL`
   - Value: your Railway URL (e.g. `https://calendarsync-production.railway.app`)
5. Click **Deploy**
6. Vercel gives you a permanent URL like `https://calendarsync.vercel.app`
7. In Railway → your backend service → Variables → update:
   - `ALLOWED_ORIGINS=https://calendarsync.vercel.app,https://calendarsync-production.railway.app`
   - `ADMIN_DASHBOARD_URL=https://calendarsync.vercel.app`

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | YES | Google Cloud Console OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | YES | Google Cloud Console OAuth client secret |
| `MICROSOFT_CLIENT_ID` | YES | Azure App Registration client ID |
| `MICROSOFT_CLIENT_SECRET` | YES | Azure App Registration client secret |
| `MICROSOFT_TENANT_ID` | NO | Default: `common` (allows any MS account) |
| `DATABASE_URL` | YES | PostgreSQL connection string |
| `REDIS_URL` | NO | Redis connection URL (Railway provides this) |
| `ENCRYPTION_KEY` | YES | 64-char hex — pre-generated in `.env` |
| `JWT_SECRET` | YES | 128-char hex — pre-generated in `.env` |
| `SESSION_SECRET` | YES | 64-char hex — pre-generated in `.env` |
| `SMTP_HOST` | YES | SMTP server (`smtp.gmail.com` or `smtp.sendgrid.net`) |
| `SMTP_PORT` | YES | `587` for TLS |
| `SMTP_USER` | YES | Your Gmail or `apikey` for SendGrid |
| `SMTP_PASS` | YES | Gmail app password or SendGrid API key |
| `SMTP_FROM` | YES | Sender email address |
| `WEBHOOK_BASE_URL` | YES | Your public HTTPS URL (Railway URL in prod) |
| `ALLOWED_ORIGINS` | YES | Comma-separated list of allowed frontend URLs |

---

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/google` | Start Google OAuth login |
| GET | `/auth/google/callback` | Google OAuth callback |
| GET | `/auth/microsoft` | Start Microsoft OAuth login |
| GET | `/auth/microsoft/callback` | Microsoft OAuth callback |

### Webhooks (called by Google/Microsoft, not by you)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/google` | Receives Google Calendar change notifications |
| POST | `/webhooks/microsoft` | Receives Microsoft Graph change notifications |

### Admin API (requires ADMIN role JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/dashboard/stats` | Overview stats |
| GET | `/api/admin/users` | All users with calendar connections |
| GET | `/api/admin/sync/transactions` | Sync transaction history |
| GET | `/api/admin/sync/failed` | Failed/dead-letter syncs |
| POST | `/api/admin/sync/retry/:id` | Retry a failed sync |
| GET | `/api/admin/audit-logs` | Immutable audit trail |
| GET | `/api/admin/conflicts` | Conflict history |
| GET | `/api/admin/webhooks` | Active webhook subscriptions |
| GET | `/api/admin/security` | Security posture dashboard |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (used by Railway) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend runtime | Node.js 20 |
| Backend framework | Express 4 + TypeScript |
| Frontend | Next.js 14 + React 18 |
| Database | PostgreSQL 14 via Prisma ORM |
| Queue | BullMQ + Redis |
| Google auth | passport-google-oauth20 + googleapis |
| Microsoft auth | @azure/msal-node + @microsoft/microsoft-graph-client |
| Encryption | AES-256-GCM (Node.js crypto) |
| Email | nodemailer (SMTP) |
| Testing | Vitest |
| Backend hosting | Railway |
| Frontend hosting | Vercel |

---

## Security

- All OAuth tokens encrypted with **AES-256-GCM** before database storage
- **JWT** authentication with HttpOnly cookies
- **Helmet** security headers on every response
- **CSRF** protection
- **Rate limiting** — 100 requests per 15 minutes
- **Webhook token validation** — rejects unsigned or mismatched webhooks
- **Sync loop prevention** — SHA-256 fingerprinting prevents infinite sync loops
- **Immutable audit logs** — BigInt auto-increment IDs, no `updatedAt`, no delete
- **Role-based access** — ADMIN / USER / VIEWER

---

## Troubleshooting

**"Google account not connected" error**
- Make sure you clicked "Continue with Google" on the login page and completed the OAuth flow

**Events not syncing**
- Check the Webhooks panel in the dashboard — subscriptions must show ACTIVE
- For local dev, webhooks from Google/Microsoft cannot reach `localhost`
- Use [ngrok](https://ngrok.com): `ngrok http 4400` then set `WEBHOOK_BASE_URL` to the ngrok URL

**Emails not sending**
- Check `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST` in `.env`
- For Gmail: make sure you used an **App Password**, not your regular password
- Check the Notifications panel or query: `SELECT * FROM notifications WHERE status = 'failed'`

**Database connection error**
- Make sure PostgreSQL is running: `pg_isready`
- Check `DATABASE_URL` has the correct password

**Tests failing**
- Run `npm test` from the `backend/` directory, not the root
