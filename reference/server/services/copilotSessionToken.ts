// bottega\reference\server\services\copilotSessionToken.ts
//
// DEPRECATED — GitHub's /copilot_internal/v2/token endpoint returns 404.
// The provider now uses the OAuth token directly as a Bearer token against
// https://api.githubcopilot.com — no session-token exchange needed.
//
// This file is kept only because copilotAuth.ts imports evictCopilotToken.
// Safe to delete entirely once that import is removed.
// To confirm zero remaining callers:
//   grep -r "copilotSessionToken" reference/

export interface CopilotApiCredentials {
  token: string;
  apiEndpoint: string;
}

/**
 * No-op. The deprecated token cache has been removed.
 * Called by copilotAuth.ts on disconnect — safe to keep as a no-op.
 */
export function evictCopilotToken(_userId: number | string | undefined): void {
  // Intentional no-op — cache removed, SDK manages auth internally.
}