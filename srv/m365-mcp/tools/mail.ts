// srv/m365-mcp/tools/mail.ts
// Tool handlers for Microsoft 365 mail interactions.

import { safeJson } from '../helpers/logging.js';
import type { GraphClient } from '../graph-client.js';

type LoggerLike = Console | { info?: (...args: unknown[]) => void; log?: (...args: unknown[]) => void } | undefined;

interface MailToolContext<TInput> {
  input: TInput;
  graphClient: GraphClient;
  logger?: LoggerLike;
}

interface LatestMessageInput {
  folderId?: string;
}

interface AttachmentDownloadInput {
  messageId: string;
  attachmentId: string;
  targetPath: string;
}

interface MessagesListInput extends LatestMessageInput {
  startDateTime?: string;
  endDateTime?: string;
  maxResults?: number;
}

interface MessageReplyInput {
  messageId: string;
  comment?: string;
  body?: string;
  contentType?: string;
  replyAll?: boolean;
}

function getInfoLogger(logger: LoggerLike): (...args: unknown[]) => void {
  if (!logger) return () => {};
  if (typeof logger.info === 'function') return logger.info.bind(logger);
  if (typeof logger.log === 'function') return logger.log.bind(logger);
  return () => {};
}

export async function handleMailLatestMessage({ input, graphClient, logger }: MailToolContext<LatestMessageInput>) {
  const info = getInfoLogger(logger);
  info('M365 mail.latestMessage.get invoked with input:', safeJson(input));
  const folderId = input.folderId || 'inbox';
  const message = await graphClient.getLatestMessage({ folderId });
  if (!message) {
    return {
      message: `No messages found in folder "${folderId}"`,
      folderId
    };
  }
  return {
    folderId,
    message
  };
}

export async function handleMailAttachmentDownload({ input, graphClient, logger }: MailToolContext<AttachmentDownloadInput>) {
  const info = getInfoLogger(logger);
  info('M365 mail.attachment.download invoked with input:', safeJson({
    ...input,
    targetPath: '[redacted]'
  }));

  const result = await graphClient.downloadAttachment({
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    targetPath: input.targetPath
  });
  return {
    status: 'downloaded',
    details: result
  };
}

export async function handleMailMessagesList({ input, graphClient, logger }: MailToolContext<MessagesListInput>) {
  const info = getInfoLogger(logger);
  info('M365 mail.messages.list invoked with input:', safeJson(input));

  const messages = await graphClient.listMessages({
    folderId: input.folderId,
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime,
    maxResults: input.maxResults
  });

  return {
    folderId: input.folderId || 'inbox',
    count: messages.length,
    messages
  };
}

export async function handleMailMessageReply({ input, graphClient, logger }: MailToolContext<MessageReplyInput>) {
  const info = getInfoLogger(logger);
  const masked = {
    ...input,
    body: input.body ? '[redacted]' : undefined,
    comment: input.comment ? '[provided]' : undefined
  };
  info('M365 mail.message.reply invoked with input:', safeJson(masked));

  if (!input.messageId) {
    throw new Error('messageId is required');
  }

  const result = await graphClient.replyToMessage({
    messageId: input.messageId,
    comment: input.comment,
    body: input.body,
    contentType: input.contentType,
    replyAll: input.replyAll
  });

  return result;
}
