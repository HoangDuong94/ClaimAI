// srv/ClaimsService.ts

import cds from '@sap/cds';
import express from 'express';
import type { Request, Response } from 'express';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import * as z from "zod";
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { initAllMCPClients, closeMCPClients } from './lib/mcp-client.js';
import { runClaudeAgent } from './lib/claude-agent.js';
import { jsonSchemaToZod } from './m365-mcp/mcp-jsonschema.js';
import { GraphClient } from './m365-mcp/graph-client.js';
import MarkdownConverter from './utils/markdown-converter.js';

type MCPClients = Awaited<ReturnType<typeof initAllMCPClients>>;
type AgentExecutor = ReturnType<typeof createReactAgent>;
type AttachmentDirPromise = Promise<unknown> | null;

type SsePayload = { type: string; [key: string]: unknown };

interface CapRequestContext {
  user?: { id?: string; name?: string; tenant?: string } | null;
  tenant?: string;
  locale?: string;
}

type ClaimsRequest = Request & CapRequestContext;

interface GraphParticipant {
  name?: string | null;
  email?: string | null;
  formatted?: string;
}

interface GraphAttachment {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
  [key: string]: unknown;
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: Record<string, unknown>;
  toRecipients?: Array<Record<string, unknown>>;
  ccRecipients?: Array<Record<string, unknown>>;
  bccRecipients?: Array<Record<string, unknown>>;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  webLink?: string;
  importance?: string;
  inferenceClassification?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string } | null;
  hasAttachments?: boolean;
  attachments?: GraphAttachment[];
  [key: string]: unknown;
}

interface SummaryRecord {
  summary: string;
  category: string;
  agentContext: Record<string, unknown> | null;
}

interface NotificationSession {
  clients: Set<Response>;
  buffer: GraphMessage[];
  knownIds: Set<string>;
  summaries: Map<string, SummaryRecord>;
  timer: NodeJS.Timeout | null;
}

type AgentBackend = 'langgraph' | 'claude';

const resolveAgentBackend = (): AgentBackend => {
  const raw = (process.env.CLAIMAI_AGENT_BACKEND || '').trim().toLowerCase();
  if (['claude', 'claude-agent', 'claude_agent', 'anthropic', 'anthropic-claude'].includes(raw)) {
    return 'claude';
  }
  return 'langgraph';
};

