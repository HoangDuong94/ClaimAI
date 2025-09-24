// srv/m365-mcp/tools/calendar.js
// Tool handlers for Microsoft 365 calendar interactions.

import { safeJson } from '../helpers/logging.js';

function getInfoLogger(logger) {
  if (!logger) return () => {};
  if (typeof logger.info === 'function') return logger.info.bind(logger);
  if (typeof logger.log === 'function') return logger.log.bind(logger);
  return () => {};
}

export async function handleCalendarEventsList({ input, graphClient, logger }) {
  const info = getInfoLogger(logger);
  info('M365 calendar.events.list invoked with input:', safeJson(input));

  const events = await graphClient.listCalendarEvents({
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime
  });

  return {
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime,
    count: events.length,
    events
  };
}
