import { Codex } from "@openai/codex-sdk";
import type {
  CodexOptions,
  RunResult,
  Thread,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";

type ConsoleLike = Pick<Console, "debug" | "info" | "warn" | "error" | "log">;

export type CodexAgentRunResult = RunResult;

export type CodexAgentRunOptions = {
  threadOptions?: ThreadOptions;
  turnOptions?: TurnOptions;
};

export type CodexAgentOptions = {
  logger?: ConsoleLike;
  codexOptions?: CodexOptions;
  defaultThreadOptions?: ThreadOptions;
};

export class CodexAgent {
  private readonly codex: Codex;
  private readonly threads = new Map<string, string>();
  private readonly logger: ConsoleLike;
  private readonly defaultThreadOptions: ThreadOptions;

  constructor(options: CodexAgentOptions = {}) {
    this.codex = new Codex(options.codexOptions ?? {});
    this.logger = options.logger ?? console;
    this.defaultThreadOptions = options.defaultThreadOptions ?? {};
  }

  async run(
    userId: string,
    prompt: string,
    options: CodexAgentRunOptions = {},
  ): Promise<CodexAgentRunResult> {
    const thread = this.getThread(userId, options.threadOptions);

    try {
      this.logger.debug?.("[CodexAgent] Running prompt", { userId });
      const result = await thread.run(prompt, options.turnOptions);
      if (thread.id) {
        this.threads.set(userId, thread.id);
      }
      return result;
    } catch (error) {
      this.logger.error?.("[CodexAgent] Execution failed", { userId, error });
      this.threads.delete(userId);
      throw error;
    }
  }

  clearSession(userId: string): void {
    this.threads.delete(userId);
  }

  clearAllSessions(): void {
    this.threads.clear();
  }

  private getThread(userId: string, threadOptions?: ThreadOptions): Thread {
    const currentThreadId = this.threads.get(userId);
    const options = threadOptions ?? this.defaultThreadOptions;

    if (currentThreadId) {
      this.logger.debug?.("[CodexAgent] Resuming thread", { userId, threadId: currentThreadId });
      return this.codex.resumeThread(currentThreadId, options);
    }

    this.logger.debug?.("[CodexAgent] Starting new thread", { userId });
    return this.codex.startThread(options);
  }
}
