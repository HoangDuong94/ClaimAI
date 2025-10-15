// srv/ClaimsService.ts

import cds from '@sap/cds';
import express from 'express';
import type { Request, Response } from 'express';
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { initAllMCPClients, closeMCPClients } from './lib/mcp-client.js';
import { GraphClient } from './m365-mcp/graph-client.js';
import { LangGraphAgentAdapter } from './agents/langgraph-adapter.js';
import { ClaudeAgentAdapter } from './agents/claude-adapter.js';
import { CodexAgentAdapter } from './agents/codex-adapter.js';
import type { AgentAdapter } from './agents/agent-adapter.js';
import type { CapRequestContext } from './types/cap-context.js';
import { analyzeImageAttachment } from './utils/vision.js';

type MCPClients = Awaited<ReturnType<typeof initAllMCPClients>>;
type AttachmentDirPromise = Promise<unknown> | null;

type SsePayload = { type: string; [key: string]: unknown };

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

type AgentBackend = 'langgraph' | 'claude' | 'codex';

const resolveAgentBackend = (): AgentBackend => {
  const raw = (process.env.CLAIMAI_AGENT_BACKEND || '').trim().toLowerCase();
  if (['claude', 'claude-agent', 'claude_agent', 'anthropic', 'anthropic-claude'].includes(raw)) {
    return 'claude';
  }
  if (['codex', 'codex-sdk', 'codex_agent', 'codexagent'].includes(raw)) {
    return 'codex';
  }
  return 'langgraph';
};

const describeAgentBackend = (backend: AgentBackend): string => {
  switch (backend) {
    case 'claude':
      return 'Claude Agent';
    case 'codex':
      return 'Codex Agent';
    default:
      return 'Multi-Modal Agent';
  }
};

const CLAUDE_APPEND_PROMPT = `Keep replies focused, note every tool you invoke, and highlight critical findings in **bold**.`;

