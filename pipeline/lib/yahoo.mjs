// yahoo.mjs — Yahoo Finance helpers for the backtest (historical daily prices,
// and earnings surprise / beat-miss). Zero deps; global fetch.
//
// The chart endpoint (v8) needs no auth. quoteSummary (v10, used for earnings
// estimates) needs a cookie+crumb handshake — fetched once and cached here.
// Everything is FAIL-SOFT: any network/parse error returns empty, never throws,
// so the backtest degrades (fewer events) instead of crashing.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchText(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, headers: res.headers };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Daily closes for a symbol over `range` ("1mo".."2y").
// -> [{ date:"YYYY-MM-DD", close:Number }] (nulls/holidays dropped), oldest first.
export async function dailyCloses(symbol, range = "3mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const { ok, text } = await fetchText(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!ok) return [];
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return [];
  }
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) return [];
  const ts = r.timestamp;
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const closes = q.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
  }
  return out;
}

// ---- earnings surprise (beat/miss) --------------------------------------
// Cached cookie+crumb; both best-effort. If the handshake fails we simply
// return [] and callers fall back to the price-reaction verdict.

let _crumb = null;
let _cookie = null;
let _crumbTried = false;

async function ensureCrumb() {
  if (_crumb) return true;
  if (_crumbTried) return !!_crumb;
  _crumbTried = true;
  // A cookie first (some regions gate the crumb behind it).
  const c = await fetchText("https://fc.yahoo.com/", { headers: { "User-Agent": UA } });
  try {
    const sc = c.headers && typeof c.headers.getSetCookie === "function" ? c.headers.getSetCookie() : null;
    if (sc && sc.length) _cookie = sc.map((s) => s.split(";")[0]).join("; ");
  } catch {
    /* ignore */
  }
  const headers = { "User-Agent": UA };
  if (_cookie) headers.Cookie = _cookie;
  const cr = await fetchText("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers });
  const t = (cr.text || "").trim();
  if (cr.ok && t && t.length < 40 && !t.includes("<")) {
    _crumb = t;
    return true;
  }
  return false;
}

// Quarterly earnings surprises for a symbol, newest last.
// -> [{ date:"YYYY-MM-DD", actual:Number|null, estimate:Number|null, surprise_pct:Number|null }]
// surprise_pct is a true percent (e.g. +6.74), not the raw Yahoo fraction.
export async function earningsSurprises(symbol) {
  if (!(await ensureCrumb())) return [];
  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (_cookie) headers.Cookie = _cookie;
  const url =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=earningsHistory&crumb=${encodeURIComponent(_crumb)}`;
  const { ok, text } = await fetchText(url, { headers });
  if (!ok) return [];
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return [];
  }
  const r = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
  const hist = (r && r.earningsHistory && r.earningsHistory.history) || [];
  return hist.map((h) => ({
    date: (h.quarter && h.quarter.fmt) || null,
    actual: h.epsActual && h.epsActual.raw != null ? h.epsActual.raw : null,
    estimate: h.epsEstimate && h.epsEstimate.raw != null ? h.epsEstimate.raw : null,
    surprise_pct: h.surprisePercent && h.surprisePercent.raw != null ? h.surprisePercent.raw * 100 : null,
  }));
}
