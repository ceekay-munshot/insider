// backtest.mjs — the STUDY: if a stock runs up on its result day, does it keep
// running afterward?
//
// The idea: results come out after close (~5pm, AMC), so the stock's own move on
// the result day is the pre-result run-up — if that's big (>X%), someone likely
// knew. You'd enter at the result-day close. The study asks: how often, and how
// much, did those names keep rising the next day and over the next 3 days.
//
// Standalone (NOT in the 30-min radar). Writes public/data/study.json.
//
// Method, per past earnings event (E = the result day; far enough back that +3
// trading days have elapsed):
//   runup = close[E]   / close[E-1] - 1   same-day pre-result move → the trigger
//   ret1  = close[E+1] / close[E]   - 1   next-day return
//   ret3  = close[E+3] / close[E]   - 1   3-day total return
// The dashboard aggregates the flat records live: cohort = runup > X (or < -X);
//   win = ret1 > 0 (kept running next day); strict win = ret1 > 0 AND ret3 > 0.
// beat/miss: real analyst surprise from Yahoo where an estimate exists.
//
// Data: past result dates — India = top liquid names by market cap + their last
// earnings date from TradingView (real, tradable companies; market cap free);
// US = Finnhub (needs FINNHUB_API_KEY). Prices + beat/miss from Yahoo. Rolling:
// each run re-sources the window, so newly-reported names flow in automatically.
// Fail-soft: a name we can't price is skipped, never fatal.

import { pathToFileURL } from "node:url";
import { writeJson } from "./lib/io.mjs";
import { dailyCloses, quoteSummary } from "./lib/yahoo.mjs";

const START_DAYS = Number(process.env.STUDY_START_DAYS || 180); // oldest event ~this many days back (6 months)
const END_DAYS = Number(process.env.STUDY_END_DAYS || 5); // newest event ~this many days back (so +3d has settled → rolling/live)
const MAX_EVENTS = Number(process.env.STUDY_MAX_EVENTS || 800); // per market
const BEATMISS = process.env.STUDY_BEATMISS !== "0"; // real Yahoo surprise (best-effort)
const YH_SLEEP = Number(process.env.STUDY_YH_SLEEP_MS || 120);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const round2 = (n) => Math.round(n * 100) / 100;

// today (UTC) shifted by whole days -> {dashed, compact}
function dayShift(delta) {
  const t = new Date(Date.now() + delta * 86400000);
  const y = t.getUTCFullYear(), mo = pad(t.getUTCMonth() + 1), d = pad(t.getUTCDate());
  return { dashed: `${y}-${mo}-${d}`, compact: `${y}${mo}${d}` };
}

async function fetchJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- event sourcing ------------------------------------------------------

// India (LIQUID): the top names by market cap, each with its last earnings date,
// straight from TradingView — so the study is real, tradable companies (Reliance,
// HDFC, TCS…) instead of the BSE micro-cap tail. Market cap comes free here.
// Keeps names whose last result fell in [endDays..startDays] ago (one event each,
// the most recent quarter). -> [{market,ticker,company,earnings_date,symbol,market_cap}]
async function indiaEvents(startDays, endDays, cap) {
  const body = {
    columns: ["name", "description", "market_cap_basic", "earnings_release_date"],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [0, Math.max(2 * cap, 1500)],
  };
  let data = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch("https://scanner.tradingview.com/india/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json", "User-Agent": UA },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = await res.json();
    data = Array.isArray(j.data) ? j.data : [];
  } catch (e) {
    console.warn(`[backtest] India (TradingView) failed: ${e.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
  const now = Math.floor(Date.now() / 1000);
  const seen = new Map();
  for (const r of data) {
    if (!r || !r.s || !r.s.startsWith("NSE:") || !Array.isArray(r.d)) continue;
    const name = r.d[0], desc = r.d[1], mcap = r.d[2], ed = r.d[3];
    if (!name || seen.has(name) || !ed) continue;
    const daysAgo = Math.round((now - ed) / 86400);
    if (daysAgo < endDays || daysAgo > startDays) continue; // result too new (not settled) or too old
    const edate = new Date(ed * 1000).toISOString().slice(0, 10);
    seen.set(name, { market: "IN", ticker: name, company: desc, earnings_date: edate, symbol: `${name}.NS`, market_cap: typeof mcap === "number" ? mcap : null });
    if (seen.size >= cap) break;
  }
  return [...seen.values()];
}

// US: past earnings from Finnhub over [from,to] (needs key) -> events (symbol = ticker)
async function usEvents(fromD, toD) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    console.warn("[backtest] US skipped — no FINNHUB_API_KEY");
    return [];
  }
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromD}&to=${toD}&token=${key}`;
  const json = await fetchJson(url, { "User-Agent": UA });
  const rows = (json && json.earningsCalendar) || [];
  const seen = new Map();
  for (const r of rows) {
    if (!r || !r.symbol || !r.date) continue;
    if (seen.has(r.symbol)) continue;
    seen.set(r.symbol, { market: "US", ticker: r.symbol, company: r.symbol, earnings_date: r.date, symbol: r.symbol });
  }
  return [...seen.values()];
}

// ---- per-event moves -----------------------------------------------------

// Anchor on the RESULT-DAY close (E). Results are after-close (AMC), so E's own
// daytime move is the pre-result run-up (the entry signal), and returns are
// measured forward from E's close.
//   runup = close[E]   / close[E-1] - 1   (same-day pre-result move → trigger)
//   ret1  = close[E+1] / close[E]   - 1   (next-day return)
//   ret3  = close[E+3] / close[E]   - 1   (3-day total return)
function movesFor(closes, earnings_date) {
  // last trading close on/before the result day (handles holidays / tz slippage)
  let iE = -1;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i].date <= earnings_date) iE = i;
    else break;
  }
  if (iE < 1 || iE + 3 >= closes.length) return null; // need E-1 .. E+3
  const cP = closes[iE - 1].close, cE = closes[iE].close, c1 = closes[iE + 1].close, c3 = closes[iE + 3].close;
  if (!cP || !cE || !c1 || !c3) return null;
  return {
    runup: round2((cE / cP - 1) * 100),
    ret1: round2((c1 / cE - 1) * 100),
    ret3: round2((c3 / cE - 1) * 100),
  };
}

