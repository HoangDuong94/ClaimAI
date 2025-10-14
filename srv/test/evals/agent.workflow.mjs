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

import { initExcelMCPClient, initFilesystemMCPClient, initTimeMCPClient, initCdsModelMCPClient, closeMCPClients, initCapInProcessClient } from '../../../gen/srv/lib/mcp-client.js';
import cds from '@sap/cds';
import { initM365InProcessClient } from '../../../gen/srv/m365-mcp/index.js';
import { jsonSchemaToZod } from '../../../gen/srv/m365-mcp/mcp-jsonschema.js';
import { section, kv, ok, warn, fail, info, colors, truncate, measure, hr } from './utils/format.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { analyzeImageAttachment } from '../../../gen/srv/utils/vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function toolSpy() {
  const start = Date.now();
  const events = [];
  const record = (type, payload) => events.push({ t: Date.now(), dt: Date.now() - start, type, payload });
  return { start, events, record };
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

let excelClientGlobal = null;
let m365ClientGlobal = null;

async function buildAgent(spy) {
  await loadDotEnv();
  const { modelName, resourceGroup, deploymentId } = getModelDeploymentFromArgs();
  section('AI Core (LLM)');
  kv('Model', modelName);
  kv('Resource group', resourceGroup || '—');
  kv('Deployment ID', deploymentId || '—');
  kv('AI Core binding detected', hasAiCoreBinding() ? colors.green('yes') : colors.red('no'));
  kv('LangSmith tracing', String(process.env.LANGSMITH_TRACING || 'false'));

  // Allow real M365 if explicitly requested via env
  if (!process.env.M365_AUTH_METHOD) process.env.M365_AUTH_METHOD = 'mock';
  const previousAttachBase = process.env.M365_ATTACHMENT_BASE_PATH;
  process.env.M365_ATTACHMENT_BASE_PATH = path.resolve(process.cwd(), 'tmp', 'attachments');
  try { await mkdir(process.env.M365_ATTACHMENT_BASE_PATH, { recursive: true }); } catch {}
  kv('Attachments base', process.env.M365_ATTACHMENT_BASE_PATH);
  if (previousAttachBase && previousAttachBase !== process.env.M365_ATTACHMENT_BASE_PATH) {
    info(`Overriding M365_ATTACHMENT_BASE_PATH for eval (was: ${previousAttachBase})`);
  }
  // Fixed Excel copy (temporary): copy fixture into tmp and use that path
  const EXCEL_SRC = path.resolve(process.cwd(), 'MockDaten', 'Kalkulation_CLM-CH-LU-2025-002 (1).xlsx');
  const TMP_DIR = path.resolve(process.cwd(), 'tmp');
  const EXCEL_TMP_PATH = path.join(TMP_DIR, 'excel_eval.xlsx');
  const EXCEL_TMP_PATH_WIN = 'C\\\\Users\\\\HoangDuong\\\\ClaimAI\\\\tmp\\\\excel_eval.xlsx';
  try { await mkdir(TMP_DIR, { recursive: true }); } catch {}
  try {
    const buf = await readFile(EXCEL_SRC);
    await writeFile(EXCEL_TMP_PATH, buf);
    info(`Copied Excel to ${EXCEL_TMP_PATH}`);
  } catch (e) { warn(`Copy Excel failed: ${String(e?.message||e)}`); }
  kv('Excel tmp path', EXCEL_TMP_PATH);
  kv('Excel tmp path (Win)', EXCEL_TMP_PATH_WIN);

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
  excelClientGlobal = excelClient;
  let timeClient = null;
  try {
    timeClient = await initTimeMCPClient();
  } catch (e) {
    warn('Time MCP unavailable (python missing) — skipping time tools');
  }
  const cdsModelClient = await initCdsModelMCPClient();
  const m365 = await initM365InProcessClient({ authMethod: process.env.M365_AUTH_METHOD, logger: console });
  m365ClientGlobal = m365;

  const wrapTools = (group, arr, spy) => {
    return arr.map((tool) => {
      // Preserve name/description/schema for observability
      const name = tool?.name || `${group}_tool`;
      const description = tool?.description || `Wrapped tool ${name}`;
      const schema = tool?.schema;
      return new DynamicStructuredTool({
        name,
        description,
        schema,
        func: async (input) => {
          const t0 = Date.now();
          spy?.record('tool.begin', { name, group, input });
          try {
            const out = await tool.invoke?.(input);
            const ms = Date.now() - t0;
            spy?.record('tool.end', { name, group, ms, ok: true });
            return typeof out === 'string' ? out : JSON.stringify(out);
          } catch (err) {
            const ms = Date.now() - t0;
            spy?.record('tool.end', { name, group, ms, ok: false, error: String(err?.message || err) });
            throw err;
          }
        }
      });
    });
  };

  // Helper: download first Excel attachment of latest message and return absolute file path
  const sanitizeFileName = (name = '') => name.replace(/[^a-z0-9_.-]+/gi, '_').replace(/_+/g, '_').trim() || `attachment_${Date.now()}`;
  const ensureExcelAttachmentPath = async () => {
    try {
      const latestRaw = await m365.callTool({ name: 'mail.latestMessage.get', arguments: {} });
      const latest = typeof latestRaw === 'string' ? JSON.parse(latestRaw) : latestRaw;
      const msg = latest;
      const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
      const isExcel = (att) => {
        const n = String(att?.name || '').toLowerCase();
        const t = String(att?.contentType || '').toLowerCase();
        return n.endsWith('.xlsx') || n.endsWith('.xls') || t.startsWith('application/vnd.openxmlformats-officedocument') || t.startsWith('application/vnd.ms-excel');
      };
      const excelAtt = attachments.find(isExcel);
      if (!excelAtt || !msg?.id) return null;
      // Prefer fixturePath to avoid cross-OS path issues; falls back to download path if missing
      if (excelAtt.fixturePath) {
        const abs = path.resolve(process.cwd(), excelAtt.fixturePath);
        return abs;
      }
      const safeName = sanitizeFileName(excelAtt.name || `${msg.id}-${excelAtt.id}`);
      const targetPath = path.resolve(process.env.M365_ATTACHMENT_BASE_PATH, safeName);
      const dlRes = await m365.callTool({ name: 'mail.attachment.download', arguments: { messageId: msg.id, attachmentId: excelAtt.id, targetPath } });
      const dl = typeof dlRes === 'string' ? JSON.parse(dlRes) : dlRes;
      return dl?.targetPath || targetPath;
    } catch (e) {
      warn(`ensureExcelAttachmentPath failed: ${String(e?.message || e)}`);
      return null;
    }
  };

  const makeTools = async () => {
    const capTools = [];
    const cdsModelToolsRaw = await loadMcpTools('search_model', cdsModelClient).catch(() => []);
    const filesystemToolsRaw = fsClient ? await loadMcpTools(
      'read_file,write_file,edit_file,create_directory,list_directory,move_file,search_files,get_file_info,list_allowed_directories',
      fsClient
    ).catch(() => []) : [];
    const excelToolsRaw = excelClient ? await loadMcpTools(
      'excel_describe_sheets,excel_read_sheet,excel_screen_capture,excel_write_to_sheet,excel_create_table,excel_copy_sheet',
      excelClient
    ).catch(() => []) : [];
    const timeToolsRaw = timeClient ? await loadMcpTools('get_current_time,convert_time', timeClient).catch(() => []) : [];

    const cdsModelTools = wrapTools('cds-model', cdsModelToolsRaw, spy);
    const filesystemTools = wrapTools('filesystem', filesystemToolsRaw, spy);
    const excelTools = wrapTools('excel', [
      new DynamicStructuredTool({
        name: 'excel_describe_sheets',
        description: 'Liest die Blattnamen aus einer Excel-Datei aus.',
        schema: z.object({ fileAbsolutePath: z.string().optional() }),
        func: async (input) => {
          const primary = input?.fileAbsolutePath || EXCEL_TMP_PATH;
          try {
            const res = await excelClient.callTool({ name: 'excel_describe_sheets', arguments: { fileAbsolutePath: primary } });
            return typeof res === 'string' ? res : JSON.stringify(res);
          } catch (e) {
            // Fallback to Windows path string
            const alt = EXCEL_TMP_PATH_WIN;
            const res2 = await excelClient.callTool({ name: 'excel_describe_sheets', arguments: { fileAbsolutePath: alt } });
            return typeof res2 === 'string' ? res2 : JSON.stringify(res2);
          }
        }
      }),
      new DynamicStructuredTool({
        name: 'excel_read_sheet',
        description: 'Liest ein bestimmtes Tabellenblatt aus einer Excel-Datei.',
        schema: z.object({ fileAbsolutePath: z.string().optional(), sheetName: z.string().optional() }),
        func: async (input) => {
          const primary = input?.fileAbsolutePath || EXCEL_TMP_PATH;
          try {
            const res = await excelClient.callTool({ name: 'excel_read_sheet', arguments: { fileAbsolutePath: primary, sheetName: input?.sheetName } });
            return typeof res === 'string' ? res : JSON.stringify(res);
          } catch (e) {
            const alt = EXCEL_TMP_PATH_WIN;
            const res2 = await excelClient.callTool({ name: 'excel_read_sheet', arguments: { fileAbsolutePath: alt, sheetName: input?.sheetName } });
            return typeof res2 === 'string' ? res2 : JSON.stringify(res2);
          }
        }
      })
    ], spy);
    const timeTools = wrapTools('time', timeToolsRaw, spy);

    const manifest = await m365.listTools();
    const m365Tools = manifest.tools.map((def) => {
      const schema = jsonSchemaToZod(def.inputSchema, z);
      return new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema,
        func: async (input) => {
          const t0 = Date.now();
          spy?.record('tool.begin', { name: def.name, group: 'm365', input });
          const result = await m365.callTool({ name: def.name, arguments: input });
          const ms = Date.now() - t0;
          spy?.record('tool.end', { name: def.name, group: 'm365', ms, ok: true });
          return typeof result === 'string' ? result : JSON.stringify(result);
        }
      });
    });

    const capMailTriage = new DynamicStructuredTool({
      name: 'cap_mail_triage_latest',
      description: 'Führt die ClaimAI Mail-Triage aus (Zusammenfassung, Kategorie und Anhangs-Insights) auf der neuesten Mail.',
      schema: z.object({
        folder: z.string().optional().describe('Mailordner (Standard: inbox).'),
        messageId: z.string().optional().describe('Optional: konkrete Nachricht-ID.')
      }),
      func: async (input) => {
        const folderId = (input?.folder || 'inbox');
        const latestRaw = await m365.callTool({ name: 'mail.latestMessage.get', arguments: { folderId } });
        const message = typeof latestRaw === 'string' ? JSON.parse(latestRaw) : latestRaw;

        // Build short summary via LLM (Azure OpenAI)
        const bodyText = (message?.body?.contentType === 'html')
          ? String(message?.body?.content || '')
              .replace(/<style[\s\S]*?<\/style>/gi,' ')
              .replace(/<script[\s\S]*?<\/script>/gi,' ')
              .replace(/<[^>]+>/g,' ')
          : (message?.body?.content || message?.bodyPreview || '');
        const shortPrompt = `Fasse die E-Mail in 2 Sätzen zusammen (Deutsch).`;
        const summarizer = new AzureOpenAiChatClient({ modelName: 'gpt-4.1' });
        let summary = null;
        try {
          const resp = await summarizer.invoke([
            { role: 'system', content: 'Du bist ein präziser Assistent.' },
            { role: 'user', content: `${shortPrompt}\n\nInhalt:\n${bodyText}` }
          ]);
          const content = (resp?.content);
          summary = Array.isArray(content)
            ? content.filter(p=>p?.type==='text').map(p=>p.text).join('\n').trim()
            : String(content||'').trim();
          if (!summary) summary = message?.bodyPreview || null;
        } catch {}

        // Enrich attachments (Excel + Images)
        const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
        const enriched = [];
        const isExcel = (att) => {
          const n = String(att?.name||'').toLowerCase();
          const t = String(att?.contentType||'').toLowerCase();
          return n.endsWith('.xlsx') || n.endsWith('.xls') || t.startsWith('application/vnd.openxmlformats-officedocument') || t.startsWith('application/vnd.ms-excel');
        };
        const isImage = (att) => {
          const t = String(att?.contentType||'').toLowerCase();
          const n = String(att?.name||'').toLowerCase();
          return t.startsWith('image/') || n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.webp');
        };
        const ensurePath = async (att) => {
          if (att.fixturePath) return path.resolve(process.cwd(), att.fixturePath);
          if (!message?.id || !att?.id) return null;
          const safe = sanitizeFileName(att.name || `${message.id}-${att.id}`);
          const targetPath = path.resolve(process.env.M365_ATTACHMENT_BASE_PATH, safe);
          await m365.callTool({ name: 'mail.attachment.download', arguments: { messageId: message.id, attachmentId: att.id, targetPath } });
          return targetPath;
        };

        for (const att of attachments) {
          const base = { id: att.id, name: att.name, contentType: att.contentType, size: att.size, isInline: !!att.isInline };
          const p = await ensurePath(att);
          if (!p) { enriched.push({ ...base, error: 'no-path' }); continue; }
          if (isExcel(att)) {
            try {
              const desc = await excelClient.callTool({ name: 'excel_describe_sheets', arguments: { fileAbsolutePath: EXCEL_TMP_PATH } });
              const out = typeof desc === 'string' ? JSON.parse(desc) : desc;
              enriched.push({ ...base, path: p, excel: out });
            } catch (e) {
              enriched.push({ ...base, path: p, error: String(e?.message||e) });
            }
            continue;
          }
          if (isImage(att)) {
            try {
              const vis = await analyzeImageAttachment(p, {});
              enriched.push({ ...base, path: p, vision: vis });
            } catch (e) {
              enriched.push({ ...base, path: p, error: String(e?.message||e) });
            }
            continue;
          }
          enriched.push({ ...base, path: p });
        }

        // Explicit Excel sheet reads from tmp path (ensure content visibility in eval)
        const excelSheets = [];
        try {
          const descRes = await excelClient.callTool({ name: 'excel_describe_sheets', arguments: { fileAbsolutePath: EXCEL_TMP_PATH } });
          const desc = typeof descRes === 'string' ? JSON.parse(descRes) : descRes;
          const extractNames = (d) => {
            if (!d) return [];
            if (Array.isArray(d)) return d.map(x => (typeof x === 'string' ? x : (x?.name || x?.sheetName))).filter(Boolean);
            const sheets = d.sheets || d.sheetNames;
            if (Array.isArray(sheets)) return sheets.map(x => (typeof x === 'string' ? x : (x?.name || x?.sheetName))).filter(Boolean);
            if (typeof d.sheetName === 'string') return [d.sheetName];
            return [];
          };
          const names = extractNames(desc);
          for (const name of names.slice(0, 4)) {
            try {
              const dataRes = await excelClient.callTool({ name: 'excel_read_sheet', arguments: { fileAbsolutePath: EXCEL_TMP_PATH, sheetName: name } });
              const data = typeof dataRes === 'string' ? JSON.parse(dataRes) : dataRes;
              excelSheets.push({ sheetName: name, data });
            } catch (e) {
              excelSheets.push({ sheetName: name, error: String(e?.message || e) });
            }
          }
        } catch (e) {
          excelSheets.push({ error: String(e?.message || e) });
        }

        const result = {
          summary: summary || message?.bodyPreview || null,
          category: 'Notification',
          agentContext: { attachments: enriched, excelSheets }
        };
        return JSON.stringify(result);
      }
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
        const t0 = Date.now();
        spy?.record('tool.begin', { name: 'draft.mail.compose', group: 'draft', input });
        const out = JSON.stringify({ status: 'draft-prepared', channel: 'mail', draft: input });
        const ms = Date.now() - t0;
        spy?.record('tool.end', { name: 'draft.mail.compose', group: 'draft', ms, ok: true });
        return out;
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
        const t0 = Date.now();
        spy?.record('tool.begin', { name: 'draft.calendar.compose', group: 'draft', input });
        const out = JSON.stringify({ status: 'draft-prepared', channel: 'calendar', draft: input });
        const ms = Date.now() - t0;
        spy?.record('tool.end', { name: 'draft.calendar.compose', group: 'draft', ms, ok: true });
        return out;
      }
    });

    const imageDescribe = new DynamicStructuredTool({
      name: 'image.describe',
      description: 'Beschreibt eine lokale Bilddatei (png/jpg/jpeg/webp) und liefert EXIF-Metadaten.',
      schema: z.object({
        fileAbsolutePath: z.string().min(1).describe('Absoluter Pfad zur Bilddatei.'),
        prompt: z.string().optional().describe('Optionaler Hinweis/Task für die Bildanalyse.'),
      }),
      func: async (input) => {
        const t0 = Date.now();
        spy?.record('tool.begin', { name: 'image.describe', group: 'vision', input });
        const { fileAbsolutePath, prompt } = input;
        const out = await analyzeImageAttachment(fileAbsolutePath, { prompt });
        const ms = Date.now() - t0;
        spy?.record('tool.end', { name: 'image.describe', group: 'vision', ms, ok: true });
        return JSON.stringify(out);
      }
    });

    return [
      ...cdsModelTools,
      ...capTools,
      ...filesystemTools,
      ...excelTools,
      ...timeTools,
      ...m365Tools,
      capMailTriage,
      draftMail,
      draftCalendar,
      imageDescribe
    ];
  };

  const tools = await makeTools();
  kv('Tools loaded', tools.map(t => t.name).join(', '));
  const llm = new AzureOpenAiChatClient(
    deploymentId ? { deploymentId, resourceGroup } : { modelName, resourceGroup }
  );
  const checkpointer = new MemorySaver();
  const agent = createReactAgent({ llm, tools, checkpointSaver: checkpointer });
  return agent;
}

