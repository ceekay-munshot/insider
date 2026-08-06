// Step 02 — price fetcher (REAL).
//
// Price source is muns FastAPI /market_data (daily OHLC), the SINGLE source for
// both US + India. From the daily series we derive, per ticker:
//   price             = latest bar close
//   prev_close        = previous bar close
//   baseline_5d_close = close ~driftSessions (5) sessions back
// (step 4 turns these into change_1d_pct / change_5d_pct + flags.)
//
// muns is yfinance-backed, so symbols must be yfinance-format and `country` is
// CAPITALIZED ("India" / "USA"):
//   US    -> plain symbol      (AAPL)
//   India -> "<bse_code>.BO"   (BSE; the BSE short name is NOT a valid symbol)
//
// muns itself isn't rate-limited, but its yfinance->Yahoo upstream can throttle
// (an HTTP 200 body "Too Many Requests. Rate limited.") — we detect that (and
// 429/5xx) and back off exponentially. We quote the FULL active set. Fail-soft:
// one bad ticker never crashes the run.
//
// The older /stock-data quote path is kept DORMANT at the bottom of this file as
// a lighter live-quote fallback (its request params are now known-good).
//
// PROBE mode:  `PROBE=1 node pipeline/steps/02-fetch-prices.mjs`
//   Gentle: prints the raw /market_data for AAPL (USA) plus India ticker-format
//   controls (RELIANCE.NS, 500325.BO, and one calendar "<bse_code>.BO") so the
//   OHLC field names and the working India symbol format can be locked. Writes NOTHING.
//
// snapshot reading:
//   { ticker, market, price, prev_close, open, baseline_5d_close, close_5d_date,
//     currency, as_of:ISO, source:"muns:market_data", interval:"1d",
//     muns_key_used, muns_symbol }

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const PROBE = process.env.PROBE === "1";
const RAW_TRUNC = 1500;
const FASTAPI = CONFIG.muns.fastapi_base;
const WINDOW_DAYS = CONFIG.step2.window_days;
const LOOKBACK_DAYS = CONFIG.step2.market_lookback_days;
const RETRIES = CONFIG.step2.muns_retries;
const DRIFT = CONFIG.windows.driftSessions; // 5 sessions back
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

// Tolerant number parse (strips thousands commas / stray spaces). null if NaN.
function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// muns's /market_data country value is capitalized ("USA" | "India").
const munsCountry = (market) => (market === "IN" ? "India" : "USA");

// ---- http (muns), with rate-limit-aware retry ---------------------------
// muns signals throttling as an HTTP 200 whose body says "Too Many Requests",
// so we can't rely on the status code alone. Token rides the Authorization
// header, so it never appears in a logged URL.

const RATE_LIMIT_RE = /too many requests|rate.?limit/i;

async function munsGet(url, token, { timeoutMs = 25000 } = {}) {
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

async function munsGetRetry(url, token) {
  const delays = [2000, 4000, 8000, 16000];
  let res;
  for (let i = 0; i <= RETRIES; i++) {
    res = await munsGet(url, token);
    const limited = res.status === 429 || res.status >= 500 || RATE_LIMIT_RE.test(res.text);
    if (!limited) return res;
    if (i < RETRIES) {
      const d = delays[Math.min(i, delays.length - 1)];
      console.warn(`[muns] rate-limited; backoff ${d}ms (retry ${i + 1}/${RETRIES})`);
      await sleep(d);
    }
  }
  return res; // exhausted — caller sees no usable bars and skips
}

// ---- /market_data parsing (DEFENSIVE — field names locked via PROBE) -----
// Handles the common shapes: a top-level array of bars, a wrapped
// { data|results|candles|... : [...] }, or an object-of-arrays { close:[], date:[] }.
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
  // Ascending by date so the last bar is the most recent.
  bars.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
  return { bars, raw: text };
}

// ---- full run -----------------------------------------------------------

// Fetch the daily series for one ticker and derive latest/prev/5-back closes.
async function quoteViaMarketData(ticker, country, token) {
  const tz = country === "India" ? IN_TZ : US_TZ;
  const end = localDateStr(tz, 0);
  const start = localDateStr(tz, -LOOKBACK_DAYS);
  const url = `${FASTAPI}/market_data?ticker=${encodeURIComponent(ticker)}&start=${start}&end=${end}&interval=1d&country=${country}`;
  const { status, text } = await munsGetRetry(url, token);
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
    as_of_bar: last.date,
    bars,
    raw: text,
  };
}

function reading(e, q, currency, muns_key_used, muns_symbol, asOf) {
  return {
    ticker: e.ticker,
    market: e.market,
    price: q.price,
    prev_close: q.prev_close,
    open: q.open,
    baseline_5d_close: q.baseline_5d_close,
    close_5d_date: q.close5_date,
    currency,
    as_of: asOf,
    source: "muns:market_data",
    interval: "1d",
    muns_key_used,
    muns_symbol, // the exact yfinance symbol quoted (step 4 reuses it)
  };
}

