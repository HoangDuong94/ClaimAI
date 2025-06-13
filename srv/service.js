// srv/service.js (FINALE VERSION, mit Markdown-Formatierung)

import cds from '@sap/cds';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { initMCPClient } from './lib/mcp-client.js';

// Importiere deinen MarkdownConverter
import MarkdownConverter from './utils/markdown-converter.js';

export default class StammtischService extends cds.ApplicationService {
  async init() {
    await super.init();
    let agentExecutor = null;

    const initializeAgent = async () => {
      if (agentExecutor) return agentExecutor;

      console.log("Initializing Agent (langgraph version)...");

      const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4o' });
      const mcpClient = await initMCPClient();
      const tools = await loadMcpTools("query", mcpClient);
      
      agentExecutor = createReactAgent({ llm, tools });

      console.log("✅ Langgraph Agent is ready.");
      return agentExecutor;
    };

    await initializeAgent();

    this.on('callLLM', async (req) => {
      const { prompt: userPrompt } = req.data;
      if (!userPrompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      console.log('🚀 Received prompt for Agent:', userPrompt);
      const executor = await initializeAgent();

      try {
        const systemMessage = {
          role: "system",
          content: `You are a helpful assistant that can explore PostgreSQL databases using SQL queries.
IMPORTANT: You MUST use PostgreSQL syntax. Do NOT use MySQL syntax like 'SHOW TABLES'.
To list tables, use: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
The 'query' tool expects the input to be a JSON object with a single key "sql".`
        };

        const userMessage = {
          role: "user",
          content: userPrompt
        };

        const result = await executor.invoke({
          messages: [systemMessage, userMessage]
        });
        
        const lastMessage = result.messages[result.messages.length - 1];
        
        // --- ANPASSUNG HIER ---
        // Nimm die rohe Antwort des Agenten
        const rawResponse = lastMessage.content;
        console.log("📝 Raw AI Response:", rawResponse);

        // Konvertiere sie in formatiertes HTML
        const htmlResponse = MarkdownConverter.convertForStammtischAI(rawResponse);
        console.log("🎨 Formatted HTML Response:", htmlResponse);

        // Gib die formatierte Antwort zurück
        return { response: htmlResponse };
        // --- ENDE DER ANPASSUNG ---

      } catch (error) {
        console.error('💥 Error during agent execution:', error);
        req.error(500, `Failed to process query: ${error.message}`);
      }
    });
  }
}