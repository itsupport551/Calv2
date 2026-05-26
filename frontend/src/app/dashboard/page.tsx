'use client';

import { useEffect, useState } from 'react';
import { supabase, apiFetch, API_BASE } from '../../lib/supabase';

interface DashboardStats {
  users: { total: number; active: number };
  events: { total: number; synced: number };
  sync: { failed: number; recentTransactions: any[] };
  conflicts: { today: number };
}

interface MeUser {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'USER' | 'VIEWER';
  googleConnected: boolean;
  microsoftConnected: boolean;
  lastSyncAt: string | null;
}

interface MyEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  isAllDay: boolean;
  location: string;
  organizerEmail: string;
  sourcePlatform: 'GOOGLE' | 'MICROSOFT';
  mirrorPlatform: 'GOOGLE' | 'MICROSOFT' | null;
  syncState: string;
  meetingLink: string;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activeTab, setActiveTab] = useState('mycalendar');
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Gate the entire dashboard on a Supabase session. If there isn't one,
  // bounce back to /. Also fetch /api/me once on mount so we know the
  // user's role (used to hide admin-only tabs).
  useEffect(() => {
    let unsub: (() => void) | undefined;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) {
        window.location.href = '/';
        return;
      }
      setAuthChecked(true);
      try {
        const j = await apiFetch<{ success: boolean; data: { user: MeUser } }>('/api/me');
        if (j.success) setMe(j.data.user);
      } catch {}
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) window.location.href = '/';
    });
    unsub = () => sub.subscription.unsubscribe();
    return unsub;
  }, []);

  // Admin stats only fetched if user is admin — stops the 403 spam.
  useEffect(() => {
    if (!me) return;
    if (me.role !== 'ADMIN') { setLoading(false); return; }
    fetchStats();
    // Poll every 60s — half the rate of the old 30s interval, plenty
    // fresh for an admin view, gentler on the rate limiter.
    const interval = setInterval(fetchStats, 60000);
    return () => clearInterval(interval);
  }, [me]);

  async function fetchStats() {
    try {
      const j = await apiFetch<{ success: boolean; data: DashboardStats }>('/api/admin/dashboard/stats');
      if (j.success) setStats(j.data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = '/';
  }

  const isAdmin = me?.role === 'ADMIN';
  const allNav = [
    { id: 'mycalendar', icon: '📅', label: 'My Calendar', adminOnly: false },
    { id: 'overview', icon: '📊', label: 'Overview', adminOnly: true },
    { id: 'sync', icon: '🔄', label: 'Sync Monitor', adminOnly: true },
    { id: 'users', icon: '👥', label: 'Users', adminOnly: true },
    { id: 'conflicts', icon: '⚠️', label: 'Conflicts', adminOnly: true },
    { id: 'audit', icon: '📋', label: 'Audit Logs', adminOnly: true },
    { id: 'webhooks', icon: '🔗', label: 'Webhooks', adminOnly: true },
    { id: 'security', icon: '🛡️', label: 'Security', adminOnly: true },
  ];
  const navItems = allNav.filter(n => !n.adminOnly || isAdmin);

  if (!authChecked) {
    return <div style={{ padding: 40, color: '#888' }}>Loading…</div>;
  }

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🔄</div>
          <div>
            <div className="sidebar-logo-text">CalendarSync</div>
            <div className="sidebar-logo-sub">Enterprise Admin</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => setActiveTab(item.id)}
            >
              <span className="nav-item-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
          {me && (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              {me.email}
              <div style={{ fontSize: 10, opacity: 0.7 }}>{me.role}</div>
            </div>
          )}
          <button className="nav-item" onClick={handleLogout}>
            <span className="nav-item-icon">🚪</span>
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {activeTab === 'mycalendar' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">My Calendar</h1>
              <p className="page-subtitle">Connect your accounts and see all your events in one place</p>
            </div>
            <MyCalendarPanel />
          </div>
        )}

        {activeTab === 'overview' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">Dashboard Overview</h1>
              <p className="page-subtitle">Real-time synchronization monitoring</p>
            </div>

            {/* Stats Grid */}
            <div className="stats-grid animate-stagger">
              <div className="stat-card">
                <span className="stat-icon">👥</span>
                <div className="stat-label">Active Users</div>
                <div className="stat-value" style={{ color: 'var(--accent-primary)' }}>
                  {loading ? <div className="skeleton" style={{ width: '80px', height: '36px' }} /> : stats?.users.active || 0}
                </div>
                <div className="stat-change positive">
                  ↑ {stats?.users.total || 0} total
                </div>
              </div>

              <div className="stat-card">
                <span className="stat-icon">📅</span>
                <div className="stat-label">Events Synced</div>
                <div className="stat-value" style={{ color: 'var(--success)' }}>
                  {loading ? <div className="skeleton" style={{ width: '80px', height: '36px' }} /> : stats?.events.synced || 0}
                </div>
                <div className="stat-change positive">
                  {stats?.events.total || 0} total events
                </div>
              </div>

              <div className="stat-card">
                <span className="stat-icon">❌</span>
                <div className="stat-label">Failed Syncs</div>
                <div className="stat-value" style={{ color: stats?.sync.failed ? 'var(--error)' : 'var(--success)' }}>
                  {loading ? <div className="skeleton" style={{ width: '80px', height: '36px' }} /> : stats?.sync.failed || 0}
                </div>
                <div className={`stat-change ${stats?.sync.failed ? 'negative' : 'positive'}`}>
                  {stats?.sync.failed ? '⚠ Needs attention' : '✓ All clear'}
                </div>
              </div>

              <div className="stat-card">
                <span className="stat-icon">⚡</span>
                <div className="stat-label">Conflicts Today</div>
                <div className="stat-value" style={{ color: 'var(--warning)' }}>
                  {loading ? <div className="skeleton" style={{ width: '80px', height: '36px' }} /> : stats?.conflicts.today || 0}
                </div>
                <div className="stat-change positive">
                  Auto-resolved
                </div>
              </div>
            </div>

            {/* Recent Transactions */}
            <div className="table-container" style={{ animationDelay: '0.3s' }}>
              <div className="table-header">
                <h3 className="table-title">Recent Sync Transactions</h3>
                <button className="btn btn-ghost btn-sm" onClick={fetchStats}>🔄 Refresh</button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th>Direction</th>
                    <th>Action</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {stats?.sync.recentTransactions?.length ? (
                    stats.sync.recentTransactions.map((tx: any) => (
                      <tr key={tx.id}>
                        <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                          {tx.transactionId?.substring(0, 12)}...
                        </td>
                        <td>
                          <span className="badge badge-info">
                            {tx.direction === 'GOOGLE_TO_OUTLOOK' ? '📧 → 📨' : '📨 → 📧'}
                            {' '}{tx.direction?.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td>{tx.action}</td>
                        <td>
                          <span className={`badge ${
                            tx.status === 'COMPLETED' ? 'badge-success' :
                            tx.status === 'FAILED' ? 'badge-error' :
                            tx.status === 'PROCESSING' ? 'badge-info' : 'badge-warning'
                          }`}>
                            <span className="badge-dot" />
                            {tx.status}
                          </span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          {new Date(tx.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-state">
                          <div className="empty-state-icon">📭</div>
                          <p>No sync transactions yet. Connect your calendars to get started.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'sync' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">Sync Monitor</h1>
              <p className="page-subtitle">Real-time event synchronization status</p>
            </div>
            <SyncMonitorPanel />
          </div>
        )}

        {activeTab === 'users' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">User Management</h1>
              <p className="page-subtitle">Manage synced users and their calendars</p>
            </div>
            <UsersPanel />
          </div>
        )}

        {activeTab === 'conflicts' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">Conflict Analytics</h1>
              <p className="page-subtitle">Meeting conflicts and auto-rejections</p>
            </div>
            <ConflictsPanel />
          </div>
        )}

        {activeTab === 'audit' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">Audit Logs</h1>
              <p className="page-subtitle">Immutable security and activity log</p>
            </div>
            <AuditPanel />
          </div>
        )}

        {activeTab === 'webhooks' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">Webhook Management</h1>
              <p className="page-subtitle">Active subscriptions and health</p>
            </div>
            <WebhooksPanel />
          </div>
        )}

        {activeTab === 'security' && (
          <div className="animate-in">
            <div className="page-header">
              <h1 className="page-title">Security Dashboard</h1>
              <p className="page-subtitle">Enterprise security posture overview</p>
            </div>
            <SecurityPanel />
          </div>
        )}
      </main>
    </div>
  );
}

