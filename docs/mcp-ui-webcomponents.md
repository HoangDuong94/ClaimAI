# MCP‑UI + UI5 Web Components (kurz)

Ziel: Im SAPUI5‑Frontend neben Text auch interaktive UI via MCP‑UI rendern – konkret UI5 Web Components innerhalb eines sandboxed Iframes.

## Voraussetzungen
- Backend (CAP/Node): `@mcp-ui/server` installiert.
- Frontend (UI5 App): MCP‑UI Renderer als Web Component geladen.
- Optional: UI5 Web Components lokal verfügbar (empfohlen) oder per CDN/esm‑Resolver.

## Server: UIResource erzeugen
Beispielroute, die eine HTML‑Ressource mit UI5 Web Components zurückgibt. esm.sh löst „bare specifiers“ direkt im Browser.

```ts
// srv/service.ts
import { createUIResource } from '@mcp-ui/server';

app.get('/service/claims/ui/webc', async (_req, res) => {
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 12px;">
      <h3>UI5 Web Components – PoC</h3>
      <ui5-button id="webcBtn" design="Emphasized">UI5 Button</ui5-button>
      <span id="webcOut" style="margin-left:8px;"></span>
      <script type="module">
        import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Assets.js';
        import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Button.js';
        const btn = document.getElementById('webcBtn');
        const out = document.getElementById('webcOut');
        btn?.addEventListener('click', () => {
          out.textContent = 'clicked';
          window.parent?.postMessage({ type: 'notify', payload: { message: 'ui5-webc-click' } }, '*');
        });
      </script>
    </div>
  `;
  const ui = createUIResource({
    uri: 'ui://poc/webc',
    content: { type: 'rawHtml', htmlString: html },
    encoding: 'text',
    metadata: {
      title: 'UI5 Web Components – PoC',
      'mcpui.dev/ui-preferred-frame-size': ['100%', '220px']
    }
  });
  res.json({ type: 'resource', resource: ui.resource });
});
```

## Frontend: Resource rendern
Renderer einmal global laden, dann `resource` setzen.

```html
<!-- app/webapp/index.html -->
<script src="thirdparty/process-shim.js"></script> <!-- falls process.env referenziert wird -->
<script type="module" src="https://unpkg.com/@mcp-ui/client@5.13.0/dist/ui-resource-renderer.wc.js"></script>
```

```js
// UI5 Controller/Code (vereinfacht)
const { resource } = await fetch('/service/claims/ui/webc').then(r => r.json());
const html = `<ui-resource-renderer id="mcpRenderer" style="display:block;width:100%;"></ui-resource-renderer>`;
chatManager.addMessage('assistant', html);
setTimeout(() => {
  const el = document.getElementById('mcpRenderer');
  if (!el) return;
  el.resource = resource;           // <- wichtig
  el.addEventListener('onUIAction', (ev) => {
    console.log('MCP-UI action:', ev.detail);
  });
}, 150);
```

## Ohne CDN (empfohlen)
1) Installation in der UI‑App: `cd app && npm i @ui5/webcomponents`
2) Benötigte Module nach `app/webapp/thirdparty/ui5/` kopieren (z. B. `Assets.js`, `Button.js`).
3) Im HTML statt CDN importieren:

```html
<script type="module">
  import '/thirdparty/ui5/Assets.js';
  import '/thirdparty/ui5/Button.js';
  // …
  </script>
```

## Sandbox/CSP
- MCP‑UI rendert HTML in einem sandboxed Iframe. Für externe Ressourcen ggf. `sandboxPermissions` setzen (z. B. `allow-scripts allow-same-origin`).
- Bei restriktiver CSP: Proxy verwenden (siehe mcp‑ui „using‑a‑proxy“), oder lokal hosten.

## Troubleshooting
- „process is not defined“ → vor dem Renderer kleines `process.env`‑Shim laden.
- „Failed to resolve module specifier '@ui5/…'“ → `esm.sh` verwenden, Import‑Map definieren oder Module lokal hosten.
- Nach UI‑Re‑Render „Resource not provided“ → Resource per ID zwischenspeichern und Renderer nachbinden.

## Minimaler Ablauf
1) Server: `createUIResource` mit HTML/ESM‑Imports zurückgeben.
2) Client: `<ui-resource-renderer>` einfügen und `el.resource = …` setzen.
3) Optional: `onUIAction` an Backend weiterreichen.

---

## Best‑Practice: UIResource direkt aus dem Tool liefern (mcp‑ui)

Statt UI über Freitext zu „signalisieren“, sollte das Tool selbst eine `UIResource` zurückgeben. Host/Frontend rendert diese direkt und verarbeitet UI‑Aktionen via `onUIAction`.

### Server (Tool) – UIResource erzeugen

```ts
// Beispiel: draft.mail.compose liefert zusätzlich uiResource
import { createUIResource } from '@mcp-ui/server';

