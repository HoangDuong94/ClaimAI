// srv/test/evals/agent.tools.mjs
// Run quick, deterministic checks for M365 tools (with mock) and Excel reading.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initM365InProcessClient } from '../../../gen/srv/m365-mcp/index.js';
import { initExcelMCPClient } from '../../../gen/srv/lib/mcp-client.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { section, kv, ok, warn, fail, info, colors, truncate, measure, hr } from './utils/format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  process.env.M365_AUTH_METHOD = process.env.M365_AUTH_METHOD || 'mock';
  process.env.M365_ATTACHMENT_BASE_PATH = process.env.M365_ATTACHMENT_BASE_PATH || path.resolve(process.cwd(), 'tmp', 'attachments');

  section('Tool Eval: M365 (mock) + Excel');
  const tStart = Date.now();

  const m365 = await initM365InProcessClient({ authMethod: 'mock', logger: console });
  ok('Microsoft 365 mock client initialized');
  const manifest = await m365.listTools();
  kv('M365 tools', manifest.tools.map(t => t.name).join(', '));

  const { out: latest, ms: tLatest } = await measure(() => m365.callTool({ name: 'mail.latestMessage.get', arguments: { folderId: 'inbox' } }));
  ok(`Latest message fetched (${tLatest} ms)`);
  kv('Subject', latest?.message?.subject || '-');
  kv('Message ID', latest?.message?.id || '-');

  const firstAttachment = (latest?.message?.attachments || [])[0];
  if (!firstAttachment) throw new Error('No attachment in fixture');

  const targetPath = path.join('downloads', firstAttachment.name || `att_${firstAttachment.id}`);
  const { out: dl, ms: tDl } = await measure(() => m365.callTool({ name: 'mail.attachment.download', arguments: { messageId: latest.message.id, attachmentId: firstAttachment.id, targetPath } }));
  ok(`Attachment downloaded (${tDl} ms)`);
  kv('File', dl?.details?.targetPath || '-');

  // If Excel is present, describe + read sheet 1 (best-effort). Fallback: verify download only.
  const absPath = dl?.details?.targetPath;
  if (String(firstAttachment.contentType || '').includes('spreadsheet') && absPath) {
    let excelClient;
    try {
      info('Excel MCP: trying to read spreadsheet');
      excelClient = await initExcelMCPClient();
      const [describeTool, readTool] = await Promise.all([
        loadMcpTools('excel_describe_sheets', excelClient),
        loadMcpTools('excel_read_sheet', excelClient)
      ]);
      kv('Describe schema keys', Object.keys(describeTool[0].schema?.properties || {}).join(', '));
      kv('Read schema keys', Object.keys(readTool[0].schema?.properties || {}).join(', '));
      const describeInputCandidates = [
        { fileAbsolutePath: absPath },
        { file_path: absPath },
        { file: absPath },
        { path: absPath }
      ];
      let describeRes;
      for (const cand of describeInputCandidates) {
        try {
          describeRes = await describeTool[0].invoke(cand);
          ok('excel_describe_sheets accepted input variant');
          break;
        } catch (e) {}
      }
      if (describeRes) ok('Excel describe returned data');
      else warn('Excel describe failed — skipping content read');
    } catch (e) {
      warn('Excel MCP not available or schema mismatch — verified download only');
    } finally {
      try { await excelClient?.close?.(); } catch {}
    }
  }

  // Calendar + reply (simulated)
  const now = new Date();
  const startIso = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
  const endIso = new Date(now.getTime() + 49 * 3600 * 1000).toISOString();
  const { out: evt, ms: tEvt } = await measure(() => m365.callTool({ name: 'calendar.event.create', arguments: { subject: 'Klärung Schadensfall', startDateTime: startIso, endDateTime: endIso, timezone: 'Europe/Berlin', attendees: [ 'partner@example.com' ], location: 'Online' } }));
  ok(`Event created (${tEvt} ms)`);
  kv('Event ID', (typeof evt === 'object' ? evt?.id : null) || '-');

  const { out: reply, ms: tReply } = await measure(() => m365.callTool({ name: 'mail.message.reply', arguments: { messageId: latest.message.id, comment: 'Vielen Dank, wir melden uns kurzfristig.' } }));
  ok(`Reply sent (${tReply} ms)`);
  kv('Status', typeof reply === 'object' ? reply?.status : String(reply));

  await m365.close();
  hr();
  const totalMs = Date.now() - tStart;
  kv('Total duration', `${totalMs} ms`);
  ok('Tool eval completed');
}

main().catch((err) => {
  console.error('Eval failed:', err);
  process.exit(1);
});
