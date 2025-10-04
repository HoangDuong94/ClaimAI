// srv/lib/mcp-client.ts

import cds from '@sap/cds';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initM365InProcessClient as createInProcessM365Client } from '../m365-mcp/index.js';
import { initCapMCPClient as createInProcessCapClient } from '../mcp-cap/index.js';

interface CapClientInitOptions {
  capService: any;
  logger?: Console;
}

interface InitAllClientOptions {
  capService?: any;
  logger?: Console;
}

interface InitAllClientsResult {
  cap: any;
  cdsModel: Client;
  postgres: Client;
  braveSearch: Client;
  playwright: null;
  filesystem: Client;
  excel: Client;
  m365: Awaited<ReturnType<typeof createInProcessM365Client>>;
  time: Client;
}

interface DbCredentials {
  user: string;
  password: string;
  host: string;
  port: number | string;
  database: string;
}

interface RequiresDbConfig {
  credentials?: Partial<DbCredentials> | null;
}

function normalizeDbCredentials(candidate: Partial<DbCredentials> | null | undefined): DbCredentials | null {
  if (!candidate) return null;
  const { user, password, host, database } = candidate;
  const port = candidate.port ?? 5433;
  if (!user || !password || !host || !database) {
    return null;
  }
  return {
    user,
    password,
    host,
    port,
    database
  };
}

function resolveDbCredentials(): DbCredentials {
  const requiresDb = cds.env?.requires?.db as RequiresDbConfig | undefined;
  const credentialsFromConfig = normalizeDbCredentials(requiresDb?.credentials ?? null);
  if (credentialsFromConfig) {
    return credentialsFromConfig;
  }

  const envCredentials = normalizeDbCredentials({
    user: process.env.POSTGRES_USER ?? process.env.CLAIMAI_POSTGRES_USER ?? undefined,
    password: process.env.POSTGRES_PASSWORD ?? process.env.CLAIMAI_POSTGRES_PASSWORD ?? undefined,
    host: process.env.POSTGRES_HOST ?? process.env.CLAIMAI_POSTGRES_HOST ?? 'localhost',
    port: process.env.POSTGRES_PORT ?? process.env.CLAIMAI_POSTGRES_PORT ?? 5433,
    database: process.env.POSTGRES_DB ?? process.env.CLAIMAI_POSTGRES_DB ?? undefined
  });

  if (envCredentials) {
    return envCredentials;
  }

  throw new Error('Unable to resolve PostgreSQL credentials from cds.env or process.env.');
}

function sanitizeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    } else if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

const dbCredentials = resolveDbCredentials();

let postgresClient: Client | null = null;
let braveSearchClient: Client | null = null;
let playwrightClient: null = null;
let filesystemClient: Client | null = null;
let excelClient: Client | null = null;
let m365Client: Awaited<ReturnType<typeof createInProcessM365Client>> | null = null;
let timeClient: Client | null = null;
let capClient: any | null = null;
let cdsModelClient: Client | null = null;

function getPostgresUri(): string {
  const creds = dbCredentials;
  return `postgresql://${creds.user}:${creds.password}@${creds.host}:${creds.port}/${creds.database}`;
}

export async function initPostgresMCPClient(): Promise<Client> {
  if (postgresClient) return postgresClient;
  console.log('Initializing PostgreSQL MCP client...');
  const postgresUri = getPostgresUri();
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-postgres-full-access', postgresUri]
  });
  postgresClient = new Client({ name: 'postgres-client', version: '1.0.0' }, {});
  await postgresClient.connect(transport);
  console.log('✅ PostgreSQL MCP Client initialized successfully.');
  return postgresClient;
}

export async function initBraveSearchMCPClient(): Promise<Client> {
  if (braveSearchClient) return braveSearchClient;
  const braveApiKey = process.env.BRAVE_API_KEY || (cds.env as any).BRAVE_API_KEY;
  if (!braveApiKey) throw new Error('BRAVE_API_KEY is required but not provided');
  console.log('Initializing Brave Search MCP client...');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: sanitizeEnv({ BRAVE_API_KEY: braveApiKey })
  });
  braveSearchClient = new Client({ name: 'brave-search-client', version: '1.0.0' }, {});
  await braveSearchClient.connect(transport);
  console.log('✅ Brave Search MCP Client initialized successfully.');
  return braveSearchClient;
}

export async function initPlaywrightMCPClient(): Promise<null> {
  console.log('⏸️ Playwright MCP client initialization is temporarily disabled.');
  return null;
}

export async function initFilesystemMCPClient(): Promise<Client> {
  if (filesystemClient) return filesystemClient;
  console.log('Initializing Filesystem MCP client...');
  const allowedDirectory = process.env.M365_ATTACHMENT_BASE_PATH || process.cwd();
  console.log(`Filesystem access is sandboxed to: ${allowedDirectory}`);
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', allowedDirectory]
  });
  filesystemClient = new Client({ name: 'filesystem-client', version: '1.0.0' }, {});
  await filesystemClient.connect(transport);
  console.log('✅ Filesystem MCP Client initialized successfully.');
  return filesystemClient;
}

