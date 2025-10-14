// srv/test/evals/agent.workflow.mjs
// Minimal LangGraph harness to exercise end-to-end workflows without spinning the CAP server.
// Uses the in-process M365 mock and MCP Excel/Filesystem/Time tools.

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { DynamicStructuredTool } from '@langchain/core/tools';
import * as z from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';

import { initExcelMCPClient, initFilesystemMCPClient, initTimeMCPClient, initCdsModelMCPClient, closeMCPClients } from '../../../gen/srv/lib/mcp-client.js';
import { initM365InProcessClient } from '../../../gen/srv/m365-mcp/index.js';
import { jsonSchemaToZod } from '../../../gen/srv/m365-mcp/mcp-jsonschema.js';
import { section, kv, ok, warn, fail, info, colors, truncate, measure, hr } from './utils/format.mjs';
import { mkdir, readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function toolSpy() {
  const events = [];
  const record = (type, payload) => events.push({ t: Date.now(), type, payload });
  return { events, record };
}

function readJson(envName) {
  try { return JSON.parse(process.env[envName] || 'null'); } catch { return null; }
}

async function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    const raw = await readFile(envPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      i++;
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if (key === 'AICORE_SERVICE_KEY' && val.trim().startsWith('{') && !val.trim().endsWith('}')) {
        const buf = [val];
        let depth = 0;
        const countBraces = (s) => (s.match(/\{/g)?.length || 0) - (s.match(/\}/g)?.length || 0);
        depth += countBraces(val);
        while (i < lines.length && depth > 0) {
          const l = lines[i++];
          buf.push(l);
          depth += countBraces(l);
          if (depth <= 0) break;
        }
        val = buf.join('\n');
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
    info(`Loaded .env (${envPath})`);
  } catch {}
}

function hasAiCoreBinding() {
  const vcap = readJson('VCAP_SERVICES');
  const hasVcap = !!vcap && (Object.keys(vcap).some(k => k.toLowerCase().includes('aicore')) || Boolean(vcap?.aicore));
  const hasKey = typeof process.env.AICORE_SERVICE_KEY === 'string' && process.env.AICORE_SERVICE_KEY.trim().startsWith('{');
  return hasVcap || hasKey;
}

function getModelDeploymentFromArgs() {
  const arg = (k) => process.argv.slice(2).find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  const modelName = (arg('model') || process.env.AICORE_MODEL || 'gpt-4.1').trim();
  const resourceGroup = (arg('rg') || process.env.AICORE_RESOURCE_GROUP || '').trim() || undefined;
  const deploymentId = (arg('deployment') || process.env.AICORE_DEPLOYMENT_ID || '').trim() || undefined;
  return { modelName, resourceGroup, deploymentId };
}

async function buildAgent(spy) {
  await loadDotEnv();
  const { modelName, resourceGroup, deploymentId } = getModelDeploymentFromArgs();
  section('AI Core (LLM)');
  kv('Model', modelName);
  kv('Resource group', resourceGroup || '—');
  kv('Deployment ID', deploymentId || '—');
  kv('AI Core binding detected', hasAiCoreBinding() ? colors.green('yes') : colors.red('no'));

  process.env.M365_AUTH_METHOD = process.env.M365_AUTH_METHOD || 'mock';
  process.env.M365_ATTACHMENT_BASE_PATH = process.env.M365_ATTACHMENT_BASE_PATH || path.resolve(process.cwd(), 'tmp', 'attachments');
  try { await mkdir(process.env.M365_ATTACHMENT_BASE_PATH, { recursive: true }); } catch {}

  let fsClient = null;
  try {
    fsClient = await initFilesystemMCPClient();
  } catch (e) {
    warn('Filesystem MCP unavailable — skipping filesystem tools');
  }
  let excelClient = null;
  try {
    excelClient = await initExcelMCPClient();
  } catch (e) {
    warn('Excel MCP unavailable — skipping Excel tools');
  }
  let timeClient = null;
  try {
    timeClient = await initTimeMCPClient();
  } catch (e) {
    warn('Time MCP unavailable (python missing) — skipping time tools');
  }
  const cdsModelClient = await initCdsModelMCPClient();
  const m365 = await initM365InProcessClient({ authMethod: 'mock', logger: console });

  const makeTools = async () => {
    const capTools = [];
    const cdsModelTools = await loadMcpTools('search_model', cdsModelClient).catch(() => []);
    const filesystemTools = fsClient ? await loadMcpTools(
      'read_file,write_file,edit_file,create_directory,list_directory,move_file,search_files,get_file_info,list_allowed_directories',
      fsClient
    ).catch(() => []) : [];
    const excelTools = excelClient ? await loadMcpTools(
      'excel_describe_sheets,excel_read_sheet,excel_screen_capture,excel_write_to_sheet,excel_create_table,excel_copy_sheet',
      excelClient
    ).catch(() => []) : [];
    const timeTools = timeClient ? await loadMcpTools('get_current_time,convert_time', timeClient).catch(() => []) : [];

    const manifest = await m365.listTools();
    const m365Tools = manifest.tools.map((def) => {
      const schema = jsonSchemaToZod(def.inputSchema, z);
      return new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema,
        func: async (input) => {
          spy?.record('tool_call', { name: def.name, input });
          const result = await m365.callTool({ name: def.name, arguments: input });
          return typeof result === 'string' ? result : JSON.stringify(result);
        }
      });
    });

    const draftMail = new DynamicStructuredTool({
      name: 'draft.mail.compose',
      description: 'Erstellt ausschließlich einen E-Mail-Entwurf (ohne Versand) und gibt eine strukturierte Vorschau zurück.',
      schema: z.object({
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string().min(1),
        body: z.string().min(1),
        contentType: z.enum(['Text', 'HTML']).default('Text')
      }),
      func: async (input) => {
        spy?.record('tool_call', { name: 'draft.mail.compose', input });
        return JSON.stringify({ status: 'draft-prepared', channel: 'mail', draft: input });
      }
    });

    const draftCalendar = new DynamicStructuredTool({
      name: 'draft.calendar.compose',
      description: 'Bereitet einen Kalendereintrag als Entwurf vor (keine Einladung wird versendet).',
      schema: z.object({
        subject: z.string().min(1),
        startDateTime: z.string().min(1),
        endDateTime: z.string().min(1),
        timezone: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        location: z.string().optional(),
        body: z.string().optional(),
        contentType: z.enum(['Text', 'HTML']).default('Text'),
        reminderMinutesBeforeStart: z.number().optional()
      }),
      func: async (input) => {
        spy?.record('tool_call', { name: 'draft.calendar.compose', input });
        return JSON.stringify({ status: 'draft-prepared', channel: 'calendar', draft: input });
      }
    });

    return [
      ...cdsModelTools,
      ...capTools,
      ...filesystemTools,
      ...excelTools,
      ...timeTools,
      ...m365Tools,
      draftMail,
      draftCalendar
    ];
  };

  const tools = await makeTools();
  const llm = new AzureOpenAiChatClient(
    deploymentId ? { deploymentId, resourceGroup } : { modelName, resourceGroup }
  );
  const checkpointer = new MemorySaver();
  const agent = createReactAgent({ llm, tools, checkpointSaver: checkpointer });
  return agent;
}

