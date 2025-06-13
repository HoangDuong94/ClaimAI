// srv/lib/mcp-client.js (Zurück zum Standard)
import cds from '@sap/cds';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dbConfig = cds.env.requires.db;
let mcpClient = null;

function getPostgresUri() {
  // Diese Funktion bleibt, da sie die Credentials aus der CAP-Konfig liest
  const creds = dbConfig.credentials;
  return `postgresql://${creds.user}:${creds.password}@${creds.host}:${creds.port}/${creds.database}`;
}

export async function initMCPClient() {
  if (mcpClient) return mcpClient;

  const postgresUri = getPostgresUri();
  console.log(`Initializing MCP client for PostgreSQL...`);

  // Wir versuchen es wieder mit dem Standard "npx"-Aufruf
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", postgresUri],
  });

  // Wichtig: Der Konstruktor braucht immer noch das zweite, leere Objekt
  mcpClient = new Client({ name: "postgres-client", version: "1.0.0" }, {});

  await mcpClient.connect(transport);
  console.log("✅ MCP Client initialized successfully.");
  return mcpClient;
}

export async function closeMCPClient() {
  if (mcpClient) {
    console.log("Closing MCP client connection");
    await mcpClient.close();
    mcpClient = null;
  }
}