// Step 03 — compute movement signals.
//
// STUB. TODO(step 4): join the earnings calendar with the latest price snapshot,
// compute the 1-day and 5-day pre-earnings moves against their baselines, set
// `flagged`/`flag_reason` when a move clears CONFIG.threshold_up_pct, and populate
// `signals`. For now we write an empty-but-valid file.
//
// signal shape (for later):
//   { ticker, market, company, earnings_date, earnings_datetime_utc, timing,
//     minutes_to_earnings:number|null, price:number|null, currency,
//     baseline_prev_close, change_1d_pct, baseline_5d_close, change_5d_pct,
//     flagged:bool, flag_reason, first_flagged_at:ISO|null, last_updated:ISO,
//     status:"pre_earnings"|"cutoff_passed"|"reported" }

import { pathToFileURL } from "node:url";
import { writeJson } from "../lib/io.mjs";

export async function run() {
  console.log("[03-compute-signals] STUB — writing empty signals");
  const payload = {
    generated_at: new Date().toISOString(),
    count: 0,
    signals: [],
  };
  const path = await writeJson("signals.json", payload);
  console.log(`[03-compute-signals] wrote ${path} (0 signals)`);
  return payload;
}

// Allow running directly: `node pipeline/steps/03-compute-signals.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