// ---- Sub-panels ----

function SyncMonitorPanel() {
  const [transactions, setTransactions] = useState<any[]>([]);
  useEffect(() => {
    apiFetch('/api/admin/sync/transactions?limit=50').then(d => d.success && setTransactions(d.data.transactions)).catch(() => {});
  }, []);

  return (
    <div className="table-container">
      <div className="table-header">
        <h3 className="table-title">All Sync Transactions</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-ghost btn-sm">Filter</button>
          <button className="btn btn-primary btn-sm">Export</button>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>Direction</th><th>Action</th><th>Status</th><th>Retry</th><th>Time</th></tr>
        </thead>
        <tbody>
          {transactions.map((tx: any) => (
            <tr key={tx.id}>
              <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{tx.transactionId?.substring(0, 16)}</td>
              <td><span className="badge badge-info">{tx.direction?.replace(/_/g, ' ')}</span></td>
              <td>{tx.action}</td>
              <td><span className={`badge ${tx.status === 'COMPLETED' ? 'badge-success' : tx.status === 'FAILED' ? 'badge-error' : 'badge-warning'}`}>{tx.status}</span></td>
              <td>{tx.retryCount}/{tx.maxRetries || 5}</td>
              <td style={{ fontSize: '12px' }}>{new Date(tx.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EMAIL_PROVIDER_LABELS: Record<string, string> = {
  AUTO: '🤖 Auto (smart route)',
  GOOGLE: '📧 Gmail API',
  MICROSOFT: '📨 MS Graph',
  SENDGRID: '📬 SendGrid SMTP',
};

function UsersPanel() {
  const [users, setUsers] = useState<any[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/admin/users?limit=100').then(d => d.success && setUsers(d.data.users)).catch(() => {});
  }, []);

  async function changeEmailProvider(userId: string, provider: string) {
    setUpdatingId(userId);
    try {
      const data = await apiFetch(`/api/admin/users/${userId}/email-provider`, {
        method: 'PATCH',
        body: JSON.stringify({ emailProvider: provider }),
      });
      if (data.success) {
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, emailProvider: provider } : u));
      }
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div className="table-container">
      <div className="table-header">
        <h3 className="table-title">All Users</h3>
      </div>
      <table>
        <thead>
          <tr><th>User</th><th>Role</th><th>Google</th><th>Microsoft</th><th>Email Route</th><th>Calendars</th><th>Status</th><th>Last Sync</th></tr>
        </thead>
        <tbody>
          {users.map((u: any) => (
            <tr key={u.id}>
              <td>
                <div><strong style={{ color: 'var(--text-primary)' }}>{u.displayName}</strong></div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{u.email}</div>
              </td>
              <td><span className={`badge ${u.role === 'ADMIN' ? 'badge-error' : 'badge-info'}`}>{u.role}</span></td>
              <td>{u.googleConnected ? <span className="badge badge-success">✓ Connected</span> : <span className="badge badge-warning">Not connected</span>}</td>
              <td>{u.microsoftConnected ? <span className="badge badge-success">✓ Connected</span> : <span className="badge badge-warning">Not connected</span>}</td>
              <td>
                <select
                  value={u.emailProvider || 'AUTO'}
                  disabled={updatingId === u.id}
                  onChange={e => changeEmailProvider(u.id, e.target.value)}
                  style={{
                    background: 'var(--surface-2, #1e2130)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '4px 8px',
                    fontSize: '12px',
                    cursor: updatingId === u.id ? 'wait' : 'pointer',
                  }}
                >
                  {Object.entries(EMAIL_PROVIDER_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </td>
              <td>{u._count?.calendars || 0}</td>
              <td>{u.isActive ? <span className="badge badge-success"><span className="badge-dot" /> Active</span> : <span className="badge badge-error">Inactive</span>}</td>
              <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{u.lastSyncAt ? new Date(u.lastSyncAt).toLocaleString() : 'Never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConflictsPanel() {
  const [conflicts, setConflicts] = useState<any[]>([]);
  useEffect(() => {
    apiFetch('/api/admin/conflicts').then(d => d.success && setConflicts(d.data.conflicts)).catch(() => {});
  }, []);

  return (
    <div className="table-container">
      <div className="table-header">
        <h3 className="table-title">Conflict History</h3>
      </div>
      <table>
        <thead>
          <tr><th>User</th><th>Type</th><th>Resolution</th><th>Reason</th><th>Notified</th><th>Time</th></tr>
        </thead>
        <tbody>
          {conflicts.map((c: any) => (
            <tr key={c.id}>
              <td>{c.user?.email || 'Unknown'}</td>
              <td><span className="badge badge-warning">{c.conflictType?.replace(/_/g, ' ')}</span></td>
              <td><span className="badge badge-error">{c.resolution?.replace(/_/g, ' ')}</span></td>
              <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.rejectionReason}</td>
              <td>{c.notificationSent ? '✅' : '⏳'}</td>
              <td style={{ fontSize: '12px' }}>{new Date(c.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditPanel() {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => {
    apiFetch('/api/admin/audit-logs?limit=100').then(d => d.success && setLogs(d.data.logs)).catch(() => {});
  }, []);

  return (
    <div className="table-container">
      <div className="table-header">
        <h3 className="table-title">Immutable Audit Trail</h3>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>🔒 Records cannot be modified or deleted</span>
      </div>
      <table>
        <thead>
          <tr><th>Action</th><th>Resource</th><th>Source</th><th>IP</th><th>Time</th></tr>
        </thead>
        <tbody>
          {logs.map((log: any) => (
            <tr key={log.id}>
              <td><span className={`badge ${
                log.action?.includes('FAIL') || log.action?.includes('REJECTED') ? 'badge-error' :
                log.action?.includes('SUCCESS') || log.action?.includes('COMPLETED') ? 'badge-success' :
                log.action?.includes('LOOP') ? 'badge-warning' : 'badge-info'
              }`}>{log.action}</span></td>
              <td>{log.resourceType} / <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{log.resourceId?.substring(0, 12)}</span></td>
              <td>{log.source}</td>
              <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{log.ipAddress}</td>
              <td style={{ fontSize: '12px' }}>{new Date(log.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WebhooksPanel() {
  const [subs, setSubs] = useState<any[]>([]);
  useEffect(() => {
    apiFetch('/api/admin/webhooks').then(d => d.success && setSubs(d.data.subscriptions)).catch(() => {});
  }, []);

  return (
    <div className="table-container">
      <div className="table-header">
        <h3 className="table-title">Webhook Subscriptions</h3>
      </div>
      <table>
        <thead>
          <tr><th>Calendar</th><th>Provider</th><th>Status</th><th>Expires</th><th>User</th></tr>
        </thead>
        <tbody>
          {subs.map((s: any) => (
            <tr key={s.id}>
              <td>{s.calendar?.name || 'Unknown'}</td>
              <td><span className={`badge ${s.provider === 'GOOGLE' ? 'badge-info' : 'badge-success'}`}>{s.provider}</span></td>
              <td><span className={`badge ${s.status === 'ACTIVE' ? 'badge-success' : 'badge-error'}`}><span className="badge-dot" />{s.status}</span></td>
              <td style={{ fontSize: '12px' }}>{new Date(s.expiresAt).toLocaleString()}</td>
              <td>{s.calendar?.user?.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SecurityPanel() {
  const [sec, setSec] = useState<any>(null);
  useEffect(() => {
    apiFetch('/api/admin/security').then(d => d.success && setSec(d.data));
  }, []);

  return (
    <div className="stats-grid animate-stagger">
      <div className="stat-card">
        <span className="stat-icon">🔐</span>
        <div className="stat-label">Encryption</div>
        <div className="stat-value" style={{ fontSize: '18px', color: 'var(--success)' }}>{sec?.encryption?.algorithm || 'AES-256-GCM'}</div>
        <div className="stat-change positive">Active</div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">🛡️</span>
        <div className="stat-label">Auth Protocol</div>
        <div className="stat-value" style={{ fontSize: '18px', color: 'var(--success)' }}>{sec?.authProtocol || 'OAuth 2.0'}</div>
        <div className="stat-change positive">Secure</div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">📝</span>
        <div className="stat-label">Audit Log Entries</div>
        <div className="stat-value" style={{ color: 'var(--accent-primary)' }}>{sec?.auditLogs?.total ?? '—'}</div>
        <div className="stat-change positive">Immutable / Append-only</div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">⚠️</span>
        <div className="stat-label">Failed Logins (24h)</div>
        <div className="stat-value" style={{ color: sec?.threats?.recentFailedLogins ? 'var(--error)' : 'var(--success)' }}>
          {sec?.threats?.recentFailedLogins ?? '—'}
        </div>
        <div className={`stat-change ${sec?.threats?.recentFailedLogins ? 'negative' : 'positive'}`}>
          {sec?.threats?.recentFailedLogins ? 'Needs review' : 'All clear'}
        </div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">🔄</span>
        <div className="stat-label">Sync Loops Prevented</div>
        <div className="stat-value" style={{ color: 'var(--success)' }}>{sec?.threats?.loopsPrevented ?? '—'}</div>
        <div className="stat-change positive">Fingerprint protection</div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">🔗</span>
        <div className="stat-label">Active Webhooks</div>
        <div className="stat-value" style={{ color: 'var(--accent-primary)' }}>{sec?.webhooks?.active ?? '—'}</div>
        <div className={`stat-change ${sec?.webhooks?.expired ? 'negative' : 'positive'}`}>
          {sec?.webhooks?.expired ? `${sec.webhooks.expired} expired` : 'All healthy'}
        </div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">🚫</span>
        <div className="stat-label">Invalid Webhooks</div>
        <div className="stat-value" style={{ color: sec?.threats?.invalidWebhooks ? 'var(--warning)' : 'var(--success)' }}>
          {sec?.threats?.invalidWebhooks ?? '—'}
        </div>
        <div className="stat-change positive">Spoofing attempts blocked</div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">🔒</span>
        <div className="stat-label">SQL Injection</div>
        <div className="stat-value" style={{ fontSize: '16px', color: 'var(--success)' }}>Protected</div>
        <div className="stat-change positive">{sec?.features?.sqlInjectionProtection || 'Prisma ORM'}</div>
      </div>
    </div>
  );
}

// ---- My Calendar — personal panel with connect buttons + events ----

function MyCalendarPanel() {
  const [me, setMe] = useState<MeUser | null>(null);
  const [events, setEvents] = useState<MyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [meData, evData] = await Promise.all([
        apiFetch('/api/me'),
        apiFetch('/api/me/events?limit=100'),
      ]);
      if (meData.success) setMe(meData.data.user);
      if (evData.success) setEvents(evData.data.events);
    } catch (err) {
      console.error('Failed to load /api/me data', err);
    } finally {
      setLoading(false);
    }
  }

  async function disconnect(provider: 'google' | 'microsoft') {
    if (!confirm(`Disconnect ${provider}? Your stored events stay; sync will stop.`)) return;
    setBusyProvider(provider);
    try {
      await apiFetch(`/api/me/disconnect/${provider}`, { method: 'POST' });
      await loadAll();
    } finally {
      setBusyProvider(null);
    }
  }

  // Calendar connect = ask backend for a signed OAuth URL (it embeds our
  // user id in `state`), then navigate the browser to the provider's
  // consent screen. The callback links the new provider to our user
  // without ever needing a cross-domain cookie.
  async function connect(provider: 'google' | 'microsoft') {
    setBusyProvider(provider);
    try {
      const j = await apiFetch<{ success: boolean; data: { url: string }; error?: { message: string } }>(
        `/auth/${provider}/url`,
      );
      if (j.success && j.data?.url) {
        window.location.href = j.data.url;
      } else {
        alert(j.error?.message || `Failed to start ${provider} OAuth`);
        setBusyProvider(null);
      }
    } catch (err) {
      alert((err as Error).message);
      setBusyProvider(null);
    }
  }

  return (
    <>
      {/* Connection cards */}
      <div className="stats-grid animate-stagger" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <ProviderCard
          icon="📧"
          label="Google Calendar + Gmail"
          connected={!!me?.googleConnected}
          busy={busyProvider === 'google'}
          onConnect={() => connect('google')}
          onDisconnect={() => disconnect('google')}
        />
        <ProviderCard
          icon="📨"
          label="Microsoft Outlook + Graph"
          connected={!!me?.microsoftConnected}
          busy={busyProvider === 'microsoft'}
          onConnect={() => connect('microsoft')}
          onDisconnect={() => disconnect('microsoft')}
        />
      </div>

      {/* Account header */}
      {me && (
        <div className="table-container" style={{ marginTop: '20px', padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ fontSize: '28px' }}>👤</div>
            <div>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{me.displayName || me.email}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                {me.email} · last sync: {me.lastSyncAt ? new Date(me.lastSyncAt).toLocaleString() : 'never'}
              </div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn-ghost btn-sm" onClick={loadAll}>🔄 Refresh</button>
            </div>
          </div>
        </div>
      )}

      {/* Events list */}
      <div className="table-container" style={{ marginTop: '20px' }}>
        <div className="table-header">
          <h3 className="table-title">Upcoming Events ({events.length})</h3>
        </div>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Title</th>
              <th>Source</th>
              <th>Synced</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: '24px' }}>Loading…</td></tr>
            ) : events.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">
                    <div className="empty-state-icon">📭</div>
                    <p>No events yet. Connect a calendar above — events will appear within ~30 seconds.</p>
                  </div>
                </td>
              </tr>
            ) : (
              events.map(ev => (
                <tr key={ev.id}>
                  <td style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>
                    {ev.isAllDay
                      ? new Date(ev.startTime).toLocaleDateString() + ' · all day'
                      : new Date(ev.startTime).toLocaleString()}
                  </td>
                  <td>
                    <strong style={{ color: 'var(--text-primary)' }}>{ev.title || '(untitled)'}</strong>
                    {ev.meetingLink && (
                      <a href={ev.meetingLink} target="_blank" rel="noreferrer" style={{ marginLeft: '8px', color: 'var(--accent-primary)', fontSize: '12px' }}>join ↗</a>
                    )}
                  </td>
                  <td>
                    <span className="badge badge-info">
                      {ev.sourcePlatform === 'GOOGLE' ? '📧 Google' : '📨 Outlook'}
                    </span>
                  </td>
                  <td>
                    {ev.mirrorPlatform ? (
                      <span className="badge badge-success">✓ {ev.syncState}</span>
                    ) : (
                      <span className="badge badge-warning">— {ev.syncState}</span>
                    )}
                  </td>
                  <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{ev.location || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProviderCard({
  icon, label, connected, busy, onConnect, onDisconnect,
}: { icon: string; label: string; connected: boolean; busy: boolean; onConnect: () => void; onDisconnect: () => void; }) {
  return (
    <div className="stat-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span className="stat-icon">{icon}</span>
        <div style={{ flex: 1 }}>
          <div className="stat-label">{label}</div>
          <div className="stat-value" style={{ fontSize: '16px', color: connected ? 'var(--success)' : 'var(--text-muted)' }}>
            {connected ? '✓ Connected' : 'Not connected'}
          </div>
        </div>
      </div>
      <button
        className={`btn ${connected ? 'btn-ghost' : 'btn-primary'} btn-sm`}
        onClick={connected ? onDisconnect : onConnect}
        disabled={busy}
        style={{ width: '100%' }}
      >
        {busy ? 'Working…' : connected ? 'Disconnect' : 'Connect'}
      </button>
    </div>
  );
}