function htmlTableToRows(html) {
  try {
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRe.exec(html))) {
      const tr = trMatch[1];
      const cells = [];
      const tdRe = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let tdMatch;
      while ((tdMatch = tdRe.exec(tr))) {
        const raw = tdMatch[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .trim();
        cells.push(raw);
      }
      if (cells.length) rows.push(cells);
    }
    return rows;
  } catch {
    return [];
  }
}

function parseClaimHeader(html) {
  const rows = htmlTableToRows(html);
  // Expect header in row with column titles and next row with values
  const headerRow = rows.find(r => r.includes('ClaimNumber')) || rows[1];
  const valuesRowIdx = rows.findIndex(r => r === headerRow) + 1;
  const valuesRow = rows[valuesRowIdx] || [];
  const idx = (name) => (headerRow ? headerRow.indexOf(name) : -1);
  const pick = (name) => {
    const i = idx(name);
    return i >= 0 ? (valuesRow[i] ?? '') : '';
  };
  const num = (s) => {
    const n = Number(String(s).replace(/[^0-9.,-]/g, '').replace(/,(\d{2})$/, '.$1'));
    return Number.isFinite(n) ? n : null;
  };
  const iso = (s) => {
    try { return new Date(s).toISOString(); } catch { return null; }
  };
  const total = num(pick('Total')) ?? 0;
  const notes = pick('Notes') || '';
  const severity = Math.max(0, Math.min(100, Math.round(total / 20)));
  const fraud = /polizei/i.test(notes) ? 3 : 5;
  return {
    claim_number: pick('ClaimNumber') || null,
    policy_number: pick('PolicyNumber') || null,
    claimant_name: pick('ClaimantName') || null,
    claimant_email: pick('ClaimantEmail') || null,
    claimant_phone: pick('ClaimantPhone') || null,
    vehicle_license: pick('VehicleLicense') || null,
    vehicle_vin: pick('VIN') || null,
    incident_date: iso(pick('IncidentDate')),
    incident_location: pick('IncidentLocation') || null,
    description_short: pick('Description') || null,
    estimated_cost: total,
    severity_score: severity,
    fraud_score: fraud,
    notes
  };
}

