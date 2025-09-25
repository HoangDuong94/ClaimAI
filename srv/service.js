// srv/StammtischService.js

import cds from '@sap/cds';
import express from 'express';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { initAllMCPClients, closeMCPClients } from './lib/mcp-client.js';
import { jsonSchemaToZod } from './m365-mcp/mcp-jsonschema.js';
import { GraphClient } from './m365-mcp/graph-client.js';
import MarkdownConverter from './utils/markdown-converter.js';

export default class StammtischService extends cds.ApplicationService {
  async init() {
    await super.init();
    let agentExecutor = null;
    let mcpClients = null;
    const app = cds.app;

    // Lightweight in-memory notification hub (per-user)
    const notificationSessions = new Map(); // userId -> { clients:Set<Response>, buffer:[], knownIds:Set<string>, timer:NodeJS.Timer|null }

    const getUserId = (req) => {
      try {
        return (req.user && (req.user.id || req.user.name)) || 'local';
      } catch {
        return 'local';
      }
    };

    const sseSend = (res, payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const broadcastToUser = (userId, payload) => {
      const session = notificationSessions.get(userId);
      if (!session) return;
      for (const client of session.clients) {
        try { sseSend(client, payload); } catch { /* ignore */ }
      }
    };

    const ensureSession = (userId) => {
      if (!notificationSessions.has(userId)) {
        notificationSessions.set(userId, {
          clients: new Set(),
          buffer: [],
          knownIds: new Set(),
          summaries: new Map(),
          timer: null
        });
      }
      return notificationSessions.get(userId);
    };

    const summarizer = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });

    const SUMMARY_MAX_INPUT_CHARS = 6000;
    const SUMMARY_MAX_OUTPUT_CHARS = 280;
    const SUMMARY_FALLBACK = 'Keine Zusammenfassung verfügbar.';

    const stripHtml = (html = '') => html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');

    const normalizeWhitespace = (text = '') => text.replace(/\s+/g, ' ').trim();

    const truncate = (text = '', maxLength = SUMMARY_MAX_OUTPUT_CHARS) => {
      if (text.length <= maxLength) return text;
      return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
    };

    const extractMessageContent = (message) => {
      if (!message) return '';
      const { body } = message;
      if (body?.content) {
        const raw = body.contentType === 'html' ? stripHtml(body.content) : body.content;
        return normalizeWhitespace(raw);
      }
      if (message.bodyPreview) {
        return normalizeWhitespace(message.bodyPreview);
      }
      return '';
    };