const preview = { to, subject, body, contentType: 'Text', createdAt: new Date().toISOString() };

// Variante A (empfohlen für lokale Assets): rawHtml
const html = `<!-- hier vollständiges UI5 Composer HTML inkl. <script type="module"> ... -->`;
const ui = createUIResource({
  uri: `ui://draft/email/${Date.now()}`,
  content: { type: 'rawHtml', htmlString: html },
  encoding: 'text',
  metadata: { 'mcpui.dev/ui-preferred-frame-size': ['100%', '520px'] }
});

// Variante B (nur wenn absoluter http(s) Link vorliegt): externalUrl
// ACHTUNG: Für mimeType 'text/uri-list' muss die URL absolut sein – relative Pfade schlagen im Renderer fehl!
// const ui = createUIResource({
//   uri: `ui://draft/email/${Date.now()}`,
//   content: { type: 'externalUrl', iframeUrl: `https://example.com/service/claims/ui/webc?to=...` },
//   encoding: 'text'
// });

return JSON.stringify({ status: 'draft-prepared', channel: 'mail', draft: preview, uiResource: ui.resource });
```

### Client – UIResource aus Agenten‑Antwort rendern

```js
// 1) Antworttext anzeigen (wie bisher)
chatManager.addMessage('assistant', responseText);

// 2) UIResource extrahieren und rendern (direkt)
const tryRenderResource = async (responseText) => {
  // a) Robuste Marker‑Erkennung (falls Freitext verändert wurde)
  const re = /\[MCP-UI-RESOURCE-B64:([A-Za-z0-9+/=]+)\]/g; // oder HTML‑Kommentar‑Marker
  let m;
  while ((m = re.exec(responseText)) !== null) {
    const json = new TextDecoder('utf-8').decode(Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)));
    const obj = JSON.parse(json);
    const res = obj.resource || obj.uiResource;
    if (res) return render(res);
  }
  // b) Direkte JSON‑Objekte als Fallback scannen
  // ... (optional)
};

async function render(resource) {
  // uri-list: relative → absolut normalisieren
  if (resource.mimeType === 'text/uri-list' && /^\//.test(resource.text || '')) {
    resource = { ...resource, text: window.location.origin + resource.text };
  }
  const uiId = `mcpui_${Date.now()}`;
  chatManager.addMessage('assistant', `<ui-resource-renderer data-uiid="${uiId}" style="display:block;width:100%;max-width:100%;border:0;"></ui-resource-renderer>`);
  setTimeout(() => {
    const el = document.querySelector(`ui-resource-renderer[data-uiid="${uiId}"]`);
    if (!el) return;
    el.htmlProps = { autoResizeIframe: { height: true }, iframeProps: { scrolling: 'no' } };
    el.resource = resource;
    el.addEventListener('onUIAction', async (evt) => {
      const a = evt.detail;
      if (a?.type === 'tool' && a.payload?.toolName) {
        await fetch('/service/claims/ui/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolName: a.payload.toolName, params: a.payload.params })
        });
      }
    });
  }, 150);
}
```

### Backend – UI‑Aktionen empfangen

```ts
// srv/service.ts
app.post('/service/claims/ui/action', express.json(), async (req, res) => {
  const b = req.body || {};
  const action = b.toolName ? b : (b.payload && b.payload.toolName ? b.payload : null);
  if (!action?.toolName) return res.status(400).json({ error: 'Invalid payload' });
  if (action.toolName === 'email.send') {
    // Optional realer Versand (Feature‑Flag)
    // if (process.env.ENABLE_M365_SEND === 'true') await graph.sendMail({ to, subject, body, contentType: 'Text' });
    return res.json({ status: 'handled' });
  }
  if (action.toolName === 'email.discard') return res.json({ status: 'handled' });
  res.json({ status: 'ignored' });
});
```

## UI5 Composer (Auszug)

Der Composer sendet standardisierte mcp‑ui Events:

```html
<ui5-button id="sendBtn" design="Emphasized">E‑Mail senden</ui5-button>
<ui5-button id="discardBtn" design="Transparent">Verwerfen</ui5-button>
<script type="module">
  import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Assets.js';
  import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Input.js';
  import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/TextArea.js';
  import 'https://esm.sh/@ui5/webcomponents@1.24.0/dist/Button.js';
  const currentDraft = () => ({ from, to: toInput.value, subject: subjectInput.value, body: bodyInput.value });
  sendBtn.addEventListener('click', () => window.parent.postMessage({ type: 'tool', payload: { toolName: 'email.send', params: currentDraft() } }, '*'));
  discardBtn.addEventListener('click', () => window.parent.postMessage({ type: 'tool', payload: { toolName: 'email.discard', params: { draft: currentDraft() } } }, '*'));
  new ResizeObserver(es => es.forEach(e => window.parent.postMessage({ type: 'ui-size-change', payload: { height: Math.ceil(e.contentRect.height) } }, '*'))).observe(document.documentElement);
