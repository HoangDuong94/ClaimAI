// srv/lib/mcp-client.ts

import cds from '@sap/cds';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import os from 'node:os';
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
  filesystem: Client;
  excel: Client;
  m365: Awaited<ReturnType<typeof createInProcessM365Client>>;
  time: Client;
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

// Brave MCP temporarily disabled
// let braveSearchClient: Client | null = null;
let filesystemClient: Client | null = null;
let excelClient: Client | null = null;
let m365Client: Awaited<ReturnType<typeof createInProcessM365Client>> | null = null;
let timeClient: Client | null = null;
let capClient: any | null = null;
let cdsModelClient: Client | null = null;

// export async function initBraveSearchMCPClient(): Promise<Client> {
//   if (braveSearchClient) return braveSearchClient;
//   const braveApiKey = process.env.BRAVE_API_KEY || (cds.env as any).BRAVE_API_KEY;
//   if (!braveApiKey) throw new Error('BRAVE_API_KEY is required but not provided');
//   console.log('Initializing Brave Search MCP client...');
//   const transport = new StdioClientTransport({
//     command: 'npx',
//     args: ['-y', '@modelcontextprotocol/server-brave-search'],
//     env: sanitizeEnv({ BRAVE_API_KEY: braveApiKey })
//   });
//   braveSearchClient = new Client({ name: 'brave-search-client', version: '1.0.0' }, {});
//   await braveSearchClient.connect(transport);
//   console.log('✅ Brave Search MCP Client initialized successfully.');
//   return braveSearchClient;
// }

export async function initFilesystemMCPClient(): Promise<Client> {
  if (filesystemClient) return filesystemClient;
  console.log('Initializing Filesystem MCP client...');
  const normalizeBase = (raw?: string): string => {
    let base = (raw && raw.trim()) || process.cwd();
    const isWSL = process.platform === 'linux' && (
      os.release().toLowerCase().includes('microsoft') || !!process.env.WSL_DISTRO_NAME
    );
    const isWindowsPath = /^[A-Za-z]:[\\/]/.test(base);
    if (isWSL && isWindowsPath) {
      const drive = base[0].toLowerCase();
      const rest = base.slice(2).replace(/\\/g, '/');
      base = `/mnt/${drive}${rest.startsWith('/') ? '' : '/'}${rest}`;
    }
    return path.resolve(base);
  };

  const allowedDirectory = normalizeBase(process.env.M365_ATTACHMENT_BASE_PATH);
  console.log(`Filesystem access is sandboxed to: ${allowedDirectory}`);
  // Avoid Windows-only env confusing the server when running in WSL
  const env = sanitizeEnv({
    M365_ATTACHMENT_BASE_PATH: allowedDirectory,
    MCP_FS_ALLOWED_DIRS: allowedDirectory,
    USERPROFILE: undefined,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    APPDATA: undefined,
    LOCALAPPDATA: undefined
  });
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', allowedDirectory],
    env
  });
  filesystemClient = new Client({ name: 'filesystem-client', version: '1.0.0' }, {});
  await filesystemClient.connect(transport, { timeout: 180000 });
  console.log('✅ Filesystem MCP Client initialized successfully.');
  return filesystemClient;
}

export async function initExcelMCPClient(): Promise<Client> {
  if (excelClient) return excelClient;

  console.log('Initializing Excel MCP client...');
  // Prefer locally installed binary if available to avoid network 'npx' fetches
  const localBin = process.platform === 'win32'
    ? path.resolve(process.cwd(), 'node_modules', '.bin', 'excel-mcp-server.cmd')
    : path.resolve(process.cwd(), 'node_modules', '.bin', 'excel-mcp-server');

  const useLocal = (() => {
    try {
      const { existsSync } = require('node:fs') as typeof import('node:fs');
      return existsSync(localBin);
    } catch { return false; }
  })();

  const transport = new StdioClientTransport(
    useLocal
      ? { command: localBin, args: [], env: sanitizeEnv({ EXCEL_MCP_PAGING_CELLS_LIMIT: '4000' }) }
      : {
          command: process.platform === 'win32' ? 'cmd' : 'npx',
          args: process.platform === 'win32'
            ? ['/c', 'npx', '--yes', '@negokaz/excel-mcp-server']
            : ['--yes', '@negokaz/excel-mcp-server'],
          env: sanitizeEnv({ EXCEL_MCP_PAGING_CELLS_LIMIT: '4000' })
        }
  );

  excelClient = new Client({ name: 'excel-client', version: '1.0.0' }, {});
  await excelClient.connect(transport, { timeout: 240000 });
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
  await timeClient.connect(transport, { timeout: 180000 });
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
  await cdsModelClient.connect(transport, { timeout: 120000 });
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
  const disableFs = String(process.env.CLAIMAI_DISABLE_MCP_FILESYSTEM || '').toLowerCase() === 'true';
  const fsClientPromise = disableFs ? Promise.resolve(null as unknown as Client) : initFilesystemMCPClient();

  const [capInProcessClient, cdsModel, fsClient, xlsxClient, microsoft365Client, timeMcpClient] = await Promise.all([
    initCapInProcessClient({ capService, logger }),
    initCdsModelMCPClient(),
    fsClientPromise,
    initExcelMCPClient(),
    initM365Client(),
    initTimeMCPClient()
  ]);

  return {
    cap: capInProcessClient,
    cdsModel,
    // braveSearch: braveClient,
    filesystem: fsClient,
    excel: xlsxClient,
    m365: microsoft365Client,
    time: timeMcpClient
  };
}

export async function closeMCPClients(): Promise<void> {
  const closePromises: Array<Promise<unknown>> = [];

  // if (braveSearchClient) {
  //   console.log('Closing Brave Search MCP client connection');
  //   closePromises.push(braveSearchClient.close());
  //   braveSearchClient = null;
  // }
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
