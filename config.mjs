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

  // Movement windows we compute.
  //   oneDay        — price vs the last session's close
  //   fiveDay       — ~5-session drift
  //   driftSessions — how many sessions the 5-day baseline looks back
  windows: { oneDay: true, fiveDay: true, driftSessions: 5 },

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

  // Optional manual always-watch tickers. The earnings calendar drives the rest;
  // anything listed here is tracked even if it isn't on the calendar.
  seed_universe: { US: [], IN: [] },

  // Step 2 (price fetcher) knobs. Quote only events within `window_days` of
  // their earnings, capped at `max_quotes` per run (soonest first).
  step2: {
    window_days: Number(process.env.STEP2_WINDOW_DAYS || 7),
    max_quotes: Number(process.env.STEP2_MAX_QUOTES || 200),
  },
};

export default CONFIG;
