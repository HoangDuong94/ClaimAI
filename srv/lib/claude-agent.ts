import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallbackMatcher,
  HookEvent,
  Options,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage
} from '@anthropic-ai/claude-agent-sdk';

type ConsoleLike = Pick<Console, 'debug' | 'info' | 'warn' | 'error' | 'log'>;

const DEFAULT_MODEL = process.env.CLAUDE_AGENT_MODEL
  || process.env.CLAUDE_MODEL
  || 'claude-3.5-sonnet';

interface RunClaudeAgentParams {
  prompt: string;
  systemPrompt: string;
  options?: Partial<Options>;
  logger?: ConsoleLike;
  resumeSessionId?: string;
}

interface ClaudeAgentResult {
  result: string;
  sessionId?: string;
}

const isAssistantMessage = (message: SDKMessage): message is SDKAssistantMessage =>
  message.type === 'assistant';

const isResultMessage = (message: SDKMessage): message is SDKResultMessage =>
  message.type === 'result';

const getResultString = (message: SDKResultMessage): string | undefined => {
  return typeof (message as { result?: unknown }).result === 'string'
    ? (message as { result: string }).result
    : undefined;
};

const summarizeResultError = (message: SDKResultMessage): string => {
  const base = getResultString(message)?.trim();
  if (base) return base;
  if (message.subtype !== 'success') return message.subtype;
  if (message.permission_denials?.length) {
    const denied = message.permission_denials
      .map((denial) => denial.tool_name)
      .join(', ');
    return `permission denied for tools: ${denied}`;
  }
  return message.is_error ? 'unknown error' : 'no content returned';
};

const extractTextBlocks = (assistantMessage: SDKAssistantMessage): string => {
  const blocks = assistantMessage.message?.content;
  if (!Array.isArray(blocks)) return '';

  return blocks
    .map((block) => {
      if (block && typeof block === 'object' && 'type' in block) {
        if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text;
        }
        if (block.type === 'tool_result' && typeof (block as { content?: unknown }).content === 'string') {
          return (block as { content: string }).content;
        }
      }
      return '';
    })
    .filter(Boolean)
    .join('')
    .trim();
};

