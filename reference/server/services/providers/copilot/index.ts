// bottega\reference\server\services\providers\copilot\index.ts
//
// CopilotProvider � implements LlmProvider for GitHub Copilot.
//
// Auth: reads the GitHub OAuth token directly from disk (stored by Device Flow).
// Uses Bearer auth against https://api.githubcopilot.com � no SDK, no session
// token exchange (the /copilot_internal/v2/token endpoint is 404 and deprecated).
//
// Transport: direct fetch() + SSE streaming. The OAuth token IS the Bearer token.
// Confirmed working via PowerShell test against the live API.

import { readGitHubOAuthToken } from '../../copilotCredentials.js';
import { getCapabilities } from '@shared/providers/capabilities';
import type {
  ProviderCapabilities,
  ProviderRunOptions,
  ProviderRunResult,
  UnifiedMessage,
} from '@shared/providers/types';
import type { LlmProvider, LoadTranscriptOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COPILOT_API_ENDPOINT = 'https://api.githubcopilot.com';

// All five headers are required � missing any one returns 403.
const COPILOT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Editor-Version': 'vscode/1.90.0',
  'Editor-Plugin-Version': 'copilot-chat/0.17.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'openai-intent': 'conversation-panel',
  'User-Agent': 'Bottega/1.0',
};

// ---------------------------------------------------------------------------
// Extract userId from the env bag.
// buildCopilotSdkEnv() in copilotCredentials.ts tags it as BOTTEGA_USER_ID.
// ---------------------------------------------------------------------------

function extractUserId(env: ProviderRunOptions['env']): string | undefined {
  const raw = (env as Record<string, unknown> | undefined)?.['BOTTEGA_USER_ID'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

// ---------------------------------------------------------------------------
// SSE reader � parses the Server-Sent Events stream from the Copilot API
// ---------------------------------------------------------------------------

async function* readSSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // skip malformed SSE chunks silently
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Map an SSE chunk to UnifiedMessage(s)
// ---------------------------------------------------------------------------

interface Delta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

function* mapChunk(
  chunk: Record<string, unknown>,
  providerSessionId: string,
): Generator<UnifiedMessage, void, unknown> {
  const choices = chunk['choices'] as
    | Array<{ delta?: Delta; finish_reason?: string | null }>
    | undefined;
  if (!choices?.length) return;
  const delta = choices[0]?.delta;
  if (!delta) return;

  if (typeof delta.content === 'string' && delta.content) {
    yield {
      type: 'stream_delta',
      id: `copilot_delta_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      provider: 'github-copilot',
      providerSessionId,
      raw: chunk,
      delta: { type: 'text_delta', text: delta.content },
    } as unknown as UnifiedMessage;
  }
if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (!tc.function?.name) continue;
      const toolInput: unknown = (() => {
        try {
          return tc.function!.arguments  // tc.function error
            ? (JSON.parse(tc.function!.arguments) as unknown)
            : {}; // error in any tc.function
        } catch {
          return { _raw: tc.function!.arguments }; // error in tc.function  
        }
      })();
      yield {
        type: 'tool_use',
        id: `copilot_tool_${tc.id ?? tc.index}_${providerSessionId}`,
        provider: 'github-copilot',
        providerSessionId,
        raw: chunk,
        toolName: tc.function.name,
        toolUseId: tc.id ?? String(tc.index),
        toolInput,
      } as unknown as UnifiedMessage;
    }
  }
}
// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class CopilotProvider implements LlmProvider {
  readonly name = 'github-copilot' as const;

  getCapabilities(): ProviderCapabilities {
    return getCapabilities('github-copilot');
  }

  async startTurn(options: ProviderRunOptions): Promise<ProviderRunResult> {
    const abortController = options.abortController ?? new AbortController();
    const providerSessionId = crypto.randomUUID();
    const userId = extractUserId(options.env);

    async function* streamEvents(): AsyncGenerator<UnifiedMessage, void, unknown> {
      // Read the GitHub OAuth token stored on disk by the Device Flow auth.
      // This IS the Bearer token � no session exchange needed.
      const { token } = readGitHubOAuthToken(userId);

      const messages: Array<{ role: string; content: string }> = [];
      if (options.customSystemPrompt) {
        messages.push({ role: 'system', content: String(options.customSystemPrompt) });
      }
      messages.push({ role: 'user', content: options.prompt ?? '' });

      const body = JSON.stringify({
        model: options.model ?? 'gpt-4o',
        messages,
        stream: true,
      });

      let response: Response;
      try {
        response = await fetch(`${COPILOT_API_ENDPOINT}/chat/completions`, {
          method: 'POST',
          headers: {
            ...COPILOT_HEADERS,
            Authorization: `Bearer ${token}`,
          },
          body,
          signal: abortController.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield {
          type: 'system',
          id: `copilot_sys_${Date.now()}`,
          provider: 'github-copilot',
          providerSessionId,
          raw: { error: msg },
          subtype: 'error',
          text: `Copilot API request failed: ${msg}`,
        } as unknown as UnifiedMessage;
        yield {
          type: 'result',
          id: `copilot_result_${Date.now()}`,
          provider: 'github-copilot',
          providerSessionId,
          raw: { error: msg },
          isError: true,
        } as unknown as UnifiedMessage;
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const msg = `Copilot API returned HTTP ${response.status}: ${text}`;
        yield {
          type: 'system',
          id: `copilot_sys_${Date.now()}`,
          provider: 'github-copilot',
          providerSessionId,
          raw: { status: response.status, body: text },
          subtype: 'error',
          text: msg,
        } as unknown as UnifiedMessage;
        yield {
          type: 'result',
          id: `copilot_result_${Date.now()}`,
          provider: 'github-copilot',
          providerSessionId,
          raw: { status: response.status },
          isError: true,
        } as unknown as UnifiedMessage;
        return;
      }

      // Synthetic assistant-start so the UI renders the turn header immediately.
      yield {
        type: 'assistant',
        id: providerSessionId,
        provider: 'github-copilot',
        providerSessionId,
        raw: {},
        text: '',
        isSubAgent: false,
      } as unknown as UnifiedMessage;

      // Stream SSE chunks and map to UnifiedMessage.
      for await (const chunk of readSSE(response)) {
        for (const msg of mapChunk(chunk, providerSessionId)) {
          yield msg;
        }
      }

      // Signal clean turn completion.
      yield {
        type: 'result',
        id: `copilot_result_${Date.now()}`,
        provider: 'github-copilot',
        providerSessionId,
        raw: {},
        isError: false,
      } as unknown as UnifiedMessage;
    }

    return {
      events: streamEvents(),
      providerSessionId$: Promise.resolve(providerSessionId),
      abort: () => abortController.abort(),
      pid: null,
    };
  }

  async sendTurnMessage(
    options: ProviderRunOptions & { resumeSessionId: string },
  ): Promise<ProviderRunResult> {
    return this.startTurn(options);
  }

  async loadTranscript(_options: LoadTranscriptOptions): Promise<UnifiedMessage[]> {
    return [];
  }

  abortTurn(_providerSessionId: string): boolean {
    return false;
  }
}

export const copilotProvider = new CopilotProvider();
