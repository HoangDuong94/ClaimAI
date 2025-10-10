# LangGraph-Mailworkflow – Migrationsplan

## Ziele
- Standard-Mailverarbeitung (Microsoft 365) als LangGraph-Fluss verfügbar machen.
- Automatische Anreicherung (Zusammenfassung, Vision, Excel) deployen.
- AgentContext direkt für UI/Agent nutzbar halten.

## Architekturänderungen
- **Backend**  
  - `srv/service.ts`: Polling/SSE belassen, aber `agentContext.attachments[*]` um Vision-/Excel-Ergebnisse erweitern.
  - LangGraph nutzen (bestehender Adapter) → neuen Workflow-Knoten (z. B. `mail_auto_triage`) registrieren.
  - Tools über ensureMcpClients laden (filesystem, excel, m365, cap).
- **Frontend**  
  - `app/webapp` kann bisherigen Agent-Kontext weiter nutzen; neue Felder optional anzeigen.

## Schritte
1. **Infra vorbereiten**
   - `m365 login` (WSL CLI); `M365_CLI_COMMAND` per `.bashrc` setzen.
   - `scripts/test-langgraph-workflow.mjs` als Referenz nutzen.
2. **Backend-Refactoring**
   - Hard-coded `GraphClient` in Skript entfernen → stattdessen bestehende Implementierung referenzieren.
   - Enrichment-Funktionen in `srv/service.ts` portieren (Vision/Exif/Excel).
   - `LangGraphAgentAdapter` aktualisieren, damit Workflow als Tool/Node verfügbar ist.
3. **Workflow implementieren**
   - LangGraph-Knoten: `fetchMail`, `summarize`, `enrichAttachments`, optional `createDraft`.
   - `mail_auto_triage` Tool im Agent registrieren.
4. **Tests**
   - Scripts: `test-langgraph-workflow` weiterverwenden; Unit/Integration (Mocha/Jest) optional ergänzen.
   - Manuelle Validierung mit MockDaten + Live-Mails.
5. **Rollout**
   - Feature-Flag (ENV), Logging, Dokumentation (`README`, `docs`).
   - Monitoring (Excel-Server, Vision, m365 Tokens).

## Risiken & Mitigation
- **m365 CLI offline** → Error-Handling, Hinweis-Logs.
- **Excel/Vision-Tool nicht erreichbar** → Attachment flagged mit `error`.
- **Kosten Vision** → Rate-Limits/Abschaltung bei Bedarf.
- **Performance** → Batch/Parallelisierung prüfen.

## Nacharbeiten
- Automatisches Draft-Handling (CAP MCP).
- Rückfrage-/Antwortautomation (`mail.message.reply` Tool).
- Dashboard/Monitoring für Workflow-Ausführung.
