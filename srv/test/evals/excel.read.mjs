// srv/test/evals/excel.read.mjs
// Locate an Excel file under tmp/ and read sheet content via Excel MCP.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, stat } from 'node:fs/promises';
import { initExcelMCPClient } from '../../../gen/srv/lib/mcp-client.js';
import { section, kv, ok, warn, fail, truncate, measure, hr } from './utils/format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function* walk(dir) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

async function findExcel(baseDirs = ['tmp', path.join('tmp', 'attachments')]) {
  const exts = new Set(['.xlsx', '.xlsm', '.xlsb', '.xls', '.csv']);
  for (const base of baseDirs) {
    for await (const p of walk(path.resolve(process.cwd(), base))) {
      const ext = path.extname(p).toLowerCase();
      if (ext && exts.has(ext)) return p;
    }
  }
  return null;
}

function parseSheetNames(describeResult) {
  if (!describeResult) return [];
  const r = describeResult;
  if (Array.isArray(r)) {
    return r.map(x => (typeof x === 'string' ? x : (x?.sheetName || x?.name || null))).filter(Boolean);
  }
  if (Array.isArray(r?.sheets)) {
    return r.sheets.map(s => (typeof s === 'string' ? s : (s?.name || s?.sheetName || null))).filter(Boolean);
  }
  if (Array.isArray(r?.sheetNames)) return r.sheetNames.filter(Boolean);
  if (typeof r?.sheetName === 'string') return [r.sheetName];
  return [];
}

async function main() {
  section('Excel MCP Read');
  const argvFile = process.argv.slice(2).find(a => a.startsWith('--file='))?.split('=')[1];
  const argvSheet = process.argv.slice(2).find(a => a.startsWith('--sheet='))?.split('=')[1];
  const absoluteFile = argvFile ? path.resolve(argvFile) : await findExcel();
  if (!absoluteFile) {
    fail('No Excel/CSV found under tmp/. Provide --file=PATH if needed.');
    process.exit(1);
  }
  kv('File', absoluteFile);

  const excelClient = await initExcelMCPClient();
  ok('Excel MCP client ready');
  const { tools } = await excelClient.listTools({}, { timeout: 120000 });
  const toolNames = tools.map(t => t.name);
  kv('Excel tools', toolNames.join(', '));
  const hasDescribe = toolNames.includes('excel_describe_sheets');
  const hasRead = toolNames.includes('excel_read_sheet');

  // The current server schema requires srcSheetName/dstSheetName even for describe.
  const candidates = [argvSheet, 'Tabelle1', 'Sheet1', 'Sheet 1', 'Blatt1'].filter(Boolean);
  let describeRes;
  if (hasDescribe) {
    for (const name of candidates) {
      try {
        const res = await excelClient.callTool({ name: 'excel_describe_sheets', arguments: { fileAbsolutePath: absoluteFile, srcSheetName: name, dstSheetName: name } }, undefined, { timeout: 120000 });
        describeRes = res.structuredContent ?? (Array.isArray(res.content) ? res.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n') : res.content);
        ok(`Describe accepted with sheetName=${name}`);
        break;
      } catch {}
    }
    if (!describeRes) warn('Describe failed for all candidates; proceeding to read with defaults.');
  } else {
    warn('excel_describe_sheets not exposed by server; proceeding to read with defaults.');
  }

  const sheets = parseSheetNames(describeRes);
  const sheet = sheets[0] || candidates[0];
  kv('Sheet', sheet);

  let readRes;
  try {
    const { out, ms } = await measure(() => excelClient.callTool({ name: 'excel_read_sheet', arguments: { fileAbsolutePath: absoluteFile, srcSheetName: sheet, dstSheetName: sheet } }, undefined, { timeout: 180000 }));
    readRes = out.structuredContent ?? (Array.isArray(out.content) ? out.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n') : out.content);
    ok(`Read OK (${ms} ms)`);
  } catch (e) {
    fail('Read failed with provided schema.');
    console.error(e?.message || e);
    process.exit(2);
  }
  const preview = typeof readRes === 'string' ? readRes : JSON.stringify(readRes);
  kv('Preview', truncate(preview, 400));
}

main().catch((err) => {
  fail('Excel read script failed');
  console.error(err);
  process.exit(1);
});