export default class ClaimsService extends cds.ApplicationService {
  async init() {
    await super.init();
    console.log('[ClaimAI] ClaimsService init: Claude MCP build with draft-patch normalization active');
    const projectClaudeInstructions = await readFile(path.resolve(process.cwd(), 'CLAUDE.md'), 'utf8')
      .then((content) => content.trim())
      .catch(() => null);
    const langGraphSystemPrompt = projectClaudeInstructions
      ? `${projectClaudeInstructions}\n\n${CLAUDE_APPEND_PROMPT}`
      : CLAUDE_APPEND_PROMPT;
    let mcpClients: MCPClients | null = null;
    const app = cds.app as express.Application;

    // Lightweight in-memory notification hub (per-user)
    const notificationSessions = new Map<string, NotificationSession>();
    const claudeSessions = new Map<string, string>();
    const preferredBackend = resolveAgentBackend();
    const mcpInfrastructureEnabled = preferredBackend !== 'codex';

    const getUserId = (req: CapRequestContext): string => {
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
      if (!mcpInfrastructureEnabled) {
        throw new Error('MCP clients are disabled for the Codex backend.');
      }
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
    const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv']);
    const EXCEL_MIME_PREFIXES = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml',
      'application/vnd.ms-excel',
      'text/csv',
      'application/vnd.ms-excel.sheet'
    ];
    const IMAGE_MIME_PREFIXES = ['image/png', 'image/jpeg', 'image/webp'];

    const TMP_DIR = path.resolve(process.cwd(), 'tmp');

    const normalizeAttachmentsBasePath = (raw?: string): string => {
      // 1) Start with env or fallback to ./tmp/attachments relative to CWD
      let base = (raw && raw.trim()) || path.resolve(process.cwd(), 'tmp', 'attachments');

      // 2) Detect WSL and convert Windows paths like C:\\Users\\... to /mnt/c/Users/...
      const isWSL = process.platform === 'linux' && (
        os.release().toLowerCase().includes('microsoft') || !!process.env.WSL_DISTRO_NAME
      );
      const isWindowsPath = /^[A-Za-z]:[\\/]/.test(base);
      if (isWSL && isWindowsPath) {
        const drive = base[0].toLowerCase();
        const rest = base.slice(2).replace(/\\/g, '/');
        base = `/mnt/${drive}${rest.startsWith('/') ? '' : '/'}${rest}`;
      }

      // 3) Normalize and return
      return path.resolve(base);
    };

    const ATTACHMENTS_DIR = normalizeAttachmentsBasePath(process.env.M365_ATTACHMENT_BASE_PATH);
    // Ensure MCP Filesystem server sees a valid, normalized base path as well
    process.env.M365_ATTACHMENT_BASE_PATH = ATTACHMENTS_DIR;

    const isUnder = (base: string, target: string): boolean => {
      const rel = path.relative(base, target);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    const detectMimeType = (fileName = ''): string => {
      const ext = path.extname(fileName).toLowerCase();
      switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.csv': return 'text/csv';
        case '.xls': return 'application/vnd.ms-excel';
        case '.xlsx':
        case '.xlsm':
        case '.xlsb': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        default: return 'application/octet-stream';
      }
    };

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

    const claudeAdapter = new ClaudeAgentAdapter({
      ensureMcpClients,
      claudeSessions,
      systemPrompt: CLAUDE_APPEND_PROMPT,
      logger: console
    });

    const langGraphAdapter = new LangGraphAgentAdapter({
      ensureMcpClients,
      langGraphSystemPrompt,
      logger: console
    });

    const codexAdapter = new CodexAgentAdapter({ logger: console });

    const agentAdapters: Record<AgentBackend, AgentAdapter> = {
      langgraph: langGraphAdapter,
      claude: claudeAdapter,
      codex: codexAdapter
    };

    const isExcelAttachment = (attachment: GraphAttachment | null | undefined): boolean => {
      if (!attachment) return false;
      const name = (attachment.name || '').toLowerCase();
      const ext = path.extname(name);
      if (ext && EXCEL_EXTENSIONS.has(ext)) return true;
      const type = (attachment.contentType || '').toLowerCase();
      return EXCEL_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));
    };

    const isImageAttachment = (attachment: GraphAttachment | null | undefined): boolean => {
      if (!attachment) return false;
      const type = (attachment.contentType || '').toLowerCase();
      if (IMAGE_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return true;
      const name = (attachment.name || '').toLowerCase();
      const ext = path.extname(name);
      return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    };

    // EXIF helpers moved to srv/utils/vision.ts

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

    const formatNumberArray = (arr: unknown): unknown => {
      if (!Array.isArray(arr)) return arr;
      return arr.map((value) => (typeof value === 'number' ? Number(value.toFixed(4)) : value));
    };

    // EXIF helpers moved to srv/utils/vision.ts

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

    // Vision analysis provided by srv/utils/vision.ts (see analyzeImageAttachment)

    const ensureAttachmentDetails = async (message: GraphMessage, summaryEntry: SummaryRecord | null | undefined): Promise<void> => {
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

        if (!attachment.id || !message.id) {
          enriched.push({ ...baseInfo, error: 'attachment id or message id missing' });
          continue;
        }

        const safeName = sanitizeFileName(attachment.name || `${message.id}-${attachment.id}`);
        const targetPath = path.join(ATTACHMENTS_DIR, safeName);

        try {
          if (!existsSync(targetPath)) {
            await graph.downloadAttachment({
              messageId: message.id,
              attachmentId: attachment.id,
              targetPath
            });
          }

          if (isExcelAttachment(attachment) && !(attachment as any).isInline) {
            const excel = await loadExcelAttachmentContext(targetPath);
            enriched.push({
              ...baseInfo,
              path: targetPath,
              excel
            });
            continue;
          }

          if (isImageAttachment(attachment) && !(attachment as any).isInline) {
            const vision = await analyzeImageAttachment(targetPath);
            enriched.push({
              ...baseInfo,
              path: targetPath,
              vision
            });
            continue;
          }

          enriched.push({ ...baseInfo, path: targetPath });
        } catch (error) {
          console.warn('Failed to process attachment:', attachment.name, getErrorMessage(error));
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
        await ensureAttachmentDetails(message, summary);
      } catch (error) {
        console.warn('ensureAttachmentDetails failed:', getErrorMessage(error));
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
    if (mcpInfrastructureEnabled) {
      await graph.bootstrap(['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite']);
    } else {
      console.log('Codex backend active; skipping Microsoft 365 MCP bootstrap.');
    }

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
      if (!mcpInfrastructureEnabled) {
        return res
          .status(503)
          .json({ error: 'Microsoft 365 notifications are disabled for the Codex backend.' });
      }
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
      if (!mcpInfrastructureEnabled) {
        return res
          .status(503)
          .json({ error: 'Microsoft 365 notifications are disabled for the Codex backend.' });
      }
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

    console.log(
      `[ClaimAI] Agent backend preference: ${preferredBackend} (env: "${(process.env.CLAIMAI_AGENT_BACKEND || '').trim()}")`,
    );
    if (preferredBackend === 'langgraph') {
      await langGraphAdapter.warmup?.();
    } else if (preferredBackend === 'claude') {
      console.log('Claude Agent backend selected; initializing MCP clients without LangGraph warmup.');
      await ensureMcpClients();
    } else if (preferredBackend === 'codex') {
      console.log('Codex Agent backend selected; skipping MCP client initialization (Codex provides its own tools).');
    }

    this.on('callLLM', async (req) => {
      const { prompt: userPrompt } = (req.data ?? {}) as { prompt?: string };
      if (!userPrompt) {
        req.error(400, 'Prompt is required');
        return;
      }

      const backend = resolveAgentBackend();
      console.log(`🚀 Received prompt for ${describeAgentBackend(backend)}:`, userPrompt);
      const adapter = agentAdapters[backend];
      if (!adapter) {
        req.error(500, `No adapter configured for backend ${backend}.`);
        return;
      }
      const userId = getUserId(req as CapRequestContext);
      const capContext = buildCapContext(req as CapRequestContext);

      try {
        const response = await adapter.call({
          prompt: userPrompt,
          userId,
          capContext,
          request: req,
        });
        return { response };
      } catch (error) {
        console.error('💥 Error during agent execution:', error);
        const backendLabel =
          backend === 'claude'
            ? 'Claude Agent'
            : backend === 'codex'
              ? 'Codex agent'
              : 'LangGraph agent';
        req.error(500, `Failed to process query via ${backendLabel}: ${getErrorMessage(error)}`);
      }
    });

    this.on('triageLatestMail', async (req) => {
      const { folder, messageId } = (req.data ?? {}) as { folder?: string | null; messageId?: string | null };
      const targetFolder = typeof folder === 'string' && folder.trim().length ? folder.trim() : 'inbox';
      try {
        let message: GraphMessage | null = null;
        if (messageId && messageId.trim()) {
          try {
            const list = await graph.listMessages({ folderId: targetFolder, maxResults: 20 }) as GraphMessage[];
            message = list.find((entry) => entry.id === messageId) || null;
          } catch (error) {
            console.warn('triageLatestMail: listMessages failed, falling back to latest.', getErrorMessage(error));
          }
        }

        if (!message) {
          message = await graph.getLatestMessage({ folderId: targetFolder }) as GraphMessage | null;
        }

        if (!message) {
          req.error(404, `Keine E-Mail im Ordner "${targetFolder}" gefunden.`);
          return;
        }

        const summaryRecord = await generateSummaryForMessage(message);
        try {
          await ensureAttachmentDetails(message, summaryRecord);
        } catch (error) {
          console.warn('triageLatestMail: ensureAttachmentDetails failed', getErrorMessage(error));
        }

        return {
          summary: summaryRecord.summary,
          category: summaryRecord.category,
          agentContext: JSON.stringify(summaryRecord.agentContext ?? null)
        };
      } catch (error) {
        console.error('triageLatestMail failed:', error);
        req.error(500, `Mail-Triage fehlgeschlagen: ${getErrorMessage(error)}`);
      }
    });

    // Persist a local file from tmp/ as an attachment
    this.on('uploadLocalFile', async (req) => {
      const data = (req.data ?? {}) as { path?: string; note?: string; claimId?: string };
      const inputPath = (data.path || '').trim();
      if (!inputPath) {
        req.error(400, 'Parameter "path" ist erforderlich.');
        return;
      }

      // Resolve to absolute path and ensure it is under allowed base dirs
      const absPath = path.resolve(process.cwd(), inputPath);
      const allowed = isUnder(TMP_DIR, absPath) || isUnder(ATTACHMENTS_DIR, absPath);
      if (!allowed) {
        const tmpRel = path.relative(process.cwd(), TMP_DIR);
        const attRel = path.relative(process.cwd(), ATTACHMENTS_DIR);
        req.error(400, `Die Datei muss unter "${tmpRel}" oder "${attRel}" liegen.`);
        return;
      }

      try {
        const st = await stat(absPath);
        if (!st.isFile()) {
          req.error(400, 'Der angegebene Pfad ist keine Datei.');
          return;
        }
        const buffer = await readFile(absPath);
        const hash = createHash('sha256').update(buffer).digest('hex');
        const fileName = path.basename(absPath);
        const mediaType = detectMimeType(fileName);
        const id = cds.utils.uuid();
        const relSource = path.relative(process.cwd(), absPath);

        const row: Record<string, unknown> = {
          ID: id,
          fileName,
          mediaType,
          size: st.size,
          sha256: hash,
          sourcePath: relSource,
          note: data.note || null,
          content: buffer
        };
        if (data.claimId) {
          (row as any).refClaim_ID = data.claimId;
        }

        await INSERT.into('kfz.claims.Attachments').entries(row);
        return id;
      } catch (error) {
        console.error('uploadLocalFile failed:', error);
        req.error(500, `Upload fehlgeschlagen: ${getErrorMessage(error)}`);
      }
    });

    // Bound variant: Persist a local file to the bound Claim (draft-aware)
    this.on('uploadLocalFileToClaim', async (req) => {
      // Expect bound keys including ID and IsActiveEntity for draft context
      const bound = (Array.isArray(req.params) && req.params.length > 0) ? (req.params[0] as any) : {};
      const claimId = (bound && typeof bound.ID === 'string') ? bound.ID : null;
      const isDraftTarget = (bound && Object.prototype.hasOwnProperty.call(bound, 'IsActiveEntity')) ? (bound.IsActiveEntity === false) : false;

      const data = (req.data ?? {}) as { path?: string; note?: string };
      const inputPath = (data.path || '').trim();
      if (!claimId) {
        req.error(400, 'Bound Claim ID fehlt.');
        return;
      }
      if (!inputPath) {
        req.error(400, 'Parameter "path" ist erforderlich.');
        return;
      }

      const absPath = path.resolve(process.cwd(), inputPath);
      const allowed = isUnder(TMP_DIR, absPath) || isUnder(ATTACHMENTS_DIR, absPath);
      if (!allowed) {
        const tmpRel = path.relative(process.cwd(), TMP_DIR);
        const attRel = path.relative(process.cwd(), ATTACHMENTS_DIR);
        req.error(400, `Die Datei muss unter "${tmpRel}" oder "${attRel}" liegen.`);
        return;
      }

      try {
        const st = await stat(absPath);
        if (!st.isFile()) {
          req.error(400, 'Der angegebene Pfad ist keine Datei.');
          return;
        }
        const buffer = await readFile(absPath);
        const hash = createHash('sha256').update(buffer).digest('hex');
        const fileName = path.basename(absPath);
        const mediaType = detectMimeType(fileName);
        const id = cds.utils.uuid();
        const relSource = path.relative(process.cwd(), absPath);

        const row: Record<string, unknown> = {
          ID: id,
          fileName,
          mediaType,
          size: st.size,
          sha256: hash,
          sourcePath: relSource,
          note: data.note || null,
          content: buffer,
          refClaim_ID: claimId,
        };

        const { Attachments, Claims } = this.entities as any;
        if (isDraftTarget && Attachments?.drafts && Claims?.drafts) {
          // Fetch parent draft UUID and attach it
          const parent = await SELECT.one.from(Claims.drafts)
            .columns('DraftAdministrativeData_DraftUUID')
            .where({ ID: claimId });
          if (!parent || !parent.DraftAdministrativeData_DraftUUID) {
            req.error(404, 'Zugehöriger Claim‑Entwurf nicht gefunden.');
            return;
          }
          (row as any).IsActiveEntity = false;
          (row as any).DraftAdministrativeData_DraftUUID = parent.DraftAdministrativeData_DraftUUID;
          await INSERT.into(Attachments.drafts).entries(row);
        } else {
          await INSERT.into(Attachments).entries(row);
        }
        return id;
      } catch (error) {
        console.error('uploadLocalFileToClaim failed:', error);
        req.error(500, `Upload (gebunden) fehlgeschlagen: ${getErrorMessage(error)}`);
      }
    });

    // Queue an excel import; stores a job referencing the attachment
    this.on('importExcel', async (req) => {
      const data = (req.data ?? {}) as { fileId?: string; target?: string };
      const fileId = (data.fileId || '').trim();
      if (!fileId) {
        req.error(400, 'Parameter "fileId" ist erforderlich.');
        return;
      }
      try {
        const att = await SELECT.one.from('kfz.claims.Attachments')
          .columns('ID', 'fileName', 'mediaType', 'size', 'sha256', 'sourcePath')
          .where({ ID: fileId });
        if (!att) {
          req.error(404, `Attachment ${fileId} nicht gefunden.`);
          return;
        }
        const importId = cds.utils.uuid();
        const logText = `Queued excel import${data.target ? ` for target=${data.target}` : ''} at ${new Date().toISOString()}`;
        await INSERT.into('kfz.claims.ExcelImports').entries({
          ID: importId,
          fileName: att.fileName,
          mediaType: att.mediaType,
          size: att.size,
          sha256: att.sha256,
          sourcePath: att.sourcePath,
          attachment_ID: fileId,
          status: 'NEW',
          rowsImported: 0,
          log: logText
        });
        return importId;
      } catch (error) {
        console.error('importExcel failed:', error);
        req.error(500, `importExcel fehlgeschlagen: ${getErrorMessage(error)}`);
      }
    });

    // Before updating media stream: buffer it and compute size/sha256 (avoid overlapping DB ops)
    const toBuffer = async (streamOrBuf: any): Promise<Buffer> => {
      if (Buffer.isBuffer(streamOrBuf)) return streamOrBuf as Buffer;
      if (streamOrBuf && typeof streamOrBuf === 'object' && typeof streamOrBuf.on === 'function') {
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          streamOrBuf.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          streamOrBuf.on('end', () => resolve());
          streamOrBuf.on('error', (err: unknown) => reject(err));
        });
        return Buffer.concat(chunks);
      }
      // Fallback: attempt to coerce
      try { return Buffer.from(streamOrBuf); } catch { return Buffer.alloc(0); }
    };

    this.before('UPDATE', 'Attachments', async (req) => {
      try {
        const hasContent = req.data && Object.prototype.hasOwnProperty.call(req.data, 'content');
        if (!hasContent) return;
        const buf = await toBuffer((req.data as any).content);
        const size = buf.length;
        const sha = createHash('sha256').update(buf).digest('hex');
        const mt = (req.data as any).mediaType || detectMimeType((req.data as any).fileName || '');
        (req.data as any).content = buf;
        (req.data as any).size = size;
        (req.data as any).sha256 = sha;
        if (!(req.data as any).mediaType) (req.data as any).mediaType = mt;
      } catch (e) {
        console.warn('before UPDATE Attachments: failed to buffer stream', getErrorMessage(e));
      }
    });

    this.on('EXIT', async () => {
      if (mcpInfrastructureEnabled) {
        console.log('Shutting down MCP clients...');
      } else {
        console.log('Codex backend active; no MCP clients were initialized.');
      }
      for (const session of notificationSessions.values()) {
        if (session.timer) {
          clearInterval(session.timer);
        }
      }
      notificationSessions.clear();
      await graph.close();
      if (mcpInfrastructureEnabled) {
        await closeMCPClients();
      }
      await codexAdapter.shutdown?.();
    });
  }
}
