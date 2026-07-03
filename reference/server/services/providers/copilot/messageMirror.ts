// GitHub Copilot transcript mirror.
//
// Persists each `UnifiedMessage` emitted by `CopilotProvider` into the
// same `messages` SQLite table the Anthropic, Codex, and OpenCode paths
// write to via `sqliteSessionStore`. The frontend's existing
// `/api/conversations/:id/messages` reader fetches off that table — so
// reloaded Copilot conversations show their history exactly the same
// way the other providers do. Mirrors `mirrorOpenCodeEvent`.
//
// Mirror writes are idempotent on `uuid` because `sqliteSessionStore.append`
// upserts on `(project_key, session_id, subpath, uuid)`.

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { resolveProjectKey } from '../../conversationContentStore.js';
import type { UnifiedMessage } from '@shared/providers/types';

interface MirrorContext {
  /** cwd / worktree path used when the Copilot turn started — the
   * sessionStore derives `projectKey` from this. */
  projectFolderPath: string;
  /** Copilot provider session id; equals the conversation's `provider_session_id`. */
  providerSessionId: string;
}

/**
 * Convert a `UnifiedMessage` into the on-disk entry shape that the
 * conversation reader consumes. Structure matches the Claude SDKMessage
 * on-the-wire shape so the frontend reloads Copilot conversations
 * through the same provider-neutral reader.
 */
function unifiedToTranscriptEntry(unified: UnifiedMessage): {
  uuid: string;
  type: string;
  timestamp: string;
  [key: string]: unknown;
} | null {
  const timestamp = new Date().toISOString();

  switch (unified.type) {
    case 'user':
      return {
        uuid: unified.id,
        type: 'user',
        timestamp,
        message: { role: 'user', content: unified.content },
      };
    case 'assistant':
      return {
        uuid: unified.id,
        type: 'assistant',
        timestamp,
        message: {
          id: unified.id,
          role: 'assistant',
          model: unified.model ?? null,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    case 'tool_use':
      return {
        uuid: `${unified.id}:tool_use`,
        type: 'assistant',
        timestamp,
        message: {
          id: unified.id,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: unified.toolUseId,
              name: unified.toolName,
              input: unified.toolInput,
            },
          ],
        },
      };
    case 'tool_result':
      return {
        uuid: `${unified.id}:tool_result`,
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: unified.toolUseId,
              content: unified.content,
              ...(unified.isError ? { is_error: true } : {}),
            },
          ],
        },
      };
    case 'assistant_thinking':
      return {
        uuid: `${unified.id}:thinking`,
        type: 'assistant',
        timestamp,
        message: {
          id: unified.id,
          role: 'assistant',
          content: [{ type: 'thinking', thinking: unified.text }],
        },
      };
    case 'result':
      return {
        uuid: unified.id,
        type: 'result',
        timestamp,
        is_error: unified.isError,
        ...(unified.usage ? { usage: unified.usage } : {}),
        ...(unified.errors ? { errors: unified.errors } : {}),
      };
    case 'system':
      return {
        uuid: unified.id,
        type: 'system',
        timestamp,
        subtype: unified.subtype ?? 'github-copilot',
      };
    case 'stream_delta':
      return null;
  }
}

/**
 * Append a single `UnifiedMessage` to the `messages` table under the
 * Copilot provider session id. Idempotent on `uuid` — duplicate events
 * produce a single row.
 */
export async function mirrorCopilotEvent(
  ctx: MirrorContext,
  unified: UnifiedMessage,
): Promise<void> {
  const entry = unifiedToTranscriptEntry(unified);
  if (!entry) return;
  await sqliteSessionStore.append(
    {
      projectKey: resolveProjectKey(ctx.projectFolderPath),
      sessionId: ctx.providerSessionId,
      subpath: '',
      provider: 'github-copilot',
    },
    [entry],
  );
}
