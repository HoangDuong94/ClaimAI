// srv/service.js (Erweitert mit Streaming-Logik)

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

      console.log("Initializing Agent with PostgreSQL, Brave Search and Playwright capabilities...");

      try {
        // Initialisiere alle MCP Clients
        mcpClients = await initAllMCPClients();

        // Lade Tools von allen MCP Clients
        const [postgresTools, braveSearchTools, playwrightTools] = await Promise.all([
          loadMcpTools("query", mcpClients.postgres),
          loadMcpTools("brave_web_search,brave_local_search", mcpClients.braveSearch),
          loadMcpTools("take_screenshot,goto_page,click_element,fill_input,execute_javascript,get_page_content,wait_for_element,generate_test_code", mcpClients.playwright)
        ]);

        // Kombiniere alle Tools
        const allTools = [...postgresTools, ...braveSearchTools, ...playwrightTools];

        console.log(`✅ Loaded ${postgresTools.length} PostgreSQL tools, ${braveSearchTools.length} Brave Search tools, and ${playwrightTools.length} Playwright tools`);
        console.log("Available tools:", allTools.map(tool => tool.name));

        const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
        const checkpointer = new MemorySaver();

        agentExecutor = createReactAgent({
          llm,
          tools: allTools,
          checkpointSaver: checkpointer
        });

        console.log("✅ Multi-Modal Agent is ready (Database + Web Search + Browser Automation).");
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
          content: `You are a helpful assistant with access to database queries, web search, and browser automation capabilities.

                  DATABASE ACCESS:
                  - You can query a PostgreSQL database using the 'query' tool
                  - IMPORTANT: Use PostgreSQL syntax, NOT MySQL syntax
                  - To list tables: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
                  - The 'query' tool expects JSON input with a single key "sql"

                  WEB SEARCH ACCESS:
                  - You can search the web using 'brave_web_search' for general information
                  - You can search for local businesses using 'brave_local_search'
                  - Use web search when the user asks about current events, external information, or topics not in the database

                  BROWSER AUTOMATION ACCESS (Playwright):
                  - take_screenshot: Capture screenshots of web pages for visual verification
                  - goto_page: Navigate to a specific URL (e.g., your Fiori Elements app)
                  - click_element: Click on buttons, links, or other interactive elements
                  - fill_input: Fill in form fields with data
                  - execute_javascript: Run custom JavaScript on the page
                  - get_page_content: Extract text content from pages
                  - wait_for_element: Wait for specific elements to appear before proceeding
                  - generate_test_code: Generate automated test scripts for repetitive tasks

                  TESTING FIORI ELEMENTS WORKLIST APPS:
                  - To test your Fiori Elements Worklist app, start by navigating to the app URL
                  - Take screenshots to verify the current state
                  - Use click_element to interact with buttons like "Create", "Edit", "Delete"
                  - Use fill_input to populate form fields when creating or editing entries
                  - Use wait_for_element to ensure elements are loaded before interacting
                  - Common Fiori Elements selectors:
                    * Create button: Often has ID like "fe::table::_Table::StandardAction::Create"
                    * Save button: Usually "fe::FooterBar::StandardAction::Save"
                    * Input fields: Often have IDs like "fe::FormContainer::FieldGroup::SectionId::FieldId"

                  RESPONSE GUIDELINES:
                  - First determine if the user needs database information, web information, browser automation, or a combination
                  - For database queries, always explain what you're looking for before querying
                  - For web searches, summarize the key findings clearly
                  - For browser automation, describe each step you're taking and take screenshots to show progress
                  - When testing Fiori apps, provide detailed feedback about what was accomplished
                  - If combining multiple sources, clearly distinguish between database results, web search results, and browser automation results
                  - Always provide context about where information is coming from`
        };

        const userMessage = {
          role: "user",
          content: userPrompt
        };
        
        // --- START: Streaming Implementation ---

        // 1. Verwende .stream() statt .invoke() für einen asynchronen Stream
        const stream = await executor.stream(
          {
            messages: [systemMessage, userMessage]
          },
          {
            configurable: { thread_id: `session_test}` }
          }
        );

        // Array zum Sammeln der finalen KI-Antwort für den Client
        const finalResponseParts = [];
        console.log("\n\n---- AGENT STREAM START ----\n");

        // 2. Iteriere durch den Stream, um jeden Schritt (Chunk) zu verarbeiten
        for await (const chunk of stream) {
          // Jeder Chunk ist ein Objekt, dessen Schlüssel der Name des Graph-Knotens ist

          // Prüfen, ob der Chunk vom 'agent'-Knoten kommt (die KI antwortet oder ruft ein Tool auf)
          if (chunk.agent?.messages) {
            const message = chunk.agent.messages[chunk.agent.messages.length - 1];
            
            // Logge den Text-Teil der KI-Antwort in Echtzeit
            if (message && message.content) {
              process.stdout.write(message.content); // Direkte Ausgabe in die Konsole
              finalResponseParts.push(message.content); // Sammle den Teil für die finale Antwort
            }

            // Logge Tool-Aufrufe, sobald der Agent sie plant
            if (message.tool_calls && message.tool_calls.length > 0) {
              const toolCall = message.tool_calls[0];
              const toolCallStr = `\n\n<TOOL_CALL>\n  Tool: ${toolCall.name}\n  Args: ${JSON.stringify(toolCall.args)}\n</TOOL_CALL>\n\n`;
              process.stdout.write(toolCallStr);
            }
          }

          // Prüfen, ob der Chunk vom 'tools'-Knoten kommt (Ergebnis eines Tool-Aufrufs)
          if (chunk.tools?.messages) {
             const toolMessage = chunk.tools.messages[0];
             const toolOutputStr = `<TOOL_OUTPUT>\n  ${toolMessage.content}\n</TOOL_OUTPUT>\n\n`;
             process.stdout.write(toolOutputStr);
          }
        }
        console.log("\n---- AGENT STREAM END ----\n");

        // 3. Setze die finale Antwort aus den gesammelten Teilen zusammen
        const rawResponse = finalResponseParts.join("");

        // --- END: Streaming Implementation ---
        
        // Konvertiere zu formatiertem HTML für die Rückgabe an den Client
        const htmlResponse = MarkdownConverter.convertForStammtischAI(rawResponse);

        return { response: htmlResponse };

      } catch (error) {
        console.error('💥 Error during agent execution:', error);
        req.error(500, `Failed to process query: ${error.message}`);
      }
    });

    this.on('EXIT', async () => {
      console.log('Shutting down MCP clients...');
      await closeMCPClients();
    });
  }
}