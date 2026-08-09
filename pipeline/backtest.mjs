// backtest.mjs — the STUDY: does a pre-earnings run-up predict a post-earnings rise?
//
// Client's question, verbatim:
//   "Average gain in next 1 / 3 / 7 days if a stock rose >X% (variable) in the
//    1 / 3 / 7 days before earnings — and how often. If 70 names rose 2% before
//    and ~80% also rose after, it's a beautiful algo." Also study FALLS (down),
//    and whether the result actually beat/missed.
//
// Standalone (NOT in the 30-min radar). Writes public/data/study.json.
//
// Method, per past earnings event (report far enough back that +7 days elapsed):
//   d0        = last trading close BEFORE the earnings date (pre-earnings ref)
//   pre[N]    = % change over the N trading days INTO d0        (the run-up)
//   post[N]   = % change from d0 to N trading days AFTER earnings (the payoff)
// Aggregate by (market, pre-window W, direction, threshold X):
//   cohort    = events with pre[W] > X (up)  or  pre[W] < -X (down)
//   hit_pct   = % of cohort whose post[P] continued the same way
//   avg_pct   = average post[P] of the cohort
// beat/miss: real analyst surprise from Yahoo when available (STUDY_BEATMISS),
//   else the price reaction (post[1] sign) is the market's verdict.
//
// Data: past earnings dates — India from BSE board-meeting OUTCOMES, US from
// Finnhub (needs FINNHUB_API_KEY). Prices + surprises from Yahoo. Fail-soft: a
// name we can't price is skipped, never fatal.

import { pathToFileURL } from "node:url";
import { writeJson } from "./lib/io.mjs";
import { dailyCloses, earningsSurprises } from "./lib/yahoo.mjs";

const WINDOWS = [1, 3, 7];
const THRESHOLDS = [0, 2, 3, 5, 10];
const DIRS = ["up", "down"];

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

function movesFor(closes, earnings_date) {
  // d0 = last close strictly BEFORE the earnings date
  let d0 = -1;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i].date < earnings_date) d0 = i;
    else break;
  }
  const maxW = Math.max(...WINDOWS);
  if (d0 < maxW || d0 + maxW >= closes.length) return null; // not enough surrounding data
  const base = closes[d0].close;
  const pre = {}, post = {};
  for (const N of WINDOWS) {
    const preRef = closes[d0 - N].close;
    const postRef = closes[d0 + N].close;
    if (!preRef || !base || !postRef) return null;
    pre[N] = round2((base / preRef - 1) * 100);
    post[N] = round2((postRef / base - 1) * 100);
  }
  return { pre, post };
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
        const rec = { ...e, pre: mv.pre, post: mv.post, reaction_up: mv.post[1] > 0, surprise_pct: null, beat: null };
        if (BEATMISS) {
          const surprises = await earningsSurprises(e.symbol).catch(() => []);
          const s = matchSurprise(surprises, e.earnings_date);
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

function mean(a) { return a.length ? round2(a.reduce((x, y) => x + y, 0) / a.length) : null; }

function cellsFor(records) {
  const cells = [];
  for (const W of WINDOWS) {
    for (const dir of DIRS) {
      for (const X of THRESHOLDS) {
        const cohort = records.filter((r) => (dir === "up" ? r.pre[W] > X : r.pre[W] < -X));
        const post = {};
        for (const P of WINDOWS) {
          const vals = cohort.map((r) => r.post[P]);
          const cont = cohort.filter((r) => (dir === "up" ? r.post[P] > 0 : r.post[P] < 0)).length;
          post[P] = { hit_pct: cohort.length ? Math.round((100 * cont) / cohort.length) : null, avg_pct: mean(vals) };
        }
        const withBeat = cohort.filter((r) => r.beat != null);
        const beatN = withBeat.filter((r) => r.beat).length;
        cells.push({
          pre_window: W, direction: dir, threshold: X, n: cohort.length, post,
          beat_rate: withBeat.length ? Math.round((100 * beatN) / withBeat.length) : null,
          beat_sample: withBeat.length,
        });
      }
    }
  }
  return cells;
}

function summarize(records, market) {
  const withSurprise = records.filter((r) => r.beat != null).length;
  return {
    events_analyzed: records.length,
    beatmiss_available: withSurprise,
    cells: cellsFor(records),
    // a small sample (biggest 3-day run-ups) for display / sanity
    sample: records
      .slice()
      .sort((a, b) => b.pre[3] - a.pre[3])
      .slice(0, 20)
      .map((r) => ({ market: r.market, ticker: r.ticker, company: r.company, earnings_date: r.earnings_date, pre3: r.pre[3], post3: r.post[3], post7: r.post[7], surprise_pct: r.surprise_pct })),
  };
}

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

  const payload = {
    generated_at: new Date().toISOString(),
    lookback: { from: from.dashed, to: to.dashed },
    windows: WINDOWS,
    thresholds: THRESHOLDS,
    directions: DIRS,
    markets: {
      IN: summarize(inRec, "IN"),
      US: summarize(usRec, "US"),
      ALL: summarize(allRec, "ALL"),
    },
  };
  const path = await writeJson("study.json", payload);
  console.log(`[backtest] wrote ${path}`);
  console.log(`[backtest] analyzed IN=${inRec.length} US=${usRec.length} ALL=${allRec.length}`);
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
