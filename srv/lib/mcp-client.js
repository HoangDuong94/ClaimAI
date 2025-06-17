// srv/lib/mcp-client.js (Erweitert für PostgreSQL, Brave Search, Playwright und Filesystem)
import cds from '@sap/cds';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from 'path'; // Import path module
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbConfig = cds.env.requires.db;
let postgresClient = null;
let braveSearchClient = null;
let playwrightClient = null;
let filesystemClient = null; // Hinzugefügt: Filesystem Client Variable

function getPostgresUri() {
  const creds = dbConfig.credentials;
  return `postgresql://${creds.user}:${creds.password}@${creds.host}:${creds.port}/${creds.database}`;
}

export async function initPostgresMCPClient() {
  if (postgresClient) return postgresClient;

  const postgresUri = getPostgresUri();
  console.log(`Initializing PostgreSQL MCP client...`);

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
  if (!braveApiKey) {
    throw new Error("BRAVE_API_KEY is required but not provided");
  }

  console.log(`Initializing Brave Search MCP client...`);

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: {
      ...process.env,
      BRAVE_API_KEY: braveApiKey
    }
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

// +++ NEUE FUNKTION: Filesystem MCP Client initialisieren +++
export async function initFilesystemMCPClient() {
  if (filesystemClient) return filesystemClient;

  console.log(`Initializing Filesystem MCP client...`);
  
  // Gewähre Zugriff auf das gesamte Projektverzeichnis.
  // process.cwd() gibt das aktuelle Arbeitsverzeichnis zurück, in dem der Node.js-Prozess gestartet wurde.
  const allowedDirectory = process.cwd();
  console.log(`Filesystem access is sandboxed to: ${allowedDirectory}`);

  const transport = new StdioClientTransport({
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      allowedDirectory,
       "C:/Users/HoangDuong/Desktop"  // Das Verzeichnis, auf das der Server zugreifen darf
    ],
  });

  filesystemClient = new Client({ name: "filesystem-client", version: "1.0.0" }, {});
  await filesystemClient.connect(transport);
  console.log("✅ Filesystem MCP Client initialized successfully.");
  return filesystemClient;
}


export async function initAllMCPClients() {
  console.log("Initializing all MCP clients...");
  
  // +++ ERWEITERT: Filesystem Client wird mit initialisiert +++
  const [pgClient, braveClient, playwrightClient, fsClient] = await Promise.all([
    initPostgresMCPClient(),
    initBraveSearchMCPClient(),
    initPlaywrightMCPClient(),
    initFilesystemMCPClient() // Neuer Client
  ]);

  return {
    postgres: pgClient,
    braveSearch: braveClient,
    playwright: playwrightClient,
    filesystem: fsClient, // Neuer Client im Rückgabeobjekt
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

  // +++ ERWEITERT: Filesystem Client wird geschlossen +++
  if (filesystemClient) {
    console.log("Closing Filesystem MCP client connection");
    closePromises.push(filesystemClient.close());
    filesystemClient = null;
  }
  
  await Promise.all(closePromises);
  console.log("✅ All MCP clients closed");
}

// Backward compatibility
export const initMCPClient = initPostgresMCPClient;
export const closeMCPClient = closeMCPClients;