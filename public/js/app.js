// app.js — fetch the JSON in ./data and render the dashboard shell.
//
// Degrades gracefully: the frame (KPI strip at 0, tabs, empty states) renders
// even if the data files are missing, empty, or blocked (e.g. opened via file://).
// No fetch failure ever throws or logs a console *error* from our code.
(function () {
  "use strict";

  var UI = window.RadarUI;
  var DATA = "./data";
  var MARKETS = ["US", "IN"];
  var TABLE_COLS = 8; // Ticker, Company, Earnings, Timing, 1d%, 5d%, Price, Status

  var activeMarket = "US";
  var signalsByMarket = { US: [], IN: [] };

  // ---- data loading -------------------------------------------------------

  function loadJson(name, fallback) {
    return fetch(DATA + "/" + name, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) return fallback;
        return res.json();
      })
      .catch(function () {
        // Missing/empty/blocked — degrade silently to the fallback.
        return fallback;
      });
  }

  // ---- rendering ----------------------------------------------------------

  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = String(value);
  }

  function renderKpis(metadata) {
    var counts = (metadata && metadata.counts) || {};
    setText("kpi-tracked", counts.tracked == null ? 0 : counts.tracked);
    setText("kpi-flagged", counts.flagged == null ? 0 : counts.flagged);
    setText("kpi-alerts", counts.alerts_today == null ? 0 : counts.alerts_today);

    var stamp = metadata && metadata.generated_at;
    setText(
      "last-updated",
      stamp ? "Updated " + new Date(stamp).toLocaleString() : "Not run yet"
    );
  }

  function emptyRow() {
    return UI.el("tr", {}, [
      UI.el(
        "td",
        {
          colspan: String(TABLE_COLS),
          class: "px-4 py-14 text-center text-slate-500 dark:text-slate-400",
        },
        "No earnings tracked yet — run the pipeline."
      ),
    ]);
  }

  function signalRow(s) {
    // No rows at scaffold stage; kept ready so later steps just supply data.
    return UI.el(
      "tr",
      { class: "border-t border-slate-100 dark:border-slate-800" },
      [
        UI.el("td", { class: "px-4 py-2 font-medium", text: s.ticker || "—" }),
        UI.el("td", { class: "px-4 py-2", text: s.company || "—" }),
        UI.el("td", { class: "px-4 py-2", text: s.earnings_date || "—" }),
        // "UNKNOWN" (India, time not yet published) shows as "—", not a fake value.
        UI.el("td", { class: "px-4 py-2", text: s.timing && s.timing !== "UNKNOWN" ? s.timing : "—" }),
        UI.el("td", { class: "px-4 py-2 text-right tabular-nums", text: UI.fmtPct(s.change_1d_pct) }),
        UI.el("td", { class: "px-4 py-2 text-right tabular-nums", text: UI.fmtPct(s.change_5d_pct) }),
        UI.el("td", { class: "px-4 py-2 text-right tabular-nums", text: UI.fmtNum(s.price) }),
        UI.el("td", { class: "px-4 py-2", text: s.status || "—" }),
      ]
    );
  }

  function renderTable(market) {
    var tbody = document.getElementById("signals-body");
    if (!tbody) return;
    UI.clear(tbody);
    var rows = signalsByMarket[market] || [];
    if (rows.length === 0) {
      tbody.appendChild(emptyRow());
      return;
    }
    rows.forEach(function (s) {
      tbody.appendChild(signalRow(s));
    });
  }

  function tabClass(active) {
    return active
      ? "px-4 py-2 text-sm font-semibold border-b-2 border-emerald-500 text-emerald-600 dark:text-emerald-400"
      : "px-4 py-2 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200";
  }

  function setActiveMarket(market) {
    activeMarket = market;
    MARKETS.forEach(function (m) {
      var btn = document.getElementById("tab-" + m);
      if (!btn) return;
      var on = m === market;
      btn.setAttribute("aria-selected", String(on));
      btn.className = tabClass(on);
    });
    renderTable(market);
  }

  // ---- boot ---------------------------------------------------------------

  function boot() {
    // Wire tabs first so the frame is interactive even if data never loads.
    MARKETS.forEach(function (m) {
      var btn = document.getElementById("tab-" + m);
      if (btn)
        btn.addEventListener("click", function () {
          setActiveMarket(m);
        });
    });
    setActiveMarket(activeMarket);

    Promise.all([
      loadJson("metadata.json", null),
      loadJson("signals.json", { signals: [] }),
    ]).then(function (results) {
      var metadata = results[0];
      var signals = results[1];

      var grouped = { US: [], IN: [] };
      ((signals && signals.signals) || []).forEach(function (s) {
        if (!grouped[s.market]) grouped[s.market] = [];
        grouped[s.market].push(s);
      });
      signalsByMarket = grouped;

      renderKpis(metadata);
      renderTable(activeMarket);

      // Draw Lucide icons if the CDN loaded (no-op otherwise).
      if (window.lucide && typeof window.lucide.createIcons === "function") {
        try {
          window.lucide.createIcons();
        } catch (e) {
          /* icons are decorative; ignore */
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
