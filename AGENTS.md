# Repository Guidelines

## Project Structure & Module Organization
- `db/` contains the CDS domain model (`schema.cds`) and CSV seeds under `db/data/` for the `kfz.claims` namespace.
- `srv/` hosts the CAP service (`service.cds`, `service.js`) plus MCP utilities in `srv/mcp-*` and shared helpers in `srv/utils/`.
- `app/` holds the SAPUI5/Fiori frontend (`webapp/`) and OPA/QUnit tests in `webapp/test/`.
- Root configuration lives in `package.json`, `eslint.config.mjs`, and `.env` overrides (not committed).

## Build, Test, and Development Commands
- `npm install && cd app && npm install` – install backend and UI dependencies.
- `npm run watch-app` – start CAP on `http://localhost:9999` and auto-open the UI shell.
- `npm start` – serve only the CAP API for integration testing or MCP use.
- `npx cds deploy --to postgres` – deploy the model and load seeds into the `claimai_db` Postgres instance (default host `localhost:5433`).
- `cd app && npx ui5 test --all` – run headless UI5 tests; use before PR submission.

## Coding Style & Naming Conventions
- Node.js code uses ES modules, 2-space indent, and mandatory semicolons.
- CDS artifacts employ lowercase namespaces (`kfz.claims`) and PascalCase entities (`Claims`, `ClaimDocuments`).
- UI components, controllers, and tests follow PascalCase; i18n keys stay in lower.dot.case.
- Run `npx eslint .` to enforce formatting; UI5 XML views should remain well-formed and lint-clean.

## Testing Guidelines
- Backend relies on integration tests via CAP; add Mocha/Jest under `srv/test/` when business logic grows.
- UI automation lives in `app/webapp/test/` using OPA and QUnit; mirror production scenarios and name suites `*.qunit.js`.
- Seed data must stay in sync with CDS enums (claim status, document type) so test fixtures resolve.

## Commit & Pull Request Guidelines
- Prefer Conventional Commits (`feat(db): add claim severity scoring`) with scoped, imperative messages.
- PRs should outline motivation, summarize functional impact, list validation steps (`cds deploy`, `ui5 test`), and attach screenshots/GIFs for UI changes.
- Flag database or schema amendments, including Postgres migrations, to alert reviewers about re-deploy requirements.

## Security & Configuration Tips
- Keep credentials out of source control; rely on `.env` for overrides and rotate Postgres passwords when sharing environments.
- The MCP postgres server expects `postgresql://claimai:claimai@localhost:5433/claimai_db`; update tooling if ports or credentials change.
- When extending agent capabilities, document new tools and guardrails in `srv/mcp-*` to maintain safe automation.
