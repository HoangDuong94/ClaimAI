// @ts-nocheck
// srv/m365-mcp/index.js
// Entry point for the Microsoft 365 in-process MCP client.

import { createM365ToolManifest, toolDefinitions } from './mcp-tool-manifest.js';
import { GraphClient } from './graph-client.js';
import { getToolHandler, listSupportedTools } from './tools/index.js';
import { safeJson } from './helpers/logging.js';

export async function initM365InProcessClient(options = {}) {
  const {
    logger = console,
    bootstrapScopes = ['Mail.Read']
  } = options;

  const graphClient = new GraphClient({ ...options, logger });
  await graphClient.bootstrap(bootstrapScopes);

  async function listTools() {
    return createM365ToolManifest();
  }

  async function callTool({ name, arguments: args = {} }) {
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
      logger.error?.(`Error while executing Microsoft 365 tool ${name}:`, safeJson(error.message || error));
      throw error;
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
