// Step 02 — fetch prices + append a snapshot.
//
// STUB. TODO(step 3): fetch live price + previous close for every tracked ticker
// (US via Finnhub, backup Yahoo; India via muns get_stock_data), build the
// `readings` array, and write a real snapshot. For now we write an empty snapshot.
//
// snapshot file (snapshots/<taken_at>.json):
//   { taken_at:ISO, readings:[ { ticker, market, price, prev_close, currency,
//     as_of:ISO, source } ] }
// ...and we append { file, taken_at, count } to snapshots/index.json for history.

import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "../lib/io.mjs";

export async function run() {
  console.log("[02-fetch-prices] STUB — writing empty price snapshot");
  const takenAt = new Date().toISOString();
  const snapshot = { taken_at: takenAt, readings: [] };

  // Snapshot filenames are time-based; ":" and "." aren't filesystem-friendly.
  const file = `snapshots/${takenAt.replace(/[:.]/g, "-")}.json`;
  await writeJson(file, snapshot);

  // Append to the snapshot index (append-only history).
  const index = await readJson("snapshots/index.json", []);
  index.push({ file, taken_at: takenAt, count: snapshot.readings.length });
  await writeJson("snapshots/index.json", index);

  console.log(
    `[02-fetch-prices] wrote ${file} (0 readings); index now has ${index.length} snapshot(s)`
  );
  return snapshot;
}

// Allow running directly: `node pipeline/steps/02-fetch-prices.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
