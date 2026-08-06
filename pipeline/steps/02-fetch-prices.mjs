// Step 02 — price fetcher (REAL), multi-source with fallback.
//
// v1 scope: the 1-DAY pre-earnings move only (price vs last session's close).
// We price ONLY the same-day / next-day reporters (CONFIG.step2.window_days,
// default 1). Keeping the set tight is what makes intraday runs fast AND avoids
// hammering muns's yfinance→Yahoo upstream into throttling — which, under load,
// surfaces as HTTP 404 "Stock quote data not found" for real, liquid names
// (EAT, PFGC, IBRX…), not just dead tickers.
//
// Per name, quote is resolved as a source chain (fail-soft, stop at first hit):
//   1. muns FastAPI /stock-data  — "Current Price" + "Previous Close". yfinance-
//      backed, so country is CAPITALIZED ("USA"/"India"); US = plain symbol
//      (AAPL); India = bare short_name (ADSL), NOT the bse_code, NOT a .BO/.NS
//      suffix. A 404 "not found" is often a throttle-induced empty, so we give
//      muns ONE cheap re-try before falling back.
//   2. fallback, by market:
//        US    -> Finnhub /quote      (c/pc/o; needs FINNHUB_API_KEY)
//        India -> TradingView scanner (NSE:<sym> then BSE:<sym>; prev = close-change; no key)
// The reading records which `source` actually answered.
//
// muns's explicit throttle (an HTTP 200 body "Too Many Requests. Rate limited.")
// is still detected and retried with exponential backoff. The 5-day baseline is
// deferred; each run still writes a dated snapshot so it can be switched on later
// with no new deps. The /market_data (daily OHLC) code is kept DORMANT below.
//
// PROBE mode:  `PROBE=1 node pipeline/steps/02-fetch-prices.mjs`
//   Gentle: prints muns /stock-data for AAPL [USA] + RELIANCE [India] + one live
//   calendar name, AND exercises both fallbacks (Finnhub AAPL, TradingView
//   RELIANCE) so all three sources can be confirmed. Writes NOTHING.
//
// snapshot reading:
//   { ticker, market, price, prev_close, open, currency, as_of:ISO,
//     source:"muns:stock-data"|"finnhub:quote"|"tradingview:scan", provider_symbol }

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const PROBE = process.env.PROBE === "1";
const RAW_TRUNC = 1500;
const FASTAPI = CONFIG.muns.fastapi_base;
const FINNHUB = CONFIG.finnhub.base;
const TV_SCANNER = CONFIG.tradingview.scanner_base;
const WINDOW_DAYS = CONFIG.step2.window_days;
const RETRIES = CONFIG.step2.muns_retries;
const NF_DELAY_MS = 1200; // one cheap re-try delay for a muns 404 "not found"
const US_TZ = CONFIG.markets_config.US.tz;
const IN_TZ = CONFIG.markets_config.IN.tz;
// Used only by the DORMANT /market_data path (future 5-day baseline).
const LOOKBACK_DAYS = CONFIG.step2.market_lookback_days;
const DRIFT = CONFIG.windows.driftSessions;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round4 = (n) => Math.round(n * 10000) / 10000;

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

// ---- http helpers -------------------------------------------------------
// muns signals upstream (Yahoo) throttling as an HTTP 200 body "Too Many
// Requests", so we can't rely on the status code alone. Token rides the
// Authorization header, so it never appears in a logged URL.

const RATE_LIMIT_RE = /too many requests|rate.?limit/i;
const NOT_FOUND_RE = /not found|no data|no such/i;

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
  return res; // exhausted — caller sees no usable quote and falls back
}

