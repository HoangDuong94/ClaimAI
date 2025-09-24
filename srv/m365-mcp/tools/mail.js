// srv/m365-mcp/tools/mail.js
// Tool handlers for Microsoft 365 mail interactions.

import { safeJson } from '../helpers/logging.js';

function getInfoLogger(logger) {
  if (!logger) return () => {};
  if (typeof logger.info === 'function') return logger.info.bind(logger);
  if (typeof logger.log === 'function') return logger.log.bind(logger);
  return () => {};
}

export async function handleMailLatestMessage({ input, graphClient, logger }) {
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

export async function handleMailAttachmentDownload({ input, graphClient, logger }) {
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