export async function initExcelMCPClient(): Promise<Client> {
  if (excelClient) return excelClient;

  console.log('Initializing Excel MCP client...');
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'cmd' : 'npx',
    args: process.platform === 'win32'
      ? ['/c', 'npx', '--yes', '@negokaz/excel-mcp-server']
      : ['--yes', '@negokaz/excel-mcp-server'],
    env: sanitizeEnv({ EXCEL_MCP_PAGING_CELLS_LIMIT: '4000' })
  });

  excelClient = new Client({ name: 'excel-client', version: '1.0.0' }, {});
  await excelClient.connect(transport);
  console.log('✅ Excel MCP Client initialized successfully.');
  return excelClient;
}

export async function initM365Client(): Promise<Awaited<ReturnType<typeof createInProcessM365Client>>> {
  if (m365Client) return m365Client;
  m365Client = await createInProcessM365Client({ logger: console });
  return m365Client;
}

export async function initTimeMCPClient(): Promise<Client> {
  if (timeClient) return timeClient;

  const command = process.env.TIME_MCP_COMMAND || 'python';
  let args: string[];
  try {
    const parsed = process.env.TIME_MCP_ARGS ? JSON.parse(process.env.TIME_MCP_ARGS) : ['-m', 'mcp_server_time'];
    if (!Array.isArray(parsed)) {
      throw new Error('TIME_MCP_ARGS must be a JSON array string when provided.');
    }
    args = parsed;
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to parse TIME_MCP_ARGS. Provide a JSON array string, e.g. ["-m","mcp_server_time"]. Original error: ${err.message}`);
  }

  console.log('Initializing Time MCP client...');
  const transport = new StdioClientTransport({
    command,
    args,
    env: sanitizeEnv()
  });

  timeClient = new Client({ name: 'time-client', version: '1.0.0' }, {});
  await timeClient.connect(transport);
  console.log('✅ Time MCP Client initialized successfully.');

  return timeClient;
}

export async function initCdsModelMCPClient(): Promise<Client> {
  if (cdsModelClient) return cdsModelClient;

  console.log('Initializing cds-mcp (model/documentation) client...');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['--yes', '--package', '@cap-js/mcp-server', 'cds-mcp']
  });

  cdsModelClient = new Client({ name: 'cds-mcp-client', version: '1.0.0' }, {});
  await cdsModelClient.connect(transport);
  console.log('✅ cds-mcp client initialized successfully.');
  return cdsModelClient;
}

export async function initCapInProcessClient({ capService, logger }: CapClientInitOptions): Promise<any> {
  if (capClient) return capClient;
  if (!capService) {
    throw new Error('initCapInProcessClient requires the CAP service instance.');
  }
  console.log('Initializing CAP in-process MCP client...');
  capClient = await createInProcessCapClient({ service: capService, logger });
  console.log('✅ CAP MCP Client initialized successfully.');
  return capClient;
}

export async function initAllMCPClients(options: InitAllClientOptions = {}): Promise<InitAllClientsResult> {
  console.log('Initializing all MCP clients...');

  const { capService, logger } = options;
  const [capInProcessClient, cdsModel, pgClient, braveClient, fsClient, xlsxClient, microsoft365Client, timeMcpClient] = await Promise.all([
    initCapInProcessClient({ capService, logger }),
    initCdsModelMCPClient(),
    initPostgresMCPClient(),
    initBraveSearchMCPClient(),
    initFilesystemMCPClient(),
    initExcelMCPClient(),
    initM365Client(),
    initTimeMCPClient()
  ]);

  return {
    cap: capInProcessClient,
    cdsModel,
    postgres: pgClient,
    braveSearch: braveClient,
    playwright: playwrightClient,
    filesystem: fsClient,
    excel: xlsxClient,
    m365: microsoft365Client,
    time: timeMcpClient
  };
}

export async function closeMCPClients(): Promise<void> {
  const closePromises: Array<Promise<unknown>> = [];

  if (postgresClient) {
    console.log('Closing PostgreSQL MCP client connection');
    closePromises.push(postgresClient.close());
    postgresClient = null;
  }
  if (braveSearchClient) {
    console.log('Closing Brave Search MCP client connection');
    closePromises.push(braveSearchClient.close());
    braveSearchClient = null;
  }
  if (filesystemClient) {
    console.log('Closing Filesystem MCP client connection');
    closePromises.push(filesystemClient.close());
    filesystemClient = null;
  }
  if (excelClient) {
    console.log('Closing Excel MCP client connection');
    closePromises.push(excelClient.close());
    excelClient = null;
  }
  if (cdsModelClient) {
    console.log('Closing cds-mcp client connection');
    closePromises.push(cdsModelClient.close());
    cdsModelClient = null;
  }
  if (m365Client) {
    console.log('Closing Microsoft 365 MCP client connection');
    closePromises.push(m365Client.close());
    m365Client = null;
  }
  if (timeClient) {
    console.log('Closing Time MCP client connection');
    closePromises.push(timeClient.close());
    timeClient = null;
  }
  if (capClient) {
    console.log('Closing CAP MCP client connection');
    closePromises.push(capClient.close());
    capClient = null;
  }

  await Promise.all(closePromises);
  console.log('✅ All MCP clients closed');
}

export const initMCPClient = initPostgresMCPClient;
export const closeMCPClient = closeMCPClients;
