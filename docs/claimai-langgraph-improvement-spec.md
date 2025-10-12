# ClaimAI – Verbesserungsanforderung für Multi‑Agent‑Prozess (LangGraph)

## 📋 Überblick
Der aktuelle **Multi‑Agent‑Workflow** mit LangGraph (Supervisor + Sub‑Agents) zeigt **inkonsistentes Routing** und **erhöhte Latenz** seit Einführung der Sub‑Agents.

Diese Datei dient als **Entwickler‑Anforderung** zur Behebung der Koordinations‑ und Performanceprobleme.

---

## 🎯 Ziele

- Supervisor bewertet den **korrekten Kontext** (nur AI‑Antworten *nach* der letzten Nutzereingabe)
- Supervisor‑Instruktionen werden **nicht als Human‑Nachrichten** behandelt
- Einführung von **Hop‑Limit** & deterministischer **Agent‑Progression**
- Reduktion der **Tool‑Fläche des General‑Agenten**
- Optionaler **Single‑Agent‑Fallback** über Env‑Flag

---

## ⚙️ Neue Environment‑Flags

| Flag | Default | Beschreibung |
|------|----------|---------------|
| `CLAIMAI_MAX_HOPS` | `6` | Maximale Anzahl Agent‑Hops pro Anfrage |
| `CLAIMAI_DISABLE_SUPERVISOR` | `0` | Bei `1`: Supervisor deaktiviert → Single‑Agent‑Modus |

---

## 🧩 Änderungen

### 1. Supervisor‑Kontext & Instruktionsbehandlung

**Problem:**  
Der Supervisor liest AI‑Antworten vor der letzten Human‑Nachricht und schreibt eigene Instruktionen als `HumanMessage`.  
Das erzeugt Schleifen und Fehlentscheidungen.

**Lösung:**
- Nur AI‑Nachrichten **nach** der letzten Nutzer‑Nachricht auswerten
- Supervisor‑Instruktionen als `SystemMessage` senden

```diff
// in agents/langgraph-adapter.ts, supervisorNode()

- const recentAgentContext = messages
-   .filter((m, i) => i < lastHumanIndex && m.getType?.() === 'ai')
+ const recentAgentContext = messages
+   .filter((m, i) => i > lastHumanIndex && m.getType?.() === 'ai')

- const updates: HumanMessage[] = [];
- updates.push(new HumanMessage({ content: ..., name: 'supervisor' }));
+ const updates: SystemMessage[] = [];
+ updates.push(new SystemMessage(`Supervisor-Anweisung: ${trimmedInstructions}`));
```

---

### 2. Loop‑Guard & deterministische Progression

```ts
const seen = new Set(messages.filter(isAIMessage).map(m => (m as any).name).filter(Boolean));
const done = {
  triage: seen.has('triage_agent'),
  claims: seen.has('claims_data_agent'),
  report: seen.has('report_agent'),
  general: seen.has('general_agent'),
};
const MAX_HOPS = Number(process.env.CLAIMAI_MAX_HOPS ?? 6);
if ([...seen].filter(n => /_agent$/.test(n)).length >= MAX_HOPS && !done.general) {
  return new Command({ goto: 'general_agent' });
}
```

**Routing‑Fix:**
```ts
let next = decision.next;
if (next === 'triage_agent' && done.triage) next = !done.claims ? 'claims_data_agent' : 'general_agent';
if (next === 'claims_data_agent' && done.claims) next = !done.report ? 'report_agent' : 'general_agent';
if (next === 'report_agent' && done.report) next = 'general_agent';
if (next === 'end' || (next === 'general_agent' && done.general)) return new Command({ goto: '__end__' });
```

---

### 3. Optional: Triage nur bei Mail‑Intent

```ts
const TRIAGE_KEYWORDS = /\b(mail|e-?mail|posteingang|inbox|anhang|attachment|outlook|teams)\b/i;
const mayTriage = TRIAGE_KEYWORDS.test(lastUserText);
if (next === 'triage_agent' && (!mayTriage || done.triage)) {
  next = !done.claims ? 'claims_data_agent' : !done.report ? 'report_agent' : 'general_agent';
}
```

---

### 4. General‑Agent – Toolfläche verschlanken

```ts
const allowedGeneralTools = new Set([
  'cap.cqn.read',
  'cap.claims.list_summary',
  'reporting.list_reports',
  'fs.write_report_html'
]);
const generalToolsSlim = routedGeneralTools.filter(t => allowedGeneralTools.has(t.name));
```

Optional dynamische Aktivierung:
```ts
function expandToolsByPrompt(prompt: string, base: StructuredToolInterface[]) {
  const lower = prompt.toLowerCase();
  const out = [...base];
  if (/(web|google|brave)/.test(lower)) out.push(...braveSearchTools);
  if (/excel|\.xlsx|tabelle/.test(lower)) out.push(...excelTools);
  return out;
}
```

---

### 5. Single‑Agent‑Fallback

```ts
if (process.env.CLAIMAI_DISABLE_SUPERVISOR === '1') {
  this.logger.log('Single-Agent-Modus aktiviert');
  const singleTools = generalToolsSlim;
  this.agentExecutor = createReactAgent({
    llm,
    tools: singleTools,
    stateModifier: new SystemMessage('Du bist der ClaimAI Hauptexperte ...'),
    checkpointSaver: checkpointer,
  });
  return this.agentExecutor;
}
```

---

### 6. Metriken für Laufzeitmessung

```ts
async function timedNodeInvoke(agent, name, state, config) {
  const t0 = Date.now();
  const result = await agent.invoke(state, config);
  const dt = Date.now() - t0;
  this.logger.log(`[Node] ${name} finished in ${dt} ms`);
  return result;
}
```

---

## ✅ Test‑Szenarien

| ID | Prompt | Erwarteter Flow |
|----|---------|----------------|
| **T1** | „Zeig mir die letzten 5 Claims …“ | claims_data_agent → supervisor → general_agent |
| **T2** | „Was steht in der neuesten E‑Mail?“ | triage_agent → supervisor → general_agent |
| **T3** | „Erstelle einen HTML‑Report zu offenen Schadenfällen.“ | claims_data_agent → report_agent → general_agent |

---

## 🧠 Zusatzhinweise

- Conversation‑IDs sollten **pro paralleler Anfrage eindeutig** sein (`conversationId` verwenden).
- Hop‑Limit (`CLAIMAI_MAX_HOPS`) schützt vor Endlosschleifen.
- Logs erweitern um Dauer‑Metrik pro Node zur Performance‑Analyse.

---

## 📄 Änderungsverlauf

| Version | Beschreibung |
|----------|---------------|
| **v1.0** | Erste Fassung – Supervisor‑Kontextfix, Loop‑Guards, Tool‑Reduktion, Single‑Agent‑Fallback |
