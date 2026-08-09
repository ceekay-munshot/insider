// Step 02 — price fetcher (REAL), multi-source with fallback.
//
// v1 scope: the 1-DAY pre-earnings move only (price vs last session's close).
// We price ONLY the same-day / next-day reporters (CONFIG.step2.window_days,
// default 1). Keeping the set tight is what makes intraday runs fast AND avoids
// hammering muns's yfinance→Yahoo upstream into throttling — which, under load,
// surfaces as HTTP 404 "Stock quote data not found" for real, liquid names
// (EAT, PFGC, IBRX…), not just dead tickers.
//
// TradingView's scanner is a BULK endpoint (native exchange data, no key), so it
// LEADS both markets — one POST prices hundreds of names in seconds. Per-market
// fallbacks fill only the names it misses (fail-soft, first hit wins; the reading
// records which `source` answered):
//   US    -> TradingView (NASDAQ:/NYSE:/AMEX:<sym>) -> Finnhub /quote -> muns
//   India -> TradingView (NSE:/BSE:<sym>)           -> muns
// prev_close = close - change_abs (TradingView). Fallbacks: Finnhub is the
// official US /quote (c/pc/o; FINNHUB_API_KEY) but its 60/min free tier makes it
// a targeted backup, not a primary; muns (/stock-data, yfinance→Yahoo, country
// CAPITALIZED, US=plain symbol / India=bare short_name) 404s ~2/3 of India names
// under load, so it's last for India. muns keeps its one 404-not-found re-try.
//
// muns's explicit throttle (an HTTP 200 body "Too Many Requests. Rate limited.")
// is still detected and retried with exponential backoff. Each run writes a dated
// price snapshot to public/data/snapshots for history.
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

// ---- source 2b: TradingView scanner (BULK; primary for both markets) -----
// The scanner prices a LIST of EXCHANGE:SYMBOL tickers in one POST; row.d =
// [close, change_abs] per matched symbol, so prev_close = close - change_abs.
// Each name is sent under every plausible exchange prefix; we take the first
// that resolves (India prefers NSE; US tries NASDAQ/NYSE/AMEX).
const TV_MARKETS = {
  US: { path: "america", prefixes: ["NASDAQ", "NYSE", "AMEX"], currency: "USD" },
  IN: { path: "india", prefixes: ["NSE", "BSE"], currency: "INR" },
};
const TV_BULK_BATCH = 250; // names per scanner call