    const extractModelOutput = (result) => {
      if (!result) return '';
      if (typeof result === 'string') return result;
      if (typeof result.content === 'string') return result.content;
      if (Array.isArray(result.content)) {
        return result.content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (part?.text) return part.text;
            return '';
          })
          .filter(Boolean)
          .join(' ');
      }
      if (result.text) return result.text;
      return '';
    };

    const generateSummaryForMessage = async (message) => {
      const content = extractMessageContent(message);
      const safeContent = content ? content.slice(0, SUMMARY_MAX_INPUT_CHARS) : '';
      const subject = message.subject || '';

      if (!safeContent) {
        return message.bodyPreview?.trim() || SUMMARY_FALLBACK;
      }

      const userPrompt = `Fasse die folgende E-Mail in höchstens zwei Sätzen zusammen. Maximal 280 Zeichen.

Betreff: ${subject || '—'}

${safeContent}`;

      try {
        const response = await summarizer.invoke([
          {
            role: 'system',
            content: 'Du bist ein Assistent, der E-Mails prägnant in bis zu zwei Sätzen (maximal 280 Zeichen) zusammenfasst. Verwende klare, neutrale Sprache und vermeide Aufzählungen.'
          },
          {
            role: 'user',
            content: userPrompt
          }
        ]);

        const rawSummary = extractModelOutput(response);
        const cleaned = normalizeWhitespace(rawSummary);
        if (!cleaned) {
          return message.bodyPreview?.trim() || SUMMARY_FALLBACK;
        }
        return truncate(cleaned, SUMMARY_MAX_OUTPUT_CHARS);
      } catch (error) {
        console.warn('Failed to generate mail summary:', error?.message || error);
        return message.bodyPreview?.trim() || SUMMARY_FALLBACK;
      }
    };

    const ensureSummaryForMessage = async (session, message) => {
      if (!message?.id) return SUMMARY_FALLBACK;
      if (session.summaries.has(message.id)) {
        return session.summaries.get(message.id);
      }
      const summary = await generateSummaryForMessage(message);
      session.summaries.set(message.id, summary);
      return summary;
    };

    const ensureSummariesForMessages = async (session, messages = []) => {
      for (const message of messages) {
        try {
          await ensureSummaryForMessage(session, message);
        } catch (error) {
          console.warn('ensureSummaryForMessage failed:', error?.message || error);
        }
      }
    };

    // Microsoft Graph client (CLI login based)
    const graph = new GraphClient({ logger: console });
    await graph.bootstrap(['Mail.Read', 'Mail.ReadWrite']);

    const POLL_INTERVAL_MS = 10_000;
    const MAX_INIT_UNREAD = 10;

    const startPollerIfNeeded = async (userId) => {
      const session = ensureSession(userId);
      if (session.timer) return;

      // Initial fetch
      try {
        const initial = await graph.listUnreadMessages({ maxResults: MAX_INIT_UNREAD });
        session.buffer = initial;
        session.knownIds = new Set(initial.map(m => m.id));
        await ensureSummariesForMessages(session, session.buffer);
      } catch (e) {
        console.warn('Initial unread fetch failed:', e?.message || e);
      }

      session.timer = setInterval(async () => {
        try {
          const unread = await graph.listUnreadMessages({ maxResults: MAX_INIT_UNREAD });
          const currentIds = new Set(unread.map(m => m.id));

          // New arrivals
          for (const msg of unread) {
            if (!session.knownIds.has(msg.id)) {
              session.knownIds.add(msg.id);
              session.buffer.unshift(msg);
              // Trim buffer
              if (session.buffer.length > MAX_INIT_UNREAD) session.buffer.length = MAX_INIT_UNREAD;
              await ensureSummaryForMessage(session, msg);
              broadcastToUser(userId, { type: 'new', item: sanitizeMessage(msg, session) });
            }
          }

          // Items that disappeared (likely got marked as read elsewhere)
          for (const id of Array.from(session.knownIds)) {
            if (!currentIds.has(id)) {
              session.knownIds.delete(id);
              session.buffer = session.buffer.filter(x => x.id !== id);
              session.summaries.delete(id);
              broadcastToUser(userId, { type: 'read', id });
            }
          }
        } catch (e) {
          console.warn('Polling unread messages failed:', e?.message || e);
        }
      }, POLL_INTERVAL_MS);
    };

    const stopPollerIfOrphaned = (userId) => {
      const session = notificationSessions.get(userId);
      if (!session) return;
      if (session.clients.size === 0 && session.timer) {
        clearInterval(session.timer);
        session.timer = null;
      }
    };

    const sanitizeMessage = (msg, session) => ({
      id: msg.id,
      subject: msg.subject || '',
      from: msg.from || null,
      receivedDateTime: msg.receivedDateTime,
      isRead: Boolean(msg.isRead),
      webLink: msg.webLink || '',
      summary: session?.summaries?.get(msg.id) || null,
      hasAttachments: Boolean(msg.hasAttachments)
    });

    // SSE stream endpoint
    app.get('/service/stammtisch/notifications/stream', async (req, res) => {
      const userId = getUserId(req);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const session = ensureSession(userId);
      session.clients.add(res);

      // Send initial buffer (unread only)
      try {
        // Ensure we have fresh buffer for this connect
        if (!session.buffer.length) {
          const initial = await graph.listUnreadMessages({ maxResults: MAX_INIT_UNREAD });
          session.buffer = initial;
          session.knownIds = new Set(initial.map(m => m.id));
          await ensureSummariesForMessages(session, session.buffer);
        } else {
          await ensureSummariesForMessages(session, session.buffer);
        }
        sseSend(res, { type: 'init', items: session.buffer.map((msg) => sanitizeMessage(msg, session)) });
      } catch (e) {
        sseSend(res, { type: 'error', message: String(e?.message || e) });
      }

      // Start poller if needed
      startPollerIfNeeded(userId);

      req.on('close', () => {
        const s = notificationSessions.get(userId);
        if (s) {
          s.clients.delete(res);
          stopPollerIfOrphaned(userId);
        }
      });
    });

    // Mark-as-read endpoint (backend-only, no MCP tool)
    app.post('/service/stammtisch/notifications/markRead', express.json(), async (req, res) => {
      try {
        const userId = getUserId(req);
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ error: 'id is required' });
        await graph.markMessageRead(id, true);

        const session = ensureSession(userId);
        session.knownIds.delete(id);
        session.buffer = session.buffer.filter(x => x.id !== id);
        session.summaries.delete(id);
        broadcastToUser(userId, { type: 'read', id });
        return res.json({ status: 'ok', id });
      } catch (e) {
        console.error('markRead failed:', e);
        return res.status(500).json({ error: String(e?.message || e) });
      }
    });

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

        const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
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
      for (const session of notificationSessions.values()) {
        if (session.timer) {
          clearInterval(session.timer);
        }
      }
      notificationSessions.clear();
      await graph.close();
      await closeMCPClients();
    });
  }
}