// Generic text fetch (fallback sources). Never throws to the caller loop.
async function fetchText(url, { method = "GET", headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---- source 1: muns /stock-data -----------------------------------------
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

// One /stock-data quote (with rate-limit backoff). country: "USA" | "India".
async function stockDataQuote(symbol, country, token) {
  const { ok, status, text } = await munsRetry(
    "POST",
    `${FASTAPI}/stock-data`,
    { ticker_symbol: symbol, type: "stockquote", country },
    token
  );
  return { ok, status, text, ...parseQuote(text) };
}

// muns quote + ONE cheap re-try when it 404s "not found" — those are often a
// throttle-induced empty for a name that really exists, and a moment later it
// answers. A genuinely dead ticker just misses twice and we fall back.
async function munsQuote(symbol, country, token) {
  let q = await stockDataQuote(symbol, country, token);
  const missing = q.price == null || q.prev_close == null;
  if (missing && (q.status === 404 || NOT_FOUND_RE.test(String(q.raw)))) {
    await sleep(NF_DELAY_MS);
    q = await stockDataQuote(symbol, country, token);
  }
  return q;
}

// ---- source 2a: Finnhub /quote (US fallback) ----------------------------
// Returns { c: current, pc: previous close, o: open, ... }. Unknown symbols
// come back as c=0,pc=0 — treated as no data.
async function finnhubQuote(symbol, apiKey) {
  if (!apiKey) return { price: null, prev_close: null, open: null, status: 0, note: "no FINNHUB_API_KEY" };
  try {
    const { status, text } = await fetchText(
      `${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
      { headers: { accept: "application/json" } }
    );
    let j = {};
    try { j = JSON.parse(text); } catch { /* leave j empty */ }
    const price = num(j.c);
    const prev_close = num(j.pc);
    const open = num(j.o);
    const dead = price === 0 && prev_close === 0; // Finnhub's "unknown symbol" shape
    return { price: dead ? null : price, prev_close: dead ? null : prev_close, open: dead ? null : open, status };
  } catch (e) {
    return { price: null, prev_close: null, open: null, status: 0, note: e.message };
  }
}

// ---- source 2b: TradingView scanner (India fallback) --------------------
// POST india/scan with [NSE:<sym>, BSE:<sym>]; row.d = [close, change_abs].
// previous close = close - change_abs. Prefer the NSE row (more liquid).
async function tradingViewIndiaQuote(shortName) {
  const nse = `NSE:${shortName}`;
  const bse = `BSE:${shortName}`;
  const body = { symbols: { tickers: [nse, bse], query: { types: [] } }, columns: ["close", "change_abs"] };
  try {
    const { status, text } = await fetchText(`${TV_SCANNER}/india/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json", "User-Agent": UA },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = JSON.parse(text); } catch { /* leave j empty */ }
    const rows = Array.isArray(j.data) ? j.data : [];
    const row = rows.find((r) => r.s === nse) || rows.find((r) => r.s === bse) || rows[0];
    if (!row || !Array.isArray(row.d)) return { price: null, prev_close: null, open: null, status };
    const close = num(row.d[0]);
    const changeAbs = num(row.d[1]);
    const prev_close = close != null && changeAbs != null ? round4(close - changeAbs) : null;
    return { price: close, prev_close, open: null, status, matched_symbol: row.s };
  } catch (e) {
    return { price: null, prev_close: null, open: null, status: 0, note: e.message };
  }
}

// ---- full run -----------------------------------------------------------

function reading(e, q, currency, source, provider_symbol, asOf) {
  return {
    ticker: e.ticker,
    market: e.market,
    price: q.price,
    prev_close: q.prev_close,
    open: q.open ?? null,
    currency,
    as_of: asOf,
    source, // which provider actually answered
    provider_symbol, // the exact symbol quoted (step 4 can reuse it)
  };
}

// Quote one event through the source chain. Returns a reading, or null if no
// source has a usable Current/Previous Close.
async function quoteForEvent(e, token, keys, asOf) {
  const isUS = e.market === "US";
  const country = isUS ? "USA" : "India";
  const currency = isUS ? "USD" : "INR";
  const symbol = e.ticker; // bare short_name for India; plain symbol for US
  if (!symbol) {
    console.warn(`[skip] ${e.market} ${e.company || "?"}: no trading symbol`);
    return null;
  }

  // 1) muns primary (rate-limit backoff + one 404/not-found re-try).
  const q = await munsQuote(symbol, country, token);
  if (q.price != null && q.prev_close != null) {
    return reading(e, q, currency, "muns:stock-data", symbol, asOf);
  }

  // 2) fallback, by market.
  if (isUS) {
    const f = await finnhubQuote(symbol, keys.finnhub);
    console.log(`[fallback] finnhub ${symbol} -> ${f.price != null ? "hit" : "miss"}`);
    if (f.price != null && f.prev_close != null) {
      return reading(e, f, currency, "finnhub:quote", symbol, asOf);
    }
  } else {
    const t = await tradingViewIndiaQuote(symbol);
    console.log(`[fallback] tradingview ${symbol} -> ${t.price != null ? `hit (${t.matched_symbol})` : "miss"}`);
    if (t.price != null && t.prev_close != null) {
      return reading(e, t, currency, "tradingview:scan", t.matched_symbol || symbol, asOf);
    }
  }

  console.warn(`[skip] ${e.market} ${symbol}: no quote from muns or fallback. muns: ${String(q.raw).slice(0, 120)}`);
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
  const keys = { finnhub: process.env.FINNHUB_API_KEY };
  const nowISO = new Date().toISOString();

  if (PROBE) return probe(token, keys);

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
      const r = await quoteForEvent(e, token, keys, nowISO);
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

  const bySource = {};
  for (const r of readings) bySource[r.source] = (bySource[r.source] || 0) + 1;
  const tally = Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(" ") || "none";

  await writeSnapshot(readings, nowISO);
  console.log(`prices: quoted ${readings.length} of ${totalActive} active (${failed} failed) [${tally}]`);
  return { taken_at: nowISO, readings };
}

// ---- PROBE (confirm all three sources) -----------------------------------

async function probeStockData(symbol, country, label, token) {
  console.log(`\n===== muns /stock-data ${label} [${country}] =====`);
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

async function probeFinnhub(symbol, apiKey) {
  console.log(`\n===== FALLBACK Finnhub /quote ${symbol} [USA] =====`);
  if (!apiKey) {
    console.warn("no FINNHUB_API_KEY — skipping (set it in the Actions secrets to test)");
    return;
  }
  const f = await finnhubQuote(symbol, apiKey);
  console.log(`(HTTP ${f.status}) price=${f.price}, prev_close=${f.prev_close}, open=${f.open}`);
  console.log(`clean quote: ${f.price != null && f.prev_close != null ? "YES" : "NO"}`);
}

async function probeTradingView(shortName) {
  console.log(`\n===== FALLBACK TradingView scan ${shortName} [India] =====`);
  const t = await tradingViewIndiaQuote(shortName);
  console.log(`(HTTP ${t.status}) matched=${t.matched_symbol || "-"} price=${t.price}, prev_close=${t.prev_close}`);
  console.log(`clean quote: ${t.price != null && t.prev_close != null ? "YES" : "NO"}`);
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

async function probe(token, keys) {
  if (!token) {
    console.warn("⚠ no MUNS_TOKEN in this environment — muns calls will fail. Run via GitHub Actions (probe=1) with the secret.");
  }
  // --- Source 1: muns /stock-data ---
  await probeStockData("AAPL", "USA", "AAPL", token);
  await probeStockData("RELIANCE", "India", "RELIANCE (control)", token);
  const s = await probeInSample();
  if (s && s.ticker) {
    await probeStockData(s.ticker, "India", `${s.company || s.ticker} "${s.ticker}"`, token);
  } else {
    console.warn("[probe] no calendar India symbol available; skipped calendar name test");
  }

  // --- Source 2: fallbacks (US=Finnhub, India=TradingView) ---
  await probeFinnhub("AAPL", keys && keys.finnhub);
  await probeTradingView("RELIANCE");
  if (s && s.ticker) await probeTradingView(s.ticker);

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
