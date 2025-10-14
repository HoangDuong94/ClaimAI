// srv/test/evals/excel.to.draft.mjs
// Focused eval: Use MCP tools + GPT-4.1 to map Excel ClaimHeader -> CAP draft import.
// Adds a per-step timeout of 2 minutes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import cds from '@sap/cds';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';

import { initExcelMCPClient, initCapInProcessClient, closeMCPClients } from '../../../gen/srv/lib/mcp-client.js';
import { section, kv, ok, warn, info, colors } from './utils/format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function ensureDbDeployed() {
  try {
    const db = await cds.connect.to('db');
    await db.run('SELECT 1');
    await db.run('SELECT 1 FROM "kfz.claims_Claims" LIMIT 1').catch(() => { throw new Error('missing claims table'); });
  } catch {
    info('Database not deployed — running cds deploy');
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cds', 'deploy'], { stdio: 'inherit' });
    if (res.status !== 0) throw new Error('cds deploy failed');
  }
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

async function withTimeout(fn, label, ms = 120000) {
  const t0 = Date.now();
  return await Promise.race([
    (async () => {
      const res = await fn();
      const dt = Date.now() - t0;
      kv(`${label} duration`, `${dt} ms`);
      return res;
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms} ms`)), ms))
  ]);
}

async function main() {
  section('Excel → Draft Eval (GPT‑4.1 + MCP)');
  // Workaround: disable lean draft for programmatic eval to avoid resolveView issues
  try {
    process.env.CDS_FIORI_LEAN_DRAFT = process.env.CDS_FIORI_LEAN_DRAFT || 'false';
    // Use SQLite for eval to avoid Postgres view resolution issues in programmatic serve
    process.env.CDS_REQUIRES_DB_IMPL = process.env.CDS_REQUIRES_DB_IMPL || '@cap-js/sqlite';
  } catch {}
  await withTimeout(loadDotEnv, 'env load');

  // Copy Excel fixture into tmp
  const TMP_DIR = path.resolve(process.cwd(), 'tmp');
  const EXCEL_SRC = path.resolve(process.cwd(), 'MockDaten', 'Kalkulation_CLM-CH-LU-2025-002 (1).xlsx');
  const EXCEL_TMP_PATH = path.join(TMP_DIR, 'excel_eval.xlsx');
  await withTimeout(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const buf = await readFile(EXCEL_SRC);
    await writeFile(EXCEL_TMP_PATH, buf);
  }, 'copy excel');
  kv('Excel tmp path', EXCEL_TMP_PATH);

  // Init Excel MCP
  const excel = await withTimeout(() => initExcelMCPClient(), 'excel mcp init');

  // Read header sheet
  const sheetName = 'ClaimHeader';
  const desc = await withTimeout(() => excel.callTool({ name: 'excel_describe_sheets', arguments: { fileAbsolutePath: EXCEL_TMP_PATH } }), 'excel describe');
  const descStr = typeof desc === 'string' ? desc : JSON.stringify(desc);
  kv('sheets', descStr.slice(0, 200));
  const hasClaimHeader = /ClaimHeader/.test(descStr);

  const excelReadRes = await withTimeout(() => excel.callTool({ name: 'excel_read_sheet', arguments: { fileAbsolutePath: EXCEL_TMP_PATH, sheetName: hasClaimHeader ? sheetName : 'Tabelle1' } }), 'excel read');
  const parts = (typeof excelReadRes === 'object' && Array.isArray(excelReadRes?.content)) ? excelReadRes.content : (Array.isArray(excelReadRes) ? excelReadRes : []);
  const headerHtml = parts.find(p => typeof p?.text === 'string')?.text || '';
  if (!headerHtml) throw new Error('No Excel content found');
  kv('header html len', String(headerHtml.length));

  // Try GPT‑4.1 mapping first, fallback to deterministic mapping
  let mapped = null;
  if (hasAiCoreBinding()) {
    const { modelName, resourceGroup, deploymentId } = getModelDeploymentFromArgs();
    section('LLM mapping');
    kv('Model', modelName);
    kv('Resource group', resourceGroup || '—');
    kv('Deployment ID', deploymentId || '—');

    try {
      const client = new AzureOpenAiChatClient(deploymentId ? { deploymentId, resourceGroup } : { modelName, resourceGroup });
      const prompt = [
        'Mappe die folgende Excel-ClaimHeader-Tabelle auf das JSON-Schema der Entität kfz.claims.Claims.',
        'Gib NUR ein einzelnes kompaktes JSON-Objekt zurück mit diesen Keys:',
        'claim_number, policy_number, claimant_name, claimant_email, claimant_phone,',
        'vehicle_license, vehicle_vin, incident_date (ISO), incident_location, description_short,',
        'estimated_cost (Number), severity_score (Number), fraud_score (Number), notes.',
        'Benutze CH-Format korrekt (z. B. 13\'100.00 -> 13100).',
        'HTML Tabelle:',
        headerHtml
      ].join('\n');
      const resp = await withTimeout(() => client.invoke([{ role: 'user', content: prompt }]), 'gpt mapping');
      const text = resp?.generations?.[0]?.text || resp?.output_text || resp?.content || '';
      try {
        const j = JSON.parse(text);
        mapped = j && typeof j === 'object' && !Array.isArray(j) ? j : null;
      } catch {
        // Try extract JSON block
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try { mapped = JSON.parse(m[0]); } catch {}
        }
      }
      if (!mapped) warn('GPT mapping failed to parse; will fallback');
    } catch (e) {
      warn(`GPT mapping error: ${String(e?.message || e)}`);
    }
  } else {
    warn('No AI Core binding — skipping GPT mapping');
  }

  if (!mapped) {
    mapped = parseClaimHeader(headerHtml);
    section('Fallback mapping');
  } else {
    section('Mapped (GPT)');
  }
  kv('claim_number', mapped.claim_number);
  kv('estimated_cost', String(mapped.estimated_cost));

  // Ensure DB + CAP service
  await withTimeout(ensureDbDeployed, 'db deploy');
  await withTimeout(async () => { try { await cds.serve('EvalClaimsService'); } catch {} }, 'serve eval service');
  kv('services', JSON.stringify(Object.keys(cds.services || {})));
  let capService = cds.services?.EvalClaimsService;
  if (!capService) {
    try {
      capService = await withTimeout(() => cds.connect.to('EvalClaimsService'), 'connect EvalClaimsService');
    } catch {}
  }
  if (!capService) throw new Error('EvalClaimsService not available');
  const cap = await withTimeout(() => initCapInProcessClient({ capService, logger: console }), 'cap mcp init');

  // Create draft
  const parseResult = (res) => {
    if (!res) return null;
    if (typeof res === 'string') { try { return JSON.parse(res); } catch { return null; } }
    if (Array.isArray(res?.content)) {
      const t = res.content.find(p => typeof p?.text === 'string')?.text;
      if (t) { try { return JSON.parse(t); } catch { return null; } }
    }
    return null;
  };
  const newDraftRes = await withTimeout(() => cap.callTool({ name: 'cap.draft.new', arguments: { entity: 'kfz.claims.Claims', data: { status: 'Eingegangen' } } }), 'draft new');
  const newDraft = parseResult(newDraftRes);
  const row = newDraft?.rows?.[0] || newDraft?.result || newDraft || {};
  const ID = row?.ID || row?.keys?.ID || row?.result?.ID;
  if (!ID) throw new Error('Draft creation failed (no ID)');
  kv('Draft ID', String(ID));

  // Patch mapped data
  await withTimeout(() => cap.callTool({ name: 'cap.draft.patch', arguments: { entity: 'kfz.claims.Claims', keys: { ID }, data: mapped } }), 'draft patch');

  // Verify
  const readResRaw = await withTimeout(() => cap.callTool({ name: 'cap.cqn.read', arguments: { entity: 'kfz.claims.Claims', where: { ID }, draft: 'draft' } }), 'draft read');
  const draftReadRes = parseResult(readResRaw);
  const rec = (draftReadRes?.rows && draftReadRes.rows[0]) || draftReadRes || {};
  const okEq = (a, b) => (a == null && b == null) || String(a) === String(b);
  const checks = [
    ['claim_number', rec?.claim_number, mapped.claim_number],
    ['policy_number', rec?.policy_number, mapped.policy_number],
    ['estimated_cost', Number(rec?.estimated_cost), Number(mapped.estimated_cost)]
  ];
  let allOk = true;
  for (const [label, a, b] of checks) {
    const pass = okEq(a, b);
    kv(label, pass ? colors.green('OK') : colors.red(`mismatch (got=${a} expect=${b})`));
    if (!pass) allOk = false;
  }
  if (!allOk) throw new Error('Verification failed');
  ok('Excel mapped → Draft import verified');

  // Cleanup
  await withTimeout(() => cap.callTool({ name: 'cap.draft.cancel', arguments: { entity: 'kfz.claims.Claims', keys: { ID } } }), 'draft cancel');
  kv('Cleanup', 'draft canceled');

  // Close clients
  try { await closeMCPClients(); } catch {}
}

main().catch((err) => {
  console.error('excel.to.draft eval failed:', err);
  process.exit(1);
});
