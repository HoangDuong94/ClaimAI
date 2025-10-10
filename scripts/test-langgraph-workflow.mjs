#!/usr/bin/env node

/**
 * LangGraph prototype that replays the ClaimAI mail workflow:
 *  - fetch latest message (or specific id)
 *  - summarize + categorize with GPT-4.1
 *  - enrich attachments via Excel MCP + GPT-4.1 Vision
 *  - emit agentContext JSON
 *
 * Usage: node scripts/test-langgraph-workflow.mjs [--message <id>] [--folder <name>]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StateGraph, START, END } from '@langchain/langgraph';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);

const DEFAULT_IMAGE_PROMPT = 'Beschreibe den sichtbaren Schaden in höchstens drei Sätzen. Falls erkennbar: Fahrzeugtyp, betroffene Bauteile, Umfeld. Nutze EXIF-Informationen nicht direkt in deiner Beschreibung.';
const TMP_ATTACHMENTS_DIR = path.resolve(process.cwd(), 'tmp', 'workflow_attachments');
const DOTENV_PATH = path.resolve(process.cwd(), '.env');

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

const TAG_NAMES = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9209: 'Flash',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension'
};

const TYPE_SIZES = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8
};

class GraphClient {
  constructor(options = {}) {
    const {
      authMethod = process.env.M365_AUTH_METHOD || 'cli',
      cliCommand = process.env.M365_CLI_COMMAND || 'm365',
      logger = console,
      tokenTtlMs = 5 * 60 * 1000
    } = options;

    this.authMethod = authMethod;
    this.cliCommand = cliCommand;
    this.logger = logger;
    this.tokenTtlMs = tokenTtlMs;
    this.tokenCache = new Map();
    this.closed = false;
    this.scopesOptionSupported = true;
  }

  async bootstrap(scopes = ['Mail.Read']) {
    this.logger.log?.('GraphClient bootstrap...');
    await this.getAccessToken(scopes);
    this.logger.log?.('GraphClient bereit.');
  }

  async close() {
    this.closed = true;
    this.tokenCache.clear();
  }

  async getAccessToken(scopes = []) {
    if (this.closed) {
      throw new Error('GraphClient wurde bereits geschlossen');
    }
    if (this.authMethod !== 'cli') {
      throw new Error(`Unterstützte Auth-Methode: cli. Angefragt: ${this.authMethod}`);
    }
    const normalized = Array.isArray(scopes) ? [...scopes].sort() : [];
    const cacheKey = normalized.join(' ');
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const cliArgs = ['util', 'accesstoken', 'get', '--resource', 'https://graph.microsoft.com'];
    if (normalized.length && this.scopesOptionSupported) {
      cliArgs.push('--scope', normalized.join(','));
    }

    try {
      const execOptions = {
        env: process.env,
        maxBuffer: 1024 * 1024
      };
      if (process.platform === 'win32') {
        const lower = this.cliCommand.toLowerCase();
        if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
          execOptions.shell = process.env.ComSpec || 'cmd.exe';
        }
      }
      const { stdout } = await execFileAsync(this.cliCommand, cliArgs, execOptions);
      const token = stdout.trim();
      if (!token) {
        throw new Error('m365 CLI lieferte keinen Access Token. Bitte "m365 login" ausführen.');
      }
      this.tokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + this.tokenTtlMs
      });
      return token;
    } catch (error) {
      const err = error;
      const errorMessage = String(err?.stderr || err?.message || err);
      if (normalized.length && this.scopesOptionSupported && /Invalid option: 'scopes?'/i.test(errorMessage)) {
        this.logger.warn?.('m365 CLI unterstützt "--scope" nicht. Verwende Standard-Scopes.');
        this.scopesOptionSupported = false;
        return this.getAccessToken([]);
      }
      if (err?.code === 'ENOENT') {
        throw new Error(`m365 CLI (${this.cliCommand}) nicht gefunden. Installation mit "npm i -g @pnp/cli-microsoft365".`);
      }
      throw new Error(`Tokenabruf fehlgeschlagen: ${err?.message || err}`);
    }
  }

  async request(method, relativePath, { query = {}, headers = {}, body, scopes = [] } = {}) {
    if (this.closed) {
      throw new Error('GraphClient ist geschlossen');
    }
    const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0/';
    const url = new URL(relativePath.replace(/^\//, ''), GRAPH_BASE_URL);
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });

    const accessToken = await this.getAccessToken(scopes);
    const baseHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    };
    const requestHeaders = { ...baseHeaders, ...headers };
    const requestInit = {
      method,
      headers: requestHeaders
    };

    if (body !== undefined) {
      requestInit.body = typeof body === 'string' ? body : JSON.stringify(body);
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, requestInit);
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Graph-Request fehlgeschlagen (${response.status} ${response.statusText}): ${errorBody}`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async getLatestMessage({ folderId = 'inbox' } = {}) {
    const data = await this.request(
      'GET',
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
      {
        query: {
          '$top': '1',
          '$orderby': 'receivedDateTime desc',
          '$select': 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,bodyPreview,body,isRead,webLink',
          '$expand': 'attachments($select=id,name,contentType,size,isInline)'
        },
        scopes: ['Mail.Read']
      }
    );
    const message = Array.isArray(data.value) && data.value.length ? data.value[0] : null;
    if (!message) {
      return null;
    }
    return this.normalizeMessage(message);
  }

  async listMessages({ folderId = 'inbox', maxResults = 20, onlyUnread = false } = {}) {
    const safeTop = Number.isInteger(maxResults) ? Math.min(Math.max(maxResults, 1), 50) : 20;
    const filterParts = [];
    if (onlyUnread) filterParts.push('isRead eq false');
    const query = {
      '$orderby': 'receivedDateTime desc',
      '$top': String(safeTop),
      '$select': 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments,bodyPreview,isRead,webLink',
      '$expand': 'attachments($select=id,name,contentType,size,isInline)'
    };
    if (filterParts.length) {
      query['$filter'] = filterParts.join(' and ');
    }
    const data = await this.request(
      'GET',
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
      {
        query,
        scopes: ['Mail.Read']
      }
    );
    return (data.value || []).map((message) => this.normalizeMessage(message));
  }

  async downloadAttachment({ messageId, attachmentId, targetPath }) {
    if (!messageId || !attachmentId || !targetPath) {
      throw new Error('messageId, attachmentId und targetPath sind erforderlich.');
    }
    const binary = await this.request(
      'GET',
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
      {
        scopes: ['Mail.Read'],
        headers: { Accept: 'application/octet-stream' }
      }
    );
    const directory = path.dirname(targetPath);
    if (!existsSync(directory)) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(targetPath, binary);
    return { targetPath };
  }

  normalizeMessage(message) {
    return {
      id: message.id,
      subject: message.subject,
      from: message.from?.emailAddress || null,
      toRecipients: (message.toRecipients || []).map((entry) => entry.emailAddress),
      ccRecipients: (message.ccRecipients || []).map((entry) => entry.emailAddress),
      receivedDateTime: message.receivedDateTime,
      isRead: Boolean(message.isRead),
      webLink: message.webLink,
      hasAttachments: Boolean(message.hasAttachments),
      bodyPreview: message.bodyPreview || null,
      body: message.body
        ? {
            contentType: message.body.contentType,
            content: message.body.content
          }
        : null,
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            isInline: attachment.isInline
          }))
        : []
    };
  }
}

const stateSchema = z.object({
  folder: z.string().default('inbox'),
  messageId: z.string().nullable().default(null),
  message: z.any().nullable().default(null),
  summaryRecord: z
    .object({
      summary: z.string(),
      category: z.string(),
      agentContext: z.any()
    })
    .nullable()
    .default(null)
});

await loadEnvFromFile(DOTENV_PATH);
await ensureAttachmentDir();

const args = parseArgs(process.argv.slice(2));

const graphClient = new GraphClient({ logger: console });
const summarizer = new AzureOpenAiChatClient({ modelName: 'gpt-4.1', max_tokens: 512 });
const visionClient = new AzureOpenAiChatClient({ modelName: 'gpt-4.1', max_tokens: 400 });
let excelClient = null;

const workflow = new StateGraph(stateSchema)
  .addNode('fetchMail', fetchMailNode)
  .addNode('summarize', summarizeNode)
  .addNode('enrichAttachments', enrichAttachmentsNode)
  .addEdge(START, 'fetchMail')
  .addEdge('fetchMail', 'summarize')
  .addEdge('summarize', 'enrichAttachments')
  .addEdge('enrichAttachments', END);

const app = workflow.compile();

let output = null;

try {
  await graphClient.bootstrap(['Mail.Read', 'Mail.ReadWrite']);
  const result = await app.invoke({
    folder: args.folder,
    messageId: args.message
  });
  output = result;
} finally {
  await graphClient.close();
  if (excelClient) {
    try {
      await excelClient.close();
    } catch {
      // ignore
    }
  }
}

if (!output?.summaryRecord) {
  console.log('Keine E-Mail verarbeitet.');
  process.exit(0);
}

console.log('\n=== LangGraph Mail Workflow Ergebnis ===');
console.log(JSON.stringify({
  summary: output.summaryRecord.summary,
  category: output.summaryRecord.category,
  agentContext: output.summaryRecord.agentContext
}, null, 2));

// --------------------------
// LangGraph Node Implementations
// --------------------------

async function fetchMailNode(state) {
  const { folder, messageId } = state;
  const targetFolder = folder || 'inbox';
  let message = null;
  if (messageId) {
    const list = await graphClient.listMessages({ folderId: targetFolder, maxResults: 20 });
    message = list.find((entry) => entry.id === messageId) || null;
  }
  if (!message) {
    message = await graphClient.getLatestMessage({ folderId: targetFolder });
  }
  if (!message) {
    console.log('Keine Nachricht gefunden.');
    return { message: null };
  }
  console.log(`[LangGraph] Nachricht geladen: ${message.subject || '(ohne Betreff)'}`);
  return { message };
}

async function summarizeNode(state) {
  if (!state.message) {
    return { summaryRecord: null };
  }
  const summaryRecord = await generateSummaryForMessage(state.message);
  console.log(`[LangGraph] Zusammenfassung: ${summaryRecord.summary}`);
  return { summaryRecord };
}

async function enrichAttachmentsNode(state) {
  if (!state.message || !state.summaryRecord) {
    return state;
  }
  await ensureAttachmentEnrichment(state.message, state.summaryRecord);
  console.log('[LangGraph] Anhänge angereichert.');
  return { summaryRecord: state.summaryRecord };
}

// --------------------------
// Helper functions (shared with run-mail-workflow.mjs)
// --------------------------

async function loadEnvFromFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    raw
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .forEach((line) => {
        const idx = line.indexOf('=');
        if (idx === -1) return;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key && (process.env[key] === undefined || process.env[key] === '')) {
          process.env[key] = value;
        }
      });
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('Konnte .env nicht laden:', error.message || error);
    }
  }
}

function parseArgs(argv) {
  const params = { folder: 'inbox', message: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--folder' && argv[i + 1]) {
      params.folder = argv[++i];
    } else if (token === '--message' && argv[i + 1]) {
      params.message = argv[++i];
    }
  }
  return params;
}

async function ensureAttachmentDir() {
  if (!existsSync(TMP_ATTACHMENTS_DIR)) {
    await mkdir(TMP_ATTACHMENTS_DIR, { recursive: true });
  }
}

function extractMessageContent(message) {
  if (!message) return '';
  const body = message.body;
  if (body?.content) {
    const raw = body.contentType === 'html' ? stripHtml(body.content) : body.content;
    return normalizeWhitespace(raw);
  }
  if (message.bodyPreview) {
    return normalizeWhitespace(message.bodyPreview);
  }
  return '';
}

function stripHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeWhitespace(text = '') {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text = '', maxLength = SUMMARY_MAX_OUTPUT_CHARS) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function extractMailParticipant(entry) {
  if (!entry) return null;
  const emailAddress = (entry.emailAddress || entry);
  const address = emailAddress.address || emailAddress.emailAddress || emailAddress.value || entry.address || null;
  const name = emailAddress.name || emailAddress.displayName || entry.name || entry.displayName || null;
  const formatted = name && address ? `${name} <${address}>` : (name || address || null);
  if (!formatted) return null;
  return { name, email: address, formatted };
}

function mapRecipients(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(extractMailParticipant)
    .filter(Boolean)
    .map((participant) => participant.formatted);
}

function mapRecipientDetails(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(extractMailParticipant)
    .filter(Boolean)
    .map((participant) => ({
      name: participant.name || null,
      email: participant.email || null
    }));
}

function sanitizeEmailHtml(message) {
  if (!message?.body?.content) return null;
  const { content, contentType } = message.body;
  if (!content) return null;
  if (contentType === 'html') {
    let sanitized = content;
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
  }
  const plain = typeof content === 'string' ? content : String(content);
  return `<pre>${escapeHtml(plain)}</pre>`;
}

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildAgentContext(message, summary, category) {
  const content = extractMessageContent(message) || '';
  const bodyPreview = normalizeWhitespace(message.bodyPreview || '').slice(0, SUMMARY_MAX_OUTPUT_CHARS);
  const sender = extractMailParticipant(message.from);
  const from = sender?.formatted || null;
  const toDetails = mapRecipientDetails(message.toRecipients);
  const ccDetails = mapRecipientDetails(message.ccRecipients);
  const bodyHtml = sanitizeEmailHtml(message);
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
}

function extractModelOutput(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (typeof result.text === 'string') return result.text;
  return '';
}

function finalizeSummaryResult(message, summaryText, categoryText) {
  const fallback = message.bodyPreview?.trim() || SUMMARY_FALLBACK;
  const normalizedSummary = normalizeWhitespace(summaryText || fallback);
  const truncated = truncate(normalizedSummary || fallback, SUMMARY_MAX_OUTPUT_CHARS);
  const normalizedCategory = typeof categoryText === 'string' && SUMMARY_CATEGORIES.includes(categoryText)
    ? categoryText
    : DEFAULT_CATEGORY;
  const agentContext = buildAgentContext(message, truncated || fallback, normalizedCategory);
  return { summary: truncated || fallback, category: normalizedCategory, agentContext };
}

async function generateSummaryForMessage(message) {
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
        content: 'Du bist ein Assistent, der eingehende E-Mails prägnant zusammenfasst und kategorisiert. Antworte ausschließlich mit gültigem JSON im Format {"summary":"...","category":"..."}.'
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
    } catch {
      parsed = null;
    }

    if (parsed && typeof parsed === 'object') {
      const summaryCandidate = typeof parsed.summary === 'string' ? parsed.summary : null;
      const categoryCandidate = typeof parsed.category === 'string' ? parsed.category : DEFAULT_CATEGORY;
      return finalizeSummaryResult(message, summaryCandidate, categoryCandidate);
    }

    return finalizeSummaryResult(message, rawContent, DEFAULT_CATEGORY);
  } catch (error) {
    console.warn('Zusammenfassung fehlgeschlagen:', error);
    return finalizeSummaryResult(message, message.bodyPreview, DEFAULT_CATEGORY);
  }
}

function sanitizeFileName(name = '') {
  const safe = name.replace(/[^a-z0-9_.-]+/gi, '_').replace(/_+/g, '_').trim();
  if (safe) return safe;
  return `attachment_${Date.now()}`;
}

function isExcelAttachment(attachment) {
  if (!attachment) return false;
  const name = (attachment.name || '').toLowerCase();
  const ext = path.extname(name);
  if (ext && EXCEL_EXTENSIONS.has(ext)) return true;
  const type = (attachment.contentType || '').toLowerCase();
  return EXCEL_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function isImageAttachment(attachment) {
  if (!attachment) return false;
  const type = (attachment.contentType || '').toLowerCase();
  if (IMAGE_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return true;
  const name = (attachment.name || '').toLowerCase();
  const ext = path.extname(name);
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
}

async function ensureAttachmentEnrichment(message, summaryRecord) {
  if (!summaryRecord?.agentContext) return;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return;

  const enriched = [];
  for (const attachment of attachments) {
    const baseInfo = {
      id: attachment.id || null,
      name: attachment.name || null,
      contentType: attachment.contentType || null,
      size: attachment.size ?? null,
      isInline: Boolean(attachment.isInline)
    };

    if (!attachment.id || !message.id) {
      enriched.push({ ...baseInfo, error: 'attachment id oder message id fehlt' });
      continue;
    }

    const safeName = sanitizeFileName(attachment.name || `${message.id}-${attachment.id}`);
    const targetPath = path.join(TMP_ATTACHMENTS_DIR, safeName);

    try {
      await graphClient.downloadAttachment({
        messageId: message.id,
        attachmentId: attachment.id,
        targetPath
      });
    } catch (error) {
      enriched.push({ ...baseInfo, error: `Download fehlgeschlagen: ${error?.message || error}` });
      continue;
    }

    if (isExcelAttachment(attachment) && !attachment.isInline) {
      const excelDetails = await loadExcelAttachmentContext(targetPath);
      enriched.push({ ...baseInfo, path: targetPath, excel: excelDetails });
      continue;
    }

    if (isImageAttachment(attachment) && !attachment.isInline) {
      const vision = await analyzeImageAttachment(targetPath);
      enriched.push({ ...baseInfo, path: targetPath, vision });
      continue;
    }

    enriched.push({ ...baseInfo, path: targetPath });
  }

  summaryRecord.agentContext.attachments = enriched;
}

async function ensureExcelClient() {
  if (excelClient) return excelClient;
  console.log('Starte Excel MCP Server...');
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'cmd' : 'npx',
    args: process.platform === 'win32'
      ? ['/c', 'npx', '--yes', '@negokaz/excel-mcp-server']
      : ['--yes', '@negokaz/excel-mcp-server'],
    env: sanitizeEnv({ EXCEL_MCP_PAGING_CELLS_LIMIT: '4000' })
  });
  excelClient = new Client({ name: 'excel-client', version: '1.0.0' }, {});
  await excelClient.connect(transport);
  console.log('Excel MCP Client verbunden.');
  return excelClient;
}

function sanitizeEnv(overrides = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    } else if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

async function loadExcelAttachmentContext(fileAbsolutePath) {
  try {
    const excel = await ensureExcelClient();
    const describe = await excel.callTool({
      name: 'excel_describe_sheets',
      arguments: { fileAbsolutePath }
    });
    const sheets = await readExcelSheets(excel, fileAbsolutePath, extractSheetNames(describe));
    return { describe, sheets };
  } catch (error) {
    return { error: error?.message || error };
  }
}

function extractSheetNames(describeResult) {
  if (!describeResult) return [];
  if (Array.isArray(describeResult)) {
    return describeResult
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === 'string') return entry;
        if (typeof entry?.name === 'string') return entry.name;
        if (typeof entry?.sheetName === 'string') return entry.sheetName;
        return null;
      })
      .filter((value) => typeof value === 'string' && value.length > 0);
  }
  const record = describeResult;
  const sheets = record.sheets;
  if (Array.isArray(sheets)) {
    return sheets
      .map((sheet) => {
        if (!sheet) return null;
        if (typeof sheet === 'string') return sheet;
        if (typeof sheet?.name === 'string') return sheet.name;
        if (typeof sheet?.sheetName === 'string') return sheet.sheetName;
        return null;
      })
      .filter((value) => typeof value === 'string' && value.length > 0);
  }
  if (typeof record.sheetName === 'string') {
    return [record.sheetName];
  }
  const sheetNames = record.sheetNames;
  if (Array.isArray(sheetNames)) {
    return sheetNames.filter((name) => typeof name === 'string' && Boolean(name));
  }
  return [];
}

async function readExcelSheets(excel, fileAbsolutePath, sheetNames = []) {
  const sheets = [];
  for (const sheetName of sheetNames) {
    try {
      const sheetData = await excel.callTool({
        name: 'excel_read_sheet',
        arguments: {
          fileAbsolutePath,
          sheetName
        }
      });
      sheets.push({ sheetName, data: sheetData });
    } catch (error) {
      sheets.push({ sheetName, error: error?.message || error });
    }
  }
  return sheets;
}

async function analyzeImageAttachment(fileAbsolutePath) {
  try {
    const buffer = await readFile(fileAbsolutePath);
    const base64Image = buffer.toString('base64');
    const exif = extractExifMetadata(buffer);
    const systemMessage = new SystemMessage({
      content: 'Du analysierst Schadenfotos und antwortest kompakt auf Deutsch.'
    });
    const humanMessage = new HumanMessage({
      content: [
        { type: 'text', text: DEFAULT_IMAGE_PROMPT },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64Image}`
          }
        }
      ]
    });
    const response = await visionClient.invoke([systemMessage, humanMessage]);
    let description = '';
    if (Array.isArray(response.content)) {
      description = response.content
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n')
        .trim();
    } else if (typeof response.content === 'string') {
      description = response.content.trim();
    }
    return { description, exif };
  } catch (error) {
    return { error: error?.message || error };
  }
}

function extractExifMetadata(buffer) {
  if (!isPng(buffer)) return {};
  const exifChunk = readPngExifChunk(buffer);
  if (!exifChunk) return {};
  return parseExifBuffer(exifChunk);
}

function isPng(buffer) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer.slice(0, 8).equals(pngSignature);
}

function readPngExifChunk(buffer) {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break;
    if (type === 'eXIf') {
      return buffer.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + 4;
  }
  return null;
}

function parseExifBuffer(buffer) {
  if (!buffer || buffer.length < 12) return {};
  const header = buffer.toString('ascii', 0, 4);
  if (header !== 'Exif') {
    return {};
  }
  const tiffBase = 6;
  const endianMarker = buffer.toString('ascii', tiffBase, tiffBase + 2);
  const littleEndian = endianMarker === 'II';

  const readUInt16 = (offset) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const readInt32 = (offset) => (littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset));
  const readUInt32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));

  const data = {};
  const firstIfdOffset = readUInt32(tiffBase + 4);
  processIfd(tiffBase + firstIfdOffset, 'IFD0');
  return data;

  function processIfd(offset, section) {
    if (!offset || offset < tiffBase || offset >= buffer.length) return;
    if (offset + 2 > buffer.length) return;
    const entryCount = readUInt16(offset);
    let cursor = offset + 2;
    if (entryCount === 0 || cursor + entryCount * 12 > buffer.length) return;
    const sectionData = data[section] || (data[section] = {});

    for (let i = 0; i < entryCount; i++, cursor += 12) {
      const tag = readUInt16(cursor);
      const type = readUInt16(cursor + 2);
      const count = readUInt32(cursor + 4);
      const valueOffset = cursor + 8;
      const tagName = TAG_NAMES[tag] || `Tag_0x${tag.toString(16)}`;
      const value = readTagValue({ tag, type, count, valueOffset });
      if (value !== undefined) {
        sectionData[tagName] = formatNumberArray(value);
      }
    }
  }

  function readTagValue({ type, count, valueOffset }) {
    const typeSize = TYPE_SIZES[type];
    if (!typeSize || count <= 0) return undefined;
    const byteLength = typeSize * count;
    let dataOffset;

    if (byteLength <= 4) {
      dataOffset = valueOffset;
    } else {
      const relativeOffset = readUInt32(valueOffset);
      dataOffset = tiffBase + relativeOffset;
    }
    if (dataOffset < 0 || dataOffset + byteLength > buffer.length) return undefined;

    const slice = buffer.subarray(dataOffset, dataOffset + byteLength);
    switch (type) {
      case 1:
      case 7:
        return Array.from(slice.values());
      case 2: {
        const str = slice.toString('utf8').replace(/\0+$/, '').trim();
        return str.length ? str : undefined;
      }
      case 3: {
        const values = [];
        for (let i = 0; i < count; i++) {
          values.push(readUInt16(dataOffset + i * 2));
        }
        return count === 1 ? values[0] : values;
      }
      case 4: {
        const values = [];
        for (let i = 0; i < count; i++) {
          values.push(readUInt32(dataOffset + i * 4));
        }
        return count === 1 ? values[0] : values;
      }
      case 5: {
        const values = [];
        for (let i = 0; i < count; i++) {
          const numerator = readUInt32(dataOffset + i * 8);
          const denominator = readUInt32(dataOffset + i * 8 + 4);
          values.push(denominator ? numerator / denominator : null);
        }
        return count === 1 ? values[0] : values;
      }
      case 9: {
        const values = [];
        for (let i = 0; i < count; i++) {
          values.push(readInt32(dataOffset + i * 4));
        }
        return count === 1 ? values[0] : values;
      }
      case 10: {
        const values = [];
        for (let i = 0; i < count; i++) {
          const numerator = readInt32(dataOffset + i * 8);
          const denominator = readInt32(dataOffset + i * 8 + 4);
          values.push(denominator ? numerator / denominator : null);
        }
        return count === 1 ? values[0] : values;
      }
      default:
        return undefined;
    }
  }
}

function formatNumberArray(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.map((value) => (typeof value === 'number' ? Number(value.toFixed(4)) : value));
}
