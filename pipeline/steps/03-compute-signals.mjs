// Step 03 — compute movement signals (the signal engine).
//
// CLIENT REQUIREMENT implemented here, verbatim:
//   "Track a stock's movement UP TILL 30 MINUTES BEFORE its earnings, measured
//    vs the LAST SESSION CLOSE / same day; if it moves 3%+ UP, flag it (→ alert).
//    US and India both. Thesis: money moves before the news, more after."
//
// We join the earnings calendar with the latest price snapshot and, per name,
// compute the 1-day move (price vs prev_close). A name may be FLAGGED only while
// it is still more than `cutoff_minutes_before_earnings` (30) minutes from its
// earnings — that 30-minute cutoff is what "up till 30 min before" means. Flags
// are sticky (fire once, never un-flag); the pre-earnings move is frozen at the
// cutoff so a later step can compare pre- vs post-earnings drift.
//
// We track the 1-day move only (price vs last session's close). Fail-soft: a
// calendar name with no fresh reading is carried forward as `stale` rather than
// dropped, and one bad record never aborts the run.
//
// signal shape:
//   { ticker, market, company, earnings_date, earnings_datetime_utc, timing,
//     earnings_time_confirmed, timing_source, concall_datetime_utc, concall_title,
//     concall_url, eps_yoy_pct, minutes_to_earnings, price, currency,
//     baseline_prev_close, change_1d_pct, peak_change_1d_pct, peak_at,
//     move_at_cutoff_pct, flagged, flag_reason, first_flagged_at, last_updated,
//     status, stale }

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";
import { minutesToEarnings } from "../lib/market.mjs";
import { CONFIG } from "../../config.mjs";

const THRESH = CONFIG.threshold_up_pct; // 3 — flag an UP move ≥ this %
const CUT_MIN = CONFIG.cutoff_minutes_before_earnings; // 30
const CUT_MS = CUT_MIN * 60000;

const key = (market, ticker) => `${market}::${ticker}`;

// ---- small numeric helpers ----------------------------------------------

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}
const round2 = (n) => Math.round(n * 100) / 100;
// "+3.5" / "-4" — the signed move for a human-readable flag reason.
const signed = (n) => (n >= 0 ? "+" : "") + round2(n);
// max of two possibly-null numbers (null if both null).
function maxOrNull(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return a > b ? a : b;
}

// ---- earnings-instant + status ------------------------------------------
// The precise earnings timestamp is `earnings_datetime_utc` when present.
// India corp results often lack a time, so we approximate from `earnings_date`
// at the market's local CLOSE — enough to advance status through the day and
// never crash. `minutes_to_earnings` stays null in that case (see below).

// UTC offset (ms) of `tz` at a given UTC instant, via Intl round-trip.
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - utcMs;
}
// Wall-clock (y-mo-d h:mi) in `tz` -> UTC ms. One refine pass handles DST edges.
function zonedTimeToUtcMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMs(guess, tz);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

// Effective earnings instant for an event/signal (both carry the same fields).
// { ms:number|null, approx:bool }. approx=true means derived from date-only.
function effectiveEarnings(ev) {
  if (ev && ev.earnings_datetime_utc) {
    const t = Date.parse(ev.earnings_datetime_utc);
    if (!Number.isNaN(t)) return { ms: t, approx: false };
  }
  if (ev && typeof ev.earnings_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ev.earnings_date)) {
    const cfg = CONFIG.markets_config[ev.market];
    const tz = cfg ? cfg.tz : "UTC";
    const close = cfg ? cfg.close : "23:59";
    const [y, mo, d] = ev.earnings_date.split("-").map(Number);
    const [h, mi] = close.split(":").map(Number);
    return { ms: zonedTimeToUtcMs(y, mo, d, h, mi, tz), approx: true };
  }
  return { ms: null, approx: false };
}

// pre_earnings | cutoff_passed | reported, from the effective instant.
//   pre_earnings  -> before the 30-min cutoff (still tracking; flags may fire)
//   cutoff_passed -> within 30 min of earnings, OR past it but NOT yet confirmed
//   reported      -> past the earnings instant AND results are confirmed out
// "reported" requires hard confirmation (resultsConfirmed) so we never claim a
// name reported just because a placeholder end-of-day time slipped past — an
// unconfirmed name past its (assumed) time stays "cutoff_passed" until we see it.
// Unknown time -> pre_earnings (keep tracking; never crash).
function statusFor(earnMs, nowMs, resultsConfirmed) {
  if (earnMs == null) return "pre_earnings";
  if (nowMs >= earnMs) return resultsConfirmed ? "reported" : "cutoff_passed";
  if (nowMs >= earnMs - CUT_MS) return "cutoff_passed";
  return "pre_earnings";
}

