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

## LangSmith Observability
- Enable tracing by exporting `LANGSMITH_TRACING=true`, `LANGSMITH_ENDPOINT=https://api.smith.langchain.com`, `LANGSMITH_API_KEY=<your-langsmith-key>`, and `LANGSMITH_PROJECT=pr-enchanted-savior-100` in your local `.env`. Keep secrets (API key) out of git.
- Restart `npm run watch-hybrid` (or your chosen start script) after setting the variables; the LangGraph adapter logs whether tracing is active.
- When tracing is on, visit [https://smith.langchain.com](https://smith.langchain.com) → `Projects` → `pr-enchanted-savior-100` to inspect runs with tool/LLM breakdowns.

## Codex SDK Agent
- Switch the backend by setting `CLAIMAI_AGENT_BACKEND=codex`; the default remains the LangGraph agent.
- Set `CODEX_API_KEY` if you want to override the cached credentials from `codex login`; other knobs (`CODEX_BASE_URL`, `CODEX_MODEL`, `CODEX_SANDBOX_MODE`, `CODEX_WORKING_DIRECTORY`, `CODEX_SKIP_GIT_CHECK`, `CODEX_EXECUTABLE`) remain optional overrides.
- Codex threads are kept per user session; they reuse the same working directory and sandbox defaults derived from environment variables.
- The Codex SDK bundles the CLI binary for common platforms; set `CODEX_EXECUTABLE` only if you need to point at a custom build.

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

## CAP

- You MUST search for CDS definitions, like entities, fields and services (which include HTTP endpoints) with cds-mcp, only if it fails you MAY read \*.cds files in the project.
- You MUST search for CAP docs with cds-mcp EVERY TIME you create, modify CDS models or when using APIs or the `cds` CLI from CAP. Do NOT propose, suggest or make any changes without first checking it.

## Rules for creation or modification of SAP Fiori elements apps

- When asked to create an SAP Fiori elements app check whether the user input can be interpreted as an application organized into one or more pages containing table data or forms, these can be translated into a SAP Fiori elements application, else ask the user for suitable input.
- The application typically starts with a List Report page showing the data of the base entity of the application in a table. Details of a specific table row are shown in the ObjectPage. This first Object Page is therefore based on the base entity of the application.
- An Object Page can contain one or more table sections based on to-many associations of its entity type. The details of a table section row can be shown in an another Object Page based on the associations target entity.
- The data model must be suitable for usage in a SAP Fiori elements frontend application. So there must be one main entity and one or more navigation properties to related entities.
- Each property of an entity must have a proper datatype.
- For all entities in the data model provide primary keys of type UUID.
- When creating sample data in CSV files, all primary keys and foreign keys MUST be in UUID format (e.g., `550e8400-e29b-41d4-a716-446655440001`).
- When generating or modifying the SAP Fiori elements application on top of the CAP service use the Fiori MCP server if available.
- When attempting to modify the SAP Fiori elements application like adding columns you must not use the screen personalization but instead modify the code of the project, before this first check whether an MCP server provides a suitable function.
- When previewing the SAP Fiori elements application use the most specific `npm run watch-*` script for the app in the `package.json`.

## Guidelines for UI5

Use the `get_guidelines` tool of the UI5 MCP server to retrieve the latest coding standards and best practices for UI5 development.