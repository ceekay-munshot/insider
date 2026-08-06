// Step 02 — price fetcher (REAL).
//
// v1 scope: the 1-DAY pre-earnings move only (price vs last session's close).
// Price source is muns FastAPI /stock-data — a single live quote returning
// "Current Price" + "Previous Close" — covering both US + India. muns is
// yfinance-backed, so symbols are yfinance-format and `country` is CAPITALIZED
// ("USA" / "India"):
//   US    -> plain symbol         (AAPL)
//   India -> bare trading symbol  (the calendar's short_name, e.g. ADSL)
//            NOT the bse_code and NOT a .BO/.NS suffix — those 404 on muns.
//
// The 5-day baseline is intentionally deferred for v1. We still write a dated
// snapshot every run, so the 5-day drift can be switched on later purely from
// snapshot history — no new deps. The /market_data (daily OHLC) code is kept
// DORMANT at the bottom of this file for that future use.
//
// muns itself isn't rate-limited, but its yfinance->Yahoo upstream can throttle
// (an HTTP 200 body "Too Many Requests. Rate limited.") — detected and retried
// with exponential backoff. We quote the FULL active set. Fail-soft: one bad
// ticker never crashes the run.
//
// PROBE mode:  `PROBE=1 node pipeline/steps/02-fetch-prices.mjs`
//   Gentle: prints the raw /stock-data response for AAPL [USA] and RELIANCE
//   [India] plus one live calendar name, so the "Current Price"/"Previous
//   Close" fields can be confirmed for both markets. Writes NOTHING.
//
// snapshot reading:
//   { ticker, market, price, prev_close, open, currency, as_of:ISO,
//     source:"muns:stock-data", muns_key_used, muns_symbol }

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const PROBE = process.env.PROBE === "1";
const RAW_TRUNC = 1500;
const FASTAPI = CONFIG.muns.fastapi_base;
const WINDOW_DAYS = CONFIG.step2.window_days;
const RETRIES = CONFIG.step2.muns_retries;
const US_TZ = CONFIG.markets_config.US.tz;
const IN_TZ = CONFIG.markets_config.IN.tz;
// Used only by the DORMANT /market_data path (future 5-day baseline).
const LOOKBACK_DAYS = CONFIG.step2.market_lookback_days;
const DRIFT = CONFIG.windows.driftSessions;
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

// Tolerant number parse (strips thousands commas / stray spaces). null if NaN.
function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// ---- http (muns), with rate-limit-aware retry ---------------------------
// muns signals upstream (Yahoo) throttling as an HTTP 200 body "Too Many
// Requests", so we can't rely on the status code alone. Token rides the
// Authorization header, so it never appears in a logged URL.

const RATE_LIMIT_RE = /too many requests|rate.?limit/i;

