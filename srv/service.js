// srv/StammtischService.js

import cds from '@sap/cds';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { initAllMCPClients, closeMCPClients } from './lib/mcp-client.js';
import { jsonSchemaToZod } from './m365-mcp/mcp-jsonschema.js';
import MarkdownConverter from './utils/markdown-converter.js';

export default class StammtischService extends cds.ApplicationService {
  async init() {
    await super.init();
    let agentExecutor = null;
    let mcpClients = null;

    const initializeAgent = async () => {
      if (agentExecutor) return agentExecutor;

      // +++ ERWEITERT: Log-Nachricht angepasst +++
      console.log("Initializing Agent with Database, Web Search, Browser, Filesystem, Excel, Microsoft 365, and Time capabilities...");

      try {
        mcpClients = await initAllMCPClients();

        // +++ ERWEITERT: Lade Tools vom neuen Excel Client +++
        const [postgresTools, braveSearchTools, playwrightTools, filesystemTools, excelTools, timeTools] = await Promise.all([
          loadMcpTools("query", mcpClients.postgres),
          loadMcpTools("brave_web_search,brave_local_search", mcpClients.braveSearch),
          loadMcpTools("take_screenshot,goto_page,click_element,fill_input,execute_javascript,get_page_content,wait_for_element,generate_test_code", mcpClients.playwright),
          loadMcpTools("read_file,write_file,edit_file,create_directory,list_directory,move_file,search_files,get_file_info,list_allowed_directories", mcpClients.filesystem),
          // +++ NEU: Lade alle verfügbaren Excel-Tools +++
          loadMcpTools("excel_describe_sheets,excel_read_sheet,excel_screen_capture,excel_write_to_sheet,excel_create_table,excel_copy_sheet", mcpClients.excel),
          loadMcpTools("get_current_time,convert_time", mcpClients.time)
        ]);

        // Kombiniere alle Tools
        const allTools = [...postgresTools, ...braveSearchTools, ...playwrightTools, ...filesystemTools, ...excelTools, ...timeTools];

        // Lade Microsoft 365 Tools dynamisch aus dem Manifest
        if (mcpClients.m365) {
          console.log("Loading Microsoft 365 tools...");
          const manifest = await mcpClients.m365.listTools();
          const m365Tools = manifest.tools.map((toolDef) => {
            const schema = jsonSchemaToZod(toolDef.inputSchema, z);
            return new DynamicStructuredTool({
              name: toolDef.name,
              description: toolDef.description,
              schema,
              func: async (input) => {
                const result = await mcpClients.m365.callTool({ name: toolDef.name, arguments: input });
                return typeof result === 'string' ? result : JSON.stringify(result);
              }
            });
          });
          allTools.push(...m365Tools);
          console.log(`✅ Loaded ${m365Tools.length} Microsoft 365 tools`);
        }

        console.log(`✅ Loaded ${postgresTools.length} PostgreSQL, ${braveSearchTools.length} Brave Search, ${playwrightTools.length} Playwright, ${filesystemTools.length} Filesystem, ${excelTools.length} Excel, and ${timeTools.length} Time tools`);
        console.log("Available tools:", allTools.map(tool => tool.name));

        const llm = new AzureOpenAiChatClient({ modelName: 'gpt-5' });
        const checkpointer = new MemorySaver();

        agentExecutor = createReactAgent({
          llm,
          tools: allTools,
          checkpointSaver: checkpointer
        });
        
        // +++ ERWEITERT: Log-Nachricht angepasst +++
        console.log("✅ Multi-Modal Agent is ready (Database + Web Search + Browser + Filesystem + Excel + M365 + Time).");
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
          content: `You are a helpful assistant with access to database queries, web search, browser automation, local filesystem, and MS Excel capabilities.

                  DATABASE ACCESS:
                  - You can query a PostgreSQL database using the 'query' tool.
                  - IMPORTANT: Use PostgreSQL syntax.

                  WEB SEARCH ACCESS:
                  - You can search the web using 'brave_web_search'. 

                  BROWSER AUTOMATION ACCESS (Playwright):
                  - You can control a web browser to perform tasks like testing web applications.

                  FILESYSTEM ACCESS:
                  - You can read, write, and manage files and directories in the project.
                  - SECURITY: You can ONLY operate within the allowed project directory.
                  - Use 'list_directory' with '.' or a subdirectory to see available files first.
                  - For 'edit_file', ALWAYS use 'dryRun: true' first to preview changes.

                  EXCEL ACCESS:
                  - You can read from and write to MS Excel files (.xlsx, .xlsm, etc.).
                  - Available tools: excel_describe_sheets, excel_read_sheet, excel_write_to_sheet, excel_create_table, excel_copy_sheet, excel_screen_capture (Windows only).
                  - ALWAYS start by using 'excel_describe_sheets' to understand the file's structure (sheet names).
                  - For all Excel tools, you MUST provide the 'fileAbsolutePath' to the target Excel file.
                  - When reading large sheets, the tool uses pagination. Pay attention to the 'knownPagingRanges' argument to read subsequent parts.
                  - When writing with 'excel_write_to_sheet', you can create a new sheet by setting 'newSheet: true'. Be careful as writing can modify files permanently.

                  ANALYSIS & VISUALIZATION WORKFLOW:
                  - If the user asks for an "analysis", "report", or "visualization" of data, you MUST follow this specific workflow:
                  1.  **Query Data:** First, use the 'query' tool to retrieve the necessary data from the PostgreSQL database. If the user's request is ambiguous (e.g., "analyze the data"), ask clarifying questions to determine which tables and columns are relevant for the analysis.
                  2.  **Generate HTML File:** After successfully retrieving the data, you will generate a single, self-contained HTML file to present the analysis and visualization.
                      -   **Structure:** Create a well-structured HTML5 document.
                      -   **Styling:** Include some basic CSS in a <style> tag in the <head> for a clean and professional look (e.g., set a modern font, center content, add padding).
                      -   **Visualization Library:** You MUST use a JavaScript charting library like **Chart.js** to create professional-looking charts (e.g., bar charts, line charts, pie charts). Include the library via its CDN link in a <script> tag in the <head>. Example: <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
                      -   **Content:** The HTML body should contain:
                          -   A clear headline (<h1>) describing the analysis (e.g., "Analyse der monatlichen Umsätze").
                          -   A <canvas> element where the chart will be rendered.
                          -   A <script> block at the end of the body. Inside this script, you will:
                              a) Store the data retrieved from the database in a JavaScript variable.
                              b) Write the JavaScript code to initialize Chart.js and render the chart on the canvas, using the data.
                  3.  **Save the File:** Use the 'edit_file' tool to write the complete HTML code into a new file.
                  4.  **Report Back:** Finally, after the file has been successfully created, inform the user that the analysis is complete and provide the full, correct path to the generated HTML file so they can open it.

                  RESPONSE GUIDELINES:
                   - First, determine which tool or combination of tools is best for the user's request.
              - Clearly explain your plan before executing it.
              - Combine information from different sources clearly, distinguishing between database results, web content, file content, and Excel data.
              - Always provide context about where information is coming from.
                    `
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