// Quote one event. muns is yfinance-backed, so symbols must be yfinance-format:
//   US    -> plain symbol (AAPL)
//   India -> "<bse_code>.BO" (BSE); the BSE short name is NOT a valid symbol.
// Returns a reading, or null if no usable daily series.
async function quoteForEvent(e, token, asOf) {
  if (e.market === "US") {
    const symbol = e.ticker;
    const q = await quoteViaMarketData(symbol, "USA", token);
    if (!q.ok) {
      console.warn(`[skip] US ${symbol}: no usable bars. raw: ${String(q.raw).slice(0, 160)}`);
      return null;
    }
    return reading(e, q, "USD", "ticker", symbol, asOf);
  }
  if (!e.bse_code) {
    console.warn(`[skip] IN ${e.ticker}: no bse_code to build a .BO symbol`);
    return null;
  }
  const symbol = `${e.bse_code}.BO`;
  const q = await quoteViaMarketData(symbol, "India", token);
  if (!q.ok) {
    console.warn(`[skip] IN ${e.ticker} (${symbol}): no usable bars. raw: ${String(q.raw).slice(0, 160)}`);
    return null;
  }
  return reading(e, q, "INR", "bse_code.BO", symbol, asOf);
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

  // No per-run cap — quote the full active set (muns confirmed no server-side limit).
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
    await sleep(150); // be gentle
  }

  await writeSnapshot(readings, nowISO);
  console.log(`prices: quoted ${readings.length} of ${totalActive} active (${failed} failed)`);
  return { taken_at: nowISO, readings };
}

// ---- PROBE (gentle: lock OHLC field names + India identifier) -------------

async function probeMarketData(ticker, country, label, token, trunc, lookbackDays) {
  const tz = country === "India" ? IN_TZ : US_TZ;
  const end = localDateStr(tz, 0);
  const start = localDateStr(tz, -lookbackDays);
  const url = `${FASTAPI}/market_data?ticker=${encodeURIComponent(ticker)}&start=${start}&end=${end}&interval=1d&country=${country}`;
  console.log(`\n===== RAW muns /market_data ${label} [${country}] =====`);
  try {
    const { status, text } = await munsGetRetry(url, token);
    console.log(`(HTTP ${status})`);
    console.log(String(text).slice(0, trunc));
    const { bars, note } = parseMarketData(text);
    if (note) console.log(`parsed: ${note}`);
    console.log(`clean OHLC series: ${bars.length >= 2 ? `YES (${bars.length} bars)` : "NO"}`);
    if (bars.length) {
      console.log("last bar:", JSON.stringify(bars[bars.length - 1]));
      const back = bars[bars.length - 1 - DRIFT] || bars[0];
      const prev = bars.length >= 2 ? bars[bars.length - 2].close : null;
      console.log(`derived -> price=${bars[bars.length - 1].close}, prev_close=${prev}, ~${DRIFT}d_close=${back.close} @ ${back.date}`);
    }
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
  console.warn("[probe] committed calendar has no India events; fetching one fresh BSE name for the identifier test...");
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
  const LB = 10; // ~10 days of daily bars — enough to see the OHLC shape

  // US control — plain yfinance symbol, capitalized country. Locks field names.
  await probeMarketData("AAPL", "USA", "AAPL", token, 2200, LB);

  // India — lock the yfinance ticker format (.BO = BSE, .NS = NSE).
  await probeMarketData("RELIANCE.NS", "India", "RELIANCE.NS (NSE control)", token, RAW_TRUNC, LB);
  await probeMarketData("500325.BO", "India", "Reliance 500325.BO (BSE-code control)", token, RAW_TRUNC, LB);
  const s = await probeInSample();
  if (s && s.bse_code) {
    await probeMarketData(`${s.bse_code}.BO`, "India", `${s.company || s.ticker} calendar "${s.bse_code}.BO"`, token, RAW_TRUNC, LB);
  } else {
    console.warn("[probe] no calendar India bse_code available; skipped calendar .BO test");
  }

  console.log("\n[PROBE] wrote nothing.");
  return { probe: true };
}

// ======================================================================
// DORMANT — /stock-data live-quote path, kept as a lighter fallback (not wired
// into run()/probe() yet). Request params are now known-good: CAPITALIZED
// country ("India"/"USA") and yfinance-format tickers (US = plain symbol,
// India = "<bse_code>.BO"), same as /market_data. The earlier 404s were from
// lowercase country + the BSE short name. Helpers are exported for tests/reuse.
// ======================================================================

// Parse a "key=value" string (split on ",", then the FIRST "=").
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
function unwrapStockData(text) {
  try {
    const j = JSON.parse(text);
    if (typeof j === "string") return j;
    if (j && typeof j.data === "string") return j.data;
    if (j && typeof j.result === "string") return j.result;
  } catch {
    /* not JSON — raw kv string */
  }
  return text;
}
export function parseQuote(text) {
  const raw = unwrapStockData(text);
  const kv = parseKvString(raw);
  return { raw, price: num(kv["Current Price"]), prev_close: num(kv["Previous Close"]), open: num(kv["Opening Price"]) };
}
// eslint-disable-next-line no-unused-vars
async function stockDataQuote(tickerSymbol, country, token) {
  const url = `${FASTAPI}/stock-data`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json", Authorization: `Bearer ${token || ""}` },
      body: JSON.stringify({ ticker_symbol: tickerSymbol, type: "stockquote", country }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, ...parseQuote(text) };
  } finally {
    clearTimeout(timer);
  }
}

// Allow running directly: `node pipeline/steps/02-fetch-prices.mjs`.
// Guard against argv[1] being undefined (e.g. when imported for testing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
