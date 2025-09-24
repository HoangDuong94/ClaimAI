// srv/m365-mcp/tools/index.js
// Registry of tool handlers exposed by the Microsoft 365 MCP client.

import { handleMailLatestMessage, handleMailAttachmentDownload } from './mail.js';
import { handleCalendarEventsList } from './calendar.js';

const handlers = {
  'mail.latestMessage.get': handleMailLatestMessage,
  'mail.attachment.download': handleMailAttachmentDownload,
  'calendar.events.list': handleCalendarEventsList
};

export function getToolHandler(name) {
  return handlers[name] || null;
}

export function listSupportedTools() {
  return Object.keys(handlers);
}
