// srv/m365-mcp/graph-client.ts
// Thin wrapper around the Microsoft Graph API using the m365 CLI for authentication.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const GRAPH_RESOURCE = 'https://graph.microsoft.com';
const GRAPH_BASE_URL = `${GRAPH_RESOURCE}/v1.0`;
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

interface LoggerLike {
  log?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface GraphClientOptions {
  authMethod?: string;
  cliCommand?: string;
  logger?: LoggerLike;
  tokenTtlMs?: number;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

interface RequestOptions {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  scopes?: string[];
}

interface LatestMessageInput {
  folderId?: string;
}

interface ReplyToMessageInput {
  messageId: string;
  comment?: string;
  body?: string;
  contentType?: string;
  replyAll?: boolean;
}

interface DownloadAttachmentInput {
  messageId: string;
  attachmentId: string;
  targetPath: string;
}

interface ListMessagesInput {
  folderId?: string;
  startDateTime?: string;
  endDateTime?: string;
  maxResults?: number;
  onlyUnread?: boolean;
}

interface CalendarEventsInput {
  startDateTime: string;
  endDateTime: string;
}

interface CreateCalendarEventInput {
  subject: string;
  body?: string;
  contentType?: string;
  startDateTime: string;
  endDateTime: string;
  timezone?: string;
  attendees?: Array<string | Record<string, any>>;
  teams?: boolean;
  location?: unknown;
  reminderMinutesBeforeStart?: number;
  allowNewTimeProposals?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
}

export class GraphClient {
  private readonly authMethod: string;
  private readonly cliCommand: string;
  private readonly logger: LoggerLike;
  private readonly tokenTtlMs: number;
  private readonly tokenCache: Map<string, TokenCacheEntry>;
  private closed: boolean;
  private scopesOptionSupported: boolean;

  constructor(options: GraphClientOptions = {}) {
    const {
      authMethod = process.env.M365_AUTH_METHOD || 'cli',
      // On Windows, the CLI executable is a CMD shim. Prefer it by default.
      cliCommand = process.env.M365_CLI_COMMAND || (process.platform === 'win32' ? 'm365.cmd' : 'm365'),
      logger = console,
      tokenTtlMs = DEFAULT_TOKEN_TTL_MS
    } = options;

    this.authMethod = authMethod;
    this.cliCommand = cliCommand;
    this.logger = logger;
    this.tokenTtlMs = tokenTtlMs;
    this.tokenCache = new Map<string, TokenCacheEntry>();
    this.closed = false;
    this.scopesOptionSupported = true;
  }

  async bootstrap(scopes: string[] = ['Mail.Read']): Promise<void> {
    this.logger.log?.('Initializing Microsoft 365 in-process MCP client...');
    try {
      await this.getAccessToken(scopes);
      this.logger.log?.('✅ Microsoft 365 MCP client initialized successfully.');
    } catch (error) {
      const err = error as Error;
      this.logger.error?.('❌ Failed to initialize Microsoft 365 MCP client:', err.message);
      throw err;
    }
  }

  async getAccessToken(scopes: string[] = []): Promise<string> {
    if (this.closed) {
      throw new Error('GraphClient is closed');
    }
    if (this.authMethod !== 'cli') {
      throw new Error(`Unsupported M365 auth method: ${this.authMethod}`);
    }

    const normalizedScopes = Array.isArray(scopes) ? [...scopes].sort() : [];
    const cacheKey = normalizedScopes.join(' ');
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const cliArgs = ['util', 'accesstoken', 'get', '--resource', GRAPH_RESOURCE];
    if (normalizedScopes.length && this.scopesOptionSupported) {
      cliArgs.push('--scope', normalizedScopes.join(','));
    }

    try {
      const execOptions: Record<string, unknown> = {
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
        throw new Error('m365 CLI returned an empty access token. Ensure you are logged in with "m365 login".');
      }
      this.tokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + this.tokenTtlMs
      });
      return token;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string };
      const errorMessage = String(err?.stderr || err?.message || err);
      if (normalizedScopes.length && this.scopesOptionSupported && /Invalid option: 'scopes?'/.test(errorMessage)) {
        this.logger.warn?.('m365 CLI does not support the --scope option. Falling back to default Graph scopes.');
        this.scopesOptionSupported = false;
        return this.getAccessToken([]);
      }
      // Windows fallback: if "m365" wasn't found, retry with "m365.cmd" via cmd.exe
      if (err?.code === 'ENOENT') {
        if (process.platform === 'win32') {
          const lower = this.cliCommand.toLowerCase();
          const looksBare = !/[.](cmd|bat|exe)$/.test(lower);
          if (looksBare) {
            const retryCommand = `${this.cliCommand}.cmd`;
            try {
              const { stdout } = await execFileAsync(
                retryCommand,
                cliArgs,
                { env: process.env, maxBuffer: 1024 * 1024, shell: process.env.Comspec || process.env.ComSpec || 'cmd.exe' }
              );
              const token = stdout.trim();
              if (!token) {
                throw new Error('m365 CLI returned an empty access token. Ensure you are logged in with "m365 login".');
              }
              this.tokenCache.set(cacheKey, {
                token,
                expiresAt: Date.now() + this.tokenTtlMs
              });
              return token;
            } catch (retryErr) {
              // Fall through to unified error below
              const re = retryErr as NodeJS.ErrnoException & { message?: string };
              throw new Error(`Could not find or execute the m365 CLI (tried: ${this.cliCommand}, ${retryCommand}). ${re?.message || re}`);
            }
          }
        }
        throw new Error(`Could not find the m365 CLI (${this.cliCommand}). Install it via "npm i -g @pnp/cli-microsoft365".`);
      }
      throw new Error(`Failed to acquire Microsoft Graph token via m365 CLI: ${err?.message}`);
    }
  }

  async request<T = any>(method: string, relativePath: string, { query = {}, headers = {}, body, scopes = [] }: RequestOptions = {}): Promise<T> {
    if (this.closed) {
      throw new Error('GraphClient is closed');
    }

    const url = new URL(relativePath.replace(/^\//, ''), `${GRAPH_BASE_URL}/`);
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });

    const accessToken = await this.getAccessToken(scopes);
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    };

    const requestHeaders: Record<string, string> = { ...baseHeaders, ...headers };
    const requestInit: RequestInit = {
      method,
      headers: requestHeaders
    };

    if (body !== undefined) {
      requestInit.body = typeof body === 'string' ? body : JSON.stringify(body);
      requestHeaders['Content-Type'] = 'application/json';
    }

    // this.logger.debug?.(`Graph request ${method} ${url} with body ${safeJson(body)}`);

    const response = await fetch(url, requestInit);
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Graph request failed (${response.status} ${response.statusText}): ${errorBody}`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }
    return Buffer.from(await response.arrayBuffer()) as T;
  }

  async getMessageById(messageId: string): Promise<{ id: string; subject?: string } | null> {
    if (!messageId) return null;
    const data = await this.request<any>(
      'GET',
      `/me/messages/${encodeURIComponent(messageId)}`,
      {
        query: {
          '$select': 'id,subject'
        },
        scopes: ['Mail.Read']
      }
    );
    if (!data || !data.id) return null;
    return { id: data.id, subject: data.subject };
  }

  async getLatestMessage({ folderId = 'inbox' }: LatestMessageInput = {}) {
    const data = await this.request<any>(
      'GET',
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
      {
        query: {
          '$top': '1',
          '$orderby': 'receivedDateTime desc',
          '$select': 'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,hasAttachments,bodyPreview,body,isRead,webLink',
          '$expand': 'attachments($select=id,name,contentType,size,isInline)'
        },
        scopes: ['Mail.Read']
      }
    );
    const message = Array.isArray(data.value) && data.value.length ? data.value[0] : null;
    if (!message) {
      return null;
    }
    return {
      id: message.id,
      subject: message.subject,
      from: message.from?.emailAddress || null,
      toRecipients: (message.toRecipients || []).map((entry: any) => entry.emailAddress),
      ccRecipients: Array.isArray(message.ccRecipients)
        ? message.ccRecipients.map((entry: any) => entry.emailAddress)
        : [],
      bccRecipients: Array.isArray(message.bccRecipients)
        ? message.bccRecipients.map((entry: any) => entry.emailAddress)
        : [],
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
        ? message.attachments.map((attachment: any) => ({
            id: attachment.id,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            isInline: attachment.isInline
          }))
        : []
    };
  }

  async replyToMessage({ messageId, comment = '', body, contentType = 'Text', replyAll = false }: ReplyToMessageInput) {
    if (!messageId) {
      throw new Error('messageId is required to reply to a mail.');
    }

    const normalizedType = (contentType || 'Text').toUpperCase() === 'HTML' ? 'HTML' : 'Text';
    const payload: Record<string, unknown> = {
      comment: comment ?? ''
    };

    if (body) {
      payload.message = {
        body: {
          contentType: normalizedType,
          content: body
        }
      };
    }

    const endpoint = replyAll
      ? `/me/messages/${encodeURIComponent(messageId)}/replyAll`
      : `/me/messages/${encodeURIComponent(messageId)}/reply`;

    await this.request('POST', endpoint, {
      body: payload,
      scopes: ['Mail.Send']
    });

    return {
      status: 'sent',
      replyAll: Boolean(replyAll)
    };
  }

  async downloadAttachment({ messageId, attachmentId, targetPath }: DownloadAttachmentInput) {
    if (!messageId || !attachmentId || !targetPath) {
      throw new Error('messageId, attachmentId and targetPath are required for attachment download.');
    }

    let resolvedTargetPath = targetPath;
    const baseDirectory = process.env.M365_ATTACHMENT_BASE_PATH;
    if (!path.isAbsolute(resolvedTargetPath)) {
      resolvedTargetPath = baseDirectory
        ? path.resolve(baseDirectory, resolvedTargetPath)
        : path.resolve(resolvedTargetPath);
    }

    const attachmentBinary = await this.request<Buffer>(
      'GET',
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
      {
        scopes: ['Mail.Read'],
        headers: {
          Accept: 'application/octet-stream'
        }
      }
    );

    const directory = path.dirname(resolvedTargetPath);
    if (!existsSync(directory)) {
      await mkdir(directory, { recursive: true });
    }

    await writeFile(resolvedTargetPath, attachmentBinary);

    const bytesWritten = typeof attachmentBinary.length === 'number'
      ? attachmentBinary.length
      : (attachmentBinary.byteLength || 0);

    return {
      messageId,
      attachmentId,
      targetPath: resolvedTargetPath,
      bytesWritten
    };
  }

  async listMessages({ folderId = 'inbox', startDateTime, endDateTime, maxResults = 20, onlyUnread = false }: ListMessagesInput = {}) {
    const numericMax = typeof maxResults === 'number' ? maxResults : undefined;
    const safeTop = Number.isInteger(numericMax ?? NaN)
      ? Math.min(Math.max(numericMax as number, 1), 200)
      : 20;

    const filterParts: string[] = [];
    if (startDateTime) {
      filterParts.push(`receivedDateTime ge ${startDateTime}`);
    }
    if (endDateTime) {
      filterParts.push(`receivedDateTime le ${endDateTime}`);
    }
    if (onlyUnread) {
      filterParts.push('isRead eq false');
    }

    const query: Record<string, string> = {
      '$orderby': 'receivedDateTime desc',
      '$top': String(safeTop),
      '$select': 'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,hasAttachments,bodyPreview,body,isRead,webLink',
      '$expand': 'attachments($select=id,name,contentType,size,isInline)'
    };

    if (filterParts.length) {
      query['$filter'] = filterParts.join(' and ');
    }

    const data = await this.request<any>(
      'GET',
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
      {
        query,
        scopes: ['Mail.Read']
      }
    );

    return (data.value || []).map((message: any) => ({
      id: message.id,
      subject: message.subject,
      from: message.from?.emailAddress || null,
      toRecipients: (message.toRecipients || []).map((entry: any) => entry.emailAddress),
      ccRecipients: Array.isArray(message.ccRecipients)
        ? message.ccRecipients.map((entry: any) => entry.emailAddress)
        : [],
      bccRecipients: Array.isArray(message.bccRecipients)
        ? message.bccRecipients.map((entry: any) => entry.emailAddress)
        : [],
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
        ? message.attachments.map((attachment: any) => ({
            id: attachment.id,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            isInline: attachment.isInline
          }))
        : []
    }));
  }

  async listUnreadMessages({ folderId = 'inbox', maxResults = 20 }: { folderId?: string; maxResults?: number } = {}) {
    return this.listMessages({ folderId, maxResults, onlyUnread: true });
  }

  async markMessageRead(messageId: string, isRead = true) {
    if (!messageId) throw new Error('messageId is required');
    const body = { isRead: Boolean(isRead) };
    await this.request(
      'PATCH',
      `/me/messages/${encodeURIComponent(messageId)}`,
      { body, scopes: ['Mail.ReadWrite'] }
    );
    return { id: messageId, isRead: Boolean(isRead) };
  }

  async listCalendarEvents({ startDateTime, endDateTime }: CalendarEventsInput) {
    if (!startDateTime || !endDateTime) {
      throw new Error('startDateTime and endDateTime are required to list events.');
    }

    const data = await this.request<any>(
      'GET',
      '/me/calendarView',
      {
        query: {
          startDateTime,
          endDateTime,
          '$orderby': 'start/dateTime asc'
        },
        scopes: ['Calendars.Read']
      }
    );

    return (data.value || []).map((event: any) => ({
      id: event.id,
      subject: event.subject,
      start: event.start,
      end: event.end,
      location: event.location,
      organizer: event.organizer
    }));
  }

  async createCalendarEvent({
    subject,
    body,
    contentType = 'Text',
    startDateTime,
    endDateTime,
    timezone = 'UTC',
    attendees = [],
    teams = false,
    location,
    reminderMinutesBeforeStart,
    allowNewTimeProposals,
    isOnlineMeeting,
    onlineMeetingProvider
  }: CreateCalendarEventInput): Promise<any> {
    if (!subject) {
      throw new Error('subject is required to create an event.');
    }
    if (!startDateTime || !endDateTime) {
      throw new Error('startDateTime and endDateTime are required.');
    }

    const normalizedContentType = (contentType || 'Text').toUpperCase() === 'HTML' ? 'HTML' : 'Text';
    const attendeeArray = Array.isArray(attendees) ? attendees : [];

    const eventPayload: Record<string, any> = {
      subject,
      start: {
        dateTime: startDateTime,
        timeZone: timezone || 'UTC'
      },
      end: {
        dateTime: endDateTime,
        timeZone: timezone || 'UTC'
      },
      attendees: attendeeArray
        .map((entry) => {
          if (!entry) return null;
          if (typeof entry === 'string') {
            return {
              emailAddress: {
                address: entry
              },
              type: 'required'
            };
          }
          const record = entry as Record<string, any>;
          const address = record.address || record.email || record.mail || record.emailAddress;
          if (!address) return null;
          return {
            emailAddress: {
              address,
              name: record.name || record.displayName || undefined
            },
            type: record.type || 'required'
          };
        })
        .filter(Boolean)
    };

    if (body) {
      eventPayload.body = {
        contentType: normalizedContentType,
        content: body
      };
    }

    if (location) {
      eventPayload.location = typeof location === 'string'
        ? { displayName: location }
        : location;
    }

    if (typeof reminderMinutesBeforeStart === 'number') {
      eventPayload.reminderMinutesBeforeStart = reminderMinutesBeforeStart;
    }

    if (typeof allowNewTimeProposals === 'boolean') {
      eventPayload.allowNewTimeProposals = allowNewTimeProposals;
    }

    if (typeof isOnlineMeeting === 'boolean') {
      eventPayload.isOnlineMeeting = isOnlineMeeting;
    }

    if (onlineMeetingProvider) {
      eventPayload.onlineMeetingProvider = onlineMeetingProvider;
    }

    if (teams) {
      eventPayload.isOnlineMeeting = true;
      eventPayload.onlineMeetingProvider = 'teamsForBusiness';
    }

    const response = await this.request<any>('POST', '/me/events', {
      body: eventPayload,
      // Send notifications to attendees when provided so invites are delivered
      query: (Array.isArray(attendeeArray) && attendeeArray.length > 0) ? { sendNotifications: 'true' } : {},
      scopes: ['Calendars.ReadWrite']
    });

    return response;
  }

  async sendMail({ to, subject, body = '', contentType = 'Text', saveToSentItems = true }: { to: string | string[]; subject: string; body?: string; contentType?: string; saveToSentItems?: boolean }): Promise<any> {
    const recipients = (Array.isArray(to) ? to : [to])
      .filter(Boolean)
      .map((addr) => ({ emailAddress: { address: String(addr) } }));
    if (!recipients.length) {
      throw new Error('At least one recipient is required to send a mail.');
    }
    const normalizedType = (contentType || 'Text').toUpperCase() === 'HTML' ? 'HTML' : 'Text';
    const payload = {
      message: {
        subject: subject || '',
        body: {
          contentType: normalizedType,
          content: body || ''
        },
        toRecipients: recipients
      },
      saveToSentItems: Boolean(saveToSentItems)
    };

    await this.request('POST', '/me/sendMail', { body: payload, scopes: ['Mail.Send'] });
    return { status: 'sent', to: recipients.map(r => r.emailAddress.address), subject };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.tokenCache.clear();
    // Give pending CLI processes a moment to settle; mainly relevant for unit tests.
    await delay(10);
  }
}
