import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage
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

export async function runClaudeAgent(params: RunClaudeAgentParams): Promise<string> {
  const { prompt, systemPrompt, logger, options } = params;

  if (!prompt.trim()) {
    throw new Error('Claude Agent prompt must not be empty.');
  }
  
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured. Set it to call the Claude Agent SDK.');
  }

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

  logger?.debug?.('[ClaudeAgent] Invoking claude-agent-sdk', {
    model: mergedOptions.model,
    cwd: mergedOptions.cwd,
    settingSources: mergedOptions.settingSources
  });

  const session = query({ prompt, options: mergedOptions });
  let finalResult = '';
  let lastAssistantText = '';

  for await (const message of session) {
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
  return finalResult;
}
