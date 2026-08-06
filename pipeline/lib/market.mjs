// market.mjs — pure-ish market/time helpers.
//
// These functions read only the clock and CONFIG (no network, no files) so they
// are easy to reason about and test. Timezone math uses Intl, which ships with
// Node 22. Market holidays are NOT modeled yet — see TODO(step 3).

import { CONFIG } from "../../config.mjs";

// Current instant. A Date is UTC-based internally; keep this as the single
// "now" source so callers can be tested by passing an explicit `now`.
export function nowUtc() {
  return new Date();
}

// Break an instant into {weekday, hours, minutes} *as seen in* an IANA tz.
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    weekday: parts.weekday, // "Mon".."Sun"
    hours: Number(parts.hour) % 24, // Intl can emit "24" at midnight
    minutes: Number(parts.minute),
  };
}

const WEEKEND = new Set(["Sat", "Sun"]);

// "HH:MM" -> minutes since local midnight.
function hmToMinutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

// Is `market` currently within its trading session? Weekends excluded.
// NOTE: does not account for exchange holidays. TODO(step 3): holiday calendar.
export function isMarketOpen(market, now = nowUtc()) {
  const cfg = CONFIG.markets_config[market];
  if (!cfg) return false;
  const { weekday, hours, minutes } = localParts(now, cfg.tz);
  if (WEEKEND.has(weekday)) return false;
  const nowMin = hours * 60 + minutes;
  return nowMin >= hmToMinutes(cfg.open) && nowMin < hmToMinutes(cfg.close);
}

// Minutes from `now` until an event's earnings datetime.
// Positive = in the future, negative = already passed, null = no precise time.
export function minutesToEarnings(event, now = nowUtc()) {
  if (!event || !event.earnings_datetime_utc) return null;
  const t = Date.parse(event.earnings_datetime_utc);
  if (Number.isNaN(t)) return null;
  return Math.round((t - now.getTime()) / 60000);
}

// Classify an earnings event's timing relative to the trading session:
//   BMO      — before market open
//   AMC      — after market close
//   INTRADAY — during the session
//   UNKNOWN  — no reliable timestamp yet
//
// US earnings are almost always BMO or AMC. India ("fuzzy") corp announcements
// frequently lack a precise time, so we return UNKNOWN until a later step
// refines them. TODO(step 2): source-specific India timing heuristics.
export function classifyTiming(event) {
  if (!event) return "UNKNOWN";
  // Trust the source if it already told us.
  if (event.timing && event.timing !== "UNKNOWN") return event.timing;

  const cfg = CONFIG.markets_config[event.market];
  if (!cfg || !event.earnings_datetime_utc) return "UNKNOWN";

  const t = new Date(event.earnings_datetime_utc);
  if (Number.isNaN(t.getTime())) return "UNKNOWN";

  const { hours, minutes } = localParts(t, cfg.tz);
  const eventMin = hours * 60 + minutes;
  if (eventMin <= hmToMinutes(cfg.open)) return "BMO";
  if (eventMin >= hmToMinutes(cfg.close)) return "AMC";
  return "INTRADAY";
}
