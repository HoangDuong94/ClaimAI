# Anforderungen – MCP‑UI Composer (UI5 Web Components) in ClaimAI

Ziel: Ein anderer Entwickler soll die MCP‑UI Integration so finalisieren, dass beim Agenten‑Aufruf (z. B. `draft.mail.compose`) die UI‑Card (UI5 Web Components Composer) als bevorzugte Darstellung erscheint, Aktionen (Senden/Verwerfen) in den Workflow greifen, und keine redundanten Text‑Antworten sichtbar sind. Diese Datei liefert den Kontext und konkrete Umsetzungsanforderungen ohne Kenntnis des bisherigen Chatverlaufs.

---

## Kontext / Ist‑Stand

- Projektstruktur (relevant):
  - `srv/` – CAP Services, MCP‑Client‑Wiring, Agent‑Adapter.
  - `app/` – UI5/Fiori Frontend mit Chat‑Panel und Web‑Komponente `<ui-resource-renderer>`.
  - `docs/` – Projektdokumentation (siehe auch `docs/mcp-ui-webcomponents.md`).
- Bereits umgesetzt (PoC & Integration):
  - Der Agent‑Tool `draft.mail.compose` erzeugt eine UIResource für den E‑Mail‑Composer (UI5 Web Components) und liefert sie zurück. Aktuell als `rawHtml` (empfohlen) – kein URL‑Parsing nötig.
  - Das Frontend rendert die UIResource mit `<ui-resource-renderer>` und bevorzugt die UI‑Card; redundanter Fließtext wird unterdrückt.
  - Buttons senden standardisierte MCP‑UI Events (`type: 'tool'`, `payload: { toolName, params }`) und werden im Backend über `POST /service/claims/ui/action` verarbeitet (PoC: quittiert; Versand optional).
  - Fallback‑Mechanismen (Base64‑Marker) existieren, sollten aber perspektivisch entfallen, sobald eine strukturierte Rückgabe (siehe unten) vorhanden ist.

---

## Zielbild (Best‑Practice gemäß MCP‑UI)

- Tools liefern interaktive UI als eigenständige UIResource (Objekt mit `uri`, `mimeType`, `text|blob`).
- Der Host rendert UIResources explizit (nicht aus Freitext) via `<ui-resource-renderer>` und verarbeitet `onUIAction`.
- Der Text‑Antwortteil bleibt optional (Kurz‑Hinweis), wird jedoch nicht zusätzlich als lange, redundante Vorschau gerendert, wenn eine UIResource vorhanden ist.
- Optionaler „Pro‑Pfad“: UIResources zusätzlich/alternativ per SSE („resource“‑Event) streamen.

---

## Anforderungen – Backend

1) Strukturierte Rückgabe der Agenten‑Action `callLLM`
- Erweiterung des OData‑Schemas (CDS) für `callLLM` so, dass die Antwort neben dem Text optional eine UIResource transportiert:
  - Beispiel: `returns { response: LargeString; ui: LargeString }` (wobei `ui` ein serialisiertes JSON der UIResource ist).
  - Wichtig: Vor Änderungen an CDS/CLI die CAP‑Doku via `cds-mcp` prüfen (Repo‑Regel!).
- Service‑Handler `srv/service.ts` (`this.on('callLLM')`):
  - Den Agent‑Adapter aufrufen und Ergebnis strukturiert als `{ response, ui }` zurückliefern.
  - `ui` nur setzen, wenn eine valide UIResource vorhanden ist; andernfalls leer lassen.
- Agent‑Adapter `srv/agents/langgraph-adapter.ts`:
  - Beim Tool `draft.mail.compose` UIResource weiterhin per `createUIResource` erzeugen (bevorzugt `rawHtml`).
  - `call()` soll ein Objekt `{ response: string, uiResource?: Resource }` zurückgeben (keine Base64‑Marker/JSON‑Beipack mehr ins Freitext‑HTML einbetten).
  - Der Freitext `response` sollte maximal eine kurze Einleitung enthalten (kein doppelter Volltext, wenn `uiResource` gesetzt ist).

2) UI‑Aktionen verarbeiten
- Endpoint `POST /service/claims/ui/action` ist vorhanden – erweitern auf Wunsch:
  - Feature‑Flag `ENABLE_M365_SEND=true` → bei `toolName==='email.send'` realer Versand über `GraphClient.sendMail({ to, subject, body, contentType:'Text' })`.
  - Bei Erfolg JSON `{ status: 'sent', to, subject }`; ansonsten `{ status: 'handled'|'ignored'|'error' }`.
  - Robust gegen unterschiedliche Payload‑Formen: `{ toolName, params }` ODER `{ type:'tool', payload:{ toolName, params } }`.
  - Optional: `messageId` aus dem iFrame berücksichtigen (asynchrones ACK gemäß mcp‑ui Protokoll).

3) Sicherheit / CSP
- Raw‑HTML Ressourcen im Iframe: Sandbox minimal halten (z. B. `allow-scripts`, kein `allow-same-origin`, sofern nicht lokal importierte Module geladen werden).
- Optional: CDN‑Abhängigkeiten (esm.sh, @mcp-ui/client) ablösen und lokal hosten.

