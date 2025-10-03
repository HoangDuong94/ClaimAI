// srv/lib/mcp-client.js

import cds from '@sap/cds';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initM365InProcessClient as createInProcessM365Client } from '../m365-mcp/index.js';
import { initCapMCPClient as createInProcessCapClient } from '../mcp-cap/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbConfig = cds.env.requires.db;
let postgresClient = null;
let braveSearchClient = null;
let playwrightClient = null;
let filesystemClient = null;
let excelClient = null; // +++ NEU: Excel Client Variable
let m365Client = null;
let timeClient = null;
let capClient = null;

function getPostgresUri() {
  const creds = dbConfig.credentials;
  return `postgresql://${creds.user}:${creds.password}@${creds.host}:${creds.port}/${creds.database}`;
}

export async function initPostgresMCPClient() {
  if (postgresClient) return postgresClient;
  console.log(`Initializing PostgreSQL MCP client...`);
  const postgresUri = getPostgresUri();
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-postgres-full-access", postgresUri],
  });
  postgresClient = new Client({ name: "postgres-client", version: "1.0.0" }, {});
  await postgresClient.connect(transport);
  console.log("✅ PostgreSQL MCP Client initialized successfully.");
  return postgresClient;
}

export async function initBraveSearchMCPClient() {
  if (braveSearchClient) return braveSearchClient;
  const braveApiKey = process.env.BRAVE_API_KEY || cds.env.BRAVE_API_KEY;
  if (!braveApiKey) throw new Error("BRAVE_API_KEY is required but not provided");
  console.log(`Initializing Brave Search MCP client...`);
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { ...process.env, BRAVE_API_KEY: braveApiKey }
  });
  braveSearchClient = new Client({ name: "brave-search-client", version: "1.0.0" }, {});
  await braveSearchClient.connect(transport);
  console.log("✅ Brave Search MCP Client initialized successfully.");
  return braveSearchClient;
}

export async function initPlaywrightMCPClient() {
  console.log('⏸️ Playwright MCP client initialization is temporarily disabled.');
  return null;
}

export async function initFilesystemMCPClient() {
  if (filesystemClient) return filesystemClient;
  console.log(`Initializing Filesystem MCP client...`);
  const allowedDirectory = process.env.M365_ATTACHMENT_BASE_PATH || process.cwd();
  console.log(`Filesystem access is sandboxed to: ${allowedDirectory}`);
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", allowedDirectory]
  });
  filesystemClient = new Client({ name: "filesystem-client", version: "1.0.0" }, {});
  await filesystemClient.connect(transport);
  console.log("✅ Filesystem MCP Client initialized successfully.");
  return filesystemClient;
}

// +++ NEUE FUNKTION: Excel MCP Client initialisieren +++
export async function initExcelMCPClient() {
  if (excelClient) return excelClient;

  console.log(`Initializing Excel MCP client...`);

  // Konfiguration basierend auf der README des Excel MCP Servers.
  // Diese Konfiguration ist für Windows. Für andere Plattformen (macOS/Linux)
  // wäre der Befehl: { command: "npx", args: ["--yes", "@negokaz/excel-mcp-server"] }
  const transport = new StdioClientTransport({
    command: "cmd",
    args: ["/c", "npx", "--yes", "@negokaz/excel-mcp-server"],
    env: {
      ...process.env,
      EXCEL_MCP_PAGING_CELLS_LIMIT: "4000" // Wie im Beispiel der README
    }
  });

  excelClient = new Client({ name: "excel-client", version: "1.0.0" }, {});
  await excelClient.connect(transport);
  console.log("✅ Excel MCP Client initialized successfully.");
  return excelClient;
}


export async function initM365Client() {
  if (m365Client) return m365Client;

  m365Client = await createInProcessM365Client({ logger: console });
  return m365Client;
}


export async function initTimeMCPClient() {
  if (timeClient) return timeClient;

  const command = process.env.TIME_MCP_COMMAND || 'python';
  let args;
  try {
    args = process.env.TIME_MCP_ARGS ? JSON.parse(process.env.TIME_MCP_ARGS) : ['-m', 'mcp_server_time'];
  } catch (error) {
    throw new Error(`Failed to parse TIME_MCP_ARGS. Provide a JSON array string, e.g. ["-m","mcp_server_time"]. Original error: ${error.message}`);
  }

  if (!Array.isArray(args)) {
    throw new Error('TIME_MCP_ARGS must be a JSON array string when provided.');
  }

  console.log('Initializing Time MCP client...');
  const transport = new StdioClientTransport({
    command,
    args,
    env: process.env
  });

  timeClient = new Client({ name: 'time-client', version: '1.0.0' }, {});
  await timeClient.connect(transport);
  console.log('✅ Time MCP Client initialized successfully.');

  return timeClient;
}

export async function initCapInProcessClient({ capService, logger } = {}) {
  if (capClient) return capClient;
  if (!capService) {
    throw new Error('initCapInProcessClient requires the CAP service instance.');
  }
  console.log('Initializing CAP in-process MCP client...');
  capClient = await createInProcessCapClient({ service: capService, logger });
  console.log('✅ CAP MCP Client initialized successfully.');
  return capClient;
}


export async function initAllMCPClients(options = {}) {
  console.log("Initializing all MCP clients...");

  const { capService, logger } = options;

  // +++ ERWEITERT: Excel Client wird mit initialisiert +++
  const [capInProcessClient, pgClient, braveClient, fsClient, xlsxClient, microsoft365Client, timeMcpClient] = await Promise.all([
    initCapInProcessClient({ capService, logger }),
    initPostgresMCPClient(),
    initBraveSearchMCPClient(),
    initFilesystemMCPClient(),
    initExcelMCPClient(), // Neuer Client
    initM365Client(),
    initTimeMCPClient()
  ]);

  return {
    cap: capInProcessClient,
    postgres: pgClient,
    braveSearch: braveClient,
    playwright: null,
    filesystem: fsClient,
    excel: xlsxClient, // Neuer Client im Rückgabeobjekt
    m365: microsoft365Client,
    time: timeMcpClient
  };
}

export async function closeMCPClients() {
  const closePromises = [];
  
  if (postgresClient) {
    console.log("Closing PostgreSQL MCP client connection");
    closePromises.push(postgresClient.close());
    postgresClient = null;
  }
  if (braveSearchClient) {
    console.log("Closing Brave Search MCP client connection");
    closePromises.push(braveSearchClient.close());
    braveSearchClient = null;
  }
  if (filesystemClient) {
    console.log("Closing Filesystem MCP client connection");
    closePromises.push(filesystemClient.close());
    filesystemClient = null;
  }
  // +++ ERWEITERT: Excel Client wird geschlossen +++
  if (excelClient) {
    console.log("Closing Excel MCP client connection");
    closePromises.push(excelClient.close());
    excelClient = null;
  }
  if (m365Client) {
    console.log("Closing Microsoft 365 MCP client connection");
    closePromises.push(m365Client.close());
    m365Client = null;
  }
  if (timeClient) {
    console.log("Closing Time MCP client connection");
    closePromises.push(timeClient.close());
    timeClient = null;
  }
  if (capClient) {
    console.log("Closing CAP MCP client connection");
    closePromises.push(capClient.close());
    capClient = null;
  }

  await Promise.all(closePromises);
  console.log("✅ All MCP clients closed");
}

// Backward compatibility
export const initMCPClient = initPostgresMCPClient;
export const closeMCPClient = closeMCPClients;