// ---- per-name signal -----------------------------------------------------
// Handles both a fresh reading and the carry-forward (stale) case. `prior` is
// the same name's signal from the previous run, holding the sticky state
// (first_flagged_at, flagged, peak, move_at_cutoff_pct).
function buildSignal(event, reading, prior, now) {
  const nowMs = now.getTime();
  const nowISO = now.toISOString();
  const fresh = !!reading;

  const { ms: earnMs } = effectiveEarnings(event);
  // "reported" only with hard proof results are out:
  //   India -> we captured the actual outcome filing (timing_source "bse:outcome")
  //   US    -> Finnhub's confirmed release timing (best signal we have for US)
  // Anything else (intimation estimate, end-of-day placeholder) past its time
  // stays "cutoff_passed" until the filing is actually seen.
  const resultsConfirmed =
    event.timing_source === "bse:outcome" ||
    (event.market === "US" && !!event.timing && event.timing !== "UNKNOWN");
  const status = statusFor(earnMs, nowMs, resultsConfirmed);
  const minutes_to_earnings = minutesToEarnings(event, now); // null if no precise time

  // price + the client's move (vs LAST SESSION CLOSE = reading.prev_close).
  let price = null;
  let currency = null;
  let baseline_prev_close = null;
  let change_1d_pct = null;
  let market_cap = null;
  if (fresh) {
    price = numOrNull(reading.price);
    currency = reading.currency ?? null;
    baseline_prev_close = numOrNull(reading.prev_close);
    market_cap = numOrNull(reading.market_cap);
    if (price != null && baseline_prev_close != null && baseline_prev_close !== 0) {
      change_1d_pct = round2(((price - baseline_prev_close) / baseline_prev_close) * 100);
    }
  } else if (prior) {
    // No reading this run — carry the last known values forward (stale).
    price = prior.price ?? null;
    currency = prior.currency ?? null;
    baseline_prev_close = prior.baseline_prev_close ?? null;
    change_1d_pct = prior.change_1d_pct ?? null;
    market_cap = prior.market_cap ?? null;
  }

  // peak: max UP move seen WHILE pre_earnings (sticky, from fresh readings only).
  let peak = prior?.peak_change_1d_pct ?? null;
  let peak_at = prior?.peak_at ?? null;
  if (fresh && status === "pre_earnings" && change_1d_pct != null) {
    if (peak == null || change_1d_pct > peak) {
      peak = change_1d_pct;
      peak_at = nowISO;
    }
  }

  // The move we test against the threshold: the best UP reading so far.
  const candidate = maxOrNull(change_1d_pct, peak);

  // flag: sticky-true; a NEW flag may only be set while pre_earnings (this is
  // what enforces "up till 30 min before" — a name first seen inside the cutoff
  // can never newly flag).
  let flagged = prior?.flagged === true;
  let first_flagged_at = prior?.first_flagged_at ?? null;
  let flag_reason = prior?.flag_reason ?? null;
  if (!flagged && status === "pre_earnings" && candidate != null && candidate >= THRESH) {
    flagged = true;
    first_flagged_at = nowISO;
    flag_reason = `1d ${signed(candidate)}% ≥ ${THRESH}% up (flagged pre-earnings)`;
  }

  // Freeze the pre-earnings move at the cutoff: the LAST known pre_earnings
  // change_1d (prior's, else the current one). Set once, when it leaves
  // pre_earnings, so step 9 can compare pre- vs post-earnings.
  let move_at_cutoff_pct = prior?.move_at_cutoff_pct ?? null;
  if (move_at_cutoff_pct == null && status !== "pre_earnings") {
    const lastPre = prior && prior.change_1d_pct != null ? prior.change_1d_pct : change_1d_pct;
    move_at_cutoff_pct = lastPre != null ? round2(lastPre) : null;
  }

  return {
    ticker: event.ticker,
    market: event.market,
    company: event.company ?? null,
    earnings_date: event.earnings_date ?? null,
    earnings_datetime_utc: event.earnings_datetime_utc ?? null,
    timing: event.timing ?? null,
    // True only when earnings_datetime_utc is a REAL published timestamp (India
    // outcome filings / scheduled intimations), not a bucket placeholder. The
    // dashboard uses this to show an actual clock time vs. just BMO/AMC.
    earnings_time_confirmed: event.earnings_time_confirmed === true,
    timing_source: event.timing_source ?? null,
    // concall.in enrichment (step 01c): the SCHEDULED concall time (shown as an
    // upcoming time + countdown until the real filing time is known), plus EPS YoY.
    concall_datetime_utc: event.concall_datetime_utc ?? null,
    concall_title: event.concall_title ?? null,
    concall_url: event.concall_url ?? null,
    eps_yoy_pct: event.eps_yoy_pct ?? null,
    minutes_to_earnings,
    price,
    market_cap,
    currency,
    baseline_prev_close,
    change_1d_pct,
    peak_change_1d_pct: peak != null ? round2(peak) : null,
    peak_at,
    move_at_cutoff_pct,
    flagged,
    flag_reason,
    first_flagged_at,
    last_updated: nowISO,
    status,
    stale: !fresh,
  };
}