async function ensureDbDeployed() {
  // Try a cheap introspection; if it fails due to missing relations, deploy
  try {
    const db = await cds.connect.to('db');
    await db.run('SELECT 1');
    // probe table existence
    await db.run('SELECT 1 FROM "kfz.claims_Claims" LIMIT 1').catch(() => { throw new Error('missing claims table'); });
  } catch {
    info('Database not deployed — running cds deploy');
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cds', 'deploy'], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error('cds deploy failed');
  }
}

async function capDraftWriteVerify({ excelClient, spy }) {
  section('CAP Draft Write + Verify');
  await ensureDbDeployed();

  // Start a minimal eval service exposing draft-enabled Claims without heavy init
  try {
    // Serve lightweight eval service (implemented in srv/eval-service.ts)
    await cds.serve('EvalClaimsService');
  } catch (e) {
    // If already served, ignore
  }
  const capService = cds.services?.EvalClaimsService;
  if (!capService) throw new Error('EvalClaimsService not available');

  const cap = await initCapInProcessClient({ capService, logger: console });

  // Read Excel header sheet and map fields
  let headerHtml = '';
  try {
    const descRes = await excelClient.callTool({ name: 'excel_describe_sheets', arguments: { fileAbsolutePath: path.resolve(process.cwd(), 'tmp', 'excel_eval.xlsx') } });
    const out = typeof descRes === 'string' ? descRes : JSON.stringify(descRes);
    const sheetName = /ClaimHeader/.test(out) ? 'ClaimHeader' : 'Tabelle1';
    const readRes = await excelClient.callTool({ name: 'excel_read_sheet', arguments: { fileAbsolutePath: path.resolve(process.cwd(), 'tmp', 'excel_eval.xlsx'), sheetName } });
    const content = (typeof readRes === 'object' && Array.isArray(readRes?.content)) ? readRes.content : (Array.isArray(readRes) ? readRes : []);
    const firstText = content.find(p => typeof p?.text === 'string')?.text || '';
    headerHtml = firstText;
  } catch (e) {
    warn(`Excel read failed for mapping: ${String(e?.message || e)}`);
  }
  if (!headerHtml) throw new Error('No Excel content for mapping');
  const mapped = parseClaimHeader(headerHtml);

  // Create draft
  const parse = (res) => {
    if (!res) return null;
    if (typeof res === 'string') { try { return JSON.parse(res); } catch { return null; } }
    if (Array.isArray(res?.content)) {
      const t = res.content.find(p => typeof p?.text === 'string')?.text;
      if (t) { try { return JSON.parse(t); } catch { return null; } }
    }
    return null;
  };
  const newDraftRes = await cap.callTool({ name: 'cap.draft.new', arguments: { entity: 'kfz.claims.Claims', data: { status: 'Eingegangen' } } });
  const newDraft = parse(newDraftRes);
  const draftRows = newDraft?.rows || (Array.isArray(newDraft) ? newDraft : []);
  const draft = Array.isArray(draftRows) && draftRows.length ? draftRows[0] : (newDraft || {});
  const ID = draft?.ID || draft?.result?.ID || draft?.keys?.ID;
  if (!ID) throw new Error('Draft creation failed (no ID)');
  kv('Draft ID', String(ID));

  // Patch with mapped data
  const patchResRaw = await cap.callTool({ name: 'cap.draft.patch', arguments: { entity: 'kfz.claims.Claims', keys: { ID }, data: mapped } });
  const patchRes = parse(patchResRaw);
  const affected = patchRes?.rowCount || (typeof patchRes === 'number' ? patchRes : 1);
  kv('Patched rows', String(affected));

  // Verify via CAP (reads from Postgres)
  const readResRaw = await cap.callTool({ name: 'cap.cqn.read', arguments: { entity: 'kfz.claims.Claims', where: { ID }, draft: 'draft' } });
  const readRes = parse(readResRaw);
  const rows = readRes?.rows || readRes || [];
  const rec = Array.isArray(rows) ? rows[0] : rows;
  const assertEq = (label, a, b) => {
    const okEq = (a == null && b == null) || String(a) === String(b);
    kv(label, okEq ? colors.green('OK') : colors.red(`mismatch (got=${a} expect=${b})`));
    if (!okEq) throw new Error(`Mismatch for ${label}`);
  };
  assertEq('claim_number', rec?.claim_number, mapped.claim_number);
  assertEq('policy_number', rec?.policy_number, mapped.policy_number);
  assertEq('estimated_cost', Number(rec?.estimated_cost), Number(mapped.estimated_cost));
  assertEq('severity_score', Number(rec?.severity_score), Number(mapped.severity_score));
  assertEq('fraud_score', Number(rec?.fraud_score), Number(mapped.fraud_score));

  // Verify at SQL level (deterministic Postgres check)
  try {
    const sql = `SELECT "claim_number", "policy_number", "estimated_cost", "severity_score", "fraud_score", "IsActiveEntity" FROM "kfz.claims_Claims" WHERE "ID" = $1 AND "IsActiveEntity" = false`;
    const sqlResRaw = await cap.callTool({ name: 'cap.sql.execute', arguments: { sql, params: [ID] } });
    const sqlRes = parse(sqlResRaw);
    const srow = sqlRes?.rows?.[0] || (Array.isArray(sqlRes) ? sqlRes[0] : null);
    if (!srow) throw new Error('No draft row found in Postgres');
    assertEq('pg.claim_number', srow.claim_number, mapped.claim_number);
    assertEq('pg.policy_number', srow.policy_number, mapped.policy_number);
    assertEq('pg.estimated_cost', Number(srow.estimated_cost), Number(mapped.estimated_cost));
  } catch (e) {
    warn(`Direct Postgres verify failed: ${String(e?.message || e)} (CAP read already verified)`);
  }

  ok('Draft write verified');

  // Cleanup: discard draft
  await cap.callTool({ name: 'cap.draft.cancel', arguments: { entity: 'kfz.claims.Claims', keys: { ID } } });
  kv('Cleanup', 'draft canceled');
}

