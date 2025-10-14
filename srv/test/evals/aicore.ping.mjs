// srv/test/evals/aicore.ping.mjs
// PoC: Check access to SAP AI Core (Azure OpenAI gpt-4.1) without E2E.

import { AzureOpenAiChatClient } from '@sap-ai-sdk/langchain';
import { section, kv, ok, warn, fail, info, truncate, measure, hr, colors } from './utils/format.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
      // Multi-line JSON support for AICORE_SERVICE_KEY
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
  } catch {
    // no .env — ignore
  }
}

function readJson(envName) {
  try { return JSON.parse(process.env[envName] || 'null'); } catch { return null; }
}

function hasAiCoreBinding() {
  const vcap = readJson('VCAP_SERVICES');
  const hasVcap = !!vcap && (Object.keys(vcap).some(k => k.toLowerCase().includes('aicore')) || Boolean(vcap?.aicore));
  const hasKey = typeof process.env.AICORE_SERVICE_KEY === 'string' && process.env.AICORE_SERVICE_KEY.trim().startsWith('{');
  return hasVcap || hasKey;
}

async function main() {
  await loadDotEnv();
  section('AI Core Connectivity Check');
  const arg = (k) => process.argv.slice(2).find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  const modelName = (arg('model') || process.env.AICORE_MODEL || 'gpt-4.1').trim();
  const resourceGroup = (arg('rg') || process.env.AICORE_RESOURCE_GROUP || '').trim() || undefined;
  const deploymentId = (arg('deployment') || process.env.AICORE_DEPLOYMENT_ID || '').trim() || undefined;

  kv('Model', modelName);
  kv('Resource group', resourceGroup || '—');
  kv('Deployment ID', deploymentId || '—');

  const vcapPresent = !!process.env.VCAP_SERVICES;
  kv('VCAP_SERVICES present', vcapPresent ? 'yes' : 'no');
  kv('AI Core binding detected', hasAiCoreBinding() ? colors.green('yes') : colors.red('no'));
  kv('Destination (AI Core)', process.env.DESTINATION_NAME || process.env.AICORE_DESTINATION || '—');

  // Build client config: prefer deploymentId if provided, else modelName (+ optional resourceGroup)
  const modelDeployment = deploymentId ? { deploymentId, resourceGroup } : { modelName, resourceGroup };

  try {
    const client = new AzureOpenAiChatClient(modelDeployment);
    const messages = [
      { role: 'system', content: 'Du bist ein präziser Test-Assistent.' },
      { role: 'user', content: 'Antworte nur mit: "Hallo von AI Core!"' }
    ];
    const { out, ms } = await measure(() => client.invoke(messages));
    ok(`Roundtrip OK (${ms} ms)`);
    let text;
    if (typeof out?.content === 'string') text = out.content;
    else if (Array.isArray(out?.content)) text = out.content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
    else text = JSON.stringify(out);
    kv('Reply', truncate(text || '', 200));
    process.exit(0);
  } catch (err) {
    fail('AI Core request failed');
    const msg = (err && (err.message || err.toString())) || String(err);
    console.error(msg);
    hr();
    warn('Quick checks');
    if (!vcapPresent) info('VCAP_SERVICES fehlt: Lokales Service-Binding für AI Core setzen.');
    if (!hasAiCoreBinding()) info('Kein AI Core Binding gefunden: Serviceinstanz/Binding prüfen.');
    info('Optional setzen: AICORE_RESOURCE_GROUP, AICORE_DEPLOYMENT_ID');
    info('Falls Destination genutzt wird: DESTINATION_NAME oder AICORE_DESTINATION und Destination-Inhalte prüfen.');
    process.exit(2);
  }
}

main();