// nearest surprise to the earnings date (within ~45 days) -> {surprise_pct, beat} | null
function matchSurprise(surprises, earnings_date) {
  const t = Date.parse(earnings_date + "T00:00:00Z");
  let best = null, bestGap = Infinity;
  for (const s of surprises) {
    if (!s.date || s.surprise_pct == null) continue;
    const gap = Math.abs(Date.parse(s.date + "T00:00:00Z") - t);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  if (!best || bestGap > 45 * 86400000) return null;
  return { surprise_pct: round2(best.surprise_pct), beat: best.surprise_pct > 0 };
}

async function enrich(events, maxPriced) {
  const out = [];
  let done = 0;
  for (const e of events) {
    if (maxPriced && out.length >= maxPriced) break; // enough priced — stop early
    done++;
    const closes = await dailyCloses(e.symbol, "6mo");
    if (closes.length >= 20) {
      const mv = movesFor(closes, e.earnings_date);
      if (mv) {
        const rec = { ...e, runup: mv.runup, ret1: mv.ret1, ret3: mv.ret3, market_cap: e.market_cap != null ? e.market_cap : null, surprise_pct: null, beat: null };
        if (BEATMISS) {
          // one quoteSummary call -> real beat/miss (+ market cap when we don't already have it)
          const qs = await quoteSummary(e.symbol).catch(() => ({ marketCap: null, surprises: [] }));
          if (rec.market_cap == null) rec.market_cap = qs.marketCap;
          const s = matchSurprise(qs.surprises, e.earnings_date);
          if (s) { rec.surprise_pct = s.surprise_pct; rec.beat = s.beat; }
          await sleep(YH_SLEEP);
        }
        out.push(rec);
      }
    }
    if (done % 50 === 0) console.log(`[backtest] priced ${out.length}/${done} (${e.market})`);
    await sleep(YH_SLEEP);
  }
  return out;
}

// ---- aggregation ---------------------------------------------------------

// ---- run -----------------------------------------------------------------

export async function run() {
  const from = dayShift(-START_DAYS), to = dayShift(-END_DAYS);
  console.log(`[backtest] window ${from.dashed} .. ${to.dashed} | max ${MAX_EVENTS}/market | beat-miss ${BEATMISS ? "on" : "off"}`);

  const CAND = MAX_EVENTS * 2; // collect extra; ~half won't price cleanly

  console.log("[backtest] sourcing India events (top liquid names via TradingView)…");
  const inEv = await indiaEvents(START_DAYS, END_DAYS, CAND);
  console.log(`[backtest] India candidates: ${inEv.length}`);

  console.log("[backtest] sourcing US events (Finnhub)…");
  let usEv = await usEvents(from.dashed, to.dashed);
  console.log(`[backtest] US candidates: ${usEv.length}`);
  if (usEv.length > CAND) usEv = usEv.slice(0, CAND);

  console.log("[backtest] pricing India via Yahoo…");
  const inRec = await enrich(inEv, MAX_EVENTS);
  console.log("[backtest] pricing US via Yahoo…");
  const usRec = await enrich(usEv, MAX_EVENTS);
  const allRec = inRec.concat(usRec);

  // Flat per-event records; the dashboard aggregates them live (so it can filter
  // by market cap / threshold / direction without a re-run).
  const trim = (r) => ({
    market: r.market, ticker: r.ticker, company: r.company, earnings_date: r.earnings_date,
    runup: r.runup, ret1: r.ret1, ret3: r.ret3,
    market_cap: r.market_cap, currency: r.market === "IN" ? "INR" : "USD",
    surprise_pct: r.surprise_pct, beat: r.beat,
  });
  const payload = {
    generated_at: new Date().toISOString(),
    lookback: { from: from.dashed, to: to.dashed },
    counts: { IN: inRec.length, US: usRec.length },
    records: allRec.map(trim),
  };
  const path = await writeJson("study.json", payload);
  // sanity: IN, ran up >3% on the result day -> % with a positive NEXT-day return
  const co = inRec.filter((r) => r.runup > 3);
  const win = co.filter((r) => r.ret1 > 0).length;
  console.log(`[backtest] wrote ${path}`);
  console.log(`[backtest] analyzed IN=${inRec.length} US=${usRec.length}` + (co.length ? ` | IN ran>3% same-day: n=${co.length}, next-day win ${Math.round((100 * win) / co.length)}%` : ""));
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
