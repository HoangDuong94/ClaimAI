// @ts-nocheck
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

export async function handleCalendarEventCreate({ input, graphClient, logger }) {
  const info = getInfoLogger(logger);
  const masked = {
    ...input,
    body: input.body ? '[provided]' : undefined
  };
  info('M365 calendar.event.create invoked with input:', safeJson(masked));

  const result = await graphClient.createCalendarEvent({
    subject: input.subject,
    body: input.body,
    contentType: input.contentType,
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime,
    timezone: input.timezone,
    attendees: input.attendees,
    teams: input.teams,
    location: input.location,
    reminderMinutesBeforeStart: input.reminderMinutesBeforeStart,
    allowNewTimeProposals: input.allowNewTimeProposals,
    isOnlineMeeting: input.isOnlineMeeting,
    onlineMeetingProvider: input.onlineMeetingProvider
  });

  return result;
}
