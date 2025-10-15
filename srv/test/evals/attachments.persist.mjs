// srv/test/evals/attachments.persist.mjs
// Tests: uploadLocalFile -> verify entity -> download $value -> queue importExcel

import fs from 'node:fs/promises';
import path from 'node:path';
import { section, kv, ok, warn, fail, truncate, measure } from './utils/format.mjs';

const BASE = process.env.CAP_BASE_URL || 'http://localhost:9999';
const SVC = `${BASE}/service/claims`;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function pickExisting(paths) {
  for (const p of paths) {
    const abs = path.resolve(p);
    if (await exists(abs)) return abs;
  }
  return null;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  const data = await res.json();
  return data;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function getBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const ct = res.headers.get('content-type');
  const cd = res.headers.get('content-disposition');
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType: ct, contentDisposition: cd };
}

async function main() {
  section('Attachments Persist Test');
  kv('Service', SVC);

  // 1) Choose a PNG and an Excel under tmp/
  const png = await pickExisting([
    'tmp/attachments/unfall1.png',
    'tmp/workflow_attachments/Generated_Image_October_10_2025_-_8_30PM.png'
  ]);
  if (!png) {
    fail('No PNG test file found under tmp/.');
    process.exit(1);
  }
  kv('PNG', png);

  const xls = await pickExisting([
    'tmp/attachments/claims_excel_anhang.xlsx',
    'tmp/excel_eval.xlsx',
    'tmp/workflow_attachments/Kalkulation_CLM-CH-LU-2025-002_1_.xlsx'
  ]);
  if (!xls) warn('No Excel found; importExcel part will be skipped.');
  else kv('Excel', xls);

  // 2) uploadLocalFile (PNG)
  const { id: pngId } = await (async () => {
    const { out, ms } = await measure(() => postJson(`${SVC}/uploadLocalFile`, { path: png, note: 'eval-upload', claimId: null }));
    ok(`uploadLocalFile (PNG) OK in ${ms} ms`);
    const id = (typeof out === 'string')
      ? out
      : (out?.ID || out?.id || out?.value || out?.d?.ID || out?.d?.id || out?.d?.value);
    if (!id || typeof id !== 'string') throw new Error('No attachment ID returned for PNG');
    return { id };
  })();
  kv('PNG ID', pngId);

  // 3) Verify metadata
  const meta = await getJson(`${SVC}/Attachments(${pngId})?$select=fileName,mediaType,size,sha256`);
  ok('Fetched attachment metadata');
  kv('fileName', meta.fileName);
  kv('mediaType', meta.mediaType);
  kv('size', meta.size);
  kv('sha256', truncate(meta.sha256, 16));

  // 4) Download $value and verify headers/length
  const { buf, contentType, contentDisposition } = await getBuffer(`${SVC}/Attachments(${pngId})/content/$value`);
  ok(`Downloaded $value (${buf.length} bytes)`);
  kv('content-type', contentType);
  kv('content-disposition', contentDisposition);
  if (Number(meta.size) !== buf.length) warn(`Size mismatch: meta=${meta.size} vs downloaded=${buf.length}`);

  // 5) Upload Excel (if available) and queue importExcel
  if (xls) {
    const { id: xlsId } = await (async () => {
      const { out, ms } = await measure(() => postJson(`${SVC}/uploadLocalFile`, { path: xls, note: 'eval-upload-excel', claimId: null }));
      ok(`uploadLocalFile (Excel) OK in ${ms} ms`);
      const id = (typeof out === 'string')
        ? out
        : (out?.ID || out?.id || out?.value || out?.d?.ID || out?.d?.id || out?.d?.value);
      if (!id || typeof id !== 'string') throw new Error('No attachment ID returned for Excel');
      return { id };
    })();
    kv('Excel ID', xlsId);

    const { importId } = await (async () => {
      const res = await postJson(`${SVC}/importExcel`, { fileId: xlsId, target: 'Claims' });
      const id = (typeof res === 'string')
        ? res
        : (res?.ID || res?.id || res?.value || res?.d?.ID || res?.d?.id || res?.d?.value);
      if (!id || typeof id !== 'string') throw new Error('No import ID returned');
      return { importId: id };
    })();
    kv('Import ID', importId);

    const job = await getJson(`${SVC}/ExcelImports(${importId})?$select=status,fileName,attachment_ID`);
    ok('Fetched import job');
    kv('status', job.status);
    kv('fileName', job.fileName);
    kv('attachment_ID', job.attachment_ID);
  }

  ok('All checks completed');
}

main().catch((err) => {
  fail('Attachments persist test failed');
  console.error(err);
  process.exit(1);
});
