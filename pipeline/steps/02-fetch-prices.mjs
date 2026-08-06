// Step 02 — price fetcher (REAL).
//
// Quotes live prices for the events nearest their earnings and appends a dated
// snapshot for history. Price source is muns (covers BOTH US + India) via the
// FastAPI /stock-data endpoint (auth: Authorization: Bearer $MUNS_TOKEN).
// Fail-soft throughout: one bad ticker never crashes the run.
//
// PROBE mode:  `PROBE=1 node pipeline/steps/02-fetch-prices.mjs`
//   Makes a small fixed set of calls, prints each raw response + parsed values,
//   and writes NOTHING. Meant to be triggered by a human via GitHub Actions
//   (secrets hold MUNS_TOKEN) so the real response shapes can be confirmed.
//
// snapshot file (snapshots/<taken_at>.json):
//   { taken_at:ISO, readings:[ { ticker, market, price, prev_close, open,
//     currency, as_of:ISO, source:"muns:stock-data", muns_key_used } ] }
// ...and we append { file, taken_at, count } to snapshots/index.json.

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const PROBE = process.env.PROBE === "1";
const RAW_TRUNC = 1500;
const FASTAPI = CONFIG.muns.fastapi_base;
const WINDOW_DAYS = CONFIG.step2.window_days;
const MAX_QUOTES = CONFIG.step2.max_quotes;
const US_TZ = CONFIG.markets_config.US.tz;
const IN_TZ = CONFIG.markets_config.IN.tz;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local calendar date in a tz (optionally shifted) -> "YYYY-MM-DD".
function localDateStr(tz, addDays = 0) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value])
  );
  const s = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) + addDays * 86400000);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

// ---- parsing ------------------------------------------------------------

// muns /stock-data returns a STRING of "key=value" pairs joined by ",".
// Split on ",", then on the FIRST "=" so keys like "Yearly Change (%)" and
// values like "1299.0 - 1313.2" or "-13.82" survive intact.
export function parseKvString(s) {
  const out = {};
  for (const piece of String(s).split(",")) {
    const i = piece.indexOf("=");
    if (i === -1) continue;
    const k = piece.slice(0, i).trim();
    if (k) out[k] = piece.slice(i + 1).trim();
  }
  return out;
}
// Tolerant number parse (strips thousands commas / stray spaces). null if NaN.
function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}
// The body may be the raw string, a JSON-quoted string, or { data|result: "..." }.
function unwrapStockData(text) {
  try {
    const j = JSON.parse(text);
    if (typeof j === "string") return j;
    if (j && typeof j.data === "string") return j.data;
    if (j && typeof j.result === "string") return j.result;
  } catch {
    /* not JSON — it's the raw kv string */
  }
  return text;
}
export function parseQuote(text) {
  const raw = unwrapStockData(text);
  const kv = parseKvString(raw);
  return {
    raw,
    price: num(kv["Current Price"]),
    prev_close: num(kv["Previous Close"]),
    open: num(kv["Opening Price"]),
  };
}

// ---- http (muns) --------------------------------------------------------
// Token rides the Authorization header, so it never appears in a logged URL.

