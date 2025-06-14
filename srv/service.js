// srv/service.js (Erweitert mit Brave Search Integration)

import cds from '@sap/cds';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { initAllMCPClients, closeMCPClients } from './lib/mcp-client.js';
import MarkdownConverter from './utils/markdown-converter.js';

export default class StammtischService extends cds.ApplicationService {
  async init() {
    await super.init();
    let agentExecutor = null;
    let mcpClients = null;

    const initializeAgent = async () => {
      if (agentExecutor) return agentExecutor;

      console.log("Initializing Agent with PostgreSQL and Brave Search capabilities...");

      try {
        // Initialisiere alle MCP Clients
        mcpClients = await initAllMCPClients();

        // Lade Tools von beiden MCP Clients
        const [postgresTools, braveSearchTools] = await Promise.all([
          loadMcpTools("query", mcpClients.postgres),
          loadMcpTools("brave_web_search,brave_local_search", mcpClients.braveSearch)
        ]);

        // Kombiniere alle Tools
        const allTools = [...postgresTools, ...braveSearchTools];

        console.log(`✅ Loaded ${postgresTools.length} PostgreSQL tools and ${braveSearchTools.length} Brave Search tools`);
        console.log("Available tools:", allTools.map(tool => tool.name));

        const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
        const checkpointer = new MemorySaver();

        agentExecutor = createReactAgent({
          llm,
          tools: allTools,
          checkpointSaver: checkpointer
        });

        console.log("✅ Multi-Modal Agent is ready (Database + Web Search).");
        return agentExecutor;

      } catch (error) {
        console.error("❌ Failed to initialize agent:", error);
        throw error;
      }
    };

    await initializeAgent();

    this.on('callLLM', async (req) => {
      const { prompt: userPrompt } = req.data;
      if (!userPrompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      console.log('🚀 Received prompt for Multi-Modal Agent:', userPrompt);
      const executor = await initializeAgent();

      try {
        const systemMessage = {
          role: "system",
          content: `You are a helpful assistant with access to both database queries and web search capabilities.

                  DATABASE ACCESS:
                  - You can query a PostgreSQL database using the 'query' tool
                  - IMPORTANT: Use PostgreSQL syntax, NOT MySQL syntax
                  - To list tables: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
                  - The 'query' tool expects JSON input with a single key "sql"

                  WEB SEARCH ACCESS:
                  - You can search the web using 'brave_web_search' for general information
                  - You can search for local businesses using 'brave_local_search'
                  - Use web search when the user asks about current events, external information, or topics not in the database

                  RESPONSE GUIDELINES:
                  - First determine if the user needs database information, web information, or both
                  - For database queries, always explain what you're looking for before querying
                  - For web searches, summarize the key findings clearly
                  - If combining both sources, clearly distinguish between database results and web search results
                  - Always provide context about where information is coming from`
        };

        const userMessage = {
          role: "user",
          content: userPrompt
        };

        const result = await executor.invoke(
          {
            messages: [systemMessage, userMessage]
          },
          {
            configurable: { thread_id: `session_${Date.now()}` }
          }
        );

        const lastMessage = result.messages[result.messages.length - 1];
        const rawResponse = lastMessage.content;

        console.log("📝 Raw AI Response:", rawResponse);

        // Konvertiere zu formatiertem HTML
        const htmlResponse = MarkdownConverter.convertForStammtischAI(rawResponse);
        console.log("🎨 Formatted HTML Response:", htmlResponse);

        return { response: htmlResponse };

      } catch (error) {
        console.error('💥 Error during agent execution:', error);
        req.error(500, `Failed to process query: ${error.message}`);
      }
    });

    // Graceful shutdown
    this.on('EXIT', async () => {
      console.log('Shutting down MCP clients...');
      await closeMCPClients();
    });
  }
}