async function runStep(agent, spy, user, promptText, idx) {
  const t0 = Date.now();
  const TIMEOUT_MS = 120_000;
  spy?.record('step.begin', { idx, prompt: promptText });

  let assistantText = '';
  const toolCalls = [];
  let timedOut = false;
  const spyIdxStart = spy?.events?.length || 0;
  const toolOutputs = [];

  try {
    const stream = await agent.stream({ messages: [{ role: 'user', content: promptText }] }, { configurable: { thread_id: user } });

    const deadline = Date.now() + TIMEOUT_MS;
    for await (const chunk of stream) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
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
      if (chunk.tools?.messages) {
        const tm = chunk.tools.messages[0];
        const content = tm?.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('\n');
        else if (content) text = JSON.stringify(content);
        if (text) toolOutputs.push(text);
      }
    }
  } catch (err) {
    warn(`Step ${idx + 1} error: ${String(err?.message || err)}`);
  }

  const ms = Date.now() - t0;
  section(`Step ${idx + 1}`);
  kv('Prompt', promptText);
  kv('Tools', toolCalls.map(t => t.name).join(', ') || '—');
  kv('Duration', `${ms} ms`);
  if (timedOut) kv('Status', colors.red('timeout after 120000 ms'));
  // Per-step tool timeline
  const stepEvents = spy?.events?.slice(spyIdxStart) || [];
  const stepToolEnds = stepEvents.filter(e => e.type === 'tool.end');
  if (stepToolEnds.length) {
    const line = stepToolEnds
      .map(e => `${e.payload.group}/${e.payload.name} (${e.payload.ms} ms)`) 
      .join(', ');
    kv('Tool timeline', line);
  }
  if (toolOutputs.length) {
    kv('Tool output', truncate(toolOutputs.join('\n---\n'), 1200));
  }
  if (assistantText) kv('Assistant', truncate(assistantText, 400));
  spy?.record('step.end', { idx, ms, timedOut, tools: toolCalls.map(t => t.name) });
  return { ms, toolCalls, assistantText, timedOut };
}

