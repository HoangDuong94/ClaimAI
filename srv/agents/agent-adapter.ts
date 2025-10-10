import type { CapRequestContext } from '../types/cap-context.js';

export interface AgentCallOptions {
  prompt: string;
  userId: string;
  capContext?: Record<string, unknown>;
  request: CapRequestContext;
}

export interface AgentAdapter {
  call(options: AgentCallOptions): Promise<string>;
  warmup?(): Promise<void>;
  shutdown?(): Promise<void>;
}
