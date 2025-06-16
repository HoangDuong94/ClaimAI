// srv/lib/mcp-client.js (Erweitert für PostgreSQL, Brave Search und Playwright)
import cds from '@sap/cds';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dbConfig = cds.env.requires.db;
let postgresClient = null;
let braveSearchClient = null;
let playwrightClient = null;

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
    // args: ["-y", "@modelcontextprotocol/server-postgres", postgresUri],
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
      // Optional: Konfiguration für Playwright
      PLAYWRIGHT_BROWSER: process.env.PLAYWRIGHT_BROWSER || "chromium",
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS || "true"
    }
  });

  playwrightClient = new Client({ name: "playwright-client", version: "1.0.0" }, {});
  await playwrightClient.connect(transport);
  console.log("✅ Playwright MCP Client initialized successfully.");
  return playwrightClient;
}

export async function initAllMCPClients() {
  console.log("Initializing all MCP clients...");
  
  const [pgClient, braveClient, playwrightClient] = await Promise.all([
    initPostgresMCPClient(),
    initBraveSearchMCPClient(),
    initPlaywrightMCPClient()
  ]);

  return {
    postgres: pgClient,
    braveSearch: braveClient,
    playwright: playwrightClient
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
  
  await Promise.all(closePromises);
  console.log("✅ All MCP clients closed");
}

// Backward compatibility - falls Sie den alten Namen noch verwenden
export const initMCPClient = initPostgresMCPClient;
export const closeMCPClient = closeMCPClients;