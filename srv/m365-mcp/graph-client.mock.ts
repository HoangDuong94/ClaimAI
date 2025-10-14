// srv/m365-mcp/graph-client.mock.ts
// Lightweight mock for Microsoft Graph interactions used by evals/tests.
// Reads deterministic fixtures and copies attachment files from the repo.

import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

type LoggerLike = Console | { log?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | undefined;

interface GraphClientMockOptions {
  logger?: LoggerLike;
  fixturesDir?: string;
}

interface FixtureAttachment {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  fixturePath: string; // path to a file in the repo to copy from
}

interface FixtureMessage {
  id: string;
  subject?: string;
  from?: Record<string, unknown> | null;
  toRecipients?: Array<Record<string, unknown>>;
  receivedDateTime?: string;
  isRead?: boolean;
  webLink?: string;
  hasAttachments?: boolean;
  bodyPreview?: string | null;
  body?: { contentType?: string; content?: string } | null;
  attachments?: FixtureAttachment[];
}

interface FixturesFile {
  messages: FixtureMessage[];
}

export class GraphClientMock {
  private readonly logger: LoggerLike;
  private readonly fixturesDir: string;
  private fixtures: FixturesFile | null = null;

  constructor(options: GraphClientMockOptions = {}) {
    this.logger = options.logger;
    this.fixturesDir = options.fixturesDir || path.resolve(process.cwd(), 'srv', 'test', 'fixtures', 'm365');
  }

  async bootstrap(_scopes: string[] = []): Promise<void> {
    await this.loadFixtures();
    this.logger?.log?.('[GraphClientMock] Bootstrapped using fixtures from', this.fixturesDir);
  }

  private async loadFixtures(): Promise<void> {
    const file = path.join(this.fixturesDir, 'messages.json');
    const raw = await readFile(file, 'utf8');
    const data = JSON.parse(raw) as FixturesFile;
    if (!data || !Array.isArray(data.messages)) {
      throw new Error('Invalid fixtures format: messages array missing');
    }
    // sort by receivedDateTime desc if present
    data.messages.sort((a, b) => {
      const ta = Date.parse(a.receivedDateTime || '1970-01-01T00:00:00Z');
      const tb = Date.parse(b.receivedDateTime || '1970-01-01T00:00:00Z');
      return tb - ta;
    });
    this.fixtures = data;
  }

  private ensureLoaded(): FixturesFile {
    if (!this.fixtures) throw new Error('GraphClientMock not bootstrapped');
    return this.fixtures;
  }

  async getLatestMessage({ folderId = 'inbox' }: { folderId?: string } = {}) {
    const fixtures = this.ensureLoaded();
    const message = fixtures.messages[0] || null;
    if (!message) return null;
    return message;
  }

  async listMessages({ folderId = 'inbox', maxResults = 20 }: { folderId?: string; maxResults?: number } = {}) {
    const fixtures = this.ensureLoaded();
    const top = Math.max(1, Math.min(200, Number(maxResults || 20)));
    return fixtures.messages.slice(0, top);
  }

  async listUnreadMessages({ folderId = 'inbox', maxResults = 20 }: { folderId?: string; maxResults?: number } = {}) {
    const fixtures = this.ensureLoaded();
    const unread = fixtures.messages.filter((m) => !m.isRead);
    const top = Math.max(1, Math.min(200, Number(maxResults || 20)));
    return unread.slice(0, top);
  }

  async markMessageRead(messageId: string, isRead = true) {
    const fixtures = this.ensureLoaded();
    const msg = fixtures.messages.find((m) => m.id === messageId);
    if (msg) msg.isRead = Boolean(isRead);
    return { id: messageId, isRead: Boolean(isRead) };
  }

  async replyToMessage({ messageId, comment = '', body, contentType = 'Text', replyAll = false }: any) {
    if (!messageId) throw new Error('messageId is required');
    // Purely simulated; no mutation required
    return { status: 'sent', replyAll: Boolean(replyAll) };
  }

  async downloadAttachment({ messageId, attachmentId, targetPath }: { messageId: string; attachmentId: string; targetPath: string }) {
    const fixtures = this.ensureLoaded();
    const msg = fixtures.messages.find((m) => m.id === messageId);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    const att = (msg.attachments || []).find((a) => a.id === attachmentId);
    if (!att) throw new Error(`Attachment not found: ${attachmentId}`);

    // Resolve source file path
    const source = path.isAbsolute(att.fixturePath)
      ? att.fixturePath
      : path.resolve(process.cwd(), att.fixturePath);

    // Resolve target path (respect M365_ATTACHMENT_BASE_PATH if relative)
    let outPath = targetPath;
    const baseDirectory = process.env.M365_ATTACHMENT_BASE_PATH;
    if (!path.isAbsolute(outPath)) {
      outPath = baseDirectory ? path.resolve(baseDirectory, outPath) : path.resolve(outPath);
    }

    const outDir = path.dirname(outPath);
    if (!existsSync(outDir)) {
      await mkdir(outDir, { recursive: true });
    }

    await copyFile(source, outPath);
    return {
      messageId,
      attachmentId,
      targetPath: outPath,
      bytesWritten: 0
    };
  }

  async listCalendarEvents({ startDateTime, endDateTime }: { startDateTime: string; endDateTime: string }) {
    return [
      {
        id: 'evt_mock_1',
        subject: 'Mock Event',
        start: { dateTime: startDateTime, timeZone: 'Europe/Berlin' },
        end: { dateTime: endDateTime, timeZone: 'Europe/Berlin' },
        location: { displayName: 'Online' },
        organizer: { emailAddress: { address: 'organizer@example.com', name: 'Organizer' } }
      }
    ];
  }

  async createCalendarEvent({ subject, startDateTime, endDateTime, timezone = 'UTC' }: any) {
    if (!subject) throw new Error('subject is required');
    if (!startDateTime || !endDateTime) throw new Error('start/end are required');
    return {
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      subject,
      start: { dateTime: startDateTime, timeZone: timezone },
      end: { dateTime: endDateTime, timeZone: timezone }
    };
  }

  async close(): Promise<void> {
    // no-op
  }
}