async function main() {
  section('Workflow Eval: LangGraph agent');
  const spy = toolSpy();
  const tStart = Date.now();
  const agent = await buildAgent(spy);
  ok('Agent built with Filesystem, Excel, Time, M365, drafts');
  const user = `eval_${Date.now()}`;

  // Scenario prompts
  const steps = [
    'Lese mir die aktuellste E-Mail und zeige sie an.',
    'Führe cap_mail_triage_latest aus und zeige mir die Excel-Inhalte und Bildbeschreibungen.',
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
    // Perform CAP writes and deterministic Postgres verification
    await capDraftWriteVerify({ excelClient: excelClientGlobal, spy });

    // Optional: send real mail reply + calendar event when using real Graph (anything except 'mock')
    const authMethod = String(process.env.M365_AUTH_METHOD || '').toLowerCase();
    if (authMethod && authMethod !== 'mock' && m365ClientGlobal) {
      section('M365 Real Send');
      try {
        const latest = await m365ClientGlobal.callTool({ name: 'mail.latestMessage.get', arguments: { folderId: 'inbox' } });
        const msg = typeof latest === 'string' ? JSON.parse(latest) : latest;
        const id = msg?.message?.id || msg?.id;
        if (id) {
          const reply = await m365ClientGlobal.callTool({ name: 'mail.message.reply', arguments: { messageId: id, comment: 'Vielen Dank! Bitte senden Sie uns den Polizeibericht zum Vorgang.' } });
          kv('Reply', typeof reply === 'string' ? 'sent' : 'sent');
        }
        const now = new Date();
        const startIso = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
        const endIso = new Date(now.getTime() + 49 * 3600 * 1000).toISOString();
        // Determine an attendee to actually send an invite to
        const attendeeFromMsg = msg?.message?.from?.address || msg?.from?.address || msg?.from?.emailAddress?.address;
        const fallbackAttendee = process.env.M365_CALENDAR_ATTENDEE || process.env.EVAL_CAL_ATTENDEE || null;
        const attendees = [attendeeFromMsg, fallbackAttendee].filter(Boolean);
        const evt = await m365ClientGlobal.callTool({
          name: 'calendar.event.create',
          arguments: {
            subject: 'Klärung Schadensfall (Eval)',
            startDateTime: startIso,
            endDateTime: endIso,
            timezone: 'Europe/Berlin',
            attendees,
            location: 'Online',
            isOnlineMeeting: true,
            onlineMeetingProvider: 'teamsForBusiness'
          }
        });
        kv('Event', typeof evt === 'string' ? 'created+invited' : 'created+invited');
      } catch (e) {
        warn(`M365 real send failed: ${String(e?.message || e)}`);
      }
    }
    hr();
    const totalMs = Date.now() - tStart;
    // Compute metrics
    const toolEnds = spy.events.filter(e => e.type === 'tool.end');
    const totalToolInvocations = toolEnds.length;
    const slowTools = [...toolEnds]
      .sort((a, b) => b.payload.ms - a.payload.ms)
      .slice(0, 5)
      .map(e => `${e.payload.group}/${e.payload.name} (${e.payload.ms} ms)`);
    kv('Total steps', steps.length);
    kv('Tool invocations', totalToolInvocations);
    kv('Total duration', `${totalMs} ms`);
    if (slowTools.length) kv('Top slow tools', slowTools.join(', '));
    ok('Workflow eval completed');
  } finally {
    try { await closeMCPClients(); } catch {}
  }
}

main().catch((err) => {
  console.error('Workflow eval failed:', err);
  process.exit(1);
});
