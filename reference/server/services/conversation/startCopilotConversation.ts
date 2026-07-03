// server/services/conversation/startCopilotConversation.ts
//
// GitHub Copilot-flavoured startConversation — the fourth-provider branch.
// Structure mirrors startOpenCodeConversation.ts exactly.
// startConversation() forks at the top when options.provider === 'github-copilot'.

import { promises as fs } from 'fs';
import { agentRunsDb, conversationsDb, tasksDb } from '../../database/db.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { getCredentialStore } from '../credentials/registry.js';
import { copilotProvider } from '../providers/copilot/index.js';
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
        parent_tool_use_id: unified.isSubAgent ? '__copilot_subagent__' : null,
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
        subtype: unified.subtype ?? 'github-copilot',
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
    provider: 'github-copilot',
  });
  broadcastFn(conversationId, {
    type: 'claude-response',
    data: wire as never,
  });
}

function failLinkedAgentRunIfRunning(
  taskId: number | undefined,
  conversationId: number,
): void {
  if (!taskId) return;
  try {
    const runs = agentRunsDb.getByTask(taskId);
    const linked = runs.find((r) => r.conversation_id === conversationId);
    if (linked && linked.status === 'running') {
      agentRunsDb.updateStatus(linked.id, 'failed');
    }
  } catch (err) {
    console.warn('[CopilotAdapter] failed to pre-mark agent run as failed:', err);
  }
}

export async function sendCopilotMessage(
  conversationId: number,
  message: string | null,
  options: ConversationOptions = {},
): Promise<void> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'sendCopilotMessage');
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
      `Copilot conversation ${conversationId} has no provider_session_id yet`,
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

  const copilotEnv = getCredentialStore('github-copilot').buildSdkEnv(userId);
  const promptText = message ?? '';

  const userOverride = resolveResumeModelEffort(conversation, userId);
  const model = normalizedOptions.model ?? userOverride.model;
  if (!model) {
    throw new Error(`Conversation ${conversationId} has no stored model to resume with`);
  }
  if (model !== conversation.model) {
    conversationsDb.updateModelEffort(conversationId, model, conversation.effort);
  }

  const abortController = new AbortController();
  const run = await copilotProvider.sendTurnMessage({
    cwd: projectPath,
    prompt: promptText,
    resumeSessionId,
    model,
    effort: null,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: copilotEnv,
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
      if (unified.type === 'result') {
        if (unified.isError) {
          failLinkedAgentRunIfRunning(tid, conversationId);
        }
        await contextUsageTracker.onResult({
          type: 'result',
          ...(unified.usage ? { modelUsage: { 'github-copilot': unified.usage } } : {}),
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
    console.error('[CopilotAdapter] Resume error:', error);
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

export async function startCopilotConversation(
  taskId: number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'startCopilotConversation');
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
  if (!model) {
    throw new Error('startCopilotConversation requires an explicit model');
  }

  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }

  let projectPath = taskWithProject.repo_folder_path;
  if (await worktreeExists(projectPath, taskId)) {
    projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
  }

  const copilotEnv = getCredentialStore('github-copilot').buildSdkEnv(userId);

  let _conversationId = options.conversationId;
  if (!_conversationId) {
    const conversation = conversationsDb.create(taskId, 'github-copilot', model, null);
    _conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created Copilot conversation ${_conversationId} for task ${taskId} (model=${model})`,
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

  const run = await copilotProvider.startTurn({
    cwd: projectPath,
    prompt: promptText,
    model,
    effort: null,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: copilotEnv,
    abortController,
  });

  const { tempImagePaths, tempDir } = imageResult;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('Copilot session creation timeout'));
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
              instance: run as unknown as never,// error
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

          if (unified.type === 'result') {
            if (unified.isError) {
              failLinkedAgentRunIfRunning(taskId, cid);
            }
            await contextUsageTracker.onResult({
              type: 'result',
              ...(unified.usage
                ? { modelUsage: { 'github-copilot': unified.usage } }
                : {}),
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
        console.error('[CopilotAdapter] Streaming error:', error);
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