</script>
```

## Wichtige Stolpersteine & Lösungen

- URL‑Fehler bei `text/uri-list`:
  - Ursache: relative Pfade → „Failed to construct 'URL'“. Lösung: immer absolute http(s)‑URL übergeben oder stattdessen `text/html` (rawHtml) verwenden.
- Freitext‑Parsing von JSON:
  - Markdown/Linkifier zerstören JSON (z. B. `mailto:`). Best‑Practice ist eine separate UIResource im Tool‑Ergebnis. Falls nicht möglich: Base64‑Marker als Kommentar/Tag mitschicken und im Client dekodieren.
- „process is not defined“:
  - Vor Laden des Web Components ein kleines `process.env`‑Shim injizieren.
- Flackern/„Resource not provided“:
  - Renderer einmalig konfigurieren (`htmlProps` setzen, `dataset`‑Flag) und Ressourcen per ID zwischenspeichern; mit MutationObserver bei UI‑Re‑Renders neu binden.

## Feature‑Flags & Umgebungsvariablen

- `ENABLE_M365_SEND=true` → realer Versand über Microsoft Graph möglich (Guard im Backend‑Endpoint).
- `CLAIMAI_BASE_URL` → Basis‑URL für absolute Links (z. B. `https://localhost:4004`).

---

## Best Practices (ClaimAI) – vollständige Integration Tool ↔ UI ↔ Backend

Dieser Abschnitt beschreibt den in ClaimAI produktiv genutzten, robusten Integrationsfluss auf Basis der mcp‑ui Empfehlungen. Ziel: Entwürfe kommen als UIResource, Aktionen laufen deterministisch im Backend, und der Chat zeigt eine kurze Bestätigung ohne doppelte Inhalte.

### Architekturüberblick

- Tool (Agent) liefert eine UIResource als strukturiertes Objekt (bevorzugt `rawHtml`).
- Host (UI5‑App) rendert die Resource per `<ui-resource-renderer>` und fängt `onUIAction` ab.
- Backend‑Endpoint `/service/claims/ui/action` verarbeitet Button‑Klicks deterministisch.
- Versand erfolgt nicht via MCP‑Reply‑Tool, sondern über den Backend‑Endpoint (Microsoft Graph). Der Agent muss nicht „nochmals“ senden.
- Optional: Nach erfolgreichem Versand startet die UI automatisch eine Folge‑Runde im Chat (Option A), um den Kontext zu aktualisieren.

### Server – Tool gibt UIResource zurück (CDS: callLLM → { response, uiResource })

Wir geben der OData‑Action `callLLM` eine strukturierte Antwort: Text + optionale UIResource. Das ist stabiler als Freitext‑Marker.

TypeScript (verkürzt, ClaimAI‑Stil):

