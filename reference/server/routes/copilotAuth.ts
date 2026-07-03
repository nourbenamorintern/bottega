// server/routes/copilotAuth.ts
// /api/copilot-auth/* — GitHub Copilot authentication, per-user scoped.
//
// Routes:
//   GET    /status     — is this user's GitHub OAuth token stored?
//   POST   /start      — begin the GitHub Device Flow (returns userCode + verificationUri)
//   GET    /poll       — poll for Device Flow completion
//   POST   /cancel     — cancel an in-progress Device Flow
//   DELETE /disconnect — remove stored token and clear in-memory state
//   GET    /models     — live model list from this user's Copilot subscription

import express from 'express';
import type { Request, Response } from 'express';
import {
  startGitHubDeviceFlow,
  pollGitHubDeviceFlow,
  cancelDeviceSession,
  GitHubCopilotAuthError,
} from '../services/githubCopilotAuthFlow.js';
import {
  getGitHubCopilotAuthStatus,
  clearGitHubOAuthToken,
  readGitHubOAuthToken,
} from '../services/copilotCredentials.js';
import { evictCopilotToken } from '../services/copilotSessionToken.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/copilot-auth/status
// ---------------------------------------------------------------------------
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const status = await getGitHubCopilotAuthStatus(userId);
    res.json({
      authenticated: status.authenticated,
      status: status.status,
      tokenPath: status.tokenPath,
      tokenFingerprint: status.tokenFingerprint ?? null,
      reason: status.authenticated ? null : (status.reason ?? null),
    });
  } catch (err) {
    console.error('[CopilotAuth] status error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/copilot-auth/start
// ---------------------------------------------------------------------------
router.post('/start', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const session = await startGitHubDeviceFlow(userId);
    res.json(session);
  } catch (err) {
    const status =
      err instanceof GitHubCopilotAuthError ? err.statusCode : 500;
    console.error('[CopilotAuth] start error:', err);
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/copilot-auth/poll?sessionId=<uuid>
// ---------------------------------------------------------------------------
router.get('/poll', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.query['sessionId'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId query parameter' });
      return;
    }

    const result = await pollGitHubDeviceFlow(userId, sessionId);

    if (result.status === 'completed') {
      await seedAgentSettingsAfterConnect(userId).catch((err) => {
        console.error('[CopilotAuth] seedAgentSettingsAfterConnect failed:', err);
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[CopilotAuth] poll error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/copilot-auth/cancel
// ---------------------------------------------------------------------------
router.post('/cancel', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const cancelled = cancelDeviceSession(userId);
    res.json({ cancelled });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/copilot-auth/disconnect
// ---------------------------------------------------------------------------
router.delete('/disconnect', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    cancelDeviceSession(userId);
    evictCopilotToken(userId);
    clearGitHubOAuthToken(userId);
    res.json({ disconnected: true });
  } catch (err) {
    console.error('[CopilotAuth] disconnect error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/copilot-auth/models
// ---------------------------------------------------------------------------
router.get('/models', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const status = await getGitHubCopilotAuthStatus(userId);
    if (!status.authenticated) {
      res.json({ models: [] });
      return;
    }

    const { token } = readGitHubOAuthToken(userId);

    const response = await fetch('https://api.githubcopilot.com/models', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Editor-Version': 'vscode/1.90.0',
        'Editor-Plugin-Version': 'copilot-chat/0.17.0',
        'Copilot-Integration-Id': 'vscode-chat',
        'User-Agent': 'Bottega/1.0',
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[CopilotAuth] models fetch failed (${response.status}): ${text}`);
      res.status(response.status).json({
        error: `Copilot API returned HTTP ${response.status}`,
      });
      return;
    }

    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        vendor?: string;
        version?: string;
      }>;
    };

    const models = (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      vendor: m.vendor,
      version: m.version,
    }));

    res.json({ models });
  } catch (err) {
    console.error('[CopilotAuth] models error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal error',
    });
  }
});

export default router;