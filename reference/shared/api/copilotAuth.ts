// Typed REST contracts for /api/copilot-auth/*.


export interface CopilotAuthStatusResponse {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  tokenPath: string;
  tokenFingerprint?: string;
  reason?: string;
}

export interface StartCopilotAuthResponse {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalMs: number;
}

export type CopilotPollStatus =
  | { status: 'pending' }
  | { status: 'slow_down'; newIntervalMs: number }
  | { status: 'completed'; authStatus: CopilotAuthStatusResponse }
  | { status: 'error'; reason: string };

export interface CancelCopilotAuthResponse {
  cancelled: boolean;
}

export interface DisconnectCopilotAuthResponse {
  disconnected: boolean;
}

/** A single Copilot model row, as surfaced to the settings UI. */
export interface CopilotModelEntry {
  id: string;
  name: string;
  vendor?: string;
  version?: string;
}

/** Response of `GET /api/copilot-auth/models`. */
export interface CopilotModelsResponse {
  models: CopilotModelEntry[];
}