async function runStep(agent, spy, user, promptText, idx) {
  const t0 = Date.now();
  const stream = await agent.stream({ messages: [{ role: 'user', content: promptText }] }, { configurable: { thread_id: user } });
  const toolCalls = [];
  let assistantText = '';
  for await (const chunk of stream) {
    if (chunk.agent?.messages) {
      const message = chunk.agent.messages[chunk.agent.messages.length - 1];
      if (message?.content) {
        const c = Array.isArray(message.content)
          ? message.content.filter(p => p?.type === 'text').map(p => p.text).join('\n')
          : String(message.content);
        assistantText = c;
      }
      if (message?.tool_calls?.length) toolCalls.push(...message.tool_calls);
    }
  }
  const ms = Date.now() - t0;
  section(`Step ${idx + 1}`);
  kv('Prompt', promptText);
  kv('Tools', toolCalls.map(t => t.name).join(', ') || '—');
  kv('Duration', `${ms} ms`);
  if (assistantText) kv('Assistant', truncate(assistantText, 400));
  spy?.record('step', { ms, tools: toolCalls.map(t => t.name) });
  return { ms, toolCalls, assistantText };
}

async function main() {
  section('Workflow Eval: LangGraph agent');
  const spy = toolSpy();
  const agent = await buildAgent(spy);
  ok('Agent built with Filesystem, Excel, Time, M365, drafts');
  const user = `eval_${Date.now()}`;

  // Scenario prompts
  const steps = [
    'Lese mir die aktuellste E-Mail und zeige sie an.',
    'Was steht in der Excel? Gib mir bitte alles aus.',
    'Beschreibe mir die Fotos.',
    'Kannst du auf die Email antworten, dass ich noch einen Polizeibericht brauche? Erstelle nur einen Entwurf.',
    'Ändere bitte den Entwurf: Füge hinzu, dass es sich um einen frontalen Auffahrunfall handelt.',
    'Erstelle mir einen Kalendereintrag für übermorgen 15:00-16:00 Uhr als Online-Termin. Frage erst nach, falls Informationen fehlen.',
    'Erstelle mir einen Draft und importiere die Excel-Daten in den Draft.'
  ];

  try {
    for (let i = 0; i < steps.length; i++) {
      const text = steps[i];
      kv(colors.bold('User'), text);
      await runStep(agent, spy, user, text, i);
    }
    hr();
    const totalToolCalls = spy.events.filter(e => e.type === 'tool_call').length;
    kv('Total steps', steps.length);
    kv('Tool invocations', totalToolCalls);
    ok('Workflow eval completed');
  } finally {
    try { await closeMCPClients(); } catch {}
  }
}

main().catch((err) => {
  console.error('Workflow eval failed:', err);
  process.exit(1);
});
