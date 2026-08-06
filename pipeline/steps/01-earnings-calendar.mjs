// Step 01 — earnings calendar (REAL fetcher).
//
// Builds public/data/earnings-calendar.json of upcoming earnings for the next
// ~EARNINGS_LOOKAHEAD_DAYS days (default 14) across US (Finnhub) and India (BSE
// "Forthcoming Results"). Fail-soft throughout: one bad source or one bad row
// never crashes the run.
//
// PROBE mode:  `PROBE=1 node pipeline/steps/01-earnings-calendar.mjs`
//   Does ONE Finnhub call + ONE BSE fetch, prints each raw response under a
//   banner plus the parsed events, and EXITS WITHOUT writing files.
//
// event shape:
//   { ticker, market:"US"|"IN", company, earnings_date:"YYYY-MM-DD",
//     earnings_datetime_utc:ISO|null, timing:"BMO"|"AMC"|"INTRADAY"|"UNKNOWN",
//     confirmed:bool, source }
//   India rows additionally carry `bse_code` (BSE scrip code) — an EXTRA field
//   beyond the base shape that step 3 uses to map a company to a price symbol.

import { pathToFileURL } from "node:url";
import { writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const LOOKAHEAD_DAYS = Number(process.env.EARNINGS_LOOKAHEAD_DAYS || 14);
const PROBE = process.env.PROBE === "1";
const RAW_TRUNC = 1500;
const US_TZ = CONFIG.markets_config.US.tz; // America/New_York
const IN_TZ = CONFIG.markets_config.IN.tz; // Asia/Kolkata

// A normal desktop Chrome UA — BSE blocks plain/library user agents.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const pad = (n) => String(n).padStart(2, "0");

// ---- time helpers -------------------------------------------------------

// Local calendar date in a tz, optionally shifted by whole days -> { y, mo, d }.
function localDate(tz, addDays = 0) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value])
  );
  const shifted = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) + addDays * 86400000);
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}
const dashed = ({ y, mo, d }) => `${y}-${pad(mo)}-${pad(d)}`; // 2026-08-06
const compact = ({ y, mo, d }) => `${y}${pad(mo)}${pad(d)}`; //  20260806