```ts
// srv/service.ts (Ausschnitt)
this.on('callLLM', async (req) => {
  const { prompt, sessionId } = req.data || {};
  const backend = resolveAgentBackend();
  const adapter = agentAdapters[backend];
  const userId = getUserId(req);
  const effectiveUserKey = sessionId ? `${userId}:${String(sessionId).trim()}` : userId;
  const result = await adapter.call({ prompt, userId: effectiveUserKey, capContext: buildCapContext(req), request: req });

  // Adapter liefert { response, uiResource? }
  const responseText = typeof result.response === 'string' ? result.response : '';
  const uiResource = result.uiResource && {
    uri: result.uiResource.uri,
    mimeType: result.uiResource.mimeType,
    text: result.uiResource.text,
  };
  return { response: responseText, uiResource };
});
```

LangGraph‑Adapter (Tool‑Seite) erzeugt für `draft.mail.compose` die UIResource direkt mit `createUIResource({ content: { type: 'rawHtml', htmlString } })`. Keine Base64‑Marker im Antworttext einbetten.

### UI – UIResource bevorzugt rendern, Text nur als Fallback

ClaimAI zeigt die Card exklusiv, wenn `uiResource` vorhanden ist, und blendet lange Textpassagen aus:

```js
// Ergebnis der OData-Action
const result = await callLLMViaOperationBinding(prompt); // => { response, uiResource? }
if (result.uiResource && result.uiResource.uri) {
  await renderMcpUiResource(result.uiResource); // bindet <ui-resource-renderer>
} else {
  addMessage('assistant', result.response || '');
}
```

Renderer‑Binden (vereinfacht):

```js
const html = `<ui-resource-renderer id="res1" style="display:block;width:100%"></ui-resource-renderer>`;
addMessage('assistant', html);
setTimeout(() => {
  const el = document.getElementById('res1');
  el.htmlProps = { autoResizeIframe: { height: true }, iframeProps: { scrolling: 'no' } };
  el.resource = resource;
  el.addEventListener('onUIAction', handleAction);
}, 150);
```

### UI → Backend – onUIAction deterministisch verarbeiten

Wir leiten `tool`‑Aktionen 1:1 an `/service/claims/ui/action` weiter. Der Endpoint akzeptiert sowohl `{ type:'tool', payload:{ toolName, params } }` als auch `{ toolName, params }` – für maximale Kompatibilität.

```js
async function handleAction(evt) {
  const a = evt?.detail || {};
  if (a.type === 'tool' && a.payload?.toolName) {
    const pl = a.toolName ? a : a.payload; // normalisieren
    const r = await fetch('/service/claims/ui/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pl)
    });
    const j = await r.json().catch(() => null);
    if (pl.toolName === 'email.send') {
      if (j?.status === 'sent') addMessage('assistant', `E‑Mail gesendet an ${arrToList(j.to)}${j.subject ? ` (Betreff: ${j.subject})` : ''}.`);
      else if (j?.status === 'handled') addMessage('assistant', `E‑Mail (Testmodus) verarbeitet${pl.params?.subject ? `: ${pl.params.subject}` : ''}.`);
      else if (j?.status === 'error') addMessage('assistant', `E‑Mail‑Versand fehlgeschlagen: ${j.error || 'Unbekannter Fehler'}`);

      // Option A: Nach erfolgreichem Versand eine Folge‑Runde starten, damit der Agent den Kontext kennt.
      if (j?.status === 'sent' || j?.status === 'handled') {
        const list = j?.to ? arrToList(j.to) : String(pl.params?.to || '');
        const subj = j?.subject || pl.params?.subject || '';
        const followUp = `Kontext: Die E‑Mail wurde soeben versendet an ${list}${subj ? ` (Betreff: ${subj})` : ''}. Bitte nächsten Schritt vorschlagen.`;
        const followRes = await callLLMViaOperationBinding(followUp);
        await handleAIResponse(followRes);
      }
    }
    if (pl.toolName === 'email.discard') {
      addMessage('assistant', 'Entwurf verworfen.');
      const subj = pl.params?.draft?.subject || '';
      const follow = `Kontext: Der Entwurf wurde verworfen${subj ? ` (Betreff: ${subj})` : ''}. Bitte nächsten Schritt vorschlagen.`;
      const res2 = await callLLMViaOperationBinding(follow);
      await handleAIResponse(res2);
    }
  }
}
```

