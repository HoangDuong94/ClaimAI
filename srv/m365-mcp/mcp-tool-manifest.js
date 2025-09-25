// srv/m365-mcp/mcp-tool-manifest.js
// Describes the tool surface exposed by the Microsoft 365 in-process MCP client.

const manifestVersion = '0.1.0';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export const toolDefinitions = [
  {
    name: 'mail.latestMessage.get',
    description: 'Liest deterministisch die neueste Nachricht aus einem Mailordner und liefert Metadaten.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: {
          type: 'string',
          description: 'ID oder bekannter Name des Zielordners, z. B. inbox.',
          default: 'inbox'
        }
      }
    },
    metadata: { scopes: ['Mail.Read'] }
  },
  {
    name: 'mail.messages.list',
    description: 'Listet eingegangene Nachrichten eines Ordners, optional gefiltert nach Zeitraum und Limit.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: {
          type: 'string',
          description: 'ID oder bekannter Name des Mailordners (z. B. inbox).',
          default: 'inbox'
        },
        startDateTime: {
          type: 'string',
          description: 'ISO-8601 Zeitpunkt. Filtert Nachrichten mit Empfangszeit >= startDateTime.'
        },
        endDateTime: {
          type: 'string',
          description: 'ISO-8601 Zeitpunkt. Filtert Nachrichten mit Empfangszeit <= endDateTime.'
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 20,
          description: 'Begrenzt die Anzahl der zurückgegebenen Nachrichten (1-200). Standard: 20.'
        }
      }
    },
    metadata: { scopes: ['Mail.Read'] }
  },
  {
    name: 'mail.attachment.download',
    description: 'Lädt einen bestimmten Anhang einer Nachricht und speichert ihn deterministisch im Zielpfad.',
    inputSchema: {
      type: 'object',
      required: ['messageId', 'attachmentId', 'targetPath'],
      properties: {
        messageId: { type: 'string', description: 'ID der Nachricht.' },
        attachmentId: { type: 'string', description: 'ID des Anhangs.' },
        targetPath: {
          type: 'string',
          description: 'Absoluter Ablageort für den heruntergeladenen Anhang.'
        }
    }
    },
    metadata: { scopes: ['Mail.Read'] }
  },
  {
    name: 'mail.message.reply',
    description: 'Antwortet auf eine vorhandene Nachricht (wahlweise Reply-All) mit Text oder HTML-Inhalt.',
    inputSchema: {
      type: 'object',
      required: ['messageId'],
      properties: {
        messageId: {
          type: 'string',
          description: 'ID der Nachricht, auf die geantwortet werden soll.'
        },
        comment: {
          type: 'string',
          description: 'Optionaler Kommentar, der oberhalb des Antworttexts eingefügt wird (Plain Text).'
        },
        body: {
          type: 'string',
          description: 'Optionaler kompletter Antworttext. Wird entsprechend contentType als Text oder HTML interpretiert.'
        },
        contentType: {
          type: 'string',
          description: 'Legt fest, ob der Body als Text oder HTML interpretiert wird.',
          enum: ['Text', 'HTML'],
          default: 'Text'
        },
        replyAll: {
          type: 'boolean',
          description: 'true, um „Allen antworten“ zu verwenden. Standard: false.'
        }
      }
    },
    metadata: { scopes: ['Mail.Send'] }
  },
  {
    name: 'calendar.events.list',
    description: 'Listet Kalenderereignisse in einem Zeitraum mit deterministischer Filterung.',
    inputSchema: {
      type: 'object',
      required: ['startDateTime', 'endDateTime'],
      properties: {
        startDateTime: { type: 'string', description: 'ISO-8601 Startzeitpunkt.' },
        endDateTime: { type: 'string', description: 'ISO-8601 Endzeitpunkt.' }
      }
    },
    metadata: { scopes: ['Calendars.Read'] }
  },
  {
    name: 'calendar.event.create',
    description: 'Erstellt einen neuen Kalendereintrag und kann optional ein Microsoft Teams Online-Meeting anlegen.',
    inputSchema: {
      type: 'object',
      required: ['subject', 'startDateTime', 'endDateTime'],
      properties: {
        subject: {
          type: 'string',
          description: 'Betreff des Termins.'
        },
        body: {
          type: 'string',
          description: 'Beschreibung des Termins. Wird gemäß contentType interpretiert.'
        },
        contentType: {
          type: 'string',
          enum: ['Text', 'HTML'],
          default: 'Text',
          description: 'Legt fest, ob die Beschreibung als Text oder HTML versendet wird.'
        },
        startDateTime: {
          type: 'string',
          description: 'Startzeit im ISO-8601 Format (z. B. 2024-09-01T09:00:00).'
        },
        endDateTime: {
          type: 'string',
          description: 'Endzeit im ISO-8601 Format.'
        },
        timezone: {
          type: 'string',
          description: 'Zeitzone für Start/Ende, z. B. Europe/Berlin. Standard: UTC.'
        },
        attendees: {
          type: 'array',
          description: 'Liste von Empfängern (E-Mail-Adressen als Strings).',
          items: {
            type: 'string'
          }
        },
        location: {
          description: 'Optionaler Ort (String oder Graph Location Objekt).',
          anyOf: [
            { type: 'string' },
            { type: 'object' }
          ]
        },
        reminderMinutesBeforeStart: {
          type: 'integer',
          description: 'Reminder in Minuten vor dem Start.'
        },
        allowNewTimeProposals: {
          type: 'boolean',
          description: 'Ob Teilnehmer neue Zeiten vorschlagen dürfen.'
        },
        isOnlineMeeting: {
          type: 'boolean',
          description: 'Setzt ein Online-Meeting ohne Provider-Auswahl.'
        },
        onlineMeetingProvider: {
          type: 'string',
          description: 'Optionaler Provider (z. B. teamsForBusiness).'
        },
        teams: {
          type: 'boolean',
          description: 'true, um automatisch ein Teams-Meeting zu erzeugen.'
        }
      }
    },
    metadata: { scopes: ['Calendars.ReadWrite'] }
  }
  // Weitere Tools aus dem PoC können hier ergänzt werden.
];

export function createM365ToolManifest() {
  return {
    namespace: 'm365',
    version: manifestVersion,
    tools: toolDefinitions.map(clone)
  };
}
