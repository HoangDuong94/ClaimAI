import type { AgentAdapter, AgentCallOptions, AgentCallResult } from './agent-adapter.js';
import MarkdownConverter from '../utils/markdown-converter.js';
import { runClaudeAgent } from '../lib/claude-agent.js';
import type { initAllMCPClients } from '../lib/mcp-client.js';

type MCPClients = Awaited<ReturnType<typeof initAllMCPClients>>;

interface ClaudeAdapterDependencies {
  ensureMcpClients: () => Promise<MCPClients>;
  claudeSessions: Map<string, string>;
  systemPrompt: string;
  logger?: Console;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  private readonly ensureMcpClients: () => Promise<MCPClients>;
  private readonly claudeSessions: Map<string, string>;
  private readonly systemPrompt: string;
  private readonly logger: Console;

  constructor(deps: ClaudeAdapterDependencies) {
    this.ensureMcpClients = deps.ensureMcpClients;
    this.claudeSessions = deps.claudeSessions;
    this.systemPrompt = deps.systemPrompt;
    this.logger = deps.logger ?? console;
  }

  async call(options: AgentCallOptions): Promise<AgentCallResult> {
    const { prompt, userId, capContext } = options;
    if (!capContext) {
      throw new Error('capContext is required for Claude agent execution.');
    }

    const clients = await this.ensureMcpClients();
    if (!clients?.cap) {
      throw new Error('CAP MCP client is not initialized.');
    }

    const capServerConfig = clients.cap.sdkServer ? { cap: clients.cap.sdkServer } : undefined;
    const capAllowedTools = Array.isArray(clients.cap.toolDefinitions)
      ? clients.cap.toolDefinitions.map((tool: { name: string }) => `mcp__cap__${tool.name}`)
      : undefined;

    const resumeSessionId = this.claudeSessions.get(userId);

    const agentResult = await clients.cap.runWithContext(capContext, async () =>
      runClaudeAgent({
        prompt,
        systemPrompt: this.systemPrompt,
        logger: this.logger,
        resumeSessionId,
        options: {
          ...(capServerConfig ? { mcpServers: capServerConfig } : {}),
          ...(capAllowedTools?.length ? { allowedTools: capAllowedTools } : {})
        }
      })
    );

    if (agentResult.sessionId) {
      this.claudeSessions.set(userId, agentResult.sessionId);
    }

    const response = MarkdownConverter.convertForClaims(agentResult.result);
    return { response };
  }
}