---

## Anforderungen – Frontend (UI5)

1) Strukturiertes Rendering bevorzugen
- `callLLMViaOperationBinding` erhält nun `{ response, ui }`.
- Rendering‑Logik ändern:
  - Wenn `ui` vorhanden → `JSON.parse(ui)` als Resource an `<ui-resource-renderer>` binden und KEINEN langen Text anzeigen (nur optional kurzer Hinweis).
  - Wenn `ui` fehlt → bisherigen Textpfad anzeigen.
- Entferne mittelfristig die Freitext‑Scans/Marker‑Parsing‑Fallbacks (sofern strukturiert vorhanden).

2) onUIAction Wiring
- Bereits vorhanden: `onUIAction` → `POST /service/claims/ui/action`.
- Optional: Antwort kurz im Chat bestätigen (z. B. „E‑Mail gesendet an …“ bei `{ status:'sent' }`).

3) UI5 Renderer‑Stabilität
- `<ui-resource-renderer>` nur einmal initialisieren; MutationObserver zum Rebind nutzen.
- Ressourcen per ID zwischenspeichern und (optional) LRU‑Eviction (z. B. letzte 100).
- Visuelles: Borderless Iframe, auto‑height via `ui-size-change` (bereits vorhanden).

---

## (Optional) SSE‑Variante

Falls Streaming bevorzugt wird, kann das Backend zusätzlich/alternativ zu `callLLM` eine SSE‑Route anbieten:

- `GET /service/claims/agent/stream` sendet Events:
  - `event: text` mit `{ html }` (Kurztexte),
  - `event: resource` mit `{ type:'resource', resource:{…} }`.
- Client öffnet `EventSource`, rendert bei `resource` sofort eine Card und zeigt Text optional.
- Vorteil: UI wird „live“ und unabhängig vom OData‑Schema geliefert.

---

## Abnahmekriterien

- [ ] Aufruf `draft.mail.compose` führt dazu, dass im Chat ausschließlich die Composer‑Card angezeigt wird (keine doppelte Textvorschau), sofern `ui` vorhanden ist.
- [ ] Buttons „E‑Mail senden/Verwerfen“ triggern Backend‑Action; bei aktivem Flag `ENABLE_M365_SEND=true` wird real gesendet; Chat zeigt kurze Bestätigung.
- [ ] Bei fehlender UIResource erscheint weiterhin nur Text (Fallback).
- [ ] Keine Base64‑Marker oder JSON‑Blöcke mehr im sichtbaren Chattext.
- [ ] Keine `Invalid URL`‑Fehler (keine `uri-list` mit relativen Pfaden verwenden; primär `rawHtml`).
- [ ] Linter/TypeScript Checks grün (`npm run ts:check`).

---

## Umgebungsvariablen / Setup

- `ENABLE_M365_SEND=true` (optional) – realer Versand via Microsoft Graph.
- `CLAIMAI_BASE_URL=https://localhost:4004` (optional) – Grundlage für absolute URLs, wenn je nach Ansatz nötig.
- Microsoft 365 Login für Tests: `m365 login` (CLI) vor dem Start.

---

## Tests / Validierung

1) Lokaler Start: `npm run watch-app`.
2) Im Chat z. B. „Bitte eine Antwort auf die letzte E‑Mail mit Hinweis auf fehlenden Polizeibericht entwerfen“.
3) Erwartung: Composer‑Card erscheint direkt; „Senden“/„Verwerfen“ löst Backend‑Action aus.
4) Mit `ENABLE_M365_SEND=true` einen Test‑Empfänger setzen und tatsächliche Zustellung prüfen.
5) Frontend Tools: `cd app && npx ui5 test --all` (falls Tests vorhanden/ergänzt werden).

---

## Hinweise & Quellen

- mcp‑ui Best‑Practices: UI als UIResource liefern (nicht als Freitext). Client rendert `<UIResourceRenderer />` / `<ui-resource-renderer>` und behandelt `onUIAction`.
- Siehe ergänzte Doku `docs/mcp-ui-webcomponents.md` (Best‑Practice, Stolpersteine, onUIAction, rawHtml vs. uri‑list).
- Sicherheit: Bei `rawHtml` auf minimale Sandbox achten; CDN in Produktion vermeiden.

---

## Arbeitspakete (Kurzform)

1) CDS + Service: `callLLM` Rückgabetyp strukturiert (Text + `ui`), Handler anpassen.
2) Adapter: Strukturierte Rückgabe `{ response, uiResource }`, Base64‑Marker entfernen.
3) Frontend: „UI zuerst“ – `ui` rendern, Text nur bei fehlender UI; Marker‑Parsing entkernen.
4) Backend Action: Optionalen Versand mit Flag scharf schalten; Chat‑Bestätigung.
5) Doku/QA: README‑Kurzabschnitt, Tests, manuelle E2E‑Prüfung.

