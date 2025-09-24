# Anforderungsdokument: Integration des M365 MCP

**Datum:** 24.09.2025
**Version:** 1.0
**Autor:** Gemini AI

## 1. Einleitung & Zielsetzung

Dieses Dokument beschreibt die technischen Anforderungen für die Integration eines Microsoft 365 (M365) Model Context Protocol (MCP) Clients in das bestehende `StammtischAI`-Projekt.

**Ziel:** Der KI-Agent der StammtischAI-Anwendung soll um die Fähigkeit erweitert werden, mit M365-Diensten zu interagieren. Dazu gehören das Lesen und Senden von E-Mails, die Verwaltung von Kalendereinträgen sowie das Lesen von Excel-Dateien, die in OneDrive gespeichert sind.

## 2. Architekturübersicht

Die Integration erfolgt durch die Implementierung eines neuen **in-process MCP-Clients**. Im Gegensatz zu den bestehenden MCP-Clients (PostgreSQL, Brave, etc.), die als separate Prozesse über `stdio` kommunizieren, wird die M365-Logik direkt in den Hauptprozess der CAP-Anwendung eingebettet. Dies vereinfacht die Authentifizierung und das Deployment.

Der M365-Client wird folgende Funktionalitäten kapseln:
*   **Authentifizierung:** Nutzt eine vorhandene `m365 login` CLI-Sitzung für die lokale Entwicklung.
*   **Tool-Definition:** Stellt eine Reihe von vordefinierten Tools (z.B. `mail.latestMessage.get`) zur Verfügung.
*   **API-Kommunikation:** Führt die eigentlichen Aufrufe gegen die Microsoft Graph API aus.

**Besonderheit Excel-Workflow (Hybrid-Ansatz):**
Der Agent wird befähigt, einen mehrstufigen Prozess für die Analyse von Excel-Anhängen durchzuführen:
1.  **Download via M365-Tool:** Der Agent lädt einen E-Mail-Anhang mit einem neuen M365-Tool (`mail.attachment.download`) auf das lokale Dateisystem des Servers herunter.
2.  **Analyse via lokalem Excel-Tool:** Der Agent übergibt den Pfad der heruntergeladenen Datei an den bereits existierenden, leistungsstarken Excel-MCP (`@negokaz/excel-mcp-server`) zur Analyse.

## 3. Detaillierte Umsetzungs-Schritte

### 3.1 Neue Verzeichnisstruktur anlegen

Erstellen Sie im `srv`-Verzeichnis die folgende Ordnerstruktur, um die M365-Logik sauber zu kapseln:

```
StammtischAI/
└── srv/
    ├── m365-mcp/      <-- NEUER ORDNER
    │   ├── helpers/   <-- NEUER ORDNER
    │   └── ... (Dateien folgen in Schritt 3.2)
    ├── lib/
    └── service.js
```

### 3.2 Neue Quelldateien erstellen

Erstellen Sie die folgenden Dateien mit dem angegebenen Inhalt innerhalb des neuen `srv/m365-mcp/` Verzeichnisses.

#### 3.2.1 `srv/m365-mcp/helpers/logging.js`
*   **Zweck:** Enthält eine Hilfsfunktion zum sicheren Konvertieren von Objekten in JSON für das Logging.

```javascript
// srv/m365-mcp/helpers/logging.js

function safeJson(x, max = 4000) {
  try {
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    return s.length > max ? s.slice(0, max) + ' …[truncated]' : s;
  } catch {
    try { return String(x); } catch { return '[unprintable]'; }
  }
}

module.exports = { safeJson };
```

#### 3.2.2 `srv/m365-mcp/mcp-tool-manifest.js`
*   **Zweck:** Definiert die "Speisekarte" der verfügbaren M365-Tools, inklusive ihrer Namen, Beschreibungen und der erwarteten Parameter (Input Schema). Dies ist die zentrale Definitionsdatei.

```javascript
// srv/m365-mcp/mcp-tool-manifest.js
// Gekürzte Version für die Übersichtlichkeit. Die volle Liste der 16 Tools ist im Anhang des PoC.
const manifestVersion = '0.1.0';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const toolDefinitions = [
  {
    name: 'mail.latestMessage.get',
    description: 'Liest deterministisch die neueste Nachricht aus einem Mailordner und liefert Metadaten.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'ID oder bekannter Name des Zielordners, z. B. inbox.', default: 'inbox' },
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
        messageId: { type: 'string' },
        attachmentId: { type: 'string' },
        targetPath: { type: 'string', description: 'Ablageort für den heruntergeladenen Anhang.' }
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
        startDateTime: { type: 'string', description: 'IS0-8601 Startzeitpunkt.' },
        endDateTime: { type: 'string', description: 'IS0-8601 Endzeitpunkt.' }
      }
    },
    metadata: { scopes: ['Calendars.Read'] }
  },
  // Fügen Sie hier bei Bedarf weitere Tool-Definitionen aus dem PoC hinzu.
  // z.B. mail.message.replyDraft, calendar.event.createOrUpdate, etc.
];

function createM365ToolManifest() {
  return {
    namespace: 'm365',
    version: manifestVersion,
    tools: toolDefinitions.map((tool) => clone(tool))
  };
}

module.exports = { createM365ToolManifest };
```

