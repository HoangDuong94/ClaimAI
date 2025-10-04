// srv/m365-mcp/tools/calendar.ts
// Tool handlers for Microsoft 365 calendar interactions.

import { safeJson } from '../helpers/logging.js';
import type { GraphClient } from '../graph-client.js';

type LoggerLike = Console | { info?: (...args: unknown[]) => void; log?: (...args: unknown[]) => void } | undefined;

interface CalendarToolContext<TInput> {
  input: TInput;
  graphClient: GraphClient;
  logger?: LoggerLike;
}

interface CalendarEventsListInput {
  startDateTime: string;
  endDateTime: string;
}

interface CalendarEventCreateInput {
  subject: string;
  startDateTime: string;
  endDateTime: string;
  body?: string;
  contentType?: string;
  timezone?: string;
  attendees?: string[];
  teams?: boolean;
  location?: unknown;
  reminderMinutesBeforeStart?: number;
  allowNewTimeProposals?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
}

function getInfoLogger(logger: LoggerLike): (...args: unknown[]) => void {
  if (!logger) return () => {};
  if (typeof logger.info === 'function') return logger.info.bind(logger);
  if (typeof logger.log === 'function') return logger.log.bind(logger);
  return () => {};
}

export async function handleCalendarEventsList({ input, graphClient, logger }: CalendarToolContext<CalendarEventsListInput>) {
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

export async function handleCalendarEventCreate({ input, graphClient, logger }: CalendarToolContext<CalendarEventCreateInput>) {
  const info = getInfoLogger(logger);
  const masked = {
    ...input,
    body: input.body ? '[provided]' : undefined
  };
  info('M365 calendar.event.create invoked with input:', safeJson(masked));

  const { startDateTime, endDateTime } = input;

  if (typeof startDateTime !== 'string' || typeof endDateTime !== 'string' || !startDateTime || !endDateTime) {
    throw new Error('startDateTime and endDateTime are required to create a calendar event.');
  }

  const result = await graphClient.createCalendarEvent({
    subject: input.subject,
    body: input.body,
    contentType: input.contentType,
    startDateTime,
    endDateTime,
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