Hinweis: Dies ist mcp‑ui‑konform. Die UI triggert gezielt die nächste Runde (Option A), statt den Agenten State intern zu modifizieren.

### Backend – deterministische Aktionen (E‑Mail senden/verwerfen)

Der Endpoint verarbeitet Tool‑Namen deterministisch. Versand erfolgt via Microsoft Graph, optional per Feature‑Flag.

```ts
// srv/service.ts (Ausschnitt)
app.post('/service/claims/ui/action', express.json(), async (req, res) => {
  const b = req.body || {};
  let action = b.toolName ? b : (b.payload?.toolName ? b.payload : null);
  if (!action?.toolName) return res.status(400).json({ error: 'Invalid payload' });
  const { toolName, params } = action;

  if (toolName === 'email.send') {
    const enableSend = process.env.ENABLE_M365_SEND?.trim().toLowerCase() === 'true';
    const to = normalizeRecipients(params?.to);
    const subject = String(params?.subject || '');
    const body = String(params?.body || '');
    if (enableSend) {
      try {
        const out = await graph.sendMail({ to, subject, body, contentType: 'Text' });
        return res.json({ status: 'sent', to: out.to || to, subject: out.subject || subject });
      } catch (e) {
        return res.status(500).json({ status: 'error', error: String(e.message || e) });
      }
    }
    return res.json({ status: 'handled', action: toolName, to, subject });
  }

  if (toolName === 'email.discard') return res.json({ status: 'handled', action: toolName });
  return res.json({ status: 'ignored', action: toolName });
});
```

Empfängernormalisierung (robuster): Strings wie `"Name <mail@example.com>"` auf reine Adresse extrahieren, Klammern/Kommas entfernen und Semikolon/Komma‑Listen splitten.

### UI5 Composer – Validierung

- E‑Mail‑Feld mit strengerer Validierung (z. B. `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) und `valueState='Negative'` bei Fehler.
- Button “Senden” bleibt klickbar; Klick‑Handler prüft `isValid()` und sendet nur, wenn alles ok ist – so bleibt die UX flüssig und Fehler sind sichtbar.

### Warum kein `mail.message.reply` mehr?

- Der Versand erfolgt über die UI (MCP‑UI) deterministisch per Endpoint. Der Agent soll nicht zusätzlich ein Reply‑Tool ausführen. In ClaimAI ist das Reply‑Tool für den Agenten ausgeblendet; der Versandweg ist UI‑gesteuert.

### Testen

1) `npm run watch-app` starten.
2) Prompt: „Bitte eine Antwort auf die letzte E‑Mail … entwerfen“ → Card erscheint.
3) “Senden” klicken → Backend antwortet `{ status:'sent'|'handled' }`, Chat zeigt kurze Bestätigung.
4) UI startet (Option A) eine Folge‑Runde: “Kontext: … gesendet …”. Agent schlägt nächsten Schritt vor.
5) Bei Fehler `{ status:'error' }` erscheint eine kompakte Fehlermeldung.

### Pitfalls & Lösungen (ClaimAI)

- Ungültige Empfänger (z. B. `user@example.com)`): UI validieren und Backend zusätzlich normalisieren.
- `text/uri-list` mit relativen Pfaden: immer absolute http(s) oder `rawHtml` verwenden.
- Doppelter Text im Chat: Wenn `uiResource` vorliegt, keine lange Textvorschau rendern.
- CSP/CDN: Für Produktion UI5 Web Components lokal hosten; im PoC sind CDN‑Imports ok.

---

## TL;DR – Minimaler Referenz‑Flow (ClaimAI)

1) Tool `draft.mail.compose` → `createUIResource({ type: 'rawHtml' })` zurückgeben.
2) callLLM liefert `{ response, uiResource }`.
3) UI rendert `<ui-resource-renderer>` und verarbeitet `onUIAction`.
4) `/service/claims/ui/action` führt `email.send`/`email.discard` deterministisch aus (Graph / Mock / Dry‑Run).
5) UI zeigt kurze Bestätigung und (Option A) startet Folge‑Runde, damit der Agent den Kontext kennt.