#### 3.2.3 `srv/m365-mcp/mcp-m365-tools.js`
*   **Zweck:** Implementiert die serverseitige Logik für jedes im Manifest definierte Tool.

```javascript
// srv/m365-mcp/mcp-m365-tools.js

function assertFunction(fn, message) {
  if (typeof fn !== 'function') throw new Error(message);
}

function createM365ToolHandlers(dependencies = {}) {
  const handlers = {};
  const mailDeps = dependencies.mail || {};
  const calendarDeps = dependencies.calendar || {};

  handlers['mail.latestMessage.get'] = async ({ folderId = 'inbox' } = {}) => {
    assertFunction(mailDeps.getLatestMessage, 'mail.getLatestMessage dependency missing');
    const result = await mailDeps.getLatestMessage({ folderId });
    if (!result) return null;
    const from = result.from?.emailAddress?.address;
    return {
      messageId: result.id,
      subject: result.subject,
      receivedDateTime: result.receivedDateTime,
      from: from,
    };
  };
  
  handlers['mail.attachment.download'] = async ({ messageId, attachmentId, targetPath }) => {
    assertFunction(mailDeps.downloadAttachment, 'mail.downloadAttachment dependency missing');
    const result = await mailDeps.downloadAttachment({ messageId, attachmentId, targetPath });
    return { status: 'saved', filePath: result.filePath };
  };

  handlers['calendar.events.list'] = async ({ startDateTime, endDateTime }) => {
    assertFunction(calendarDeps.listEvents, 'calendar.listEvents dependency missing');
    const result = await calendarDeps.listEvents({ startDateTime, endDateTime });
    return { events: result?.events || [] };
  };

  return handlers;
}

module.exports = { createM365ToolHandlers };
```

#### 3.2.4 `srv/m365-mcp/mcp-m365-defaults.js`
*   **Zweck:** Die Kernlogik für die Authentifizierung (nur CLI-Methode) und die Kommunikation mit der MS Graph API.

```javascript
// srv/m365-mcp/mcp-m365-defaults.js
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

function ensureFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('Eine fetch-Implementierung wird für Microsoft Graph benötigt.');
}

function createCliOnlyTokenManager() {
  let cachedToken = null;

  async function acquireTokenFromCli() {
    if (cachedToken) return cachedToken; // Vereinfachtes Caching
    
    const token = await new Promise((resolve) => {
      execFile('m365', ['util', 'accesstoken', 'get', '--resource', 'https://graph.microsoft.com', '--output', 'text'], (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout || '').trim());
      });
    });

    if (!token) {
      throw new Error('Konnte keinen M365 Access Token über die CLI erhalten. Bitte "m365 login" ausführen.');
    }
    console.log('[M365 MCP] Token via m365 CLI erfolgreich erhalten.');
    cachedToken = token;
    return token;
  }

  return { getToken: acquireTokenFromCli };
}

async function createDefaultM365Dependencies(options = {}) {
  const fetchImpl = ensureFetch(options.fetchImpl);
  const baseUrl = 'https://graph.microsoft.com/v1.0';
  const tokenManager = createCliOnlyTokenManager();

  async function graphFetch(pathname, { method = 'GET', headers = {}, body } = {}) {
    const token = await tokenManager.getToken();
    const url = new URL(pathname, baseUrl);
    const finalHeaders = { Authorization: `Bearer ${token}`, ...headers };
    if (body && typeof body === 'object') {
        finalHeaders['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }
    const response = await fetchImpl(url.toString(), { method, headers: finalHeaders, body });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Graph API Fehler: ${response.status} ${text}`);
    }
    if (response.status === 204) return null; // No Content
    return response.json();
  }

  const mail = {
    getLatestMessage: ({ folderId }) => graphFetch(`/me/mailFolders/${folderId}/messages?$top=1&$orderby=receivedDateTime desc`),
    downloadAttachment: async ({ messageId, attachmentId, targetPath }) => {
        const attachment = await graphFetch(`/me/messages/${messageId}/attachments/${attachmentId}`);
        const content = Buffer.from(attachment.contentBytes, 'base64');
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content);
        return { filePath: targetPath };
    }
  };
  
  const calendar = {
    listEvents: ({ startDateTime, endDateTime }) => graphFetch(`/me/calendarview?startDateTime=${startDateTime}&endDateTime=${endDateTime}`)
  };

  return { mail, calendar };
}

