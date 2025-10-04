# Repository Guidelines

## Project Structure & Module Organization
- `db/` — CDS domain models (`schema.cds`) and CSV seeds under `db/data/` for the `kfz.claims` namespace.
- `srv/` — CAP services (`service.cds`, `service.ts`), MCP helpers, LangGraph agent wiring, and TypeScript augmentations.
- `srv/types/` — local declaration merges (for example CAP Request helpers) consumed by the TypeScript build.
- `app/` — SAPUI5/Fiori frontend in `webapp/`, including integration tests under `webapp/test/`.
- Root configs: `package.json`, `eslint.config.mjs`, `ui5.yaml`; environment overrides belong in local `.env` files.

## Build, Test, and Development Commands
- `npm install && cd app && npm install` — install backend and UI dependencies.
- `npm run watch-app` — run CAP locally on `http://localhost:9999` and open the UI shell.
- `npm start` — serve only the CAP API (useful for integration tests or MCP tooling).
- `npx cds deploy` — deploy the data model and seeds to Postgres (`claimai_db` on `localhost:5433`).
- `cd app && npx ui5 test --all` — execute headless UI5 test suites before submitting changes.
- `npm run ts:check` — strict TypeScript validation for the `srv/` layer (runs automatically in CI via `ci:verify`).

## TypeScript Workflow
- All server-side code now compiles through `tsconfig.json`; prefer authoring new logic in `.ts` files.
- Use `npm run ts:watch` during local development; `npm run watch-hybrid` already chains the watcher with `cds watch`.
- When adding CAP runtime APIs that lack typings, extend them in `srv/types/cds-augmentations.d.ts` rather than sprinkling `any`.

## LangGraph / MCP Agent
- `srv/service.ts` hosts the LangGraph React agent and SSE endpoints; it expects MCP clients from `srv/lib/mcp-client.ts`.
- Initialize the full toolset with `npm run watch-hybrid` (starts the TS watcher + CAP server with the hybrid profile).
- Microsoft 365 tooling requires the m365 CLI login; Excel attachments are downloaded to `tmp/attachments` and enriched automatically.
- CAP MCP actions (`srv/mcp-cap/index.ts`) maintain draft caches per entity—prefer `cap.draft.*` flows over raw SQL writes.

## Coding Style & Naming Conventions
- Node services use ES modules, 2-space indentation, and mandatory semicolons; run `npx eslint .` before committing.
- CDS artifacts: lowercase namespaces (`kfz.claims`), PascalCase entities (`Claims`), snake_case database columns.
- UI5 controllers/views follow PascalCase; i18n keys stay in lower.dot.case.
- Keep XML views well-formed; avoid adding non-ASCII characters unless already present.

## Testing Guidelines
- Prefer CAP integration tests; add service-level tests under `srv/test/` when business logic grows.
- UI automation lives in `app/webapp/test/` (OPA + QUnit). Name suites `*.qunit.js` and mirror user flows.
- Ensure seed CSVs stay in sync with CDS enums (e.g., `ClaimStatusTexts`) so dropdowns render correctly.

## Commit & Pull Request Guidelines
- Use Conventional Commits, e.g., `feat(app): add claim status value help`.
- PRs should explain motivation, summarize functional changes, and list validation steps (`cds deploy`, `ui5 test`).
- Attach screenshots or GIFs for UI updates and flag schema changes that require database redeploys.

## Security & Configuration Tips
- Do not commit credentials; maintain local `.env` files and rotate Postgres passwords when sharing environments.
- Two Postgres containers may map to `5433`; confirm you target `claimai-postgres` before deploying.
- Document new MCP tooling in `srv/mcp-*` and add guardrails to prevent unsafe automation.
