// Earnings Radar — central configuration ("the knobs").
//
// Everything tunable about the pipeline lives here so later steps read one
// source of truth. Keep this file free of secrets; secrets come from env vars
// (see README.md → Environment variables).

export const CONFIG = {
  // Which markets we track. Drives fetchers, tabs, and metadata.
  markets: ["US", "IN"],

  // Signal threshold: flag a stock that moved at least this % before earnings.
  threshold_up_pct: 3,

  // Direction of interest. "up" only for now — the thesis is pre-earnings ramps.
  direction: "up",

  // We track the 1-day move only: price vs the last session's close.
  // (A 5-day drift was considered and dropped — v1 is the same-day signal.)

  // Once a stock is inside this many minutes of its earnings event, freeze the
  // reading (the pre-earnings move is what we care about — see step 4/5).
  cutoff_minutes_before_earnings: 30,

  // Per-market trading calendar (local exchange time). Used by market.mjs.
  markets_config: {
    US: { tz: "America/New_York", open: "09:30", close: "16:00" },
    IN: { tz: "Asia/Kolkata", open: "09:15", close: "15:30" },
  },

  // Where each market's data comes from. "muns:*" entries are muns.io endpoints
  // wired up in later steps; "finnhub" / "yahoo" are US sources.
  data_sources: {
    US: { earnings: "finnhub", prices: "finnhub", price_backup: "yahoo" },
    IN: {
      earnings: "muns:corp_announcements|street_estimates",
      prices: "muns:get_stock_data",
    },
  },

  // muns.io API bases. Two services: the NestJS app (corp announcements / LLM
  // adjacent) and the FastAPI app (stock quotes + OHLC). All overridable via env.
  muns: {
    base_url: process.env.MUNS_BASE_URL || "https://devde.muns.io", // legacy alias == nestjs_base
    nestjs_base: process.env.MUNS_NESTJS_BASE || "https://devde.muns.io",
    fastapi_base: process.env.MUNS_FASTAPI_BASE || "https://fastapi.muns.io",
  },

  // Price fallback sources, tried per-name ONLY when muns misses (see step 2).
  // muns is yfinance→Yahoo, so a Yahoo hiccup 404s real names; a second, unrelated
  // source recovers them:
  //   US    -> Finnhub /quote  (returns c/pc/o; needs FINNHUB_API_KEY)
  //   India -> TradingView scanner (NSE:<sym> then BSE:<sym>; no key)
  finnhub: { base: process.env.FINNHUB_BASE || "https://finnhub.io/api/v1" },
  tradingview: { scanner_base: process.env.TRADINGVIEW_SCANNER_BASE || "https://scanner.tradingview.com" },

  // Optional manual always-watch tickers. The earnings calendar drives the rest;
  // anything listed here is tracked even if it isn't on the calendar.
  seed_universe: { US: [], IN: [] },

  // Step 2 (price fetcher) knobs. Price only events whose earnings fall within
  // `window_days` of today (market-local) — default 1 = today + tomorrow, the
  // "same-day / next-day" reporters. Keeping this tight is what makes intraday
  // runs fast and — crucially — avoids hammering muns's yfinance→Yahoo upstream
  // into throttling (which surfaces as 404 "not found" for real names). Override
  // per-run via STEP2_WINDOW_DAYS (the workflow exposes it as the `days` input).
  // `muns_retries` sets the exponential-backoff count for explicit rate-limits.
  step2: {
    window_days: Number(process.env.STEP2_WINDOW_DAYS || 1),
    muns_retries: Number(process.env.MUNS_RETRIES || 4),
  },
};

export default CONFIG;