// Returns Map<short_name, { price, prev_close, open, matched_symbol }>.
async function tradingViewBulk(market, names) {
  const cfg = TV_MARKETS[market];
  const out = new Map();
  const uniq = [...new Set((names || []).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += TV_BULK_BATCH) {
    const chunk = uniq.slice(i, i + TV_BULK_BATCH);
    const tickers = [];
    for (const n of chunk) for (const p of cfg.prefixes) tickers.push(`${p}:${n}`);
    const body = { symbols: { tickers, query: { types: [] } }, columns: ["close", "change_abs", "market_cap_basic"] };
    try {
      const { status, text } = await fetchText(`${TV_SCANNER}/${cfg.path}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json", "User-Agent": UA },
        body: JSON.stringify(body),
        timeoutMs: 30000,
      });
      let j = {};
      try { j = JSON.parse(text); } catch { /* leave j empty */ }
      const rows = Array.isArray(j.data) ? j.data : [];
      console.log(`[tv-bulk] ${market} batch ${Math.floor(i / TV_BULK_BATCH) + 1}: ${chunk.length} names -> ${rows.length} rows (HTTP ${status})`);
      const bySym = new Map();
      for (const r of rows) if (r && r.s && Array.isArray(r.d)) bySym.set(r.s, r.d);
      for (const n of chunk) {
        let matched = null;
        let d = null;
        for (const p of cfg.prefixes) {
          const dd = bySym.get(`${p}:${n}`);
          if (dd) { matched = `${p}:${n}`; d = dd; break; }
        }
        if (!d) continue;
        const close = num(d[0]);
        const chg = num(d[1]);
        const market_cap = num(d[2]);
        const prev_close = close != null && chg != null ? round4(close - chg) : null;
        if (close != null && prev_close != null) {
          out.set(n, { price: close, prev_close, open: null, market_cap, matched_symbol: matched });
        }
      }
    } catch (e) {
      console.warn(`[tv-bulk] ${market} batch failed: ${e.message}`);
    }
    await sleep(300); // gentle between batches
  }
  return out;
}

// ---- full run -----------------------------------------------------------

function reading(e, q, currency, source, provider_symbol, asOf) {
  return {
    ticker: e.ticker,
    market: e.market,
    price: q.price,
    prev_close: q.prev_close,
    open: q.open ?? null,
    market_cap: q.market_cap ?? null,
    currency,
    as_of: asOf,
    source, // which provider actually answered
    provider_symbol, // the exact symbol quoted (step 4 can reuse it)
  };
}

// Fallback for a name TradingView didn't return. US -> Finnhub (official) then
// muns; India -> muns (Yahoo is weakest for India, so it's the last resort).
async function fallbackQuote(market, e, token, keys, asOf) {
  const sym = e.ticker;
  if (market === "US") {
    const f = await finnhubQuote(sym, keys.finnhub);
    console.log(`[fallback] finnhub ${sym} -> ${f.price != null ? "hit" : "miss"}`);
    if (f.price != null && f.prev_close != null) return reading(e, f, "USD", "finnhub:quote", sym, asOf);
    const q = await munsQuote(sym, "USA", token);
    if (q.price != null && q.prev_close != null) return reading(e, q, "USD", "muns:stock-data", sym, asOf);
    console.warn(`[skip] US ${sym}: TradingView + Finnhub + muns all missed`);
    return null;
  }
  const q = await munsQuote(sym, "India", token);
  if (q.price != null && q.prev_close != null) return reading(e, q, "INR", "muns:stock-data", sym, asOf);
  console.warn(`[skip] IN ${sym}: TradingView miss + muns ${String(q.raw).slice(0, 80)}`);
  return null;
}

// Price one market: one bulk TradingView sweep, then per-name fallback for the
// (few) names it didn't return.
async function priceMarket(market, events, token, keys, asOf) {
  const readings = [];
  let failed = 0;
  if (!events.length) return { readings, failed };

  const tv = await tradingViewBulk(market, events.map((e) => e.ticker));
  console.log(`[prices ${market}] TradingView returned ${tv.size} of ${events.length} names; fallback covers the rest`);

  let processed = 0;
  for (const e of events) {
    processed++;
    try {
      const hit = tv.get(e.ticker);
      if (hit) {
        readings.push(reading(e, hit, TV_MARKETS[market].currency, "tradingview:scan", hit.matched_symbol, asOf));
      } else if (!e.ticker) {
        console.warn(`[skip] ${market} ${e.company || "?"}: no trading symbol`);
        failed++;
      } else {
        const r = await fallbackQuote(market, e, token, keys, asOf);
        if (r) readings.push(r);
        else failed++;
        await sleep(150); // fallback only — gentle on the per-name upstreams
      }
    } catch (err) {
      failed++;
      console.warn(`[skip] ${market} ${e.ticker}: ${err.message}`);
    }
    if (processed % 50 === 0) {
      console.log(`[prices ${market}] ${processed}/${events.length} resolved (${readings.length} quoted, ${failed} failed)`);
    }
  }
  return { readings, failed };
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

  // MUNS_TOKEN doubles as the "secrets are present / real Actions run" signal.
  // Absent locally -> skip so committed data stays pristine (TradingView is
  // keyless and drives real runs in CI, where the token is set).
  if (!token) {
    console.warn("no MUNS_TOKEN — skipping (treat as a non-Actions run; secrets live in CI)");
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

  // TradingView leads both markets (one bulk sweep each); fallbacks fill misses.
  for (const [market, evs] of [
    ["IN", active.filter((e) => e.market === "IN")],
    ["US", active.filter((e) => e.market === "US")],
  ]) {
    const res = await priceMarket(market, evs, token, keys, nowISO);
    readings.push(...res.readings);
    failed += res.failed;
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

async function probeTradingView(market, shortName) {
  console.log(`\n===== TradingView scan ${shortName} [${market}] (primary) =====`);
  const m = await tradingViewBulk(market, [shortName]);
  const t = m.get(shortName);
  if (t) console.log(`matched=${t.matched_symbol} price=${t.price}, prev_close=${t.prev_close}`);
  console.log(`clean quote: ${t ? "YES" : "NO"}`);
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
    console.warn("note: no MUNS_TOKEN here — muns is only the fallback now, so the TradingView primaries below still work.");
  }
  // --- Primary: TradingView scanner (bulk), both markets ---
  await probeTradingView("US", "AAPL");
  await probeTradingView("IN", "RELIANCE");
  const s = await probeInSample();
  if (s && s.ticker) await probeTradingView("IN", s.ticker);
  else console.warn("[probe] no calendar India symbol available; skipped calendar name test");

  // --- Fallbacks: US = Finnhub then muns; India = muns ---
  await probeFinnhub("AAPL", keys && keys.finnhub);
  await probeStockData("AAPL", "USA", "AAPL (muns fallback)", token);
  await probeStockData("RELIANCE", "India", "RELIANCE (muns fallback)", token);

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
