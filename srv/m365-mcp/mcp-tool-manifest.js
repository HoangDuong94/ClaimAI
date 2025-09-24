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
