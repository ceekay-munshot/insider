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
// Data: past result dates — India from BSE board-meeting OUTCOMES, US from
// Finnhub (needs FINNHUB_API_KEY). Prices + surprises from Yahoo. Fail-soft: a
// name we can't price is skipped, never fatal.

import { pathToFileURL } from "node:url";
import { writeJson } from "./lib/io.mjs";
import { dailyCloses, quoteSummary } from "./lib/yahoo.mjs";

const START_DAYS = Number(process.env.STUDY_START_DAYS || 60); // oldest event ~this many days back
const END_DAYS = Number(process.env.STUDY_END_DAYS || 12); // newest event ~this many days back (so +7d elapsed)
const MAX_EVENTS = Number(process.env.STUDY_MAX_EVENTS || 400); // per market cap
const BEATMISS = process.env.STUDY_BEATMISS !== "0"; // real Yahoo surprise (best-effort)
const YH_SLEEP = Number(process.env.STUDY_YH_SLEEP_MS || 120);
const BSE_PAGES = Number(process.env.STUDY_BSE_PAGES || 70);

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

// India: past board-meeting OUTCOMES over the last [startDays..endDays] ago.
// BSE caps any single query at ~31 days, so we walk the window in 28-day chunks.
// Stops once we have `cap` candidates. -> [{market,ticker,company,earnings_date,symbol}]
async function indiaEvents(startDays, endDays, cap) {
  const ANN = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
  const headers = { "User-Agent": UA, Accept: "application/json, text/plain, */*", Origin: "https://www.bseindia.com", Referer: "https://www.bseindia.com/" };
  const seen = new Map();
  const CHUNK = 28;
  for (let newer = endDays; newer < startDays && seen.size < cap; newer += CHUNK) {
    const older = Math.min(startDays, newer + CHUNK);
    const from = dayShift(-older).compact; // older calendar date
    const to = dayShift(-newer).compact; // newer calendar date
    for (let page = 1; page <= BSE_PAGES && seen.size < cap; page++) {
      const url = `${ANN}?pageno=${page}&strCat=Board%20Meeting&strPrevDate=${from}&strScrip=&strSearch=P&strToDate=${to}&strType=C&subcategory=-1`;
      const json = await fetchJson(url, headers);
      const rows = (json && Array.isArray(json.Table) && json.Table) || [];
      if (rows.length === 0) break;
      for (const a of rows) {
        if (!a || !/outcome/i.test(String(a.NEWSSUB || ""))) continue;
        const code = String(a.SCRIP_CD || "").trim();
        if (!code || seen.has(code)) continue;
        const m = String(a.NEWS_DT || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) continue;
        const company = String(a.NEWSSUB || "").split(" - ")[0].trim();
        seen.set(code, { market: "IN", ticker: code, company, earnings_date: `${m[1]}-${m[2]}-${m[3]}`, symbol: `${code}.BO` });
      }
      const total = json && json.Table1 && json.Table1[0] && json.Table1[0].ROWCNT;
      if (typeof total === "number" && page * 50 >= total) break;
      await sleep(160);
    }
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
  let iE = -1;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i].date === earnings_date) { iE = i; break; }
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
        const rec = { ...e, runup: mv.runup, ret1: mv.ret1, ret3: mv.ret3, market_cap: null, surprise_pct: null, beat: null };
        if (BEATMISS) {
          // one quoteSummary call -> market cap (for the size filter) + real beat/miss
          const qs = await quoteSummary(e.symbol).catch(() => ({ marketCap: null, surprises: [] }));
          rec.market_cap = qs.marketCap;
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

  console.log("[backtest] sourcing India events (BSE outcomes, 28-day chunks)…");
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
