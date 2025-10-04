// srv/m365-mcp/index.ts
// Entry point for the Microsoft 365 in-process MCP client.

import { createM365ToolManifest, toolDefinitions } from './mcp-tool-manifest.js';
import { GraphClient, type GraphClientOptions } from './graph-client.js';
import { getToolHandler, listSupportedTools } from './tools/index.js';
import { safeJson } from './helpers/logging.js';

type LoggerLike = Console | { error?: (...args: unknown[]) => void; log?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };

interface InitOptions extends GraphClientOptions {
  bootstrapScopes?: string[];
  logger?: LoggerLike;
}

interface ToolInvocation {
  name: string;
  arguments?: Record<string, unknown>;
}

export async function initM365InProcessClient(options: InitOptions = {}) {
  const {
    logger = console,
    bootstrapScopes = ['Mail.Read']
  } = options;

  const graphClient = new GraphClient({ ...options, logger });
  await graphClient.bootstrap(bootstrapScopes);

  async function listTools() {
    return createM365ToolManifest();
  }

  async function callTool({ name, arguments: args = {} }: ToolInvocation) {
    if (!name) {
      throw new Error('Tool name is required');
    }
    const handler = getToolHandler(name);
    if (!handler) {
      throw new Error(`Unknown Microsoft 365 tool: ${name}. Supported tools: ${listSupportedTools().join(', ')}`);
    }
    const input = args && typeof args === 'object' ? args : {};
    try {
      const result = await handler({ input, graphClient, logger });
      return result;
    } catch (error) {
      const err = error as Error & { message?: string };
      logger.error?.(`Error while executing Microsoft 365 tool ${name}:`, safeJson(err.message || err));
      throw err;
    }
  }

  async function close() {
    await graphClient.close();
  }

  return {
    listTools,
    callTool,
    close,
    toolDefinitions
  };
}