module.exports = { createDefaultM365Dependencies };
```

#### 3.2.5 `srv/m365-mcp/mcp-m365-inprocess.js` & `srv/m365-mcp/mcp-jsonschema.js`
*   **Zweck:** Diese beiden Dateien sind "Boilerplate"-Code, der die Brücke zwischen dem Manifest, den Handlern und dem Client schlägt.

```javascript
// srv/m365-mcp/mcp-m365-inprocess.js
const { createM365ToolManifest } = require('./mcp-tool-manifest');
const { createM365ToolHandlers } = require('./mcp-m365-tools');

function createM365InProcessClient({ dependencies }) {
  const manifest = createM365ToolManifest();
  const handlers = createM365ToolHandlers(dependencies);
  const handlerNames = new Set(Object.keys(handlers));

  async function callTool({ name, arguments: args = {} } = {}) {
    if (!handlerNames.has(name)) throw new Error(`Unbekanntes MCP Tool: ${name}`);
    return handlers[name](args);
  }
  
  return {
    callTool,
    listTools: async () => manifest,
    close: async () => {},
  };
}

module.exports = { createM365InProcessClient };
```

```javascript
// srv/m365-mcp/mcp-jsonschema.js
function jsonSchemaToZod(schema, z) {
  // Diese Funktion konvertiert das JSON-Schema aus dem Manifest in ein Zod-Schema,
  // das von LangChain zur Validierung der Tool-Parameter verwendet wird.
  // Der Code aus dem PoC kann hier 1:1 übernommen werden.
  // ... (Inhalt aus der PoC-Datei hier einfügen)
  if (!schema || typeof schema !== 'object') throw new Error('schema must be an object');
  // ...
  return z.object({}); // Platzhalter, hier den echten Code einfügen
}
module.exports = { jsonSchemaToZod };
```

### 3.3 Abhängigkeiten installieren

Öffnen Sie ein Terminal im Hauptverzeichnis des `StammtischAI`-Projekts und installieren Sie die `zod`-Bibliothek.

```bash
npm install zod
```

### 3.4 Bestehende Dateien anpassen

#### 3.4.1 `srv/lib/mcp-client.js` modifizieren
*   **Änderung:** Fügen Sie die Initialisierung für den neuen in-process M365 Client hinzu.

```javascript
// srv/lib/mcp-client.js (VOLLSTÄNDIGE, AKTUALISIERTE VERSION)

import cds from '@sap/cds';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from 'path';
import { fileURLToPath } from 'url';

// +++ NEU START: Importiere die M365-Client-Logik +++
import { createM365InProcessClient } from '../m365-mcp/mcp-m365-inprocess.js';
import { createDefaultM365Dependencies } from '../m365-mcp/mcp-m365-defaults.js';
// +++ NEU ENDE +++

// ... (bestehende Variablen-Deklarationen)
let m365Client = null; // +++ NEU: M365 Client Variable

// ... (bestehende init-Funktionen für postgres, brave, etc. bleiben unverändert)

// +++ NEU START: Eigene Initialisierungsfunktion für den M365 Client +++
async function initM365InProcessClient() {
  if (m365Client) return m365Client;
  // Nur initialisieren, wenn die Authentifizierungsmethode konfiguriert ist
  if (process.env.M365_AUTH_METHOD !== 'cli') {
      console.log("Skipping M365 client initialization: M365_AUTH_METHOD is not set to 'cli'.");
      return null;
  }
  console.log(`Initializing in-process Microsoft 365 MCP client...`);
  try {
    const dependencies = await createDefaultM365Dependencies();
    m365Client = createM365InProcessClient({ dependencies });
    console.log("✅ Microsoft 365 in-process MCP client initialized successfully.");
    return m365Client;
  } catch (error) {
    console.error("❌ Failed to initialize in-process M365 client:", error.message);
    return null;
  }
}
// +++ NEU ENDE +++

export async function initAllMCPClients() {
  console.log("Initializing all MCP clients...");

  const [pgClient, braveClient, playwrightClient, fsClient, xlsxClient, m365] = await Promise.all([
    initPostgresMCPClient(),
    initBraveSearchMCPClient(),
    initPlaywrightMCPClient(),
    initFilesystemMCPClient(),
    initExcelMCPClient(),
    initM365InProcessClient() // +++ NEU: Neuer Client
  ]);

  return {
    postgres: pgClient,
    braveSearch: braveClient,
    playwright: playwrightClient,
    filesystem: fsClient,
    excel: xlsxClient,
    m365: m365, // +++ NEU: Neuer Client im Rückgabeobjekt
  };
}

// ... (Rest der Datei, `closeMCPClients` um m365Client erweitern)
```

#### 3.4.2 `srv/service.js` modifizieren
*   **Änderung:** Bringen Sie dem Agenten bei, die neuen M365-Tools zu laden und zu verwenden.

```javascript
// srv/service.js (AUSZUG AUS `initializeAgent`)