async function munsRequest(method, url, body, token, { timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", accept: "application/json", Authorization: `Bearer ${token || ""}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const tag = body && body.ticker_symbol ? ` {${body.ticker_symbol} / ${body.country}}` : "";
    console.log(`[http] ${method} ${url}${tag} -> ${res.status}`);
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function munsRetry(method, url, body, token) {
  const delays = [2000, 4000, 8000, 16000];
  let res;
  for (let i = 0; i <= RETRIES; i++) {
    res = await munsRequest(method, url, body, token);
    const limited = res.status === 429 || res.status >= 500 || RATE_LIMIT_RE.test(res.text);
    if (!limited) return res;
    if (i < RETRIES) {
      const d = delays[Math.min(i, delays.length - 1)];
      console.warn(`[muns] rate-limited; backoff ${d}ms (retry ${i + 1}/${RETRIES})`);
      await sleep(d);
    }
  }
  return res; // exhausted — caller sees no usable quote and skips
}

// ---- /stock-data quote parsing (LIVE) -----------------------------------
// The body is a "key=value" string joined by ",". Split on ",", then the FIRST
// "=", so keys like "Yearly Change (%)" and values like "1299.0 - 1313.2" or
// "-13.82" survive intact.
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

// One /stock-data quote (with backoff). country: "USA" | "India".
async function stockDataQuote(symbol, country, token) {
  const { ok, status, text } = await munsRetry(
    "POST",
    `${FASTAPI}/stock-data`,
    { ticker_symbol: symbol, type: "stockquote", country },
    token
  );
  return { ok, status, text, ...parseQuote(text) };
}

// ---- full run -----------------------------------------------------------

function reading(e, q, currency, muns_key_used, muns_symbol, asOf) {
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
    muns_symbol, // the exact yfinance symbol quoted (step 4 reuses it)
  };
}

// Quote one event. muns is yfinance-backed:
//   US    -> plain symbol    (AAPL)
//   India -> bare short_name (ADSL) — NOT the bse_code, NOT a .BO/.NS suffix
// Returns a reading, or null if no usable Current/Previous Close.
async function quoteForEvent(e, token, asOf) {
  if (e.market === "US") {
    const symbol = e.ticker;
    const q = await stockDataQuote(symbol, "USA", token);
    if (q.price == null || q.prev_close == null) {
      console.warn(`[skip] US ${symbol}: no Current/Previous Close. raw: ${String(q.raw).slice(0, 160)}`);
      return null;
    }
    return reading(e, q, "USD", "ticker", symbol, asOf);
  }
  const symbol = e.ticker; // the calendar's bare short_name is the yfinance symbol muns accepts
  if (!symbol) {
    console.warn(`[skip] IN ${e.company || "?"}: no trading symbol`);
    return null;
  }
  const q = await stockDataQuote(symbol, "India", token);
  if (q.price == null || q.prev_close == null) {
    console.warn(`[skip] IN ${symbol}: no Current/Previous Close. raw: ${String(q.raw).slice(0, 160)}`);
    return null;
  }
  return reading(e, q, "INR", "ticker", symbol, asOf);
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
    console.log("prices: quoted 0 of 0 active (0 failed)");
    return { taken_at: nowISO, readings: [] };
  }

  // Active set: events within [today .. today+WINDOW_DAYS] (market-local),
  // intersected with a non-empty seed_universe, soonest first. No per-run cap.
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
  const readings = [];
  let failed = 0;
  let processed = 0;
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
    await sleep(150); // be gentle on the yfinance upstream
  }

  await writeSnapshot(readings, nowISO);
  console.log(`prices: quoted ${readings.length} of ${totalActive} active (${failed} failed)`);
  return { taken_at: nowISO, readings };
}

// ---- PROBE (confirm /stock-data Current/Previous Close) -------------------

