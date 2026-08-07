// Step 01c — enrich India events with concall.in data (best-effort).
//
// Adds two things to matched India events, WITHOUT touching the result-filing
// fields that 01b owns (earnings_datetime_utc / timing / earnings_time_confirmed):
//
//   - concall_datetime_utc : the SCHEDULED earnings-concall time, published in
//     advance (e.g. "Titan, 7 Aug 18:00 IST"). The dashboard shows this as an
//     upcoming time + countdown BEFORE the result is out; once the real filing
//     time is known (01b, from the BSE outcome) that takes over.
//   - eps_yoy_pct          : earnings-per-share YoY %, a fundamentals hint.
//
// Source: concall.in's public /fetch/* feeds (no auth). Their data is itself
// BSE-sourced (invite PDFs live on bseindia.com), so this can be re-based on BSE
// announcements later. This step is a COURTESY read of a public endpoint:
// low-frequency (a couple of calls per run) and FULLY fail-soft — any error, block,
// or shape change just means "no concall enrichment this run", never a crash.
//
// Names are matched to our universe by normalized company name (exact, then a
// safe prefix match that recovers concall.in's truncations like
// "Afcons Infrastruct." -> "Afcons Infrastructure Ltd").
//
// PROBE mode:  `PROBE=1 node pipeline/steps/01c-enrich-concall.mjs`
//   Fetches + reports match rate against the committed calendar. Writes NOTHING.

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const PROBE = process.env.PROBE === "1";
const BASE = CONFIG.concall.base;
const CONCALL_SIZE = Number(process.env.CONCALL_SIZE || 1000);
const RESULTS_SIZE = Number(process.env.CONCALL_RESULTS_SIZE || 2500);

// ---- normalization + matching -------------------------------------------

// Company name -> comparable key: lowercase, & -> and, drop only the noisiest
// suffixes, strip to alphanumerics. Kept light so prefix matching can do the rest.
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(ltd|limited|the)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

// Build a matcher over our India events. Returns match(name) -> event | null.
// Exact normalized hit first; else the longest safe prefix match (>= 6 shared
// leading chars, one key a prefix of the other) — recovers truncated names
// without the false positives a looser fuzzy match would cause.
function buildMatcher(events) {
  const exact = new Map();
  const list = [];
  for (const e of events) {
    if (e.market !== "IN" || !e.company) continue;
    const n = normName(e.company);
    if (n.length < 4) continue;
    if (!exact.has(n)) exact.set(n, e);
    list.push({ n, e });
  }
  return function match(name) {
    const c = normName(name);
    if (c.length < 4) return null;
    const ex = exact.get(c);
    if (ex) return ex;
    let best = null;
    let bestLen = 0;
    for (const { n, e } of list) {
      const short = Math.min(c.length, n.length);
      if (short >= 6 && (c.startsWith(n) || n.startsWith(c)) && short > bestLen) {
        bestLen = short;
        best = e;
      }
    }
    return best;
  };
}

// ---- concall.in fetch ----------------------------------------------------

// IST wall time "2026-08-08T09:00:00" (no tz) -> UTC ISO. IST is fixed +5:30.
function istLocalToUtcIso(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) - (5 * 60 + 30) * 60000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Flatten the nested { content:[{ eventsWithDate:[{ eventList:[...] }] }] } shape.
function flattenEvents(json) {
  const out = [];
  const groups = (json && json.content && json.content[0] && json.content[0].eventsWithDate) || [];
  for (const g of groups) for (const e of g.eventList || []) out.push(e);
  return out;
}

// POST a concall.in /fetch feed; returns a flat event array ([] on any failure).
async function fetchFeed(path, size) {
  const url = `${BASE}/${path}?page=0&size=${size}&sector=All&marketCap=All&searchTerm=`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://concall.in",
        Referer: "https://concall.in/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      body: "{}",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[concall] ${path}: HTTP ${res.status} — skipping`);
      return [];
    }
    const json = await res.json();
    return flattenEvents(json);
  } catch (e) {
    console.warn(`[concall] ${path}: ${e.message} — skipping`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---- run -----------------------------------------------------------------

export async function run() {
  if (!CONFIG.concall.enabled) {
    console.log("[enrich-concall] disabled (CONCALL_ENRICH=0) — skipping");
    return { skipped: true };
  }

  const calendar = await readJson("earnings-calendar.json", { events: [] });
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const inCount = events.filter((e) => e.market === "IN").length;
  if (inCount === 0) {
    console.log("[enrich-concall] no India events — skipping");
    return { skipped: true };
  }

  const match = buildMatcher(events);

  const [concalls, results] = await Promise.all([
    fetchFeed("fetch/upcomingConcalls", CONCALL_SIZE),
    fetchFeed("fetch/upcomingResults", RESULTS_SIZE),
  ]);

  if (PROBE) return probe(concalls, results, match);

  // (1) Scheduled concall time + title + invite link.
  let timed = 0;
  for (const c of concalls) {
    const e = match(c.companyName);
    if (!e) continue;
    const iso = istLocalToUtcIso(c.concallInviteDateTime);
    if (!iso) continue;
    e.concall_datetime_utc = iso;
    if (c.title) e.concall_title = String(c.title);
    if (c.documentUrl) e.concall_url = String(c.documentUrl);
    timed++;
  }

  // (2) EPS YoY %.
  let epsTagged = 0;
  for (const r of results) {
    if (r.epsYearOverYearPercent == null) continue;
    const e = match(r.companyName);
    if (!e) continue;
    const n = Number(r.epsYearOverYearPercent);
    if (!Number.isFinite(n)) continue;
    e.eps_yoy_pct = Math.round(n * 100) / 100;
    epsTagged++;
  }

  const payload = { ...calendar, count: events.length, events };
  await writeJson("earnings-calendar.json", payload);
  console.log(
    `enrich-concall: ${concalls.length} concalls / ${results.length} results fetched; ` +
      `${timed} names got a scheduled concall time, ${epsTagged} got EPS YoY`
  );
  return { concalls: concalls.length, results: results.length, timed, eps: epsTagged };
}

// ---- PROBE ---------------------------------------------------------------

async function probe(concalls, results, match) {
  console.log(`\n===== concall.in feeds =====`);
  console.log(`upcomingConcalls: ${concalls.length} | upcomingResults: ${results.length}`);
  let hit = 0;
  const sample = [];
  for (const c of concalls) {
    const e = match(c.companyName);
    if (e) {
      hit++;
      if (sample.length < 8)
        sample.push(`${c.companyName} -> ${e.ticker}  ${c.concallInviteDateTime} (${istLocalToUtcIso(c.concallInviteDateTime)})`);
    }
  }
  console.log(`\nconcall names matched into our universe: ${hit}/${concalls.length}`);
  sample.forEach((s) => console.log("  " + s));
  const eps = results.filter((r) => r.epsYearOverYearPercent != null);
  let epsHit = 0;
  for (const r of eps) if (match(r.companyName)) epsHit++;
  console.log(`\nresults with EPS YoY: ${eps.length}; matched into our universe: ${epsHit}`);
  console.log("\n[PROBE] wrote nothing.");
  return { probe: true, concalls: concalls.length, matched: hit };
}

// Allow running directly: `node pipeline/steps/01c-enrich-concall.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