async function munsPost(path, body, token, { timeoutMs = 20000 } = {}) {
  const url = `${FASTAPI}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${token || ""}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    console.log(`[http] POST ${url} { ${body.ticker_symbol} / ${body.country} } -> ${res.status}`);
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}
async function munsGet(url, token, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token || ""}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    console.log(`[http] GET ${url} -> ${res.status}`);
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// One /stock-data quote. country: "usa" | "india".
async function quoteOnce(tickerSymbol, country, token) {
  const { ok, status, text } = await munsPost(
    "/stock-data",
    { ticker_symbol: tickerSymbol, type: "stockquote", country },
    token
  );
  return { ok, status, text, ...parseQuote(text) };
}

// ---- full run -----------------------------------------------------------

function reading(e, q, currency, muns_key_used, asOf) {
  return {
    ticker: e.ticker,
    market: e.market,
    price: q.price,
    prev_close: q.prev_close,
    open: q.open,
    currency,
    as_of: asOf,
    source: "muns:stock-data",
    muns_key_used,
  };
}

// Quote one event. US uses its ticker; India tries ticker then falls back to
// bse_code. Returns a reading, or null if no usable Current/Previous Close.
async function quoteForEvent(e, token, asOf) {
  if (e.market === "US") {
    const q = await quoteOnce(e.ticker, "usa", token);
    if (q.price == null || q.prev_close == null) {
      console.warn(`[skip] US ${e.ticker}: no Current/Previous Close. raw: ${String(q.raw).slice(0, 160)}`);
      return null;
    }
    return reading(e, q, "USD", "ticker", asOf);
  }
  // India: ticker (BSE short name) first, then the numeric bse_code.
  let last = await quoteOnce(e.ticker, "india", token);
  if (last.price != null && last.prev_close != null) return reading(e, last, "INR", "ticker", asOf);
  if (e.bse_code) {
    const byCode = await quoteOnce(String(e.bse_code), "india", token);
    if (byCode.price != null && byCode.prev_close != null) return reading(e, byCode, "INR", "bse_code", asOf);
    last = byCode;
  }
  console.warn(
    `[skip] IN ${e.ticker}${e.bse_code ? `/${e.bse_code}` : ""}: no Current/Previous Close. raw: ${String(last.raw).slice(0, 160)}`
  );
  return null;
}

async function writeSnapshot(readings, takenAt) {
  const file = `snapshots/${takenAt.replace(/[:.]/g, "-")}.json`;
  await writeJson(file, { taken_at: takenAt, readings });
  const index = await readJson("snapshots/index.json", []);
  index.push({ file, taken_at: takenAt, count: readings.length });
  await writeJson("snapshots/index.json", index);
  console.log(`[snapshot] wrote ${file} (${readings.length} readings); index now ${index.length}`);
}

export async function run() {
  const token = process.env.MUNS_TOKEN;
  const nowISO = new Date().toISOString();

  if (PROBE) return probe(token);

  if (!token) {
    console.warn("no MUNS_TOKEN — skipping");
    await writeSnapshot([], nowISO);
    console.log("prices: quoted 0 of 0 active (0 dropped by cap, 0 failed)");
    return { taken_at: nowISO, readings: [] };
  }

  // Active set: events within [today .. today+WINDOW_DAYS] (market-local),
  // intersected with a non-empty seed_universe, soonest first, capped.
  const calendar = await readJson("earnings-calendar.json", { events: [] });
  const floor = { US: localDateStr(US_TZ, 0), IN: localDateStr(IN_TZ, 0) };
  const ceil = { US: localDateStr(US_TZ, WINDOW_DAYS), IN: localDateStr(IN_TZ, WINDOW_DAYS) };

  let active = (calendar.events || []).filter((e) => {
    const f = floor[e.market];
    const c = ceil[e.market];
    if (!f || !(e.earnings_date >= f && e.earnings_date <= c)) return false;
    const seed = CONFIG.seed_universe[e.market] || [];
    return seed.length === 0 || seed.includes(e.ticker);
  });
  active.sort((a, b) => (a.earnings_date < b.earnings_date ? -1 : a.earnings_date > b.earnings_date ? 1 : 0));

  const totalActive = active.length;
  let dropped = 0;
  if (active.length > MAX_QUOTES) {
    dropped = active.length - MAX_QUOTES;
    console.warn(`[cap] dropping ${dropped} of ${totalActive} active events (STEP2_MAX_QUOTES=${MAX_QUOTES})`);
    active = active.slice(0, MAX_QUOTES);
  }

  const readings = [];
  let failed = 0;
  let processed = 0;
  // Sequential + a small delay — be gentle on muns; one bad ticker never crashes.
  for (const e of active) {
    processed++;
    try {
      const r = await quoteForEvent(e, token, nowISO);
      if (r) readings.push(r);
      else failed++;
    } catch (err) {
      failed++;
      console.warn(`[skip] ${e.market} ${e.ticker}: ${err.message}`);
    }
    if (processed % 25 === 0) {
      console.log(`[prices] ${processed}/${active.length} processed (${readings.length} quoted, ${failed} failed)`);
    }
    await sleep(150);
  }

  await writeSnapshot(readings, nowISO);
  console.log(
    `prices: quoted ${readings.length} of ${totalActive} active (${dropped} dropped by cap, ${failed} failed)`
  );
  return { taken_at: nowISO, readings };
}

// ---- PROBE --------------------------------------------------------------

async function probeStockData(sym, country, token, label) {
  console.log(`\n===== RAW muns /stock-data ${label} =====`);
  try {
    const q = await quoteOnce(sym, country, token);
    console.log(`(HTTP ${q.status})`);
    console.log(String(q.raw).slice(0, RAW_TRUNC));
    console.log(`parsed -> Current Price=${q.price}, Previous Close=${q.prev_close}, Opening Price=${q.open}`);
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

async function probeKeyTest(sample, form, symbol, token) {
  console.log(`\n===== India KEY TEST: ${sample.company || sample.ticker} via ${form}="${symbol}" =====`);
  try {
    const q = await quoteOnce(String(symbol), "india", token);
    console.log(`(HTTP ${q.status})`);
    console.log(String(q.raw).slice(0, RAW_TRUNC));
    console.log(`Current Price found: ${q.price != null ? `YES (${q.price})` : "NO"}`);
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

async function probeMarketData(ticker, country, token) {
  const end = localDateStr(US_TZ, 0);
  const start = localDateStr(US_TZ, -10);
  const url = `${FASTAPI}/market_data?ticker=${encodeURIComponent(ticker)}&start=${start}&end=${end}&interval=1d&country=${country}`;
  console.log(`\n===== RAW muns /market_data ${ticker} 1d =====`);
  try {
    const { status, text } = await munsGet(url, token);
    console.log(`(HTTP ${status})`);
    console.log(String(text).slice(0, RAW_TRUNC));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

// Get 3 India {ticker, bse_code, company} samples for the KEY TEST — from the
// committed calendar if present, else a fresh minimal BSE fetch (no key needed).
async function probeInSamples() {
  const cal = await readJson("earnings-calendar.json", { events: [] });
  const inEvents = (cal.events || []).filter((e) => e.market === "IN");
  if (inEvents.length >= 3) {
    return inEvents.slice(0, 3).map((e) => ({ ticker: e.ticker, bse_code: e.bse_code, company: e.company }));
  }
  console.warn("[probe] committed calendar has <3 India events; fetching a few fresh BSE names for the KEY TEST...");
  try {
    const from = localDateStr(IN_TZ, 0).replace(/-/g, "");
    const to = localDateStr(IN_TZ, WINDOW_DAYS).replace(/-/g, "");
    const url = `https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w?fromdate=${from}&todate=${to}&scripcode=`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", Origin: "https://www.bseindia.com", Referer: "https://www.bseindia.com/" },
        signal: ctrl.signal,
      });
      const data = await res.json();
      return (Array.isArray(data) ? data : []).slice(0, 3).map((r) => ({
        ticker: r.short_name || r.scrip_Code,
        bse_code: r.scrip_Code,
        company: r.Long_Name || r.short_name,
      }));
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn(`[probe] BSE sample fetch failed: ${e.message}; India KEY TEST skipped`);
    return [];
  }
}

async function probe(token) {
  if (!token) {
    console.warn("⚠ no MUNS_TOKEN in this environment — muns calls will 401. Run via GitHub Actions (probe=1) with the secret to see real data.");
  }
  // US + India controls.
  await probeStockData("AAPL", "usa", token, "AAPL (usa)");
  await probeStockData("RELIANCE", "india", token, "RELIANCE (india)");

  // India KEY TEST — does muns accept the calendar's BSE identifiers?
  const samples = await probeInSamples();
  for (const s of samples) {
    await probeKeyTest(s, "ticker", s.ticker, token);
    await probeKeyTest(s, "bse_code", s.bse_code, token);
  }

  // History endpoint shape (step 4 owns the 5-day baseline; just confirm shape).
  await probeMarketData("AAPL", "USA", token);

  console.log("\n[PROBE] wrote nothing.");
  return { probe: true };
}

// Allow running directly: `node pipeline/steps/02-fetch-prices.mjs`.
// Guard against argv[1] being undefined (e.g. when imported for testing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
