Agent Evals: Local Harness and LangSmith

Overview
- Quickly test tools and end-to-end workflows without UI/E2E.
- Run deterministic M365 mock fixtures so tests are repeatable.
- Optionally enable LangSmith to capture latency, token, and tool metrics.

Prereqs
- npm install at repo root.
- For Excel tests: network to fetch the Excel MCP server once via npx.
- For LangSmith: export LANGSMITH_TRACING=true plus API key and project as in AGENTS.md.

Commands
- Tool checks (mocked M365): `npm run eval:tools`
- Workflow harness (LangGraph, mocked M365): `npm run eval:workflow`
- Both: `npm run eval:all`
- AI Core ping (no E2E): `npm run eval:aicore`

What runs
- Tools: Calls `mail.latestMessage.get`, downloads first attachment, reads the spreadsheet via Excel MCP, simulates a reply and event create.
- Workflow: Builds a LangGraph agent with Filesystem, Excel, Time and Microsoft 365 tools, plus draft-only helpers. Executes a scripted scenario and prints an eval summary. Additionally, it creates a draft for `kfz.claims.Claims`, maps values from the Excel `ClaimHeader` sheet into draft fields, verifies the values deterministically against Postgres, and finally discards the draft.

Fixtures / Test Data
- M365 fixtures at `srv/test/fixtures/m365/messages.json` reference repo files under `MockDaten/` for attachments (Excel and PNG).
- Attachments download to `tmp/attachments` by default (`M365_ATTACHMENT_BASE_PATH`).

Switches
- `M365_AUTH_METHOD=mock` forces the in-process Microsoft 365 client to use fixtures (default in eval scripts).
- Set `M365_AUTH_METHOD=real` to use a real Microsoft 365 account (requires valid local auth for the Graph client). The workflow will then send an actual reply and create a calendar event.
- `LANGSMITH_TRACING=true` enables tracing; set `LANGSMITH_PROJECT` to group runs.
- For AI Core locally, copy `.env.aicore.example` to `.env`, fill `AICORE_SERVICE_KEY` with your service key JSON, and run `npm run eval:aicore`. Optionally set `AICORE_DEPLOYMENT_ID` or `AICORE_RESOURCE_GROUP`.

Extending
- Add more messages and attachments to the fixtures for richer scenarios.
- Create additional prompts in `srv/test/evals/agent.workflow.mjs` to cover edge cases.
- For stricter checks, parse the tool call list printed during the workflow run, or wire a custom evaluator that validates trajectory and outputs.
