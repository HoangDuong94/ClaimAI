import path from 'node:path';
import MarkdownConverter from '../utils/markdown-converter.js';
import { CodexAgent } from '../lib/codex-agent.js';
import type { AgentAdapter, AgentCallOptions, AgentCallResult } from './agent-adapter.js';
import type { CodexOptions, SandboxMode, ThreadItem, ThreadOptions } from '@openai/codex-sdk';

interface CodexAdapterDependencies {
  logger?: Console;
}

export class CodexAgentAdapter implements AgentAdapter {
  private readonly logger: Console;
  private codexAgent: CodexAgent | null = null;

  constructor(deps: CodexAdapterDependencies = {}) {
    this.logger = deps.logger ?? console;
  }

  async call(options: AgentCallOptions): Promise<AgentCallResult> {
    const { prompt, userId } = options;
    const agent = this.ensureCodexAgent();
    this.logger.log('🤖 Invoking Codex SDK for prompt');

    const result = await agent.run(userId, prompt, {
      threadOptions: this.buildCodexThreadOptions(),
    });

    if (result.usage) {
      this.logger.debug?.('[CodexAgent] Token usage', result.usage);
    }

    const rawResponse =
      (result.finalResponse && result.finalResponse.trim().length > 0
        ? result.finalResponse
        : this.extractCodexAgentMessage(result.items)) ?? '';

    const normalizedResponse =
      rawResponse.trim().length > 0 ? rawResponse : 'Keine Antwort vom Codex-Agenten erhalten.';

    return { response: MarkdownConverter.convertForClaims(normalizedResponse) };
  }

  private ensureCodexAgent(): CodexAgent {
    if (this.codexAgent) return this.codexAgent;

    const apiKey = (process.env.CODEX_API_KEY || '').trim();
    const baseUrl = (process.env.CODEX_BASE_URL || '').trim();
    const codexExecutable = (process.env.CODEX_EXECUTABLE || '').trim();

    const codexOptions: CodexOptions = {};
    if (apiKey) {
      codexOptions.apiKey = apiKey;
    } else {
      this.logger.log(
        '[CodexAgent] CODEX_API_KEY not set; falling back to Codex CLI cached credentials if available.',
      );
    }
    if (baseUrl) {
      codexOptions.baseUrl = baseUrl;
    }
    if (codexExecutable) {
      codexOptions.codexPathOverride = codexExecutable;
    }

    this.codexAgent = new CodexAgent({
      logger: this.logger,
      codexOptions,
      defaultThreadOptions: this.buildCodexThreadOptions(),
    });

    this.logger.log('[CodexAgent] Codex SDK initialized.');
    return this.codexAgent;
  }

  private resolveCodexSandboxMode(): SandboxMode {
    const value = (process.env.CODEX_SANDBOX_MODE || '').trim().toLowerCase();
    switch (value) {
      case '':
        return 'workspace-write';
      case 'read-only':
      case 'workspace-write':
      case 'danger-full-access':
        return value;
      default:
        this.logger.warn?.(
          `[CodexAgent] Unsupported CODEX_SANDBOX_MODE "${value}", falling back to workspace-write.`,
        );
        return 'workspace-write';
    }
  }

  private resolveCodexWorkingDirectory(): string {
    const raw =
      (process.env.CODEX_WORKING_DIRECTORY || process.env.CODEX_WORKING_DIR || '').trim();
    if (!raw) {
      return process.cwd();
    }
    return path.resolve(raw);
  }

  private shouldSkipCodexGitCheck(): boolean {
    const raw =
      (process.env.CODEX_SKIP_GIT_CHECK || process.env.CODEX_SKIP_GIT_REPO_CHECK || '')
        .trim()
        .toLowerCase();
    if (!raw) return true;
    if (['false', '0', 'no'].includes(raw)) return false;
    return true;
  }

  private buildCodexThreadOptions(): ThreadOptions {
    const options: ThreadOptions = {
      sandboxMode: this.resolveCodexSandboxMode(),
      workingDirectory: this.resolveCodexWorkingDirectory(),
      skipGitRepoCheck: this.shouldSkipCodexGitCheck(),
    };
    const model = (process.env.CODEX_MODEL || '').trim();
    if (model) {
      options.model = model;
    }
    return options;
  }

  private extractCodexAgentMessage(items: ThreadItem[]): string | null {
    for (const item of items) {
      if (item && item.type === 'agent_message') {
        const candidate = (item as { text?: unknown }).text;
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          return candidate;
        }
      }
    }
    return null;
  }

  async shutdown(): Promise<void> {
    this.codexAgent?.clearAllSessions();
  }
}
