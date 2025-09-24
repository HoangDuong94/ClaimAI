// srv/lib/mcp-client.js

import cds from '@sap/cds';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbConfig = cds.env.requires.db;
let postgresClient = null;
let braveSearchClient = null;
let playwrightClient = null;
let filesystemClient = null;
let excelClient = null; // +++ NEU: Excel Client Variable

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
  if (playwrightClient) return playwrightClient;
  console.log(`Initializing Playwright MCP client...`);
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@executeautomation/playwright-mcp-server"],
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSER: process.env.PLAYWRIGHT_BROWSER || "chromium",
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS || "true"
    }
  });
  playwrightClient = new Client({ name: "playwright-client", version: "1.0.0" }, {});
  await playwrightClient.connect(transport);
  console.log("✅ Playwright MCP Client initialized successfully.");
  return playwrightClient;
}

export async function initFilesystemMCPClient() {
  if (filesystemClient) return filesystemClient;
  console.log(`Initializing Filesystem MCP client...`);
  const allowedDirectory = process.cwd();
  console.log(`Filesystem access is sandboxed to: ${allowedDirectory}`);
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", allowedDirectory, "C:/Users/HoangDuong/Desktop/StammtischAI"]
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


export async function initAllMCPClients() {
  console.log("Initializing all MCP clients...");
  
  // +++ ERWEITERT: Excel Client wird mit initialisiert +++
  const [pgClient, braveClient, playwrightClient, fsClient, xlsxClient] = await Promise.all([
    initPostgresMCPClient(),
    initBraveSearchMCPClient(),
    initPlaywrightMCPClient(),
    initFilesystemMCPClient(),
    initExcelMCPClient() // Neuer Client
  ]);

  return {
    postgres: pgClient,
    braveSearch: braveClient,
    playwright: playwrightClient,
    filesystem: fsClient,
    excel: xlsxClient, // Neuer Client im Rückgabeobjekt
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
  if (playwrightClient) {
    console.log("Closing Playwright MCP client connection");
    closePromises.push(playwrightClient.close());
    playwrightClient = null;
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
  
  await Promise.all(closePromises);
  console.log("✅ All MCP clients closed");
}

// Backward compatibility
export const initMCPClient = initPostgresMCPClient;
export const closeMCPClient = closeMCPClients;