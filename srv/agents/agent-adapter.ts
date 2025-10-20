import type { CapRequestContext } from '../types/cap-context.js';

export interface AgentCallOptions {
  prompt: string;
  userId: string;
  capContext?: Record<string, unknown>;
  request: CapRequestContext;
}

export interface AgentCallResult {
  response: string;
  // UIResource shape matches mcp-ui resource; we keep it untyped here to avoid SDK coupling
  uiResource?: { uri?: string; mimeType?: string; text?: string; blob?: string | null; [k: string]: unknown } | null;
}

export interface AgentAdapter {
  call(options: AgentCallOptions): Promise<AgentCallResult>;
  warmup?(): Promise<void>;
  shutdown?(): Promise<void>;
}
