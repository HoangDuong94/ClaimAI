// srv/StammtischService.js

import cds from '@sap/cds';
import express from 'express';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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

    let attachmentDirReadyPromise = null;

    const stripHtml = (html = '') => html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');

    const normalizeWhitespace = (text = '') => text.replace(/\s+/g, ' ').trim();

    const truncate = (text = '', maxLength = SUMMARY_MAX_OUTPUT_CHARS) => {
      if (text.length <= maxLength) return text;
      return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
    };

    const ensureAttachmentDir = async () => {
      if (!attachmentDirReadyPromise) {
        attachmentDirReadyPromise = mkdir(ATTACHMENTS_DIR, { recursive: true }).catch(() => {});
      }
      await attachmentDirReadyPromise;
    };

    const sanitizeFileName = (name = '') => {
      const safe = name.replace(/[^a-z0-9_.-]+/gi, '_').replace(/_+/g, '_').trim();
      if (safe) return safe;
      return `attachment_${Date.now()}`;
    };

    const isExcelAttachment = (attachment) => {
      if (!attachment) return false;
      const name = (attachment.name || '').toLowerCase();
      const ext = path.extname(name);
      if (ext && EXCEL_EXTENSIONS.has(ext)) return true;
      const type = (attachment.contentType || '').toLowerCase();
      return EXCEL_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));
    };

    const parseMcpContent = (payload) => {
      if (!payload) return null;
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
        if (Array.isArray(payload.content)) {
          const parts = payload.content
            .map((part) => {
              if (!part) return null;
              if (typeof part === 'string') return parseMcpContent(part);
              if (typeof part.text === 'string') return parseMcpContent(part.text);
              if (part.json !== undefined) return part.json;
              if (part.data !== undefined) return part.data;
              return null;
            })
            .filter((entry) => entry !== null && entry !== undefined);
          if (parts.length === 1) return parts[0];
          return parts;
        }
        return payload;
      }
      return payload;
    };

    const callExcelTool = async (toolName, args) => {
      if (!mcpClients?.excel) return null;
      try {
        const result = await mcpClients.excel.callTool({ name: toolName, arguments: args });
        return parseMcpContent(result) ?? null;
      } catch (error) {
        console.warn(`Excel tool ${toolName} failed:`, error?.message || error);
        return null;
      }
    };

    const extractSheetNames = (describeResult) => {
      if (!describeResult) return [];
      if (Array.isArray(describeResult)) {
        return describeResult
          .map((entry) => {
            if (!entry) return null;
            if (typeof entry === 'string') return entry;
            if (entry.name) return entry.name;
            if (entry.sheetName) return entry.sheetName;
            return null;
          })
          .filter(Boolean);
      }
      if (Array.isArray(describeResult.sheets)) {
        return describeResult.sheets
          .map((sheet) => (sheet?.name || sheet?.sheetName || (typeof sheet === 'string' ? sheet : null)))
          .filter(Boolean);
      }
      if (Array.isArray(describeResult.sheetNames)) {
        return describeResult.sheetNames.filter(Boolean);
      }
      if (typeof describeResult.sheetName === 'string') {
        return [describeResult.sheetName];
      }
      return [];
    };

    const loadExcelAttachmentContext = async (filePath) => {
      const describeResult = await callExcelTool('excel_describe_sheets', { fileAbsolutePath: filePath });
      const sheetNames = extractSheetNames(describeResult);

      const sheets = [];
      for (const sheetName of sheetNames) {
        try {
          const sheetData = await callExcelTool('excel_read_sheet', {
            fileAbsolutePath: filePath,
            sheetName
          });
          sheets.push({ sheetName, data: sheetData });
        } catch (error) {
          console.warn('Failed to read Excel sheet', sheetName, error?.message || error);
          sheets.push({ sheetName, error: String(error?.message || error) });
        }
      }

      return {
        describe: describeResult,
        sheets
      };
    };

    const ensureExcelAttachmentDetails = async (message, summaryEntry) => {
      if (!summaryEntry?.agentContext) return;
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      if (!attachments.length) return;

      await ensureAttachmentDir();

      const enriched = [];
      for (const attachment of attachments) {
        const baseInfo = {
          id: attachment.id || null,
          name: attachment.name || null,
          contentType: attachment.contentType || null,
          size: attachment.size ?? null,
          isInline: Boolean(attachment.isInline)
        };

        if (!isExcelAttachment(attachment) || attachment.isInline) {
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
          console.warn('Failed to process Excel attachment:', attachment.name, error?.message || error);
          enriched.push({ ...baseInfo, path: targetPath, error: String(error?.message || error) });
        }
      }

      summaryEntry.agentContext.attachments = enriched;
    };

    const escapeHtml = (text = '') => text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const sanitizeEmailHtml = (html = '') => {
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

    const getSanitizedBodyHtml = (message) => {
      if (!message?.body?.content) return null;
      const { content, contentType } = message.body;
      if (!content) return null;
      if (contentType === 'html') {
        return sanitizeEmailHtml(content);
      }
      const plain = typeof content === 'string' ? content : String(content);
      return `<pre>${escapeHtml(plain)}</pre>`;
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

    const extractMailParticipant = (entry) => {
      if (!entry) return null;
      const emailAddress = entry.emailAddress || entry;
      const address = emailAddress?.address || emailAddress?.emailAddress || emailAddress?.value || entry.address || null;
      const name = emailAddress?.name || emailAddress?.displayName || entry.name || entry.displayName || null;
      const formatted = name && address ? `${name} <${address}>` : (name || address || null);
      if (!formatted) return null;
      return {
        name,
        email: address,
        formatted
      };
    };

    const formatMailAddress = (entry) => {
      const participant = extractMailParticipant(entry);
      return participant?.formatted || null;
    };

    const mapRecipients = (list = []) => {
      if (!Array.isArray(list)) return [];
      return list
        .map(formatMailAddress)
        .filter(Boolean);
    };

    const mapRecipientDetails = (list = []) => {
      if (!Array.isArray(list)) return [];
      return list
        .map(extractMailParticipant)
        .filter(Boolean)
        .map((participant) => ({
          name: participant.name || null,
          email: participant.email || null
        }));
    };

    const buildAgentContext = (message, summary, category) => {
      const content = extractMessageContent(message) || '';
      const bodyPreview = normalizeWhitespace(message.bodyPreview || '').slice(0, SUMMARY_MAX_OUTPUT_CHARS);
      const sender = extractMailParticipant(message.from);
      const from = sender?.formatted || null;
      const toDetails = mapRecipientDetails(message.toRecipients);
      const ccDetails = mapRecipientDetails(message.ccRecipients);
      const bodyHtml = getSanitizedBodyHtml(message);
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
          defaultEmailRecipients: sender?.email ? [sender.email] : [],
          defaultCalendarAttendees: sender?.email ? [sender.email] : [],
          instructions: 'Bei Antworten oder Kalendereinladungen den ursprünglichen Absender automatisch als Empfänger hinzufügen, es sei denn, der Nutzer nennt ausdrücklich weitere Teilnehmer.'
        },
        attachments: []
      };
    };

    const finalizeSummaryResult = (message, summaryText, categoryText) => {
      const fallback = message.bodyPreview?.trim() || SUMMARY_FALLBACK;
      const normalizedSummary = normalizeWhitespace(summaryText || fallback);
      const truncated = truncate(normalizedSummary || fallback, SUMMARY_MAX_OUTPUT_CHARS);
      const normalizedCategory = SUMMARY_CATEGORIES.includes(categoryText) ? categoryText : DEFAULT_CATEGORY;
      const agentContext = buildAgentContext(message, truncated || fallback, normalizedCategory);
      return { summary: truncated || fallback, category: normalizedCategory, agentContext };
    };

    const generateSummaryForMessage = async (message) => {
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
        console.warn('Failed to generate mail summary:', error?.message || error);
        return finalizeSummaryResult(message, message.bodyPreview, DEFAULT_CATEGORY);
      }
    };

    const ensureSummaryForMessage = async (session, message) => {
      if (!message?.id) return finalizeSummaryResult(message, null, DEFAULT_CATEGORY);
      if (session.summaries.has(message.id)) {
        return session.summaries.get(message.id);
      }
      const summary = await generateSummaryForMessage(message);
      try {
        await ensureExcelAttachmentDetails(message, summary);
      } catch (error) {
        console.warn('ensureExcelAttachmentDetails failed:', error?.message || error);
      }
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
    await graph.bootstrap(['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite']);

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

    const sanitizeMessage = (msg, session) => {
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
      console.log("Initializing Agent with Database, Web Search, Filesystem, Excel, Microsoft 365, and Time capabilities...");

      try {
        mcpClients = await initAllMCPClients();

        const [postgresTools, braveSearchTools, filesystemTools, excelTools, timeTools] = await Promise.all([
          loadMcpTools("query", mcpClients.postgres),
          loadMcpTools("brave_web_search,brave_local_search", mcpClients.braveSearch),
          loadMcpTools("read_file,write_file,edit_file,create_directory,list_directory,move_file,search_files,get_file_info,list_allowed_directories", mcpClients.filesystem),
          loadMcpTools("excel_describe_sheets,excel_read_sheet,excel_screen_capture,excel_write_to_sheet,excel_create_table,excel_copy_sheet", mcpClients.excel),
          loadMcpTools("get_current_time,convert_time", mcpClients.time)
        ]);

        // Kombiniere alle Tools
        const allTools = [...postgresTools, ...braveSearchTools, ...filesystemTools, ...excelTools, ...timeTools];

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

        console.log(`✅ Loaded ${postgresTools.length} PostgreSQL, ${braveSearchTools.length} Brave Search, ${filesystemTools.length} Filesystem, ${excelTools.length} Excel, and ${timeTools.length} Time tools`);
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
          content: `You are a helpful assistant with access to database queries, web search, the local filesystem, Microsoft 365 (mail + calendar), and MS Excel capabilities, who helps the user Hoang by his work.

                   RESPONSE GUIDELINES:
              - Keep responses intentionally concise: focus on the key result, list only the most relevant steps, and offer extra details only when the user asks for them.
              - Highlight the most important information for the user by wrapping key phrases or sentences in **bold**.

                  DATABASE ACCESS:
                  - You can query a PostgreSQL database using the 'query' tool (SELECT only).
                  - Use 'execute_dml_ddl_dcl_tcl' for INSERT/UPDATE/DELETE/DDL and 'execute_commit' / 'execute_rollback' for transactions.
                  - IMPORTANT: PostgreSQL + CAP naming — never use dot-notation like sap.stammtisch.*.
                    CAP flattens CDS names to underscore table names. Always discover with 'list_tables' and verify columns with 'describe_table' before writing.
                  - Relevant tables: sap_stammtisch_stammtische (events), sap_stammtisch_praesentatoren (presenters), sap_stammtisch_teilnehmer (attendees).
                  - Quote columns exactly as returned by 'describe_table' (e.g., "ID", "praesentator_ID").
                  - If a command fails and you see "current transaction is aborted", immediately call 'execute_rollback' and then retry with corrected SQL.

                  STAMMTISCH IMPORT RULES (POC):
                  - ID generation rule: Always generate UUIDs using gen_random_uuid() (PostgreSQL pgcrypto) for any missing "id" fields and for "praesentator_ID" when mapping presenters.
                  - On explicit user approval to import a neues Thema, INSERT into table sap_stammtisch_stammtische using 'execute_dml_ddl_dcl_tcl' and then call 'execute_commit'.
                  - Columns to consider (confirm via 'describe_table'): "ID", "thema", "datum", "ort", "notizen", "praesentator_ID".
                  - ID: Prefer DB default. If needed, set "ID" = gen_random_uuid(); if the function is unavailable, omit "ID" so that the DB default generates it.
                  - datum: Build a timestamp at 18:00 local (ISO string, e.g., '2025-09-30T18:00:00Z'). Ask the user if the date is unknown.
                  - ort: Default to 'Luzern' unless the user provides a different location.
                  - Presenter mapping: For each value in the Excel column "Vorgetragen durch", set "praesentator_ID" to gen_random_uuid()
                  - Duplicate prevention: Compare normalized Themen against BekannteThemenJSON (case-insensitive, trim). If a duplicate is found, do not insert without explicit user approval.

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
