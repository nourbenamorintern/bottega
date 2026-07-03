// server/services/conversation/startCodexConversation.ts
// Codex-flavoured `startConversation` — the second-provider branch of
// the orchestrator.
//
// `startConversation` (in `startConversation.ts`) forks at the top: when
// the conversation's provider is `'openai'`, it delegates here. The
// existing Claude path stays bit-identical for Anthropic conversations.

import { promises as fs } from 'fs';
import { conversationsDb, tasksDb } from '../../database/db.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { getCredentialStore } from '../credentials/registry.js';
import { codexProvider } from '../providers/openai/index.js';
import { mirrorCodexEvent } from '../providers/openai/messageMirror.js';
import { activeSessions } from './sessionState.js';
import { validateAndNormalizeOptions } from './sdkOptions.js';
import { handleImages, cleanupTempFiles, handleVideoRecording } from './media.js';
import {
  handleStreamingStarted,
  handleStreamingComplete,
  composeAsync,
} from './streamingLifecycle.js';
import { buildAgentRunCompletionHandler } from './agentRunLifecycle.js';
import { resolveSlashCommand } from './slashCommands.js';
import type { ConversationOptions, StreamingContext } from './types.js';
import type { BroadcastFn } from '@shared/websocket/messages';
import type { UnifiedMessage } from '@shared/providers/types';

function composeOnComplete(ctx: StreamingContext): () => Promise<void> {
  return composeAsync<void>(
    () => handleStreamingComplete(ctx),
    buildAgentRunCompletionHandler(ctx),
  );
}

