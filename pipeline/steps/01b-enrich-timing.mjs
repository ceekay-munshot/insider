// Step 01b — enrich India earnings timing with the REAL announcement time.
//
// BSE's "forthcoming results" feed (step 1) gives only a DATE — no time — so
// India events land with timing "UNKNOWN" and a flat 16:00 IST placeholder. But
// once a company files its result, BSE's "Board Meeting Outcome" announcement
// carries an exact timestamp (NEWS_DT). We read that and set the TRUE timing:
//   NEWS_DT 12:41 IST -> INTRADAY,  19:01 IST -> AMC,  before 09:15 -> BMO.
//
// Honest by design: we only fill a time when the outcome is actually published.
// Names that haven't reported yet keep timing "UNKNOWN" (their exact hour isn't
// public in India — the intimation states only the date). No LLM: there is no
// time to "extract" from the intimation text; the outcome timestamp is structured.
//
// Efficient + scoped: one BULK, paginated fetch of ALL board-meeting outcomes
// filed TODAY (IST), indexed by scrip code — not a per-name call. Only India
// events dated today can have an outcome, so that's all we resolve. Resolutions
// persist in timing-cache.json, accumulating the ground-truth "news broke at"
// times a later backtest (step 9) compares pre- vs post-earnings moves against.
//
// PROBE mode:  `PROBE=1 node pipeline/steps/01b-enrich-timing.mjs`
//   Fetches today's board-meeting outcomes and prints a few, plus how many of
//   the committed calendar's India names it would resolve. Writes NOTHING.

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";
import { CONFIG } from "../../config.mjs";

const PROBE = process.env.PROBE === "1";
const IN_TZ = CONFIG.markets_config.IN.tz; // Asia/Kolkata
const IN_OPEN = 9 * 60 + 15; // 09:15 IST
const IN_CLOSE = 15 * 60 + 30; // 15:30 IST
const MAX_PAGES = Number(process.env.STEP1B_MAX_PAGES || 30); // 30*50 = 1500 anns/day cap
const PAGE_SLEEP_MS = 250;

const ANN_URL = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BSE_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/",
};

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

// BSE NEWS_DT ("2026-08-06T19:01:44.33") is IST wall time. -> { iso, mins } where
// iso is the true UTC ISO and mins is minutes-since-midnight IST (for classify).
// IST is a fixed UTC+5:30 (no DST), so the shift is exact.
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

  // Only India names reporting TODAY can have an outcome filed today.
  const todayIN = events.filter((e) => e.market === "IN" && e.earnings_date === today.dashed && e.bse_code);
  if (PROBE) return probe(today, todayIN);

  let resolvedNow = 0;
  let fromCache = 0;

  if (todayIN.length) {
    const anns = await fetchBoardMeetings(today.compact);
    const outcomes = outcomeMap(anns);
    console.log(`[enrich-timing] ${anns.length} board-meeting anns today; ${outcomes.size} outcomes with a time`);

    for (const e of todayIN) {
      const key = `${e.market}|${e.ticker}|${e.earnings_date}`;
      const cached = cache[key];
      if (cached && cached.earnings_datetime_utc) {
        applyResolved(e, cached, cached.source || "bse:outcome");
        fromCache++;
        continue;
      }
      const hit = outcomes.get(String(e.bse_code));
      if (hit) {
        const r = { earnings_datetime_utc: hit.iso, timing: classifyIST(hit.mins) };
        applyResolved(e, r, "bse:outcome");
        cache[key] = { ...r, news_dt: hit.news_dt, source: "bse:outcome", resolved_at: nowISO };
        resolvedNow++;
      } else {
        e.timing_source = "default"; // not reported yet — hour isn't public in India
      }
    }
  }

  const payload = { ...calendar, generated_at: calendar.generated_at || nowISO, count: events.length, events };
  await writeJson("earnings-calendar.json", payload);
  await writeJson("timing-cache.json", cache);
  console.log(
    `enrich-timing: ${todayIN.length} India names due today — ${resolvedNow} newly timed, ` +
      `${fromCache} from cache, ${todayIN.length - resolvedNow - fromCache} still awaiting result`
  );
  return { resolved: resolvedNow, from_cache: fromCache, due_today: todayIN.length };
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
