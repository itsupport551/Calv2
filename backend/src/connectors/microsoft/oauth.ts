// ============================================================
// Microsoft OAuth 2.0 helpers (direct HTTP, no MSAL)
// ============================================================
// We talk to Microsoft Identity directly instead of via @azure/msal-node
// because MSAL deliberately hides the refresh_token inside its in-memory
// cache — that cache doesn't survive container restarts on Railway, so
// after one ~hour we'd lose the user's session permanently and the
// refresh-token field in our DB would always be empty.
//
// With the direct token endpoint we get refresh_token explicitly in the
// response, encrypt it, store it, and use it later via a plain POST when
// the access token expires.
// ============================================================

import config from '../../config';

const SCOPES = [
  'Calendars.ReadWrite',
  'User.Read',
  'Mail.Send',
  'offline_access', // required to receive a refresh_token
];

function tokenEndpoint(): string {
  const tenant = config.microsoft.tenantId || 'common';
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

function authorizeEndpoint(): string {
  const tenant = config.microsoft.tenantId || 'common';
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

/** Build the Microsoft consent URL the user is redirected to. */
export function buildMicrosoftAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    response_type: 'code',
    redirect_uri: config.microsoft.redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    prompt: 'consent', // forces refresh_token issuance on every connect
  });
  return `${authorizeEndpoint()}?${params.toString()}`;
}

interface MsTokenResponse {
  token_type: string;
  scope: string;
  expires_in: number; // seconds
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export interface MsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

async function postToken(body: URLSearchParams): Promise<MsTokens> {
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as MsTokenResponse & { error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Microsoft token request failed: ${msg}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt: new Date(Date.now() + (data.expires_in - 60) * 1000), // -60s safety margin
  };
}

/** Exchange an authorization `code` from the callback for tokens. */
export async function exchangeCodeForTokens(code: string): Promise<MsTokens> {
  return postToken(
    new URLSearchParams({
      client_id: config.microsoft.clientId,
      client_secret: config.microsoft.clientSecret,
      code,
      redirect_uri: config.microsoft.redirectUri,
      grant_type: 'authorization_code',
      scope: SCOPES.join(' '),
    }),
  );
}

/** Use a stored refresh_token to get a fresh access_token. */
export async function refreshAccessToken(refreshToken: string): Promise<MsTokens> {
  return postToken(
    new URLSearchParams({
      client_id: config.microsoft.clientId,
      client_secret: config.microsoft.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    }),
  );
}
