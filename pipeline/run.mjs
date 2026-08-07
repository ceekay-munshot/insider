// run.mjs — pipeline orchestrator.
//
// Chains steps 01 -> 04 as child processes (so a crash in one step can't take the
// orchestrator's process state with it), rolls the results up into metadata.json,
// prints a summary, and exits 0. Each run also appends a dated price snapshot for
// history (see step 02).
//
// Usage: node pipeline/run.mjs

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./lib/io.mjs";
import { CONFIG } from "../config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STEPS_DIR = resolve(__dirname, "steps");

const STEPS = [
  "01-earnings-calendar.mjs",
  "01b-enrich-timing.mjs",
  "02-fetch-prices.mjs",
  "03-compute-signals.mjs",
  "04-alerts.mjs",
];

// Run one step script as a child process; resolve on exit 0, reject otherwise.
function runStep(file) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(STEPS_DIR, file)], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${file} exited with code ${code}`))
    );
  });
}

async function main() {
  const startedAt = new Date();
  console.log(`\n=== Earnings Radar pipeline @ ${startedAt.toISOString()} ===\n`);

  let ok = true;
  for (const step of STEPS) {
    try {
      await runStep(step);
    } catch (err) {
      ok = false;
      console.error(`[run] step failed: ${err.message}`);
      // TODO(step 8): decide per-step continue vs. fail-fast for scheduled runs.
      break;
    }
  }

  // Roll counts up into metadata.json — the dashboard's single source of truth.
  const calendar = await readJson("earnings-calendar.json", { events: [] });
  const signals = await readJson("signals.json", { signals: [] });
  const alerts = await readJson("alerts.json", { alerts: [] });

  const today = new Date().toISOString().slice(0, 10);
  const flagged = (signals.signals || []).filter((s) => s.flagged).length;
  const alertsToday = (alerts.alerts || []).filter(
    (a) => (a.fired_at || "").slice(0, 10) === today
  ).length;

  const metadata = {
    generated_at: new Date().toISOString(),
    markets: CONFIG.markets,
    counts: {
      tracked: (calendar.events || []).length,
      flagged,
      alerts_today: alertsToday,
    },
    thresholds: { up_pct: CONFIG.threshold_up_pct, windows: ["1d"] },
    last_run_ok: ok,
  };
  await writeJson("metadata.json", metadata);

  // Summary.
  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log("\n--- summary ---");
  console.log(`tracked:      ${metadata.counts.tracked}`);
  console.log(`flagged:      ${metadata.counts.flagged}`);
  console.log(`alerts_today: ${metadata.counts.alerts_today}`);
  console.log(`last_run_ok:  ${metadata.last_run_ok}`);
  console.log(`elapsed:      ${elapsed}s`);
  console.log("===============\n");

  // Exit 0 so the scheduled workflow's commit-back step always runs, even when a
  // stub no-ops. `last_run_ok` records whether every step actually succeeded.
  process.exit(0);
}

main().catch((err) => {
  console.error("[run] fatal:", err);
  process.exit(1);
});