// Offset (localWall - utc), in ms, for a tz at a given instant.
function tzOffsetMs(instantMs, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instantMs))
      .map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - instantMs;
}
// Wall-clock time in a tz -> UTC ISO string (DST-correct, two-pass refine).
function wallToUtcIso(y, mo, d, hh, mm, tz) {
  const wallMs = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let utc = wallMs - tzOffsetMs(wallMs, tz);
  utc = wallMs - tzOffsetMs(utc, tz);
  return new Date(utc).toISOString();
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Parse "06 Aug 2026" | "6 Aug 2026" | "2026-08-06" | "06/08/2026" -> { y, mo, d }.
function parseFlexibleDate(s) {
  const t = String(s || "").trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return { y: +m[1], mo: +m[2], d: +m[3] };
  if ((m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mo) throw new Error(`bad month in "${t}"`);
    return { y: +m[3], mo, d: +m[1] };
  }
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return { y: +m[3], mo: +m[2], d: +m[1] };
  throw new Error(`unparseable date "${t}"`);
}

// ---- logging + fetch ----------------------------------------------------

const redact = (u) => u.replace(/(token|api[_-]?key)=[^&]*/gi, "$1=REDACTED");
const warnLoud = (msg) => console.warn(`\n!!!!! ${msg} !!!!!\n`);

// GET with logging + timeout; never throws on HTTP status (caller decides).
async function httpGet(url, { headers = {}, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    console.log(`[http] GET ${redact(url)} -> ${res.status}`);
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}
async function httpPostJson(url, body, { headers = {}, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    console.log(`[http] POST ${redact(url)} -> ${res.status}`);
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---- US: Finnhub --------------------------------------------------------

const FINNHUB_HOUR_TIMING = { bmo: "BMO", amc: "AMC", dmh: "INTRADAY" };
const FINNHUB_ET_TIME = { BMO: [8, 0], AMC: [16, 15], INTRADAY: [12, 0] }; // wall time in ET

// One call to Finnhub's earnings calendar. Returns { events, raw }.
async function fetchUS(fromD, toD) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    console.warn("[skip] US/finnhub: no FINNHUB_API_KEY set");
    return { events: [], raw: null };
  }
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromD}&to=${toD}&token=${key}`;
  const { status, text } = await httpGet(url);

  // Auth / access / rate-limit — log LOUDLY (we can pivot to Yahoo later) and continue.
  if (status === 401 || status === 403 || status === 429) {
    warnLoud(
      `FINNHUB blocked (HTTP ${status}) — US calendar skipped, pivot to Yahoo in a later step. Body: ${text.slice(0, 200)}`
    );
    return { events: [], raw: text };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.warn(`[skip] US/finnhub: non-JSON response: ${e.message}`);
    return { events: [], raw: text };
  }
  if (data && data.error) {
    warnLoud(`FINNHUB error — US calendar skipped. Body: ${text.slice(0, 200)}`);
    return { events: [], raw: text };
  }

  const rows = (data && data.earningsCalendar) || [];
  const events = [];
  for (const r of rows) {
    try {
      if (!r || !r.symbol || !r.date) continue;
      const timing = FINNHUB_HOUR_TIMING[String(r.hour || "").toLowerCase()] || "UNKNOWN";
      const dp = parseFlexibleDate(r.date);
      let dt = null;
      if (timing !== "UNKNOWN") {
        const [hh, mm] = FINNHUB_ET_TIME[timing];
        dt = wallToUtcIso(dp.y, dp.mo, dp.d, hh, mm, US_TZ);
      }
      events.push({
        ticker: r.symbol,
        market: "US",
        company: r.symbol, // TODO(step 3+): enrich with the real company name
        earnings_date: dashed(dp),
        earnings_datetime_utc: dt,
        timing,
        confirmed: true,
        source: "finnhub",
      });
    } catch (e) {
      console.warn(`[skip] US row ${r && r.symbol}: ${e.message}`);
    }
  }
  return { events, raw: text };
}

// ---- India: BSE "Forthcoming Results" ----------------------------------

const BSE_API = "https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w";
const BSE_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/",
};
const BSE_PAGE = "https://www.bseindia.com/corporates/forth_results?expandable=0";

// Normalize one India row to an event. India gives no time, so timing is
// UNKNOWN and the datetime is an approximate 16:00 IST (market close).
function makeInEvent({ code, ticker, company, dateStr }) {
  const dp = parseFlexibleDate(dateStr);
  return {
    ticker,
    market: "IN",
    company: company || ticker,
    bse_code: code || null, // EXTRA field — step 3 maps this to a price symbol
    earnings_date: dashed(dp),
    earnings_datetime_utc: wallToUtcIso(dp.y, dp.mo, dp.d, 16, 0, IN_TZ),
    timing: "UNKNOWN",
    confirmed: true,
    source: "bse:forth_results",
  };
}

// Method A — BSE JSON API (no key). Rows: { scrip_Code, short_name, Long_Name, meeting_date, URL }.
async function fetchIN_api(fromC, toC) {
  const url = `${BSE_API}?fromdate=${fromC}&todate=${toC}&scripcode=`;
  const { ok, status, text } = await httpGet(url, { headers: BSE_HEADERS });
  if (!ok) throw new Error(`BSE API HTTP ${status}`);
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : data.Table || data.Data || [];
  if (!Array.isArray(rows)) throw new Error("BSE API: unexpected shape");
  const events = [];
  for (const r of rows) {
    try {
      events.push(
        makeInEvent({
          code: r.scrip_Code,
          ticker: r.short_name || r.scrip_Code,
          company: r.Long_Name || r.short_name,
          dateStr: r.meeting_date,
        })
      );
    } catch (e) {
      console.warn(`[skip] IN row ${r && (r.short_name || r.scrip_Code)}: ${e.message}`);
    }
  }
  return { events, raw: text, method: "bse:api" };
}

// Parse a markdown table of forthcoming results -> IN events.
// Columns are [Security Code, Security Name, Result Date] in some order.
function parseBseTableCells(rows) {
  const events = [];
  for (const cells of rows) {
    if (cells.length < 3) continue;
    const code = cells.find((c) => /^\d{5,6}$/.test(c));
    const dateCell = cells.find((c) =>
      /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}|^\d{1,2}\/\d{1,2}\/\d{4}|^\d{4}-\d{2}-\d{2}/.test(c)
    );
    if (!code || !dateCell) continue;
    const name = cells.find((c) => c !== code && c !== dateCell && /[A-Za-z]/.test(c));
    if (!name) continue;
    try {
      events.push(makeInEvent({ code, ticker: name, company: name, dateStr: dateCell }));
    } catch {
      /* skip unparseable row */
    }
  }
  return events;
}

// Method B — firecrawl (JS render) -> markdown table (no HTML parser needed).
async function fetchIN_firecrawl() {
  const key = process.env.FIRECRAWL_API_KEY;
  const { ok, status, text } = await httpPostJson(
    "https://api.firecrawl.dev/v1/scrape",
    { url: BSE_PAGE, formats: ["markdown"], waitFor: 6000 },
    { headers: { authorization: `Bearer ${key}` } }
  );
  if (!ok) throw new Error(`firecrawl HTTP ${status}`);
  const md = (JSON.parse(text)?.data?.markdown) || "";
  const rows = md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length)
    );
  return { events: parseBseTableCells(rows), raw: md.slice(0, 4000), method: "firecrawl" };
}

// Method B' — scrape.do (JS render) -> rendered HTML -> regex table rows.
async function fetchIN_scrapedo() {
  const key = process.env.SCRAPEDO_API_KEY;
  const url = `https://api.scrape.do/?token=${key}&url=${encodeURIComponent(BSE_PAGE)}&render=true`;
  const { ok, status, text } = await httpGet(url, { timeoutMs: 60000 });
  if (!ok) throw new Error(`scrape.do HTTP ${status}`);
  const rows = [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) =>
    [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((td) =>
      td[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim()
    )
  );
  return { events: parseBseTableCells(rows), raw: text.slice(0, 4000), method: "scrapedo" };
}

// Try the BSE JSON API first; fall back to a JS-rendering scraper if it's blocked.
async function fetchIN(fromC, toC) {
  try {
    return await fetchIN_api(fromC, toC);
  } catch (e) {
    console.warn(`[warn] BSE API failed (${e.message}); trying scrape fallback...`);
  }
  try {
    if (process.env.FIRECRAWL_API_KEY) return await fetchIN_firecrawl();
    if (process.env.SCRAPEDO_API_KEY) return await fetchIN_scrapedo();
    console.warn("[skip] IN/bse: API blocked and no FIRECRAWL_API_KEY / SCRAPEDO_API_KEY for fallback");
  } catch (e) {
    console.warn(`[skip] IN/bse fallback failed: ${e.message}`);
  }
  return { events: [], raw: null, method: "none" };
}

// ---- orchestration ------------------------------------------------------

function dedupeSort(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = `${e.market}|${e.ticker}|${e.earnings_date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => (a.earnings_date < b.earnings_date ? -1 : a.earnings_date > b.earnings_date ? 1 : 0));
  return out;
}

export async function run() {
  // Market-local windows: today .. today + LOOKAHEAD.
  const usFrom = localDate(US_TZ, 0);
  const usTo = localDate(US_TZ, LOOKAHEAD_DAYS);
  const inFrom = localDate(IN_TZ, 0);
  const inTo = localDate(IN_TZ, LOOKAHEAD_DAYS);

  // US (one call). Never let a failure stop India.
  let us = { events: [], raw: null };
  try {
    us = await fetchUS(dashed(usFrom), dashed(usTo));
  } catch (e) {
    console.warn(`[skip] US/finnhub: ${e.message}`);
  }

  // India (one source; API first, scraper fallback).
  let ind = { events: [], raw: null, method: "none" };
  try {
    ind = await fetchIN(compact(inFrom), compact(inTo));
  } catch (e) {
    console.warn(`[skip] IN/bse: ${e.message}`);
  }

  if (PROBE) {
    console.log("\n===== RAW FINNHUB (calendar) =====");
    console.log(us.raw ? us.raw.slice(0, RAW_TRUNC) : "(no data — set FINNHUB_API_KEY)");
    console.log(`\n===== RAW BSE (forthcoming results)  [method: ${ind.method}] =====`);
    console.log(ind.raw ? String(ind.raw).slice(0, RAW_TRUNC) : "(no data)");
    const events = dedupeSort([...us.events, ...ind.events]);
    console.log(`\n===== PARSED EVENTS (${events.length}: ${us.events.length} US, ${ind.events.length} IN) =====`);
    console.log(JSON.stringify(events.slice(0, 8), null, 2));
    if (events.length > 8) console.log(`... (${events.length - 8} more)`);
    console.log("\n[PROBE] wrote nothing.");
    return { events, probe: true };
  }

  const events = dedupeSort([...us.events, ...ind.events]);
  const fromD = dashed(usFrom) < dashed(inFrom) ? dashed(usFrom) : dashed(inFrom);
  const toD = dashed(usTo) > dashed(inTo) ? dashed(usTo) : dashed(inTo);

  const payload = { generated_at: new Date().toISOString(), count: events.length, events };
  await writeJson("earnings-calendar.json", payload);
  console.log(
    `calendar: ${events.length} events (${us.events.length} US, ${ind.events.length} IN) over ${fromD}..${toD}`
  );
  return payload;
}

// Allow running directly: `node pipeline/steps/01-earnings-calendar.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
