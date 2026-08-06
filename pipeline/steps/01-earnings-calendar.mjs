// Step 01 — earnings calendar.
//
// STUB. TODO(step 2): fetch the real upcoming-earnings calendar — US via Finnhub,
// India via muns corp_announcements|street_estimates — normalize each row to the
// event shape below, and populate `events`. For now we write an empty-but-valid file.
//
// event shape (for later):
//   { ticker, market:"US"|"IN", company, earnings_date:"YYYY-MM-DD",
//     earnings_datetime_utc:ISO|null, timing:"BMO"|"AMC"|"INTRADAY"|"UNKNOWN",
//     confirmed:bool, source }

import { pathToFileURL } from "node:url";
import { writeJson } from "../lib/io.mjs";

export async function run() {
  console.log("[01-earnings-calendar] STUB — writing empty earnings calendar");
  const payload = {
    generated_at: new Date().toISOString(),
    count: 0,
    events: [],
  };
  const path = await writeJson("earnings-calendar.json", payload);
  console.log(`[01-earnings-calendar] wrote ${path} (0 events)`);
  return payload;
}

// Allow running directly: `node pipeline/steps/01-earnings-calendar.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