const MULTI_MODAL_SYSTEM_PROMPT = `You are a helpful assistant with access to database queries, web search, the local filesystem, Microsoft 365 (mail + calendar), and MS Excel capabilities, who helps the user Hoang by his work.

                   RESPONSE GUIDELINES:
              - Keep responses intentionally concise: focus on the key result, list only the most relevant steps, and offer extra details only when the user asks for them.
              - Highlight the most important information for the user by wrapping key phrases or sentences in **bold**.

                  CAP MODEL CONTEXT:
                  - Before answering any question about CDS models, entities, fields, services, or CAP APIs, you MUST call the cds-mcp tool 'search_model' for the exact entity/service (unless you already called it earlier in this conversation and nothing has changed). Do not rely on intuition or prior knowledge.
                  - If 'search_model' returns no match, state that clearly and ask the user for clarification instead of guessing; only read *.cds files directly when the user explicitly requests it.
                  - Summarize the relevant findings from 'search_model' in your reply (for example required fields, draft status, endpoints) so subsequent tool calls remain grounded in that metadata.

                  DATABASE ACCESS:
                  - Before invoking any 'cap.*' tool (cqn.read, draft.new, draft.patch, etc.), ensure the relevant entity/service metadata from 'search_model' is already in context for this conversation; if not, call 'search_model' first and base your reasoning on its results.
                  - Use 'cap.cqn.read' for SELECT-style queries against CAP entities. Always provide the fully qualified entity name (for example kfz.claims.Claims) and keep result sets small (limit ≤ 200).
                  - Use 'cap.sql.execute' when you need raw SQL. The tool is read-only by default; set allowWrite=true only after explicit user approval and double-check the statement before execution.
                  - Draft workflow: 'cap.draft.new' → optional 'cap.draft.patch' → 'cap.draft.save'. The MCP remembers the most recently created draft automatically; only provide keys when multiple drafts are open.
                  - 'cap.draft.patch/save/cancel' accept convenient top-level fields (for example 'claim_number', 'status', 'estimated_cost'). If the draft ID is missing, the MCP reuses the last known draft instance.
                  - CAP entity names use dot notation, but physical tables are underscored (kfz_claims_claims, kfz_claims_claimdocuments). Inspect a single row with 'cap.cqn.read' before mutating data.
                  - Always tell the user which tool/entity you intend to modify before enabling allowWrite or saving a draft, and report affected rows or IDs afterward.

                  CLAIMS HANDLING GUIDELINES (POC):
                  - ID generation: Prefer letting CAP/DB defaults create UUIDs. If you must set IDs manually in SQL, call gen_random_uuid() within 'cap.sql.execute' (allowWrite=true) and document it.
                  - All write operations require explicit user approval. Use draft-enabled flows ('cap.draft.new' → 'cap.draft.save') when capturing claim edits.
                  - Key claim attributes to surface (confirm via 'cap.cqn.read'): "claim_number", "status", "incident_date", "estimated_cost", "severity_score", "fraud_score".
                  - Validate enum fields before persisting: status ∈ {Eingegangen, In Prüfung, Freigegeben, Abgelehnt}.
                  - Monetary values in 'estimated_cost' are CHF decimals (13,2). Normalize to two decimal places before saving.
                  - Severity and fraud scores are integers 0–100; clamp user inputs to this range.
                  - ClaimDocuments must reference an existing Claim via 'claim_ID'. Store structured metadata in 'parsed_meta' (JSON) and human-readable context in 'extracted_text'.

                  WEB SEARCH ACCESS:
                  - You can search the web using 'brave_web_search'. 

                  FILESYSTEM ACCESS:
                  - You can read, write, and manage files and directories in the project.
                  - SECURITY: You can ONLY operate within the allowed project directory.
                  - Use 'list_directory' with '.' or a subdirectory to see available files first.
                  - For 'edit_file', ALWAYS use 'dryRun: true' first to preview changes.

                  MICROSOFT 365 ACCESS:
                  - Use mail tools for reading, replying, or downloading attachments.
                  - Use calendar tools only if the user explicitly asks to schedule or modify a meeting; do not create events when the user only requests text drafts.
                  - Before scheduling events with relative dates ("morgen", "übermorgen", "in X Tagen"), call the 'get_current_time' tool with timezone 'Europe/Berlin', compute the exact target date/time, confirm it with the user if unclear, and then create the event.

                  EXCEL ACCESS:
                  - You can read from and write to MS Excel files (.xlsx, .xlsm, etc.).
                  - Available tools: excel_describe_sheets, excel_read_sheet, excel_write_to_sheet, excel_create_table, excel_copy_sheet, excel_screen_capture (Windows only).
                  - ALWAYS start by using 'excel_describe_sheets' to understand the file's structure (sheet names).
                  - For all Excel tools, you MUST provide the 'fileAbsolutePath' to the target Excel file.
                  - When reading large sheets, the tool uses pagination. Pay attention to the 'knownPagingRanges' argument to read subsequent parts.
                  - When writing with 'excel_write_to_sheet', you can create a new sheet by setting 'newSheet: true'. Be careful as writing can modify files permanently.

                  ANALYSIS & VISUALIZATION WORKFLOW:
                  - If the user asks for an "analysis", "report", or "visualization" of data, you MUST follow this specific workflow:
                  1.  **Query Data:** First, use the 'cap.cqn.read' tool (or 'cap.sql.execute' with a read-only statement) to retrieve the necessary data from CAP. If the user's request is ambiguous (e.g., "analyze the data"), ask clarifying questions to determine which entities and columns are relevant for the analysis.
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

                    `;