function unifiedToWireMessage(unified: UnifiedMessage): Record<string, unknown> | null {
  switch (unified.type) {
    case 'user':
      return {
        type: 'user',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        message: { role: 'user', content: unified.content },
      };
    case 'assistant':
      return {
        type: 'assistant',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        parent_tool_use_id: unified.isSubAgent ? '__codex_subagent__' : null,
        message: {
          id: unified.id,
          model: unified.model ?? null,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    case 'tool_use':
      return {
        type: 'assistant',
        uuid: `${unified.id}:wire`,
        session_id: unified.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: unified.id,
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
        type: 'user',
        uuid: `${unified.id}:wire`,
        session_id: unified.providerSessionId,
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
        type: 'assistant',
        uuid: `${unified.id}:thinking`,
        session_id: unified.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: unified.id,
          content: [{ type: 'thinking', thinking: unified.text }],
        },
      };
    case 'result':
      return {
        type: 'result',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        is_error: unified.isError,
        ...(unified.usage ? { usage: unified.usage } : {}),
        ...(unified.errors ? { errors: unified.errors } : {}),
      };
    case 'system':
      return {
        type: 'system',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        subtype: unified.subtype ?? 'codex',
      };
    case 'stream_delta':
      return null;
  }
}

function broadcastUnified(
  broadcastFn: BroadcastFn | undefined,
  conversationId: number,
  unified: UnifiedMessage,
): void {
  if (!broadcastFn) return;
  const wire = unifiedToWireMessage(unified);
  if (!wire) return;
  broadcastFn(conversationId, {
    type: 'ai-response',
    data: wire as never,
    provider: 'openai',
  });
  broadcastFn(conversationId, {
    type: 'claude-response',
    data: wire as never,
  });
}

export async function sendCodexMessage(
  conversationId: number,
  message: string | null,
  options: ConversationOptions = {},
): Promise<void> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'sendCodexMessage');
  const { broadcastFn, broadcastToTaskSubscribersFn, userId, permissionMode } =
    normalizedOptions;

  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const resumeSessionId =
    conversation.provider_session_id ?? conversation.claude_conversation_id;
  if (!resumeSessionId) {
    throw new Error(
      `Codex conversation ${conversationId} has no provider_session_id yet`,
    );
  }

  const taskId = conversation.task_id;
  if (!taskId) {
    throw new Error(`Conversation ${conversationId} has no task_id`);
  }
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task for conversation ${conversationId} not found`);
  }
  const projectId = taskWithProject.project_id;
  const tid: number = taskId; // narrowed for closure use

  let projectPath: string;
  if (conversation.session_path) {
    projectPath = conversation.session_path;
  } else {
    projectPath = taskWithProject.repo_folder_path;
    if (await worktreeExists(projectPath, tid)) {
      projectPath = getWorktreeProjectPath(
        projectPath,
        tid,
        taskWithProject.subproject_path,
      );
    }
  }

  const codexEnv = getCredentialStore('openai').buildSdkEnv(userId);
  const promptText = message ?? '';

  const userOverride = resolveResumeModelEffort(conversation, userId);
  const model = normalizedOptions.model ?? userOverride.model;
  const effort = normalizedOptions.effort ?? userOverride.effort;
  if (!model) {
    throw new Error(`Conversation ${conversationId} has no stored model to resume with`);
  }
  if (model !== conversation.model || effort !== conversation.effort) {
    conversationsDb.updateModelEffort(conversationId, model, effort);
  }

  const abortController = new AbortController();
  const run = await codexProvider.sendTurnMessage({
    cwd: projectPath,
    prompt: promptText,
    resumeSessionId,
    model,
    effort,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: codexEnv,
    abortController,
  });

  const ctx: StreamingContext = {
    conversationId,
    taskId: tid,
    claudeSessionId: resumeSessionId,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    isNewSession: false,
  };

  activeSessions.set(resumeSessionId, {
    instance: run as unknown as never,
    abortController,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths: [],
    tempDir: null,
    conversationId,
    taskId: tid,
    projectId,
    userId: userId ?? null,
  });

  handleStreamingStarted(ctx);

  const contextUsageTracker = createContextUsageTracker({
    conversationId,
    broadcastFn,
  });

  try {
    for await (const unified of run.events) {
      broadcastUnified(broadcastFn, conversationId, unified);
      await mirrorCodexEvent(
        { projectFolderPath: projectPath, providerSessionId: resumeSessionId },
        unified,
      ).catch((err) => {
        console.warn('[ConversationAdapter] Codex resume mirror failed:', err);
      });
      if (unified.type === 'result') {
        await contextUsageTracker.onResult({
          type: 'result',
          ...(unified.usage ? { modelUsage: { codex: unified.usage } } : {}),
        } as never);
      }
    }

    activeSessions.delete(resumeSessionId);
    if (broadcastFn) {
      broadcastFn(conversationId, {
        type: 'claude-complete',
        sessionId: resumeSessionId,
        exitCode: 0,
        isNewSession: false,
      });
    }
    await composeOnComplete(ctx)();
  } catch (error) {
    console.error('[ConversationAdapter] Codex resume error:', error);
    activeSessions.delete(resumeSessionId);
    if (broadcastFn) {
      const errMsg = error instanceof Error ? error.message : String(error);
      broadcastFn(conversationId, {
        type: 'claude-error',
        error: errMsg,
      });
    }
    await composeOnComplete(ctx)();
    throw error;
  }
}

export async function startCodexConversation(
  taskId: number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'startCodexConversation');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId,
    permissionMode,
    images,
    customSystemPrompt,
    videoConfig,
  } = normalizedOptions;

  const model = normalizedOptions.model;
  const effort = normalizedOptions.effort ?? null;
  if (!model) {
    throw new Error('startCodexConversation requires an explicit model');
  }

  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }

  let projectPath = taskWithProject.repo_folder_path;
  if (await worktreeExists(projectPath, taskId)) {
    projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
  }

  const codexEnv = getCredentialStore('openai').buildSdkEnv(userId);

  let _conversationId = options.conversationId;
  if (!_conversationId) {
    const conversation = conversationsDb.create(taskId, 'openai', model, effort);
    _conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created Codex conversation ${_conversationId} for task ${taskId} (model=${model})`,
    );
  }
  // Narrowed to number — TypeScript loses narrowing inside async closures.
  const cid: number = _conversationId;

  const imageResult =
    images && images.length > 0
      ? await handleImages(message, images, projectPath)
      : { modifiedCommand: message, tempImagePaths: [] as string[], tempDir: null };
  const finalMessageRaw = imageResult.modifiedCommand;
  const finalMessage = await resolveSlashCommand(finalMessageRaw, projectPath);
  const promptText =
    (finalMessage ?? message) +
    (customSystemPrompt ? `\n\n[System]\n${customSystemPrompt}` : '');

  const abortController = new AbortController();

  const run = await codexProvider.startTurn({
    cwd: projectPath,
    prompt: promptText,
    model,
    effort,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: codexEnv,
    abortController,
  });

  const { tempImagePaths, tempDir } = imageResult;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('Codex session creation timeout'));
    }, 60000);

    const ctx: StreamingContext = {
      conversationId: cid,
      taskId,
      claudeSessionId: null,
      userId,
      broadcastFn,
      broadcastToTaskSubscribersFn,
      isNewSession: true,
      videoConfig,
    };

    const contextUsageTracker = createContextUsageTracker({
      conversationId: cid,
      broadcastFn,
    });

    const preSessionBuffer: UnifiedMessage[] = [];

    void (async () => {
      try {
        for await (const unified of run.events) {
          if (!resolved && unified.providerSessionId && ctx.claudeSessionId === null) {
            const sid = unified.providerSessionId;
            ctx.claudeSessionId = sid;
            conversationsDb.updateClaudeId(cid, sid);
            conversationsDb.updateProviderSessionId(cid, sid);
            conversationsDb.updateSessionPath(cid, projectPath);
            activeSessions.set(sid, {
              instance: run as unknown as never, // error
              abortController,
              startTime: Date.now(),
              status: 'active',
              tempImagePaths,
              tempDir,
              conversationId: cid,
              taskId,
              projectId: taskWithProject.project_id,
              userId: userId ?? null,
            });

            generateConversationTitle(
              cid,
              message,
              broadcastFn,
              userId,
              taskId,
              broadcastToTaskSubscribersFn,
            );

            handleStreamingStarted(ctx);

            if (broadcastFn) {
              broadcastFn(cid, {
                type: 'conversation-created',
                conversationId: cid,
                claudeSessionId: sid,
              });
              broadcastFn(cid, {
                type: 'session-created',
                sessionId: sid,
              });
            }
            if (broadcastToTaskSubscribersFn) {
              broadcastToTaskSubscribersFn(taskId, {
                type: 'conversation-added',
                conversation: {
                  id: cid,
                  task_id: taskId,
                  claude_conversation_id: sid,
                  created_at: new Date().toISOString(),
                },
              });
            }

            clearTimeout(timeout);
            resolved = true;
            resolve({ conversationId: cid, claudeSessionId: sid });
          }

          broadcastUnified(broadcastFn, cid, unified);

          if (ctx.claudeSessionId) {
            if (preSessionBuffer.length > 0) {
              const sid = ctx.claudeSessionId;
              for (const buffered of preSessionBuffer) {
                const patched = { ...buffered, providerSessionId: sid };
                await mirrorCodexEvent(
                  { projectFolderPath: projectPath, providerSessionId: sid },
                  patched,
                ).catch((err) => {
                  console.warn('[ConversationAdapter] Codex mirror failed (buffered):', err);
                });
              }
              preSessionBuffer.length = 0;
            }
            await mirrorCodexEvent(
              {
                projectFolderPath: projectPath,
                providerSessionId: ctx.claudeSessionId,
              },
              unified,
            ).catch((err) => {
              console.warn('[ConversationAdapter] Codex mirror failed:', err);
            });
          } else {
            preSessionBuffer.push(unified);
          }

          if (unified.type === 'result') {
            await contextUsageTracker.onResult({
              type: 'result',
              ...(unified.usage ? { modelUsage: { codex: unified.usage } } : {}),
            } as never);
          }
        }

        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);
        if (ctx.videoConfig) {
          await handleVideoRecording(ctx.videoConfig);
        }

        if (broadcastFn) {
          broadcastFn(cid, {
            type: 'claude-complete',
            sessionId: ctx.claudeSessionId,
            exitCode: 0,
            isNewSession: true,
          });
        }

        await composeOnComplete(ctx)();
      } catch (error) {
        console.error('[ConversationAdapter] Codex streaming error:', error);
        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);
        if (ctx.videoConfig?.tempDir) {
          await fs.rm(ctx.videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
        }

        if (!resolved) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (broadcastFn) {
          const errMsg = error instanceof Error ? error.message : String(error);
          broadcastFn(cid, {
            type: 'claude-error',
            error: errMsg,
          });
        }
        await composeOnComplete(ctx)();
      }
    })();
  });
}