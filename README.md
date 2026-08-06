# Earnings Radar 📈

_Working title — may be renamed._

A dashboard that watches stocks with **earnings coming up** (US + India), measures
how much each moved **before** its report, and **flags + alerts** when a stock is
up ≥ 3% ahead of the news.

> **Thesis:** smart / insider money moves the price before the news breaks. It's a
> signal, not proof.

## Status

**Step 1 of 9 — scaffold only.** This is the skeleton: a dependency-free Node
pipeline of stub steps that write empty-but-valid JSON into `public/data/`, a
static dashboard shell that reads those files, and a Cloudflare Worker to serve
it. Real fetchers, charts, alerts, and automation come in later steps.

Roadmap: **(1) scaffold ← you are here**, (2) earnings-calendar fetcher,
(3) price fetcher + snapshots, (4) movement/signal engine, (5) alerting,
(6) insider + news overlay, (7) dashboard UI, (8) intraday automation,
(9) backtest.

## Architecture

- **Node 22, ESM (`.mjs`)**, no runtime dependencies (Node 22 ships a global
  `fetch`). The repo **is** the database — no DB.
- A pipeline of small step scripts writes plain JSON into `public/data/`. Each run
  also appends a dated price snapshot under `public/data/snapshots/` for history.
- A static site in `./public` (plain HTML + vanilla JS, **no build step**; Tailwind
  + ECharts + Lucide via CDN) reads those JSON files.
- A **Cloudflare Worker** (`worker/index.js`) serves `./public` via the `ASSETS`
  binding and will later hold secret keys for private routes.
- **GitHub Actions** runs the pipeline on a schedule (added in a later step); for
  now the workflow is manual-dispatch only.

```
README.md                         this file
config.mjs                        central knobs (CONFIG)
package.json                      "type":"module", scripts
wrangler.jsonc                    Worker + ASSETS -> ./public
worker/index.js                   serves ./public, GET /api/health -> { ok:true }
pipeline/
  run.mjs                         orchestrator: runs steps 01->04, writes metadata
  lib/
    io.mjs                        readJson / writeJson under public/data
    http.mjs                      fetchJson / fetchText with 4x backoff retry
    market.mjs                    nowUtc, isMarketOpen, minutesToEarnings, classifyTiming
    llm.mjs                       multi-provider LLM client (Anthropic + Mistral); unused yet
  steps/
    01-earnings-calendar.mjs      STUB -> earnings-calendar.json
    02-fetch-prices.mjs           STUB -> snapshot + snapshots/index.json
    03-compute-signals.mjs        STUB -> signals.json
    04-alerts.mjs                 STUB -> alerts.json
public/
  index.html                      dashboard shell (KPI strip, US/India tabs, empty state)
  js/app.js                       fetch ./data JSON, render KPIs + tabs + table
  js/ui.js                        tiny format/DOM helpers
  data/                           the "database" (committed JSON)
.github/workflows/refresh.yml     manual-dispatch pipeline run + commit data back
```

## Run it

```bash
node pipeline/run.mjs
```

This runs steps 01→04, refreshes every file under `public/data/`, writes one empty
snapshot, updates `snapshots/index.json`, prints a summary, and exits 0.

### View the dashboard

Serve `./public` over HTTP (browsers block `fetch()` of local files over
`file://`, so the data won't load if you just double-click `index.html`):

```bash
npx wrangler dev          # serves the Worker + static site, incl. /api/health
# or any static server, e.g.:  python3 -m http.server -d public 8080
```

Then open the printed URL. You should see the KPI strip at **0**, working
**US / India** tabs, and a friendly empty state ("No earnings tracked yet — run
the pipeline").

## Environment variables

All optional at this scaffold stage — the stubs run green without any of them.
**Never commit secrets** (see `.gitignore`); set them in your shell, a local
`.env`/`.dev.vars` (git-ignored), or GitHub Actions secrets.

| Variable            | Used for                                    | Notes                                  |
| ------------------- | ------------------------------------------- | -------------------------------------- |
| `FINNHUB_API_KEY`   | US earnings + prices                        | step 2/3                               |
| `MUNS_TOKEN`        | India data (muns.io)                        | step 2/3                               |
| `MUNS_BASE_URL`     | muns.io API base                            | defaults to `https://devde.muns.io`    |
| `ANTHROPIC_API_KEY` | LLM overlay (optional)                      | Anthropic; step 6                      |
| `MISTRAL_API_KEY`   | LLM overlay (optional)                      | Mistral; step 6                        |
| `ALERT_EMAIL_TO`    | alert recipient                             | step 5                                 |
| `FIRECRAWL_API_KEY` | scraping fallback (reserved, unused now)    | optional                               |
| `SCRAPEDO_API_KEY`  | scraping fallback (reserved, unused now)    | optional                               |

## Deploy (later)

```bash
npx wrangler deploy
```

Serves `./public` via the Worker's `ASSETS` binding; `GET /api/health` returns
`{ "ok": true }`.
