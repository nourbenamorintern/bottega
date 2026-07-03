// GitHub Device Flow auth for the Bottega GitHub Copilot provider.
//
// Implements RFC 8628 (OAuth 2.0 Device Authorization Grant) against GitHub.
// No subprocess, no PTY — pure Node.js fetch().
//
// Flow:
//   1. POST /login/device/code → device_code + user_code + verification_uri
//   2. Show user_code to the user ("Go to github.com/login/device and enter XXXX-YYYY")
//   3. Frontend polls /api/copilot-auth/poll every pollIntervalMs ms
//   4. This module polls GitHub's token endpoint and writes the token on success

import {
  writeGitHubOAuthToken,
  getGitHubCopilotAuthStatus,
  type GitHubCopilotAuthStatus,
} from './copilotCredentials.js';

const GITHUB_BASE = process.env.GITHUB_ENTERPRISE_URL ?? 'https://github.com';

const DEVICE_CODE_URL = `${GITHUB_BASE}/login/device/code`;
const POLL_URL = `${GITHUB_BASE}/login/oauth/access_token`;
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// 'copilot' is required for the session-token exchange.
// 'read:org' lets GitHub verify Copilot Business org membership.
const SCOPES = 'copilot read:org';

function getClientId(): string {
  const id = process.env.GITHUB_COPILOT_CLIENT_ID;
  if (!id) {
    throw new GitHubCopilotAuthError(
      'GITHUB_COPILOT_CLIENT_ID is not set in .env. ' +
        'Create a GitHub OAuth App at https://github.com/settings/developers ' +
        'with Device Flow enabled, and add GITHUB_COPILOT_CLIENT_ID to your .env.',
      500,
    );
  }
  return id;
}

export class GitHubCopilotAuthError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'GitHubCopilotAuthError';
    this.statusCode = statusCode;
  }
}

// ---- Session types ---------------------------------------------------------

export interface DeviceFlowSession {
  sessionId: string;
  userId: number | string;
  deviceCode: string;
  userCode: string; // shown to the user, e.g. "ABCD-1234"
  verificationUri: string; // always "https://github.com/login/device"
  expiresAt: string; // ISO timestamp
  pollIntervalMs: number;
  startedAt: string;
}

export interface PublicDeviceSession {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalMs: number;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; newIntervalMs: number }
  | { status: 'completed'; authStatus: GitHubCopilotAuthStatus }
  | { status: 'error'; reason: string };

// ---- In-memory session store (one per user) --------------------------------

const activeSessions = new Map<string, DeviceFlowSession>();

function normalizeKey(userId: number | string): string {
  const n = Number(userId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new GitHubCopilotAuthError('Invalid user ID for device flow', 400);
  }
  return String(n);
}

function toPublic(s: DeviceFlowSession): PublicDeviceSession {
  return {
    sessionId: s.sessionId,
    userCode: s.userCode,
    verificationUri: s.verificationUri,
    expiresAt: s.expiresAt,
    pollIntervalMs: s.pollIntervalMs,
  };
}

// ---- Public API ------------------------------------------------------------

export function getActiveDeviceSession(
  userId: number | string,
): PublicDeviceSession | null {
  const s = activeSessions.get(normalizeKey(userId));
  return s ? toPublic(s) : null;
}

export function cancelDeviceSession(userId: number | string): boolean {
  return activeSessions.delete(normalizeKey(userId));
}

/**
 * Start the GitHub Device Flow for a user.
 * Cancels any existing in-progress session before starting a new one.
 */
export async function startGitHubDeviceFlow(
  userId: number | string,
): Promise<PublicDeviceSession> {
  const clientId = getClientId();
  const key = normalizeKey(userId);

  activeSessions.delete(key);

  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: clientId, scope: SCOPES }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubCopilotAuthError(
      `GitHub rejected the device code request (HTTP ${res.status}): ${body}`,
      502,
    );
  }

  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (data.error || !data.device_code || !data.user_code || !data.verification_uri) {
    throw new GitHubCopilotAuthError(
      `GitHub error starting device flow: ${data.error_description ?? data.error ?? 'unknown'}`,
      502,
    );
  }

  const expiresInMs = (data.expires_in ?? 900) * 1000;
  const pollIntervalMs = Math.max((data.interval ?? 5) * 1000, 5000);
  const now = Date.now();

  const session: DeviceFlowSession = {
    sessionId: crypto.randomUUID(),
    userId,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: new Date(now + expiresInMs).toISOString(),
    pollIntervalMs,
    startedAt: new Date(now).toISOString(),
  };

  activeSessions.set(key, session);

  // Auto-clean from memory once the device code expires.
  const cleanup = setTimeout(() => {
    if (activeSessions.get(key)?.sessionId === session.sessionId) {
      activeSessions.delete(key);
    }
  }, expiresInMs + 5_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cleanup as any).unref?.();

  console.log(
    `[GitHubCopilotAuthFlow] Started device flow for user ${userId}. ` +
      `Session: ${session.sessionId}. Expires: ${session.expiresAt}.`,
  );

  return toPublic(session);
}

/**
 * Poll GitHub once for the given user's active device session.
 * The route calls this on each frontend poll request.
 */
export async function pollGitHubDeviceFlow(
  userId: number | string,
  sessionId: string,
): Promise<PollResult> {
  const clientId = getClientId();
  const key = normalizeKey(userId);
  const session = activeSessions.get(key);

  if (!session) {
    return { status: 'error', reason: 'No active device flow session. Start a new login.' };
  }
  if (session.sessionId !== sessionId) {
    return { status: 'error', reason: 'Session ID mismatch — session was replaced.' };
  }
  if (Date.now() > new Date(session.expiresAt).getTime()) {
    activeSessions.delete(key);
    return { status: 'error', reason: 'Device code expired. Start a new login.' };
  }

  const res = await fetch(POLL_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: session.deviceCode,
      grant_type: GRANT_TYPE,
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    interval?: number;
  };

  // --- SUCCESS ---
  if (data.access_token) {
    activeSessions.delete(key);
    writeGitHubOAuthToken(userId, data.access_token);
    const authStatus = await getGitHubCopilotAuthStatus(userId);
    console.log(`[GitHubCopilotAuthFlow] Login completed for user ${userId}.`);
    return { status: 'completed', authStatus };
  }

  // --- STILL WAITING ---
  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending' };

    case 'slow_down': {
      const extra = (data.interval ?? 5) * 1000;
      session.pollIntervalMs += extra;
      return { status: 'slow_down', newIntervalMs: session.pollIntervalMs };
    }

    case 'expired_token':
      activeSessions.delete(key);
      return { status: 'error', reason: 'Device code expired. Please start a new login.' };

    case 'access_denied':
      activeSessions.delete(key);
      return { status: 'error', reason: 'You denied the authorization. Try again when ready.' };

    default:
      return {
        status: 'error',
        reason: `Unexpected GitHub response: ${data.error ?? JSON.stringify(data)}`,
      };
  }
}
