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

      // +++ ERWEITERT: Log-Nachricht angepasst +++
      console.log("Initializing Agent with Database, Web Search, Browser and Filesystem capabilities...");

      try {
        mcpClients = await initAllMCPClients();

        // +++ ERWEITERT: Lade Tools vom neuen Filesystem Client +++
        const [postgresTools, braveSearchTools, playwrightTools, filesystemTools] = await Promise.all([
          loadMcpTools("query", mcpClients.postgres),
          loadMcpTools("brave_web_search,brave_local_search", mcpClients.braveSearch),
          loadMcpTools("take_screenshot,goto_page,click_element,fill_input,execute_javascript,get_page_content,wait_for_element,generate_test_code", mcpClients.playwright),
          // Lade alle verfügbaren Filesystem-Tools
          loadMcpTools("read_file,write_file,edit_file,create_directory,list_directory,move_file,search_files,get_file_info,list_allowed_directories", mcpClients.filesystem)
        ]);

        // Kombiniere alle Tools
        const allTools = [...postgresTools, ...braveSearchTools, ...playwrightTools, ...filesystemTools];

        // +++ ERWEITERT: Log-Nachricht angepasst +++
        console.log(`✅ Loaded ${postgresTools.length} PostgreSQL, ${braveSearchTools.length} Brave Search, ${playwrightTools.length} Playwright, and ${filesystemTools.length} Filesystem tools`);
        console.log("Available tools:", allTools.map(tool => tool.name));

        const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
        const checkpointer = new MemorySaver();

        agentExecutor = createReactAgent({
          llm,
          tools: allTools,
          checkpointSaver: checkpointer
        });

        console.log("✅ Multi-Modal Agent is ready (Database + Web Search + Browser Automation + Filesystem).");
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
          // +++ ERWEITERT: System-Prompt mit Anweisungen für den Dateizugriff +++
          content: `You are a helpful assistant with access to database queries, web search, browser automation, and local filesystem capabilities.

                  DATABASE ACCESS:
                  - You can query a PostgreSQL database using the 'query' tool.
                  - IMPORTANT: Use PostgreSQL syntax.
                  - To list tables: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
                  - The 'query' tool expects JSON input with a single key "sql".

                  WEB SEARCH ACCESS:
                  - You can search the web using 'brave_web_search' for general information.
                  - Use web search when the user asks about current events or topics not in the database.

                  BROWSER AUTOMATION ACCESS (Playwright):
                  - You can control a web browser to perform tasks like testing web applications.
                  - Available tools: take_screenshot, goto_page, click_element, fill_input, get_page_content.
                  - When testing Fiori apps, provide detailed feedback and take screenshots.

                  FILESYSTEM ACCESS:
                  - You can read, write, and manage files and directories in the project.
                  - Available tools: read_file, write_file, edit_file, create_directory, list_directory, search_files.
                  - SECURITY: You can ONLY operate within the allowed project directory. Do not try to access paths like '/' or '~'.
                  - Use 'list_directory' with '.' or a subdirectory to see available files first.
                  - For 'write_file', be cautious as it can overwrite existing files. Confirm with the user if unsure.
                  - For 'edit_file', it's a powerful tool for complex changes. ALWAYS use 'dryRun: true' first to preview the changes and get a diff. Only after confirming the diff is correct, run it again with 'dryRun: false'.

                  RESPONSE GUIDELINES:
                  - First, determine which tool or combination of tools is best for the user's request.
                  - Clearly explain your plan before executing it.
                  - For filesystem operations, state which file you are reading, writing, or listing.
                  - Combine information from different sources clearly, distinguishing between database results, web content, and file content.
                  - Always provide context about where information is coming from.`
        };

        const userMessage = {
          role: "user",
          content: userPrompt
        };
        
        const stream = await executor.stream(
          {
            messages: [systemMessage, userMessage]
          },
          {
            configurable: { thread_id: `session_test}` }
          }
        );

        const finalResponseParts = [];
        console.log("\n\n---- AGENT STREAM START ----\n");

        for await (const chunk of stream) {
          if (chunk.agent?.messages) {
            const message = chunk.agent.messages[chunk.agent.messages.length - 1];
            if (message && message.content) {
              process.stdout.write(message.content);
              finalResponseParts.push(message.content);
            }
            if (message.tool_calls && message.tool_calls.length > 0) {
              const toolCall = message.tool_calls[0];
              const toolCallStr = `\n\n<TOOL_CALL>\n  Tool: ${toolCall.name}\n  Args: ${JSON.stringify(toolCall.args)}\n</TOOL_CALL>\n\n`;
              process.stdout.write(toolCallStr);
            }
          }

          if (chunk.tools?.messages) {
             const toolMessage = chunk.tools.messages[0];
             const toolOutputStr = `<TOOL_OUTPUT>\n  ${toolMessage.content}\n</TOOL_OUTPUT>\n\n`;
             process.stdout.write(toolOutputStr);
          }
        }
        console.log("\n---- AGENT STREAM END ----\n");

        const rawResponse = finalResponseParts.join("");
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