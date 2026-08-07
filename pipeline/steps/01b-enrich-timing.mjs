// Step 01b — enrich India earnings timing with the REAL announcement time.
//
// BSE's "forthcoming results" feed (step 1) gives only a DATE — no time — so
// India events land with timing "UNKNOWN" and a flat 16:00 IST placeholder.
// This step fills a real time from two BSE sources, in priority order:
//
//   1. Board Meeting OUTCOME (filed when results drop) carries an exact
//      timestamp NEWS_DT -> the true time, e.g. 12:41 IST INTRADAY, 19:01 AMC,
//      before 09:15 BMO. One BULK paginated fetch of today's outcomes, indexed
//      by scrip. Exact + structured; overrides any estimate below.
//   2. Board Meeting INTIMATION (filed days ahead) states only a date in ~4 of 5
//      cases, but ~1 in 5 also give the scheduled hour inside the attached PDF
//      ("...held on <date> at 4:00 pm..."). For FLAGGED names only (a handful,
//      from the prior run's signals) we open that PDF and read the time — so we
//      fetch only a few PDFs, and each name is checked ONCE (hit or miss cached).
//
// Honest by design: a time appears only when actually published; otherwise the
// name stays UNKNOWN (the dashboard shows "—"). Resolutions persist in
// timing-cache.json, accumulating ground-truth times for a later backtest.
// Fully fail-soft: BSE throttle, a missing PDF reader, or an unreadable PDF just
// means "no time this run" — never a crash.
//
// PDF text needs a reader (PyMuPDF via pipeline/lib/pdf-text.py); if python3 or
// the lib is absent, the intimation path silently no-ops.
//
// PROBE mode:  `PROBE=1 node pipeline/steps/01b-enrich-timing.mjs`
//   Prints today's outcomes + how many committed India names they'd resolve, and
//   demos the intimation-PDF time path on one scrip. Writes NOTHING.

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const PROBE = process.env.PROBE === "1";
const IN_TZ = CONFIG.markets_config.IN.tz; // Asia/Kolkata
const IN_OPEN = 9 * 60 + 15; // 09:15 IST
const IN_CLOSE = 15 * 60 + 30; // 15:30 IST
const MAX_PAGES = Number(process.env.STEP1B_MAX_PAGES || 30); // 30*50 = 1500 anns/day cap
const MAX_PDF = Number(process.env.STEP1B_MAX_PDF || 40); // flagged PDFs opened per run
const PAGE_SLEEP_MS = 250;
const PDF_SLEEP_MS = 700;

const ANN_URL = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const ATTACH_BASES = [
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive/",
  "https://www.bseindia.com/xml-data/corpfiling/AttachHis/",
];
const PDF_HELPER = pathResolve(dirname(fileURLToPath(import.meta.url)), "../lib/pdf-text.py");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BSE_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/",
};
// "...scheduled/held ... at 4:00 pm ..." — the hour must be a number after "at"
// (so "at Nirmala Apartments" and other places never match).
const SCHED_TIME_RE = /(?:scheduled|held)[^.]{0,180}?\bat\s+(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m|p\.?m|hrs|hours)/i;

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Today's date in a tz -> { dashed:"2026-08-06", compact:"20260806" }.
function todayIn(tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value])
  );
  return { dashed: `${p.year}-${p.month}-${p.day}`, compact: `${p.year}${p.month}${p.day}` };
}

// "YYYY-MM-DD" shifted by whole days -> "YYYYMMDD".
function compactShift(dateStr, delta) {
  const [y, mo, d] = String(dateStr).split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d) + delta * 86400000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
}

// A wall time (HH:MM IST) on `earnings_date` -> true UTC ISO. IST is fixed +5:30.
function istWallToUtcIso(earnings_date, hh, mm) {
  const [y, mo, d] = String(earnings_date).split("-").map(Number);
  const utcMs = Date.UTC(y, mo - 1, d, hh, mm, 0) - (5 * 60 + 30) * 60000;
  return new Date(utcMs).toISOString();
}

