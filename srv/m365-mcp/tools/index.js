// srv/m365-mcp/tools/index.js
// Registry of tool handlers exposed by the Microsoft 365 MCP client.

import { handleMailLatestMessage, handleMailAttachmentDownload, handleMailMessagesList, handleMailMessageReply } from './mail.js';
import { handleCalendarEventsList, handleCalendarEventCreate } from './calendar.js';

const handlers = {
  'mail.latestMessage.get': handleMailLatestMessage,
  'mail.attachment.download': handleMailAttachmentDownload,
  'mail.messages.list': handleMailMessagesList,
  'mail.message.reply': handleMailMessageReply,
  'calendar.events.list': handleCalendarEventsList,
  'calendar.event.create': handleCalendarEventCreate
};

export function getToolHandler(name) {
  return handlers[name] || null;
}

export function listSupportedTools() {
  return Object.keys(handlers);
}
