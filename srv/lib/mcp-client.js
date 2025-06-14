// srv/lib/mcp-client.js (Erweitert für mehrere MCP Server)
import cds from '@sap/cds';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dbConfig = cds.env.requires.db;
let postgresClient = null;
let braveSearchClient = null;

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
    args: ["-y", "@modelcontextprotocol/server-postgres", postgresUri],
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

export async function initAllMCPClients() {
  console.log("Initializing all MCP clients...");
  
  const [pgClient, braveClient] = await Promise.all([
    initPostgresMCPClient(),
    initBraveSearchMCPClient()
  ]);

  return {
    postgres: pgClient,
    braveSearch: braveClient
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
  
  await Promise.all(closePromises);
  console.log("✅ All MCP clients closed");
}

// Backward compatibility - falls Sie den alten Namen noch verwenden
export const initMCPClient = initPostgresMCPClient;
export const closeMCPClient = closeMCPClients;