export default class ClaimsService extends cds.ApplicationService {
  async init() {
    await super.init();
    let agentExecutor: AgentExecutor | null = null;
    let mcpClients: MCPClients | null = null;
    const app = cds.app as express.Application;

    // Lightweight in-memory notification hub (per-user)
    const notificationSessions = new Map<string, NotificationSession>();

    const getUserId = (req: ClaimsRequest): string => {
      try {
        return (req.user && (req.user.id || req.user.name)) || 'local';
      } catch {
        return 'local';
      }
    };

    const sseSend = (res: Response, payload: SsePayload): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const broadcastToUser = (userId: string, payload: SsePayload): void => {
      const session = notificationSessions.get(userId);
      if (!session) return;
      for (const client of session.clients) {
        try { sseSend(client, payload); } catch { /* ignore */ }
      }
    };

    const ensureSession = (userId: string): NotificationSession => {
      if (!notificationSessions.has(userId)) {
        notificationSessions.set(userId, {
          clients: new Set<Response>(),
          buffer: [],
          knownIds: new Set<string>(),
          summaries: new Map<string, SummaryRecord>(),
          timer: null
        });
      }
      return notificationSessions.get(userId)!;
    };

    const ensureMcpClients = async (): Promise<MCPClients> => {
      if (mcpClients) return mcpClients;
      const clients = await initAllMCPClients({ capService: this, logger: console });
      mcpClients = clients;
      return clients;
    };

    const summarizer = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });

    const SUMMARY_MAX_INPUT_CHARS = 6000;
    const SUMMARY_MAX_OUTPUT_CHARS = 280;
    const SUMMARY_FALLBACK = 'Keine Zusammenfassung verfügbar.';
    const SUMMARY_CATEGORIES = ['To Respond', 'Notification', 'FYI', 'Meeting Update', 'Action needed', 'Completed'];
    const DEFAULT_CATEGORY = 'Notification';
    const ATTACHMENTS_DIR = process.env.M365_ATTACHMENT_BASE_PATH
      ? path.resolve(process.env.M365_ATTACHMENT_BASE_PATH)
      : path.resolve(process.cwd(), 'tmp', 'attachments');
    const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv']);
    const EXCEL_MIME_PREFIXES = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml',
      'application/vnd.ms-excel',
      'text/csv',
      'application/vnd.ms-excel.sheet'
    ];

    let attachmentDirReadyPromise: AttachmentDirPromise = null;

    const stripHtml = (html = ''): string => html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');

    const normalizeWhitespace = (text = ''): string => text.replace(/\s+/g, ' ').trim();

    const truncate = (text = '', maxLength = SUMMARY_MAX_OUTPUT_CHARS): string => {
      if (text.length <= maxLength) return text;
      return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
    };

    const ensureAttachmentDir = async (): Promise<void> => {
      if (!attachmentDirReadyPromise) {
        attachmentDirReadyPromise = mkdir(ATTACHMENTS_DIR, { recursive: true }).catch(() => {});
      }
      await attachmentDirReadyPromise;
    };

    const sanitizeFileName = (name = ''): string => {
      const safe = name.replace(/[^a-z0-9_.-]+/gi, '_').replace(/_+/g, '_').trim();
      if (safe) return safe;
      return `attachment_${Date.now()}`;
    };

    const getErrorMessage = (err: unknown): string => {
      if (err && typeof err === 'object' && 'message' in err) {
        const message = (err as { message?: unknown }).message;
        return typeof message === 'string' ? message : String(message);
      }
      return String(err);
    };

    const buildCapContext = (req: CapRequestContext) => ({
      user: req.user,
      tenant: req.user?.tenant || req.tenant,
      locale: req.locale
    });

    const executeClaudeCall = async (prompt: string, req: CapRequestContext): Promise<string> => {
      const clients = await ensureMcpClients();
      if (!clients?.cap) {
        throw new Error('CAP MCP client is not initialized.');
      }
      console.log('🤖 Invoking Claude Agent SDK for prompt');
      const rawResponse = await clients.cap.runWithContext(buildCapContext(req), async () =>
        runClaudeAgent({
          prompt,
          systemPrompt: MULTI_MODAL_SYSTEM_PROMPT,
          logger: console
        })
      );

      return MarkdownConverter.convertForClaims(rawResponse);
    };

    const isExcelAttachment = (attachment: GraphAttachment | null | undefined): boolean => {
      if (!attachment) return false;
      const name = (attachment.name || '').toLowerCase();
      const ext = path.extname(name);
      if (ext && EXCEL_EXTENSIONS.has(ext)) return true;
      const type = (attachment.contentType || '').toLowerCase();
      return EXCEL_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));
    };

    const parseMcpContent = (payload: unknown): unknown => {
      if (payload === null || payload === undefined) return null;
      if (typeof payload === 'string') {
        try {
          return JSON.parse(payload);
        } catch {
          return payload;
        }
      }
      if (Array.isArray(payload)) {
        const parsed = payload
          .map((entry) => parseMcpContent(entry))
          .filter((entry) => entry !== null && entry !== undefined);
        if (parsed.length === 1) return parsed[0];
        return parsed;
      }
      if (typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (Array.isArray(record.content)) {
          const parts = record.content
            .map((part) => {
              if (!part) return null;
              if (typeof part === 'string') return parseMcpContent(part);
              if (typeof (part as Record<string, unknown>).text === 'string') {
                return parseMcpContent((part as Record<string, unknown>).text);
              }
              const partRecord = part as Record<string, unknown>;
              if (partRecord.json !== undefined) return partRecord.json;
              if (partRecord.data !== undefined) return partRecord.data;
              return null;
            })
            .filter((entry) => entry !== null && entry !== undefined);
          if (parts.length === 1) return parts[0];
          return parts;
        }
        return record;
      }
      return payload;
    };

    const callExcelTool = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      if (!mcpClients?.excel) return null;
      try {
        const result = await mcpClients.excel.callTool({ name: toolName, arguments: args });
        return parseMcpContent(result) ?? null;
      } catch (error) {
        console.warn(`Excel tool ${toolName} failed:`, getErrorMessage(error));
        return null;
      }
    };

    const extractSheetNames = (describeResult: unknown): string[] => {
      if (!describeResult) return [];
      if (Array.isArray(describeResult)) {
        return describeResult
          .map((entry) => {
            if (!entry) return null;
            if (typeof entry === 'string') return entry;
            const record = entry as Record<string, unknown>;
            if (typeof record.name === 'string') return record.name;
            if (typeof record.sheetName === 'string') return record.sheetName;
            return null;
          })
          .filter((value): value is string => typeof value === 'string' && value.length > 0);
      }
      const record = describeResult as Record<string, unknown>;
      const sheets = record.sheets;
      if (Array.isArray(sheets)) {
        return sheets
          .map((sheet) => {
            if (!sheet) return null;
            if (typeof sheet === 'string') return sheet;
            const record = sheet as Record<string, unknown>;
            if (typeof record.name === 'string') return record.name;
            if (typeof record.sheetName === 'string') return record.sheetName;
            return null;
          })
          .filter((value): value is string => typeof value === 'string' && value.length > 0);
      }
      const sheetNames = record.sheetNames;
      if (Array.isArray(sheetNames)) {
        return sheetNames.filter((name): name is string => typeof name === 'string' && Boolean(name));
      }
      if (typeof record.sheetName === 'string') {
        return [record.sheetName];
      }
      return [];
    };

    const loadExcelAttachmentContext = async (filePath: string): Promise<{ describe: unknown; sheets: unknown[] }> => {
      const describeResult = await callExcelTool('excel_describe_sheets', { fileAbsolutePath: filePath });
      const sheetNames = extractSheetNames(describeResult);

      const sheets: unknown[] = [];
      for (const sheetName of sheetNames) {
        try {
          const sheetData = await callExcelTool('excel_read_sheet', {
            fileAbsolutePath: filePath,
            sheetName
          });
          sheets.push({ sheetName, data: sheetData });
        } catch (error) {
          console.warn('Failed to read Excel sheet', sheetName, getErrorMessage(error));
          sheets.push({ sheetName, error: getErrorMessage(error) });
        }
      }

      return { describe: describeResult, sheets };
    };

    const ensureExcelAttachmentDetails = async (message: GraphMessage, summaryEntry: SummaryRecord | null | undefined): Promise<void> => {
      if (!summaryEntry?.agentContext) return;
      const attachments = Array.isArray(message?.attachments) ? (message.attachments as GraphAttachment[]) : [];
      if (!attachments.length) return;

      await ensureAttachmentDir();

      const enriched: Array<Record<string, unknown>> = [];
      for (const attachment of attachments) {
        const baseInfo = {
          id: attachment.id || null,
          name: attachment.name || null,
          contentType: attachment.contentType || null,
          size: attachment.size ?? null,
          isInline: Boolean(attachment.isInline)
        };

        if (!isExcelAttachment(attachment) || (attachment as any).isInline) {
          enriched.push(baseInfo);
          continue;
        }

        if (!attachment.id || !message.id) {
          enriched.push({ ...baseInfo, error: 'attachment id or message id missing' });
          continue;
        }

        const safeName = sanitizeFileName(attachment.name || `${message.id}-${attachment.id}.xlsx`);
        const targetPath = path.join(ATTACHMENTS_DIR, safeName);

        try {
          if (!existsSync(targetPath)) {
            await graph.downloadAttachment({
              messageId: message.id,
              attachmentId: attachment.id,
              targetPath
            });
          }

          const excel = await loadExcelAttachmentContext(targetPath);
          enriched.push({
            ...baseInfo,
            path: targetPath,
            excel
          });
        } catch (error) {
          console.warn('Failed to process Excel attachment:', attachment.name, getErrorMessage(error));
          enriched.push({ ...baseInfo, path: targetPath, error: getErrorMessage(error) });
        }
      }

      (summaryEntry.agentContext as Record<string, unknown>).attachments = enriched;
    };

    const escapeHtml = (text = ''): string => text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const sanitizeEmailHtml = (html = ''): string => {
      if (!html) return '';
      let sanitized = html;
      sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/gi, '');
      sanitized = sanitized.replace(/<style[\s\S]*?<\/style>/gi, '');
      sanitized = sanitized.replace(/<link[\s\S]*?>/gi, '');
      sanitized = sanitized.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
      sanitized = sanitized.replace(/<object[\s\S]*?<\/object>/gi, '');
      sanitized = sanitized.replace(/<embed[\s\S]*?<\/embed>/gi, '');
      sanitized = sanitized.replace(/<base[\s\S]*?>/gi, '');
      sanitized = sanitized.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
      sanitized = sanitized.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
      sanitized = sanitized.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
      sanitized = sanitized.replace(/javascript:/gi, '');
      sanitized = sanitized.replace(/data:text\/html;[^"'>]+/gi, '');
      return sanitized.trim();
    };

    const getSanitizedBodyHtml = (message: GraphMessage): string | null => {
      if (!message?.body?.content) return null;
      const { content, contentType } = message.body;
      if (!content) return null;
      if (contentType === 'html') {
        return sanitizeEmailHtml(content);
      }
      const plain = typeof content === 'string' ? content : String(content);
      return `<pre>${escapeHtml(plain)}</pre>`;
    };

    const extractMessageContent = (message: GraphMessage | null | undefined): string => {
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

    const extractModelOutput = (result: unknown): string => {
      if (!result) return '';
      if (typeof result === 'string') return result;
      const record = result as Record<string, unknown>;
      const content = record.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === 'string') return part;
            const partRecord = part as Record<string, unknown>;
            if (typeof partRecord?.text === 'string') return partRecord.text as string;
            return '';
          })
          .filter(Boolean)
          .join(' ');
      }
      if (typeof record.text === 'string') return record.text as string;
      return '';
    };

    const extractMailParticipant = (entry: unknown): GraphParticipant | null => {
      if (!entry) return null;
      const entryRecord = entry as Record<string, unknown>;
      const emailAddress = (entryRecord.emailAddress || entryRecord) as Record<string, unknown>;
      const address = (emailAddress.address || emailAddress.emailAddress || emailAddress.value || entryRecord.address || null) as string | null;
      const name = (emailAddress.name || emailAddress.displayName || entryRecord.name || entryRecord.displayName || null) as string | null;
      const formatted = name && address ? `${name} <${address}>` : (name || address || null);
      if (!formatted) return null;
      return {
        name,
        email: address,
        formatted
      };
    };

    const formatMailAddress = (entry: unknown): string | null => {
      const participant = extractMailParticipant(entry);
      return participant?.formatted || null;
    };

    const mapRecipients = (list: unknown): string[] => {
      if (!Array.isArray(list)) return [];
      return list
        .map(formatMailAddress)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    };

    const mapRecipientDetails = (list: unknown): Array<{ name: string | null; email: string | null }> => {
      if (!Array.isArray(list)) return [];
      return list
        .map(extractMailParticipant)
        .filter((participant): participant is GraphParticipant => Boolean(participant))
        .map((participant) => ({
          name: participant.name || null,
          email: participant.email || null
        }));
    };

    const buildAgentContext = (message: GraphMessage, summary: string, category: string): Record<string, unknown> => {
      const content = extractMessageContent(message) || '';
      const bodyPreview = normalizeWhitespace(message.bodyPreview || '').slice(0, SUMMARY_MAX_OUTPUT_CHARS);
      const sender = extractMailParticipant(message.from);
      const from = sender?.formatted || null;
      const toDetails = mapRecipientDetails(message.toRecipients);
      const ccDetails = mapRecipientDetails(message.ccRecipients);
      const bodyHtml = getSanitizedBodyHtml(message);
      const senderEmail = sender?.email ?? null;
      return {
        id: message.id,
        subject: message.subject || '',
        from,
        sender: sender
          ? {
              name: sender.name || null,
              email: sender.email || null,
              formatted: sender.formatted
            }
          : null,
        toRecipients: mapRecipients(message.toRecipients),
        toRecipientDetails: toDetails,
        ccRecipients: mapRecipients(message.ccRecipients),
        ccRecipientDetails: ccDetails,
        receivedDateTime: message.receivedDateTime || null,
        webLink: message.webLink || null,
        hasAttachments: Boolean(message.hasAttachments),
        attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : null,
        category,
        summary,
        bodyPreview,
        body: content,
        bodyText: content,
        bodyHtml,
        importance: message.importance || null,
        inferenceClassification: message.inferenceClassification || null,
        replyGuidelines: {
          defaultEmailRecipients: senderEmail ? [senderEmail] : [],
          defaultCalendarAttendees: senderEmail ? [senderEmail] : [],
          instructions: 'Bei Antworten oder Kalendereinladungen den ursprünglichen Absender automatisch als Empfänger hinzufügen, es sei denn, der Nutzer nennt ausdrücklich weitere Teilnehmer.'
        },
        attachments: []
      };
    };

    const finalizeSummaryResult = (
      message: GraphMessage,
      summaryText: string | null | undefined,
      categoryText: string | null | undefined
    ): SummaryRecord => {
      const fallback = message.bodyPreview?.trim() || SUMMARY_FALLBACK;
      const normalizedSummary = normalizeWhitespace(summaryText || fallback);
      const truncated = truncate(normalizedSummary || fallback, SUMMARY_MAX_OUTPUT_CHARS);
      const normalizedCategory = typeof categoryText === 'string' && SUMMARY_CATEGORIES.includes(categoryText)
        ? categoryText
        : DEFAULT_CATEGORY;
      const agentContext = buildAgentContext(message, truncated || fallback, normalizedCategory);
      return { summary: truncated || fallback, category: normalizedCategory, agentContext };
    };

    const generateSummaryForMessage = async (message: GraphMessage): Promise<SummaryRecord> => {
      const content = extractMessageContent(message);
      const safeContent = content ? content.slice(0, SUMMARY_MAX_INPUT_CHARS) : '';
      const subject = message.subject || '';

      if (!safeContent) {
        return finalizeSummaryResult(message, message.bodyPreview, DEFAULT_CATEGORY);
      }

      const userPrompt = `Fasse die folgende E-Mail in höchstens zwei Sätzen (maximal 280 Zeichen) zusammen und kategorisiere sie.
Gültige Kategorien: To Respond, Notification, FYI, Meeting Update, Action needed, Completed.
Gib das Ergebnis ausschließlich als kompaktes JSON-Objekt zurück: {"summary":"...","category":"..."}.

Betreff: ${subject || '—'}

${safeContent}`;

      try {
        const response = await summarizer.invoke([
          {
            role: 'system',
            content: 'Du bist ein Assistent, der eingehende E-Mails prägnant in höchstens zwei Sätzen (maximal 280 Zeichen) zusammenfasst und sie in eine vorgegebene Kategorie einordnet. Antworte ausschließlich mit gültigem JSON im Format {"summary":"...","category":"..."}.'
          },
          {
            role: 'user',
            content: userPrompt
          }
        ]);

        const rawContent = (extractModelOutput(response) || '').trim();
        if (!rawContent) {
          return finalizeSummaryResult(message, null, DEFAULT_CATEGORY);
        }
        let parsed = null;
        try {
          const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          } else {
            parsed = JSON.parse(rawContent);
          }
        } catch (parseError) {
          parsed = null;
        }

        if (parsed && typeof parsed === 'object') {
          const summaryCandidate = typeof parsed.summary === 'string' ? parsed.summary : null;
          const categoryCandidate = typeof parsed.category === 'string' ? parsed.category : DEFAULT_CATEGORY;
          return finalizeSummaryResult(message, summaryCandidate, categoryCandidate);
        }

        return finalizeSummaryResult(message, rawContent, DEFAULT_CATEGORY);
      } catch (error) {
        console.warn('Failed to generate mail summary:', getErrorMessage(error));
        return finalizeSummaryResult(message, message.bodyPreview, DEFAULT_CATEGORY);
      }
    };

    const ensureSummaryForMessage = async (session: NotificationSession, message: GraphMessage): Promise<SummaryRecord> => {
      if (!message?.id) return finalizeSummaryResult(message, null, DEFAULT_CATEGORY);
      const cached = session.summaries.get(message.id);
      if (cached) {
        return cached;
      }
      const summary = await generateSummaryForMessage(message);
      try {
        await ensureExcelAttachmentDetails(message, summary);
      } catch (error) {
        console.warn('ensureExcelAttachmentDetails failed:', getErrorMessage(error));
      }
      session.summaries.set(message.id, summary);
      return summary;
    };

    const ensureSummariesForMessages = async (session: NotificationSession, messages: GraphMessage[] = []): Promise<void> => {
      for (const message of messages) {
        try {
          await ensureSummaryForMessage(session, message);
        } catch (error) {
          console.warn('ensureSummaryForMessage failed:', getErrorMessage(error));
        }
      }
    };

    // Microsoft Graph client (CLI login based)
    const graph = new GraphClient({ logger: console });
    await graph.bootstrap(['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite']);

    const POLL_INTERVAL_MS = 10_000;
    const MAX_INIT_UNREAD = 10;

    const startPollerIfNeeded = async (userId: string): Promise<void> => {
      const session = ensureSession(userId);
      if (session.timer) return;

      // Initial fetch
      try {
        const initial = await graph.listUnreadMessages({ maxResults: MAX_INIT_UNREAD }) as GraphMessage[];
        session.buffer = initial;
        session.knownIds = new Set(initial.map(m => m.id));
        await ensureSummariesForMessages(session, session.buffer);
      } catch (e) {
        console.warn('Initial unread fetch failed:', getErrorMessage(e));
      }

      session.timer = setInterval(async () => {
        try {
          const unread = await graph.listUnreadMessages({ maxResults: MAX_INIT_UNREAD }) as GraphMessage[];
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
          console.warn('Polling unread messages failed:', getErrorMessage(e));
        }
      }, POLL_INTERVAL_MS);
    };

    const stopPollerIfOrphaned = (userId: string): void => {
      const session = notificationSessions.get(userId);
      if (!session) return;
      if (session.clients.size === 0 && session.timer) {
        clearInterval(session.timer);
        session.timer = null;
      }
    };

    const sanitizeMessage = (msg: GraphMessage, session: NotificationSession): Record<string, unknown> => {
      const cacheEntry = session?.summaries?.get(msg.id) || null;
      return {
        id: msg.id,
        subject: msg.subject || '',
        from: msg.from || null,
        receivedDateTime: msg.receivedDateTime,
        isRead: Boolean(msg.isRead),
        webLink: msg.webLink || '',
        summary: cacheEntry?.summary || null,
        category: cacheEntry?.category || null,
        agentContext: cacheEntry?.agentContext || null,
        hasAttachments: Boolean(msg.hasAttachments)
      };
    };

    // SSE stream endpoint
    app.get('/service/claims/notifications/stream', async (req: ClaimsRequest, res: Response) => {
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
          const initial = await graph.listUnreadMessages({ maxResults: MAX_INIT_UNREAD }) as GraphMessage[];
          session.buffer = initial;
          session.knownIds = new Set(initial.map(m => m.id));
          await ensureSummariesForMessages(session, session.buffer);
        } else {
          await ensureSummariesForMessages(session, session.buffer);
        }
        sseSend(res, { type: 'init', items: session.buffer.map((msg) => sanitizeMessage(msg, session)) });
      } catch (e) {
        sseSend(res, { type: 'error', message: getErrorMessage(e) });
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
    app.post('/service/claims/notifications/markRead', express.json(), async (req: ClaimsRequest, res: Response) => {
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
        return res.status(500).json({ error: getErrorMessage(e) });
      }
    });

    const initializeAgent = async (): Promise<AgentExecutor> => {
      if (agentExecutor) return agentExecutor;

      // +++ ERWEITERT: Log-Nachricht angepasst +++
      console.log("Initializing Agent with CAP data access, Web Search, Filesystem, Excel, Microsoft 365, and Time capabilities...");

      try {
        const clients = await ensureMcpClients();

        const [capTools, cdsModelTools, braveSearchTools, filesystemTools, excelTools, timeTools] = await Promise.all([
          loadMcpTools('cap', clients.cap),
          loadMcpTools('search_model', clients.cdsModel),
          loadMcpTools("brave_web_search,brave_local_search", clients.braveSearch),
          loadMcpTools("read_file,write_file,edit_file,create_directory,list_directory,move_file,search_files,get_file_info,list_allowed_directories", clients.filesystem),
          loadMcpTools("excel_describe_sheets,excel_read_sheet,excel_screen_capture,excel_write_to_sheet,excel_create_table,excel_copy_sheet", clients.excel),
          loadMcpTools("get_current_time,convert_time", clients.time)
        ]) as StructuredToolInterface[][];

        // PostgreSQL tools are temporarily disabled while the CAP MCP migration is in progress.
        // const postgresTools = await loadMcpTools("query", clients.postgres);
        const postgresTools: StructuredToolInterface[] = [];

        // Kombiniere alle Tools
        const allTools = [...postgresTools, ...cdsModelTools, ...capTools, ...braveSearchTools, ...filesystemTools, ...excelTools, ...timeTools];

        // Lade Microsoft 365 Tools dynamisch aus dem Manifest
        if (clients.m365) {
          console.log("Loading Microsoft 365 tools...");
          const manifest = await clients.m365.listTools();
          const m365Tools = manifest.tools.map((toolDef) => {
            const schema = jsonSchemaToZod(toolDef.inputSchema, z);
            return new DynamicStructuredTool({
              name: toolDef.name,
              description: toolDef.description,
              schema,
              func: async (input) => {
                const result = await clients.m365!.callTool({ name: toolDef.name, arguments: input });
                return typeof result === 'string' ? result : JSON.stringify(result);
              }
            });
          });
          allTools.push(...m365Tools);
          console.log(`✅ Loaded ${m365Tools.length} Microsoft 365 tools`);
        }

        console.log(`✅ Loaded ${capTools.length} CAP, ${cdsModelTools.length} cds-mcp, ${braveSearchTools.length} Brave Search, ${filesystemTools.length} Filesystem, ${excelTools.length} Excel, and ${timeTools.length} Time tools (${postgresTools.length} PostgreSQL tools currently disabled)`);
        console.log("Available tools:", allTools.map(tool => tool.name));

        const llm = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
        const checkpointer = new MemorySaver();

        agentExecutor = createReactAgent({
          llm,
          tools: allTools,
          checkpointSaver: checkpointer
        });
        
        // +++ ERWEITERT: Log-Nachricht angepasst +++
        console.log("✅ Multi-Modal Agent is ready (Database + Web Search + Filesystem + Excel + M365 + Time).");
        return agentExecutor;

      } catch (error) {
        console.error("❌ Failed to initialize agent:", error);
        throw error;
      }
    };

    const preferredBackend = resolveAgentBackend();
    if (preferredBackend === 'langgraph') {
      await initializeAgent();
    } else {
      console.log('Claude Agent backend selected; initializing MCP clients without LangGraph warmup.');
      await ensureMcpClients();
    }

    this.on('callLLM', async (req) => {
      const { prompt: userPrompt } = req.data;
      if (!userPrompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      const backend = resolveAgentBackend();
      console.log(`🚀 Received prompt for ${backend === 'claude' ? 'Claude Agent' : 'Multi-Modal Agent'}:`, userPrompt);

      try {
        if (backend === 'claude') {
          const claudeResponse = await executeClaudeCall(userPrompt, req);
          return { response: claudeResponse };
        }

        const executor = await initializeAgent();
        const clients = await ensureMcpClients();
        const capContext = buildCapContext(req);

        return await clients.cap.runWithContext(capContext, async () => {
          const systemMessage = {
            role: 'system',
            content: MULTI_MODAL_SYSTEM_PROMPT
          };

          const userMessage = {
            role: 'user',
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

          const finalResponseParts: string[] = [];
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
                const toolCallStr = `

<TOOL_CALL>
  Tool: ${toolCall.name}
  Args: ${JSON.stringify(toolCall.args)}
</TOOL_CALL>

`;
                process.stdout.write(toolCallStr);
              }
            }

            if (chunk.tools?.messages) {
              const toolMessage = chunk.tools.messages[0];
              const toolOutputStr = `<TOOL_OUTPUT>
  ${toolMessage.content}
</TOOL_OUTPUT>

`;
              process.stdout.write(toolOutputStr);
            }
          }
          console.log("\n---- AGENT STREAM END ----\n");

          const rawResponse = finalResponseParts.join("");
          const htmlResponse = MarkdownConverter.convertForClaims(rawResponse);

          return { response: htmlResponse };
        });

      } catch (error) {
        console.error('💥 Error during agent execution:', error);
        const backendLabel = backend === 'claude' ? 'Claude Agent' : 'LangGraph agent';
        req.error(500, `Failed to process query via ${backendLabel}: ${getErrorMessage(error)}`);
      }
    });

    this.on('callClaudeAgent', async (req) => {
      const { prompt: userPrompt } = req.data;
      if (!userPrompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      console.log('🚀 Received prompt for Claude Agent (direct):', userPrompt);

      try {
        const claudeResponse = await executeClaudeCall(userPrompt, req);
        return { response: claudeResponse };
      } catch (error) {
        console.error('💥 Error during Claude agent execution:', error);
        req.error(500, `Failed to process query via Claude Agent: ${getErrorMessage(error)}`);
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