// ---- join + compute (pure; unit-tested with synthetic inputs) ------------
// events   — earnings-calendar events (the universe)
// readings — latest snapshot readings
// prior    — previous signals.json signals (sticky state)
// now      — Date (injected so this is deterministic under test)
export function computeSignals({ events = [], readings = [], prior = [], now = new Date() }) {
  const nowD = now instanceof Date ? now : new Date(now);

  const readingByKey = new Map();
  for (const r of readings) {
    if (r && r.ticker && r.market) readingByKey.set(key(r.market, r.ticker), r);
  }
  const priorByKey = new Map();
  for (const p of prior) {
    if (p && p.ticker && p.market) priorByKey.set(key(p.market, p.ticker), p);
  }

  // Calendar drives the universe; dedupe by key, keeping the soonest earnings.
  const eventByKey = new Map();
  for (const e of events) {
    if (!e || !e.ticker || !e.market) continue;
    const k = key(e.market, e.ticker);
    const prev = eventByKey.get(k);
    if (!prev) {
      eventByKey.set(k, e);
      continue;
    }
    const a = effectiveEarnings(prev).ms ?? Infinity;
    const b = effectiveEarnings(e).ms ?? Infinity;
    if (b < a) eventByKey.set(k, e);
  }

  const signals = [];
  for (const [k, e] of eventByKey) {
    try {
      signals.push(buildSignal(e, readingByKey.get(k) || null, priorByKey.get(k) || null, nowD));
    } catch (err) {
      // One bad record never aborts the run; carry a prior forward if we have one.
      console.warn(`[skip] ${e.market} ${e.ticker}: ${err.message}`);
      const priorSig = priorByKey.get(k);
      if (priorSig) signals.push({ ...priorSig, stale: true, last_updated: nowD.toISOString() });
    }
  }

  // Sort: flagged first, then soonest earnings, then ticker for stability.
  signals.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    const am = effectiveEarnings(a).ms ?? Infinity;
    const bm = effectiveEarnings(b).ms ?? Infinity;
    if (am !== bm) return am - bm;
    return String(a.ticker).localeCompare(String(b.ticker));
  });

  const counts = {
    tracked: signals.length,
    flagged: signals.filter((s) => s.flagged).length,
    flaggedUS: signals.filter((s) => s.flagged && s.market === "US").length,
    flaggedIN: signals.filter((s) => s.flagged && s.market === "IN").length,
    pastCutoff: signals.filter((s) => s.status !== "pre_earnings").length,
  };
  return { signals, counts };
}

// ---- full run ------------------------------------------------------------

// Newest snapshot's readings (or [] if none / unreadable).
async function latestReadings() {
  const index = await readJson("snapshots/index.json", []);
  if (!Array.isArray(index) || index.length === 0) return [];
  const newest = index.reduce((a, b) => (String(a.taken_at) >= String(b.taken_at) ? a : b));
  const snap = (await readJson(newest.file, { readings: [] })) || { readings: [] };
  return Array.isArray(snap.readings) ? snap.readings : [];
}

export async function run() {
  const now = new Date();

  const calendar = await readJson("earnings-calendar.json", { events: [] });
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const readings = await latestReadings();
  const priorDoc = await readJson("signals.json", { signals: [] });
  const prior = Array.isArray(priorDoc.signals) ? priorDoc.signals : [];

  const { signals, counts } = computeSignals({ events, readings, prior, now });

  const payload = { generated_at: now.toISOString(), count: signals.length, signals };
  const path = await writeJson("signals.json", payload);
  console.log(`[03-compute-signals] wrote ${path}`);
  console.log(
    `signals: ${counts.tracked} tracked, ${counts.flagged} flagged ` +
      `(${counts.flaggedUS} US, ${counts.flaggedIN} IN), ${counts.pastCutoff} past-cutoff`
  );
  return payload;
}

// Allow running directly: `node pipeline/steps/03-compute-signals.mjs`.
// Guard against argv[1] being undefined (e.g. when imported for testing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
