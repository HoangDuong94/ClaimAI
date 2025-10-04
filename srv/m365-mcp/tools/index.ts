// srv/m365-mcp/tools/index.ts
// Registry of tool handlers exposed by the Microsoft 365 MCP client.

import { handleMailLatestMessage, handleMailAttachmentDownload, handleMailMessagesList, handleMailMessageReply } from './mail.js';
import { handleCalendarEventsList, handleCalendarEventCreate } from './calendar.js';

type ToolHandler = (...args: any[]) => unknown | Promise<unknown>;

const handlers: Record<string, ToolHandler> = {
  'mail.latestMessage.get': handleMailLatestMessage,
  'mail.attachment.download': handleMailAttachmentDownload,
  'mail.messages.list': handleMailMessagesList,
  'mail.message.reply': handleMailMessageReply,
  'calendar.events.list': handleCalendarEventsList,
  'calendar.event.create': handleCalendarEventCreate
};

export function getToolHandler(name: string): ToolHandler | null {
  return handlers[name] || null;
}

export function listSupportedTools(): string[] {
  return Object.keys(handlers);
}
