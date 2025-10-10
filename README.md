# ClaimAI (KFZ Claims Assistant)

This CAP project manages vehicle insurance claims and related documents. It exposes the `ClaimsService` at `/service/claims` and ships with a Fiori elements UI under `app/webapp` for browsing and triaging claims data.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `db/` | CDS domain model (`db/schema.cds`) and CSV seed data under `db/data/` |
| `srv/` | CAP service implementation (`service.cds`, `service.js`, MCP helpers, utilities) |
| `app/` | SAPUI5/Fiori frontend sources and integration tests |
| `package.json` | CAP configuration including the Postgres connection for `claimai_db` |

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   cd app && npm install
   ```
2. Ensure the dedicated Postgres container/database is running (default: `claimai-postgres` on `localhost:5433`).
3. Deploy the CDS model and seed data:
   ```bash
   npx cds deploy --to postgres
   ```
4. Start the CAP server with UI:
   ```bash
   npm run watch-app
   ```
   This serves the backend on `http://localhost:9999` and opens the Fiori app.

### Hybrid profile workflows

- Single run (build + serve, no watch):
  ```bash
  npm run run:hybrid
  ```
- Watch mode (TypeScript rebuild + `cds watch --profile hybrid`):
  ```bash
  npm run watch-hybrid
  ```
- Backend only (no UI shell):
  ```bash
  npm run serve:hybrid
  ```

All scripts automatically disable the CDS `tsx` auto-runner (`CDS_TYPESCRIPT=false`) so the runtime uses the transpiled output in `gen/srv`.

## Useful Commands

- CAP service only: `npm start`
- UI build: `cd app && npx ui5 build --all`
- UI tests (headless): `cd app && npx ui5 test --all`
- Lint all sources: `npx eslint .`
- CI-friendly type check: `npm run ci:verify`

## Additional Notes

- Namespace: `kfz.claims` (entities `Claims` and `ClaimDocuments`).
- Draft handling is enabled for claims to support staged edits.
- The multi-tool agent entry point remains the `callLLM` action in `srv/service.ts`. Set `CLAIMAI_AGENT_BACKEND=claude` to route that action through the Claude Agent SDK (requires `ANTHROPIC_API_KEY`), or `CLAIMAI_AGENT_BACKEND=codex` to target the Codex SDK backend (requires `CODEX_API_KEY`).
- Microsoft 365 tooling expects the `m365` CLI to be available globally (install via `npm i -g @pnp/cli-microsoft365`). The backend will log a warning if the CLI is missing but continue to start.

### Codex SDK backend

To enable the Codex-based agent, install dependencies and provide credentials:

```bash
npm install
```

Set the key environment variables before starting the service:

- `CLAIMAI_AGENT_BACKEND=codex`
- `CODEX_API_KEY=<your Codex API key>` (optional if you already ran `codex login` and want to use the cached credentials)

Optional environment variables:

- `CODEX_BASE_URL` — override the Codex API endpoint (defaults to the public endpoint).
- `CODEX_MODEL` — model identifier to pass to Codex (defaults to the CLI's configured model).
- `CODEX_SANDBOX_MODE` — one of `read-only`, `workspace-write`, or `danger-full-access` (defaults to `workspace-write`).
- `CODEX_WORKING_DIRECTORY` — execution directory for Codex; defaults to the project root.
- `CODEX_SKIP_GIT_CHECK` — set to `false` to enforce the Git repository check (defaults to `true`).
- `CODEX_EXECUTABLE` — optional absolute path if you want to override the bundled `codex` CLI binary.

For CAP documentation and further guidance, visit [https://cap.cloud.sap/docs](https://cap.cloud.sap/docs).
