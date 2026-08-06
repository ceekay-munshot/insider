// Step 04 — alerts.
//
// STUB. TODO(step 5): turn newly-flagged signals into alerts (dedupe by
// id = "TICKER-YYYY-MM-DD"), fire the configured channels (email + dashboard),
// and record which alerts were emailed. For now we write an empty-but-valid file.
//
// alert shape (for later):
//   { id:"TICKER-YYYY-MM-DD", ticker, market, company, earnings_date, timing,
//     fired_at:ISO, change_1d_pct, change_5d_pct, price, baseline_prev_close,
//     channels:["email","dashboard"], emailed:bool }

import { pathToFileURL } from "node:url";
import { writeJson } from "../lib/io.mjs";

export async function run() {
  console.log("[04-alerts] STUB — writing empty alerts");
  const payload = {
    generated_at: new Date().toISOString(),
    count: 0,
    alerts: [],
  };
  const path = await writeJson("alerts.json", payload);
  console.log(`[04-alerts] wrote ${path} (0 alerts)`);
  return payload;
}

// Allow running directly: `node pipeline/steps/04-alerts.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