async function probeStockData(symbol, country, label, token) {
  console.log(`\n===== RAW muns /stock-data ${label} [${country}] =====`);
  try {
    const q = await stockDataQuote(symbol, country, token);
    console.log(`(HTTP ${q.status})`);
    console.log(String(q.raw).slice(0, RAW_TRUNC));
    console.log(`parsed -> Current Price=${q.price}, Previous Close=${q.prev_close}, Opening Price=${q.open}`);
    console.log(`clean quote: ${q.price != null && q.prev_close != null ? "YES" : "NO"}`);
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

// One India {ticker, bse_code, company} sample — from the committed calendar if
// present, else a fresh minimal BSE fetch (no key needed).
async function probeInSample() {
  const cal = await readJson("earnings-calendar.json", { events: [] });
  const inEvents = (cal.events || []).filter((e) => e.market === "IN");
  if (inEvents.length) {
    const e = inEvents[0];
    return { ticker: e.ticker, bse_code: e.bse_code, company: e.company };
  }
  console.warn("[probe] committed calendar has no India events; fetching one fresh BSE name...");
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
      const r = (Array.isArray(data) ? data : [])[0];
      return r ? { ticker: r.short_name || r.scrip_Code, bse_code: r.scrip_Code, company: r.Long_Name || r.short_name } : null;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn(`[probe] BSE sample fetch failed: ${e.message}`);
    return null;
  }
}

async function probe(token) {
  if (!token) {
    console.warn("⚠ no MUNS_TOKEN in this environment — muns calls will fail. Run via GitHub Actions (probe=1) with the secret.");
  }
  // US control — plain yfinance symbol, capitalized country.
  await probeStockData("AAPL", "USA", "AAPL", token);
  // India control — the bare trading symbol (NOT the bse_code, NOT a suffix).
  await probeStockData("RELIANCE", "India", "RELIANCE (control)", token);
  // India — a real calendar name as its bare short_name.
  const s = await probeInSample();
  if (s && s.ticker) {
    await probeStockData(s.ticker, "India", `${s.company || s.ticker} "${s.ticker}"`, token);
  } else {
    console.warn("[probe] no calendar India symbol available; skipped calendar name test");
  }

  console.log("\n[PROBE] wrote nothing.");
  return { probe: true };
}

// ======================================================================
// DORMANT — /market_data (daily OHLC) path, kept for the future 5-day
// baseline (v1 ships the 1-day move only). muns returns a truncated text
// preview + saves a full CSV server-side; parseMarketData handles the JSON
// shapes for when a full/JSON series becomes available. Not called by
// run()/probe(). Helpers are exported for unit tests / reuse.
// ======================================================================

// Defensive OHLC parser: top-level array, wrapped { data|results|... }, or an
// object-of-arrays, with common field namings.
export function parseMarketData(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { bars: [], raw: text, note: "non-JSON body" };
  }
  let arr = null;
  if (Array.isArray(j)) {
    arr = j;
  } else if (j && typeof j === "object") {
    for (const key of ["data", "results", "candles", "ohlc", "prices", "history", "bars", "quotes"]) {
      if (Array.isArray(j[key])) {
        arr = j[key];
        break;
      }
    }
    if (!arr) {
      const closeArr = j.close || j.Close || j.c;
      if (Array.isArray(closeArr)) {
        const dates = j.date || j.Date || j.timestamp || j.t || [];
        const opens = j.open || j.Open || j.o || [];
        arr = closeArr.map((c, i) => ({ close: c, date: dates[i], open: opens[i] }));
      }
    }
  }
  if (!Array.isArray(arr)) return { bars: [], raw: text, note: "no bar array found" };
  const pick = (o, keys) => {
    for (const k of keys) if (o != null && o[k] != null) return o[k];
    return null;
  };
  const bars = arr
    .map((o) => ({
      date: pick(o, ["date", "Date", "datetime", "timestamp", "t", "time"]),
      open: num(pick(o, ["open", "Open", "o"])),
      high: num(pick(o, ["high", "High", "h"])),
      low: num(pick(o, ["low", "Low", "l"])),
      close: num(pick(o, ["close", "Close", "c", "adjClose", "Adj Close", "adj_close"])),
      volume: num(pick(o, ["volume", "Volume", "v"])),
    }))
    .filter((b) => b.close != null);
  bars.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
  return { bars, raw: text };
}

// eslint-disable-next-line no-unused-vars
async function quoteViaMarketData(ticker, country, token) {
  const tz = country === "India" ? IN_TZ : US_TZ;
  const end = localDateStr(tz, 0);
  const start = localDateStr(tz, -LOOKBACK_DAYS);
  const url = `${FASTAPI}/market_data?ticker=${encodeURIComponent(ticker)}&start=${start}&end=${end}&interval=1d&country=${country}`;
  const { status, text } = await munsRetry("GET", url, null, token);
  const { bars } = parseMarketData(text);
  if (bars.length < 2) return { ok: false, status, raw: text, bars };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const back = bars[bars.length - 1 - DRIFT] || bars[0];
  return {
    ok: true,
    status,
    price: last.close,
    prev_close: prev.close,
    open: last.open,
    baseline_5d_close: back.close,
    close5_date: back.date,
    bars,
    raw: text,
  };
}

// Allow running directly: `node pipeline/steps/02-fetch-prices.mjs`.
// Guard against argv[1] being undefined (e.g. when imported for testing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