// BSE NEWS_DT ("2026-08-06T19:01:44.33") is IST wall time. -> { iso, mins }.
function parseIstStamp(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, H, M, S] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +H, +M, +(S || 0)) - (5 * 60 + 30) * 60000;
  return { iso: new Date(utcMs).toISOString(), mins: +H * 60 + +M };
}
function classifyIST(mins) {
  if (mins < IN_OPEN) return "BMO";
  if (mins >= IN_CLOSE) return "AMC";
  return "INTRADAY";
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: BSE_HEADERS, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, json: null };
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, json: null }; // HTML error page etc.
    }
  } catch (e) {
    // Timeout / network / abort — fail-soft so the step degrades, never crashes.
    return { ok: false, status: 0, json: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// All Board Meeting announcements filed on `compact` (YYYYMMDD), paginated.
async function fetchBoardMeetings(compact) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${ANN_URL}?pageno=${page}&strCat=Board%20Meeting&strPrevDate=${compact}&strScrip=&strSearch=P&strToDate=${compact}&strType=C&subcategory=-1`;
    const { ok, status, json } = await fetchJson(url);
    if (!ok || !json) {
      console.warn(`[bse-ann] page ${page} not JSON (HTTP ${status}); stopping pagination`);
      break;
    }
    const page_rows = Array.isArray(json.Table) ? json.Table : [];
    rows.push(...page_rows);
    const total = json.Table1 && json.Table1[0] && json.Table1[0].ROWCNT;
    if (page_rows.length === 0 || (typeof total === "number" && rows.length >= total)) break;
    await sleep(PAGE_SLEEP_MS);
  }
  return rows;
}

// scrip_code(String) -> { news_dt, iso, mins } for the latest OUTCOME per scrip.
function outcomeMap(annRows) {
  const map = new Map();
  for (const a of annRows) {
    if (!a || !/outcome/i.test(String(a.NEWSSUB || ""))) continue; // outcome, not intimation
    const parsed = parseIstStamp(a.NEWS_DT);
    if (!parsed) continue;
    const code = String(a.SCRIP_CD);
    const prev = map.get(code);
    if (!prev || parsed.iso > prev.iso) map.set(code, { news_dt: a.NEWS_DT, ...parsed });
  }
  return map;
}

// Fetch a BSE filing PDF by attachment name -> Buffer, or null.
async function fetchPdf(name) {
  for (const base of ATTACH_BASES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(base + name, {
        headers: { "User-Agent": UA, Accept: "*/*", Referer: "https://www.bseindia.com/" },
        signal: ctrl.signal,
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      /* try next base */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// PDF buffer -> extracted text via the python helper (PyMuPDF). "" on any failure
// (python3 / lib missing, unreadable/scanned PDF, timeout) so callers no-op.
function pdfText(buf) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn("python3", [PDF_HELPER], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return finish("");
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish("");
    }, 20000);
    child.on("error", () => {
      clearTimeout(timer);
      finish(""); // python3 not installed
    });
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(out);
    });
    try {
      child.stdin.on("error", () => {});
      child.stdin.end(buf);
    } catch {
      clearTimeout(timer);
      finish("");
    }
  });
}

// Read a scrip's board-meeting INTIMATION PDF and extract the scheduled time,
// if the notice states one. -> { iso, mins, timing } or null.
async function intimationTime(scrip, earnings_date) {
  const from = compactShift(earnings_date, -30);
  const to = compactShift(earnings_date, 0);
  const url = `${ANN_URL}?pageno=1&strCat=Board%20Meeting&strPrevDate=${from}&strScrip=${scrip}&strSearch=P&strToDate=${to}&strType=C&subcategory=-1`;
  const { ok, json } = await fetchJson(url);
  if (!ok || !json) return null;
  const rows = Array.isArray(json.Table) ? json.Table : [];
  const it = rows.find((a) => /intimation/i.test(String(a.NEWSSUB || "")) && a.ATTACHMENTNAME);
  if (!it) return null;
  const pdf = await fetchPdf(it.ATTACHMENTNAME);
  if (!pdf) return null;
  const text = (await pdfText(pdf)).replace(/\s+/g, " ");
  const m = SCHED_TIME_RE.exec(text);
  if (!m) return null;
  let hh = +m[1];
  const mm = m[2] ? +m[2] : 0;
  const ap = (m[3] || "").toLowerCase();
  if (/p/.test(ap) && hh < 12) hh += 12; // pm
  if (/a/.test(ap) && hh === 12) hh = 0; // 12am
  if (hh > 23 || mm > 59) return null;
  const mins = hh * 60 + mm;
  return { iso: istWallToUtcIso(earnings_date, hh, mm), mins, timing: classifyIST(mins) };
}

// Apply a resolved timing to an event (mutates + returns it).
function applyResolved(e, r, source) {
  e.earnings_datetime_utc = r.earnings_datetime_utc;
  e.timing = r.timing;
  e.timing_source = source;
  e.earnings_time_confirmed = true;
  return e;
}

export async function run() {
  const nowISO = new Date().toISOString();
  const today = todayIn(IN_TZ);

  const calendar = await readJson("earnings-calendar.json", { events: [] });
  const events = Array.isArray(calendar.events) ? calendar.events : [];
  const cache = (await readJson("timing-cache.json", {})) || {};

  const todayIN = events.filter((e) => e.market === "IN" && e.earnings_date === today.dashed && e.bse_code);
  if (PROBE) return probe(today, todayIN);

  // (1) Exact time from today's OUTCOMES (bulk). Overrides any cached estimate.
  let resolvedNow = 0;
  let fromCache = 0;
  if (todayIN.length) {
    const anns = await fetchBoardMeetings(today.compact);
    const outcomes = outcomeMap(anns);
    console.log(`[enrich-timing] ${anns.length} board-meeting anns today; ${outcomes.size} outcomes with a time`);
    for (const e of todayIN) {
      const key = `${e.market}|${e.ticker}|${e.earnings_date}`;
      const hit = outcomes.get(String(e.bse_code));
      if (hit) {
        const r = { earnings_datetime_utc: hit.iso, timing: classifyIST(hit.mins) };
        applyResolved(e, r, "bse:outcome");
        cache[key] = { ...r, news_dt: hit.news_dt, source: "bse:outcome", resolved_at: nowISO };
        resolvedNow++;
      } else if (cache[key] && cache[key].earnings_datetime_utc) {
        applyResolved(e, cache[key], cache[key].source || "bse:outcome");
        fromCache++;
      } else {
        e.timing_source = "default"; // not reported yet
      }
    }
  }

  // (2) Scheduled time for FLAGGED names from the intimation PDF (few, cached
  //     once each — positive AND negative — so we never re-open a PDF).
  const prior = await readJson("signals.json", { signals: [] });
  const flagged = (Array.isArray(prior.signals) ? prior.signals : []).filter(
    (s) => s && s.flagged && s.market === "IN" && s.bse_code
  );
  let pdfTimed = 0;
  let pdfTried = 0;
  for (const s of flagged) {
    if (pdfTried >= MAX_PDF) break;
    const key = `${s.market}|${s.ticker}|${s.earnings_date}`;
    if (cache[key]) continue; // already resolved or known to have no scheduled time
    pdfTried++;
    let r = null;
    try {
      r = await intimationTime(s.bse_code, s.earnings_date);
    } catch {
      /* fail-soft */
    }
    if (r) {
      cache[key] = { earnings_datetime_utc: r.iso, timing: r.timing, source: "bse:intimation", resolved_at: nowISO };
      const ev = events.find((e) => e.market === s.market && e.ticker === s.ticker && e.earnings_date === s.earnings_date);
      if (ev) applyResolved(ev, cache[key], "bse:intimation");
      pdfTimed++;
    } else {
      cache[key] = { source: "no-scheduled-time", checked_at: nowISO }; // negative cache
    }
    await sleep(PDF_SLEEP_MS);
  }

  const payload = { ...calendar, generated_at: calendar.generated_at || nowISO, count: events.length, events };
  await writeJson("earnings-calendar.json", payload);
  await writeJson("timing-cache.json", cache);
  console.log(
    `enrich-timing: today ${todayIN.length} IN — ${resolvedNow} timed from outcome, ${fromCache} from cache; ` +
      `flagged PDFs opened ${pdfTried}, scheduled time found ${pdfTimed}`
  );
  return { resolved: resolvedNow, from_cache: fromCache, due_today: todayIN.length, pdf_timed: pdfTimed };
}

// ---- PROBE ---------------------------------------------------------------

async function probe(today, todayIN) {
  console.log(`\n===== BSE board-meeting outcomes for ${today.dashed} (bulk) =====`);
  const anns = await fetchBoardMeetings(today.compact);
  const outcomes = outcomeMap(anns);
  console.log(`fetched ${anns.length} board-meeting announcements; ${outcomes.size} are outcomes with a time`);
  let shown = 0;
  for (const [code, r] of outcomes) {
    if (shown++ >= 6) break;
    console.log(`  scrip ${code}: ${r.news_dt} IST -> ${classifyIST(r.mins)} (${r.iso})`);
  }
  const resolvable = todayIN.filter((e) => outcomes.has(String(e.bse_code)));
  console.log(`\ncommitted calendar: ${todayIN.length} India names due today; ${resolvable.length} already have an outcome`);
  for (const e of resolvable.slice(0, 6)) {
    const hit = outcomes.get(String(e.bse_code));
    console.log(`  ${e.ticker} (${e.bse_code}): ${hit.news_dt} IST -> ${classifyIST(hit.mins)}`);
  }

  console.log("\n===== intimation scheduled-time (PDF) demo =====");
  const sample = todayIN.find((e) => !outcomes.has(String(e.bse_code))) || todayIN[0];
  if (sample) {
    const t = await intimationTime(sample.bse_code, sample.earnings_date).catch(() => null);
    console.log(`  ${sample.ticker} (${sample.bse_code}): ${t ? `${t.timing} @ ${t.iso}` : "no scheduled time in the filing (or PDF unavailable)"}`);
  } else {
    console.log("  (no India sample available)");
  }

  console.log("\n[PROBE] wrote nothing.");
  return { probe: true };
}

// Allow running directly: `node pipeline/steps/01b-enrich-timing.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
