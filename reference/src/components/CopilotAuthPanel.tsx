// Settings → Providers — GitHub Copilot auth panel.
//
// Implements the GitHub Device Flow:
//   1. POST /api/copilot-auth/start → show userCode + link
//   2. Poll /api/copilot-auth/poll every pollIntervalMs ms
//   3. On success: collapse to "Connected" card
//   4. On error: show reason + "Try Again" / "Cancel" buttons
//
// Uses the same visual conventions as ClaudeAuthPanel and CodexAuthPanel.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Copy,
  ExternalLink,
  Github,
} from 'lucide-react';
import { api } from '../utils/api';
import { Button } from './ui/button';
import type { CopilotAuthStatusResponse, StartCopilotAuthResponse } from '../../shared/api/copilotAuth';

type DeviceFlowState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; session: StartCopilotAuthResponse }
  | { phase: 'error'; reason: string; session: StartCopilotAuthResponse | null };

export function CopilotAuthPanel() {
  const [status, setStatus] = useState<CopilotAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState>({ phase: 'idle' });
  const pollTimer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await api.copilotAuth.status();
      if (res.ok) {
        const body = await res.json();
        setStatus(body);
      }
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return stopPolling;
  }, [refresh, stopPolling]);

  // Poll GitHub once per interval while a device flow is in-flight.
  useEffect(() => {
    if (deviceFlow.phase !== 'waiting') {
      stopPolling();
      return;
    }
    if (pollTimer.current !== null) return;

    let intervalMs = deviceFlow.session.pollIntervalMs;

    const tick = async () => {
      if (deviceFlow.phase !== 'waiting') return;
      try {
        const res = await api.copilotAuth.poll(deviceFlow.session.sessionId);
        if (!res.ok) return;
        const result = await res.json();

        if (result.status === 'completed') {
          stopPolling();
          setDeviceFlow({ phase: 'idle' });
          await refresh();
        } else if (result.status === 'slow_down') {
          // Update interval — re-schedule with new rate
          stopPolling();
          intervalMs = result.newIntervalMs;
          pollTimer.current = window.setInterval(tick, intervalMs);
        } else if (result.status === 'error') {
          stopPolling();
          setDeviceFlow({
            phase: 'error',
            reason: result.reason,
            session: deviceFlow.session,
          });
        }
        // 'pending' → keep polling
      } catch {
        // network hiccup — keep polling
      }
    };

    pollTimer.current = window.setInterval(tick, intervalMs);
    return stopPolling;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceFlow.phase, stopPolling]);

  const handleConnect = async () => {
    setDeviceFlow({ phase: 'starting' });
    try {
      const res = await api.copilotAuth.start();
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setDeviceFlow({
          phase: 'error',
          reason: body.error ?? 'Failed to start GitHub Device Flow.',
          session: null,
        });
        return;
      }
      const session = await res.json();
      setDeviceFlow({ phase: 'waiting', session });
    } catch (err) {
      setDeviceFlow({
        phase: 'error',
        reason: err instanceof Error ? err.message : String(err),
        session: null,
      });
    }
  };

  const handleCancel = async () => {
    stopPolling();
    await api.copilotAuth.cancel().catch(() => {});
    setDeviceFlow({ phase: 'idle' });
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.copilotAuth.disconnect();
      await refresh();
    } finally {
      setDisconnecting(false);
    }
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ---- Render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading GitHub Copilot status…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="copilot-auth-panel">
      {/* Header row */}
      <div className="flex items-center gap-3">
        <Github className="w-5 h-5 text-foreground" />
        <div>
          <h3 className="text-base font-semibold text-foreground">GitHub Copilot</h3>
          <p className="text-xs text-muted-foreground">
            Business / Enterprise — gpt-4o, claude-3.5-sonnet, o1, and more
          </p>
        </div>
      </div>

      {/* Connected state */}
      {status?.authenticated && deviceFlow.phase === 'idle' && (
        <div className="flex items-center justify-between rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
            <span className="text-sm font-medium text-green-700 dark:text-green-300">
              Connected
            </span>
            {status.tokenFingerprint && (
              <span className="text-xs text-green-600 dark:text-green-400 font-mono">
                (···{status.tokenFingerprint})
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
            data-testid="copilot-auth-disconnect"
          >
            {disconnecting ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <Trash2 className="w-3 h-3 mr-1" />
            )}
            Disconnect
          </Button>
        </div>
      )}

      {/* Disconnected / idle state */}
      {!status?.authenticated && deviceFlow.phase === 'idle' && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="w-4 h-4" />
            <span>Not connected</span>
          </div>
          <Button size="sm" onClick={handleConnect} data-testid="copilot-auth-connect">
            Connect
          </Button>
        </div>
      )}

      {/* Starting spinner */}
      {deviceFlow.phase === 'starting' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Starting Device Flow…</span>
        </div>
      )}

      {/* Device Flow modal: show userCode */}
      {deviceFlow.phase === 'waiting' && (
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              Go to{' '}
              <a
                href={deviceFlow.session.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline inline-flex items-center gap-1"
                data-testid="copilot-auth-login-url"
              >
                github.com/login/device
                <ExternalLink className="w-3 h-3" />
              </a>{' '}
              and enter the code:
            </p>
            <div className="flex items-center gap-3">
              <code className="text-2xl font-mono font-bold tracking-widest text-foreground bg-background border border-border rounded px-3 py-2">
                {deviceFlow.session.userCode}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleCopy(deviceFlow.session.userCode)}
              >
                <Copy className="w-3 h-3 mr-1" />
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
            <span>Waiting for authorization…</span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCancel()}
            className="text-muted-foreground"
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Error state */}
      {deviceFlow.phase === 'error' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{deviceFlow.reason}</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void handleConnect()}>
              Try Again
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeviceFlow({ phase: 'idle' })}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CopilotAuthPanel;
