# Fresh Setup Verification

Verified: 2026-10-22 under Node.js 24 and npm 11.19.0.

## Method

A fresh directory was copied from the working tree while excluding `node_modules`, `.next`, `data`, `assets-local`, `.env.local`, `.git`, `agent-memory`, `AGENTS.md`, test output and TypeScript build info. The copy therefore had no installed dependencies, no database, no private assets and no Git metadata. `.env.example` was copied to `.env.local` unchanged (mock mode, blank keys).

## Commands and Results

| Command | Result |
|---|---|
| `npm ci` | Installed 413 packages from the committed lockfile. |
| `npm run fixtures:prepare` | Generated both synthetic 1024 x 1024 PNGs; licensed photos not ready; SAM captures not ready. |
| `npm run db:migrate` | Applied committed Drizzle migrations successfully. |
| `npm run typecheck` | Passed. |
| `npm test` | 32 files / 178 tests passed. |
| `npm run lint` | Passed. |
| `npm run build` | Production build passed; all API routes compiled. |
| `npm run test:e2e` | 12 Playwright mock tests passed (generation, selection, editing, comparison/evaluation, mobile/accessibility). |
| `npm run db:generate` | Reported no schema changes and created no migration. |
| `npm run check:contracts` | Passed offline; no network, credentials or paid probes. |

No manual SQL, global CLI, provider key or external service was required for the mock path. The Playwright Chromium binary was already present in the machine cache; on a new machine run `npx playwright install chromium` as documented in the README.

## npm 11 Install-Scripts Warning

`npm ci` printed an `install-scripts` allowScripts warning for `esbuild`, `better-sqlite3` and `unrs-resolver`. All commands above still passed on this Linux/Node 24 environment because usable binaries were present. If a platform fails to load a native module after `npm ci`, run `npm rebuild better-sqlite3` (and `npm rebuild esbuild` if needed) before setup; do not add hidden global build steps.

## Known Warnings

- Full `npm audit` reported 9 vulnerabilities (4 moderate, 5 high) in dev dependencies; `npm audit --omit=dev` found 0 production vulnerabilities. npm marked `eslint@9.39.5` as no longer supported. No `npm audit fix --force` was applied because it can make breaking changes to the pinned lockfile. Review `npm audit` before deployment and upgrade deliberately.
- `npm ci` may print the install-scripts warning described above.

## Not Covered

- No live provider call was made; mock/fixture results are not live evidence.
- No licensed photograph or authentic SAM capture was present.
- The fresh copy had no `.git`, so the repository-hygiene test used its filesystem-walk fallback instead of `git ls-files`; both paths are covered by the test implementation.
