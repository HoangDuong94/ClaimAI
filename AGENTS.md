# Repository Guidelines

## Project Structure & Module Organization
- `db/` CDS domain models (`schema.cds`) and CSV seed data under `db/data/`.
- `srv/` CAP service layer: `service.cds` + `service.js`, shared MCP client helpers in `srv/lib/`, markdown utilities in `srv/utils/`.
- `app/` SAPUI5 frontend (`webapp/` sources, tests under `webapp/test/`).
- `docs/` project documentation; generated build artifacts stay out of VCS.
- Root `package.json` configures CAP, Postgres, and dev scripts.

## Build, Test, and Development Commands
- Install deps (root): `npm install` (and `cd app && npm install` for UI tooling).
- Run CAP in watch mode with UI: `npm run watch-app` (opens `app/webapp/index.html`).
- Run CAP service only: `npm start` (serves on `http://localhost:9999`).
- Initialize database: `npx cds deploy --to postgres` (configure Postgres first).
- UI5 build: `cd app && npx ui5 build --all` (outputs `dist/`).
- UI tests (browser): `cd app && npx ui5 serve -o test/testsuite.qunit.html`.
- UI tests (headless): `cd app && npx ui5 test --all`.

## Coding Style & Naming Conventions
- Language: Node.js ES Modules (import/export). Use 2‑space indent and semicolons.
- Filenames under `srv/` favour lowercase or kebab‑case (e.g., `markdown-converter.js`).
- CDS: namespaces lower‑case dot notation; entities in PascalCase.
- UI5: components/controllers PascalCase; i18n keys lower.dot.case.
- Linting: ESLint with CAP’s recommended config (`eslint.config.mjs`). Prefer `npx eslint .` if installed.

## Testing Guidelines
- UI: QUnit/OPA tests live in `app/webapp/test/` (e.g., `test/integration/FirstJourney.js`, `pages/*`). Name files `*.qunit.js` for suites.
- Backend: no unit tests yet; add Mocha/Jest under `test/` or `srv/test/` following ESM.
- PRs should keep tests green (`ui5 test`) and include new/updated tests for changed behavior.

## Commit & Pull Request Guidelines
- Commits: concise, imperative. Prefer Conventional Commits: `feat(srv): add callLLM stream handling`.
- PRs: include a clear description, linked issues, steps to validate, and screenshots/GIFs for UI changes. Note DB/schema changes and required migrations.

## Security & Configuration Tips
- Do not commit secrets. Use `.env` for local dev and environment variables to override `cds.requires` (Postgres, destinations, AI services). `.gitignore` already excludes common files.
- Service runs at port `9999` (see `package.json`). Service root: `/service/claims`; action `callLLM` in `srv/service.js` executes the multi-tool agent.
- Supporting agent helpers live in `srv/lib/` and `srv/utils/`; avoid reintroducing generated artefacts into version control.

## MCP Servers

### cds-mcp (CAP context)
- Added via `codex mcp add cds-mcp -- npx --yes --package @cap-js/mcp-server cds-mcp`; ensure the command resolves on your PATH.
- `search_model` MUST be used for CDS definitions (entities, services, endpoints); only read `*.cds` manually if a lookup fails.
- `search_docs` MUST precede any CAP model or API changes and `cds` CLI usage; never propose or apply changes without consulting it.

### postgres (Database access)
- Registered with `codex mcp add postgres -- npx --yes mcp-postgres-full-access postgresql://duh:test123@localhost:5432/stammtisch_ai_db`.
- Connection string aligns with `cds.requires.db[development]` credentials; update if credentials/env differ.
- Use the `query` tool for read/write SQL; prefer read-only queries unless a migration or data fix was requested.