// ... (bestehende imports)

// +++ NEU START: Importiere Helfer für die M365-Tools +++
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
// Pfad muss ggf. angepasst werden
const { jsonSchemaToZod } = require("./m365-mcp/mcp-jsonschema.js");
// +++ NEU ENDE +++

// ...

const initializeAgent = async () => {
    if (agentExecutor) return agentExecutor;
    console.log("Initializing Agent with all capabilities...");
    try {
        mcpClients = await initAllMCPClients();
        let allTools = [];

        // ... (bestehender Code zum Laden von postgres, brave, excel etc. Tools)
        allTools.push(...postgresTools, ...braveSearchTools, ...excelTools);

        // +++ NEU START: Lade die M365-Tools dynamisch aus dem Manifest +++
        if (mcpClients.m365) {
            console.log("Loading Microsoft 365 tools...");
            const m365Manifest = await mcpClients.m365.listTools();
            const m365LangchainTools = m365Manifest.tools.map(toolDef => {
                const zodSchema = jsonSchemaToZod(toolDef.inputSchema, z);
                return new DynamicStructuredTool({
                    name: toolDef.name,
                    description: toolDef.description,
                    schema: zodSchema,
                    func: async (input) => {
                        const result = await mcpClients.m365.callTool({ name: toolDef.name, arguments: input });
                        return typeof result === 'string' ? result : JSON.stringify(result);
                    }
                });
            });
            allTools.push(...m365LangchainTools);
            console.log(`✅ Loaded ${m365LangchainTools.length} Microsoft 365 tools.`);
        }
        // +++ NEU ENDE +++

        console.log("All available tools:", allTools.map(tool => tool.name));
        
        // ... (Rest der Funktion: LLM initialisieren, Agent erstellen, etc.)
        
    } catch (error) {
        console.error("❌ Failed to initialize agent:", error);
        throw error;
    }
};
```

### 3.5 Authentifizierung konfigurieren

Erstellen oder bearbeiten Sie die `.env`-Datei im Hauptverzeichnis des `StammtischAI`-Projekts und fügen Sie die folgende Zeile hinzu:

```ini
# .env Datei
# ... (andere Variablen)

# Konfiguration für den M365 Client: Nur die 'm365 login' CLI verwenden
M365_AUTH_METHOD=cli
```

Der Entwickler muss sicherstellen, dass die M365 CLI installiert (`npm i -g @pnp/cli-microsoft365`) und er angemeldet ist (`m365 login`).

### 3.6 System Prompt des Agenten aktualisieren

Öffnen Sie die Datei `srv/prompts/assistant-prompt.js` und fügen Sie im `SYSTEM_PROMPT` einen neuen Abschnitt hinzu, der die M365-Fähigkeiten und den Hybrid-Workflow erklärt.

**Fügen Sie diesen Block zum `SYSTEM_PROMPT` hinzu:**

```
## Erweiterte Agent-Funktionen mit Microsoft 365

Du hast zusätzlich Zugriff auf Microsoft 365.

### Fähigkeiten
- **E-Mails:** Letzte E-Mail lesen (`mail.latestMessage.get`), Anhänge herunterladen (`mail.attachment.download`).
- **Kalender:** Termine auflisten (`calendar.events.list`).

### WICHTIGER WORKFLOW FÜR EXCEL-ANHÄNGE
Wenn du eine Excel-Datei aus einem E-Mail-Anhang analysieren sollst, folge IMMER diesem Plan:
1.  **Schritt 1:** Lade den Anhang zuerst mit `mail.attachment.download` in ein temporäres Verzeichnis herunter. Das Tool gibt dir den benötigten Dateipfad.
2.  **Schritt 2:** Verwende dann die `excel_*` Tools (z.B. `excel_read_sheet`) und übergib ihnen den Dateipfad aus Schritt 1 für die Analyse.
3.  **Schritt 3:** Berichte dem Benutzer das Ergebnis.
```

## 4. Akzeptanzkriterien

Die Umsetzung gilt als erfolgreich, wenn:
1.  Die Anwendung ohne Fehler startet und in den Logs die erfolgreiche Initialisierung des "Microsoft 365 in-process MCP client" angezeigt wird.
2.  Der Agent in der Lage ist, auf die Anfrage "Lies die letzte E-Mail in meinem Posteingang" zu reagieren und den Betreff der E-Mail korrekt wiedergibt.
3.  Der Agent auf die Anfrage "Welche Termine habe ich heute?" korrekt mit einer Liste von Terminen antwortet.
4.  Der Agent den in 3.6 beschriebenen Hybrid-Workflow für Excel-Anhänge korrekt ausführt, wenn eine entsprechende Anfrage gestellt wird.