const truncateForLog = (value: unknown, maxLength = 500): string => {
  let str = '';
  if (typeof value === 'string') {
    str = value;
  } else if (value !== undefined) {
    try {
      str = JSON.stringify(value, null, 2) || '';
    } catch {
      str = String(value);
    }
  }
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}…`;
};

const createLoggingHooks = (
  logger: ConsoleLike | undefined,
  toolTimers: Map<string, { tool: string; startedAt: number }>
): Options['hooks'] | undefined => {
  if (!logger) return undefined;

  const pre: HookCallbackMatcher = {
    hooks: [
      async (input, toolUseId) => {
        try {
          const preInput = input as PreToolUseHookInput;
          const toolName = preInput.tool_name;
          const toolInput = preInput.tool_input;
          if (toolUseId) {
            toolTimers.set(toolUseId, { tool: toolName, startedAt: Date.now() });
          }
          logger.debug?.('[ClaudeAgent] Tool invocation requested', {
            tool: toolName,
            toolUseId,
            input: truncateForLog(toolInput)
          });
        } catch (error) {
          logger.warn?.('[ClaudeAgent] Failed to log PreToolUse hook', { error });
        }
        return { continue: true };
      }
    ]
  };

  const post: HookCallbackMatcher = {
    hooks: [
      async (input, toolUseId) => {
        try {
          const postInput = input as PostToolUseHookInput;
          const toolName = postInput.tool_name;
          const toolInput = postInput.tool_input;
          const toolResponse = postInput.tool_response;
          const timing = toolUseId ? toolTimers.get(toolUseId) : undefined;
          const durationMs = timing ? Date.now() - timing.startedAt : undefined;
          if (toolUseId && timing) {
            toolTimers.delete(toolUseId);
          }
          logger.debug?.('[ClaudeAgent] Tool invocation completed', {
            tool: toolName,
            toolUseId,
            durationMs,
            input: truncateForLog(toolInput),
            output: truncateForLog(toolResponse)
          });
        } catch (error) {
          logger.warn?.('[ClaudeAgent] Failed to log PostToolUse hook', { error });
        }
        return { continue: true };
      }
    ]
  };

  return {
    PreToolUse: [pre],
    PostToolUse: [post]
  };
};

const mergeHooks = (
  base: Options['hooks'] | undefined,
  extra: Options['hooks'] | undefined
): Options['hooks'] | undefined => {
  if (!base) return extra;
  if (!extra) return base;

  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  const assign = (source: Options['hooks'] | undefined) => {
    if (!source) return;
    for (const [event, matchers] of Object.entries(source)) {
      if (!matchers?.length) continue;
      const hookEvent = event as HookEvent;
      const list = merged[hookEvent] ?? [];
      list.push(...matchers);
      merged[hookEvent] = list;
    }
  };

  assign(base);
  assign(extra);
  return merged;
};

const logSdkMessage = (message: SDKMessage, logger?: ConsoleLike): void => {
  if (!logger) return;

  const basePayload: Record<string, unknown> = {
    type: message.type,
    sessionId: (message as { session_id?: string }).session_id,
    uuid: (message as { uuid?: string }).uuid
  };

  if (message.type === 'assistant') {
    const assistantMessage = message as SDKAssistantMessage;
    const preview = extractTextBlocks(assistantMessage);
    logger.debug?.('[ClaudeAgent] Assistant message', {
      ...basePayload,
      parentToolUseId: assistantMessage.parent_tool_use_id,
      preview: preview ? truncateForLog(preview, 300) : undefined,
      usage: assistantMessage.message?.usage
    });
    return;
  }

  if (message.type === 'user') {
    logger.debug?.('[ClaudeAgent] User message received', basePayload);
    return;
  }

  if (message.type === 'result') {
    const resultMessage = message as SDKResultMessage;
    logger.debug?.('[ClaudeAgent] Result message', {
      ...basePayload,
      subtype: resultMessage.subtype,
      isError: resultMessage.is_error,
      durationMs: resultMessage.duration_ms,
      apiDurationMs: resultMessage.duration_api_ms,
      totalCostUsd: resultMessage.total_cost_usd,
      usage: resultMessage.usage,
      result: truncateForLog(getResultString(resultMessage), 300) || undefined
    });
    return;
  }

  if (message.type === 'stream_event') {
    logger.debug?.('[ClaudeAgent] Stream event', {
      ...basePayload,
      eventType: (message as { event?: { type?: string } }).event?.type
    });
    return;
  }

  if (message.type === 'system') {
    const systemMessage = message as SDKSystemMessage;

    logger.debug?.('[ClaudeAgent] System message', {
      ...basePayload,
      tools: systemMessage.tools,
      mcpServers: systemMessage.mcp_servers
    });
    return;
  }

  logger.debug?.('[ClaudeAgent] Message', basePayload);
};

export async function runClaudeAgent(params: RunClaudeAgentParams): Promise<ClaudeAgentResult> {
  const { prompt, systemPrompt, logger, options, resumeSessionId } = params;

  if (!prompt.trim()) {
    throw new Error('Claude Agent prompt must not be empty.');
  }
  
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured. Set it to call the Claude Agent SDK.');
  }

  const toolTimers = new Map<string, { tool: string; startedAt: number }>();

  const mergedOptions: Options = {
    cwd: process.cwd(),
    model: DEFAULT_MODEL,
    settingSources: ['project'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPrompt
    },
    includePartialMessages: false,
    ...options
  };

  if (!mergedOptions.permissionMode) {
    mergedOptions.permissionMode = 'bypassPermissions';
  }

  if (resumeSessionId && !mergedOptions.resume) {
    mergedOptions.resume = resumeSessionId;
  }

  if (!mergedOptions.settingSources || mergedOptions.settingSources.length === 0) {
    mergedOptions.settingSources = ['project'];
  }

  if (!mergedOptions.systemPrompt) {
    mergedOptions.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: systemPrompt
    };
  }

  const loggingHooks = createLoggingHooks(logger, toolTimers);
  mergedOptions.hooks = mergeHooks(loggingHooks, options?.hooks);

  logger?.debug?.('[ClaudeAgent] Invoking claude-agent-sdk', {
    model: mergedOptions.model,
    cwd: mergedOptions.cwd,
    settingSources: mergedOptions.settingSources
  });

  const session = query({ prompt, options: mergedOptions });
  let finalResult = '';
  let lastAssistantText = '';
  let resolvedSessionId: string | undefined;

  for await (const message of session) {
    logSdkMessage(message, logger);

    if (message.type === 'system') {
      const systemMessage = message as SDKSystemMessage;
      resolvedSessionId = systemMessage.session_id ?? resolvedSessionId;
    }

    if (isAssistantMessage(message)) {
      lastAssistantText = extractTextBlocks(message) || lastAssistantText;
      continue;
    }

    if (isResultMessage(message)) {
      if (message.subtype !== 'success' || message.is_error) {
        const reason = summarizeResultError(message);
        const failureResult = getResultString(message);
        logger?.error?.('[ClaudeAgent] Query failed', {
          result: failureResult,
          subtype: message.subtype,
          isError: message.is_error,
          permissionDenials: message.permission_denials
        });
        throw new Error(`Claude Agent run failed: ${reason}`);
      }
      finalResult = getResultString(message)?.trim() ?? '';
    }
  }

  if (!finalResult) {
    finalResult = lastAssistantText.trim();
  }

  if (!finalResult) {
    throw new Error('Claude Agent did not return any content.');
  }

  logger?.debug?.('[ClaudeAgent] Completed invocation');
  return { result: finalResult, sessionId: resolvedSessionId ?? resumeSessionId };
}
