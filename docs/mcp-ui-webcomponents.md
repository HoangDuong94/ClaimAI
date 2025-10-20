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

