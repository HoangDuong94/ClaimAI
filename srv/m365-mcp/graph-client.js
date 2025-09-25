// srv/m365-mcp/graph-client.js
// Thin wrapper around the Microsoft Graph API using the m365 CLI for authentication.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeJson } from './helpers/logging.js';

const execFileAsync = promisify(execFile);
const GRAPH_RESOURCE = 'https://graph.microsoft.com';
const GRAPH_BASE_URL = `${GRAPH_RESOURCE}/v1.0`;
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

export class GraphClient {
  constructor(options = {}) {
    const {
      authMethod = process.env.M365_AUTH_METHOD || 'cli',
      cliCommand = process.env.M365_CLI_COMMAND || 'm365',
      logger = console,
      tokenTtlMs = DEFAULT_TOKEN_TTL_MS
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
    this.logger.log('Initializing Microsoft 365 in-process MCP client...');
    try {
      await this.getAccessToken(scopes);
      this.logger.log('✅ Microsoft 365 MCP client initialized successfully.');
    } catch (error) {
      this.logger.error('❌ Failed to initialize Microsoft 365 MCP client:', error.message);
      throw error;
    }
  }

  async getAccessToken(scopes = []) {
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
      const execOptions = {
        env: process.env,
        maxBuffer: 1024 * 1024
      };

      // Windows: .cmd/.bat require a shell wrapper, otherwise spawn() raises EINVAL.
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
      const errorMessage = String(error.stderr || error.message || error);
      if (normalizedScopes.length && this.scopesOptionSupported && /Invalid option: 'scopes?'/.test(errorMessage)) {
        this.logger.warn?.('m365 CLI does not support the --scope option. Falling back to default Graph scopes.');
        this.scopesOptionSupported = false;
        return this.getAccessToken([]);
      }
      if (error.code === 'ENOENT') {
        throw new Error(`Could not find the m365 CLI (${this.cliCommand}). Install it via "npm i -g @pnp/cli-microsoft365".`);
      }
      throw new Error(`Failed to acquire Microsoft Graph token via m365 CLI: ${error.message}`);
    }
  }

  async request(method, relativePath, { query = {}, headers = {}, body, scopes = [] } = {}) {
    if (this.closed) {
      throw new Error('GraphClient is closed');
    }

    const url = new URL(relativePath.replace(/^\//, ''), `${GRAPH_BASE_URL}/`);
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });

    const accessToken = await this.getAccessToken(scopes);
    const baseHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    };

    const options = {
      method,
      headers: { ...baseHeaders, ...headers }
    };

    if (body !== undefined) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    this.logger.debug?.(`Graph request ${method} ${url} with body ${safeJson(body)}`);

    const response = await fetch(url, options);
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Graph request failed (${response.status} ${response.statusText}): ${errorBody}`);
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
          '$select': 'id,subject,from,toRecipients,receivedDateTime,hasAttachments,bodyPreview,body,isRead,webLink',
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
      toRecipients: (message.toRecipients || []).map((entry) => entry.emailAddress),
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

  async downloadAttachment({ messageId, attachmentId, targetPath }) {
    if (!messageId || !attachmentId || !targetPath) {
      throw new Error('messageId, attachmentId and targetPath are required for attachment download.');
    }

    let resolvedTargetPath = targetPath;
    const baseDirectory = process.env.M365_ATTACHMENT_BASE_PATH;
    if (!path.isAbsolute(resolvedTargetPath)) {
      if (baseDirectory) {
        resolvedTargetPath = path.resolve(baseDirectory, resolvedTargetPath);
      } else {
        resolvedTargetPath = path.resolve(resolvedTargetPath);
      }
    }

    const attachmentBinary = await this.request(
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

  async listMessages({ folderId = 'inbox', startDateTime, endDateTime, maxResults = 20, onlyUnread = false } = {}) {
    const safeTop = Number.isInteger(maxResults)
      ? Math.min(Math.max(maxResults, 1), 200)
      : 20;

    const filterParts = [];
    if (startDateTime) {
      filterParts.push(`receivedDateTime ge ${startDateTime}`);
    }
    if (endDateTime) {
      filterParts.push(`receivedDateTime le ${endDateTime}`);
    }
    if (onlyUnread) {
      filterParts.push('isRead eq false');
    }

    const query = {
      '$orderby': 'receivedDateTime desc',
      '$top': String(safeTop),
      '$select': 'id,subject,from,toRecipients,receivedDateTime,hasAttachments,bodyPreview,body,isRead,webLink',
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

    return (data.value || []).map((message) => ({
      id: message.id,
      subject: message.subject,
      from: message.from?.emailAddress || null,
      toRecipients: (message.toRecipients || []).map((entry) => entry.emailAddress),
      receivedDateTime: message.receivedDateTime,
      isRead: Boolean(message.isRead),
      webLink: message.webLink,
      hasAttachments: Boolean(message.hasAttachments),
      bodyPreview: message.bodyPreview || null,
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            isInline: attachment.isInline
          }))
        : []
    }));
  }

  async listUnreadMessages({ folderId = 'inbox', maxResults = 20 } = {}) {
    return this.listMessages({ folderId, maxResults, onlyUnread: true });
  }

  async markMessageRead(messageId, isRead = true) {
    if (!messageId) throw new Error('messageId is required');
    const body = { isRead: Boolean(isRead) };
    await this.request(
      'PATCH',
      `/me/messages/${encodeURIComponent(messageId)}`,
      { body, scopes: ['Mail.ReadWrite'] }
    );
    return { id: messageId, isRead: Boolean(isRead) };
  }

  async listCalendarEvents({ startDateTime, endDateTime }) {
    if (!startDateTime || !endDateTime) {
      throw new Error('startDateTime and endDateTime are required to list events.');
    }

    const data = await this.request(
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

    return (data.value || []).map((event) => ({
      id: event.id,
      subject: event.subject,
      start: event.start,
      end: event.end,
      location: event.location,
      organizer: event.organizer
    }));
  }

  async close() {
    this.closed = true;
    this.tokenCache.clear();
    // Give pending CLI processes a moment to settle; mainly relevant for unit tests.
    await delay(10);
  }
}
