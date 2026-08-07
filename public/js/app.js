// app.js — Earnings Radar dashboard.
//
// Loads the pipeline's JSON (./data) and renders a Munshot-standard screener:
// filters/context, KPIs, a sortable + paginated signals table, and a source
// trail. Degrades gracefully — missing/blocked data shows an empty state, never
// a thrown error.
(function () {
  "use strict";

  var UI = window.RadarUI;
  var DATA = "./data";
  var PAGE = 50;

  // Each market's local trading timezone — earnings times are shown as the
  // clock time a trader there reads, not UTC.
  var MARKET_TZ = { US: "America/New_York", IN: "Asia/Kolkata" };

  // ---- state --------------------------------------------------------------

  var ALL = { US: [], IN: [] }; // all signals, grouped by market
  var META = null;
  var TODAY = todayStr();

  var filters = { market: "IN", days: 3, status: "ALL", flagged: false, q: "" };
  var sort = { key: "default", dir: "desc" }; // default = flagged-first, move desc
  var shown = PAGE; // pagination cursor

  // ---- small helpers ------------------------------------------------------

  function todayStr(d) {
    d = d || new Date();
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    );
  }
  function pad(n) { return String(n).padStart(2, "0"); }

  // whole-day offset of a YYYY-MM-DD from today (UTC-anchored so tz can't drift it)
  function daysFrom(dateStr) {
    if (!dateStr) return null;
    var a = Date.parse(TODAY + "T00:00:00Z");
    var b = Date.parse(dateStr + "T00:00:00Z");
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function fmtDate(dateStr) {
    if (!dateStr) return "—";
    var p = dateStr.split("-");
    if (p.length !== 3) return dateStr;
    return Number(p[2]) + " " + (MONTHS[Number(p[1]) - 1] || p[1]) + " " + p[0];
  }

  // ISO instant -> local clock time in the market tz, e.g. "11:16 AM".
  function fmtClock(iso, market) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    try {
      return d.toLocaleTimeString("en-US", {
        timeZone: MARKET_TZ[market] || "UTC",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      return null;
    }
  }

  // Real published time when we have one; else the honest bucket; else null.
  function timingText(s) {
    if (s.earnings_time_confirmed) {
      var t = fmtClock(s.earnings_datetime_utc, s.market);
      if (t) return t;
    }
    if (s.timing && s.timing !== "UNKNOWN") return s.timing;
    return null;
  }

  var STATUS = {
    pre_earnings: { label: "Upcoming", cls: "upcoming", tip: "Before earnings — still watching for a pre-earnings run-up." },
    cutoff_passed: { label: "Awaiting", cls: "awaiting", tip: "Reporting window passed; result not confirmed out yet." },
    reported: { label: "Reported", cls: "reported", tip: "Result is confirmed out." },
  };
  var STATUS_ORDER = { pre_earnings: 0, cutoff_passed: 1, reported: 2 };

  function num(v) {
    return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
  }

  // ---- data loading -------------------------------------------------------

  function loadJson(name, fallback) {
    return fetch(DATA + "/" + name, { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : fallback; })
      .catch(function () { return fallback; });
  }

  // ---- filtering + sorting ------------------------------------------------

  function currentUniverse() {
    if (filters.market === "BOTH") return ALL.IN.concat(ALL.US);
    return (ALL[filters.market] || []).slice();
  }

  function passesFilters(s) {
    var off = daysFrom(s.earnings_date);
    if (filters.days < 99 && (off === null || off < 0 || off > filters.days)) return false;
    if (filters.status !== "ALL" && s.status !== filters.status) return false;
    if (filters.flagged && !s.flagged) return false;
    if (filters.q) {
      var q = filters.q.toLowerCase();
      var hay = ((s.ticker || "") + " " + (s.company || "")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function sortVal(s, key) {
    switch (key) {
      case "market": return s.market || "";
      case "ticker": return (s.ticker || "").toLowerCase();
      case "company": return (s.company || "").toLowerCase();
      case "date": return Date.parse((s.earnings_date || "9999-12-31") + "T00:00:00Z") || Infinity;
      case "timing": return s.earnings_datetime_utc ? Date.parse(s.earnings_datetime_utc) : Infinity;
      case "move": return num(s.change_1d_pct);
      case "price": return num(s.price);
      case "status": return STATUS_ORDER[s.status] == null ? -1 : STATUS_ORDER[s.status];
      default: return 0;
    }
  }

  function cmp(a, b, key, dir) {
    var av = sortVal(a, key), bv = sortVal(b, key);
    // nulls always sort last, regardless of direction
    var an = av === null, bn = bv === null;
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    var r = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return dir === "asc" ? r : -r;
  }

  function sortRows(rows) {
    if (sort.key === "default") {
      // flagged first, then biggest UP move, then soonest earnings
      return rows.sort(function (a, b) {
        if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
        var m = cmp(a, b, "move", "desc");
        if (m !== 0) return m;
        return cmp(a, b, "date", "asc");
      });
    }
    return rows.sort(function (a, b) {
      var r = cmp(a, b, sort.key, sort.dir);
      if (r !== 0) return r;
      return cmp(a, b, "ticker", "asc");
    });
  }

  function computeView() {
    var rows = currentUniverse().filter(passesFilters);
    return sortRows(rows);
  }

  // ---- rendering: KPIs ----------------------------------------------------

  function setKpi(id, val, note) {
    var card = document.getElementById(id);
    if (!card) return;
    card.querySelector('[data-slot="val"]').textContent = String(val);
    if (note != null) card.querySelector('[data-slot="note"]').textContent = note;
  }

  function renderKpis(view) {
    var flaggedTotal = ALL.IN.concat(ALL.US).filter(function (s) { return s.flagged; }).length;
    setKpi("kpi-tracked", view.length, "in view");
    setKpi("kpi-flagged", view.filter(function (s) { return s.flagged; }).length, "of " + flaggedTotal + " total · click to isolate");
    setKpi("kpi-reported", view.filter(function (s) { return s.status === "reported"; }).length, "confirmed out");

    var f = document.getElementById("kpi-flagged");
    if (f) f.classList.toggle("active", filters.flagged);
  }

  // ---- rendering: table ---------------------------------------------------

  function columns() {
    var cols = [];
    if (filters.market === "BOTH") cols.push({ key: "market", label: "Mkt" });
    cols.push({ key: "ticker", label: "Ticker" });
    cols.push({ key: "company", label: "Company", cls: "hide-sm" });
    cols.push({ key: "date", label: "Earnings" });
    cols.push({ key: "timing", label: "Timing" });
    cols.push({ key: "move", label: "1D", num: true });
    cols.push({ key: "price", label: "Price", num: true });
    cols.push({ key: "status", label: "Status" });
    return cols;
  }

  function renderHead() {
    var thead = document.getElementById("thead");
    UI.clear(thead);
    var tr = UI.el("tr");
    columns().forEach(function (c) {
      var active = sort.key === c.key;
      var arrow = active ? UI.el("span", { class: "arrow", text: " " + (sort.dir === "asc" ? "▲" : "▼") }) : null;
      var th = UI.el(
        "th",
        {
          class: (c.num ? "num " : "") + "sortable " + (c.cls || ""),
          onclick: function () { onSort(c.key); },
          title: "Sort by " + c.label,
        },
        [c.label, arrow]
      );
      tr.appendChild(th);
    });
    thead.appendChild(tr);
  }

  function moveCell(pct) {
    var n = num(pct);
    if (n === null) return UI.el("td", { class: "num" }, [UI.el("span", { class: "dash", text: "—" })]);
    var big = Math.abs(n) >= 3;
    var cls = "move " + (n >= 0 ? "pos" : "neg") + (big ? " big" : "");
    var caret = UI.el("span", { class: "car", text: n >= 0 ? "▲" : "▼" });
    var txt = (n > 0 ? "+" : "") + n.toFixed(2) + "%";
    return UI.el("td", { class: "num" }, [UI.el("span", { class: cls }, [caret, txt])]);
  }

  function tickerCell(s) {
    var kids = [];
    if (s.flagged) {
      kids.push(UI.el("span", {
        class: "flag",
        title: s.flag_reason || "Flagged: ran up ≥3% before earnings",
        html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><line x1="4" y1="22" x2="4" y2="15" stroke-linecap="round"/></svg>',
      }));
    }
    kids.push(UI.el("span", { class: "sym", text: s.ticker || "—" }));
    return UI.el("td", {}, [UI.el("span", { class: "tk" }, kids)]);
  }

  function statusCell(s) {
    var m = STATUS[s.status] || { label: s.status || "—", cls: "upcoming", tip: "" };
    return UI.el("td", {}, [
      UI.el("span", { class: "chip " + m.cls, title: m.tip }, [UI.el("span", { class: "dot" }), m.label]),
    ]);
  }

  function timingCell(s) {
    var t = timingText(s);
    if (!t) return UI.el("td", {}, [UI.el("span", { class: "dash", text: "—" })]);
    return UI.el("td", { class: "when" }, [UI.el("span", { class: "mono", text: t })]);
  }

  function signalRow(s) {
    var tds = [];
    if (filters.market === "BOTH")
      tds.push(UI.el("td", {}, [UI.el("span", { class: "mkt " + s.market, text: s.market === "IN" ? "IN" : "US" })]));
    tds.push(tickerCell(s));
    tds.push(UI.el("td", { class: "company hide-sm", title: s.company || "" , text: s.company || "—" }));
    tds.push(UI.el("td", { class: "when", html: '<span style="white-space:nowrap">' + fmtDate(s.earnings_date) + "</span>" }));
    tds.push(timingCell(s));
    tds.push(moveCell(s.change_1d_pct));
    tds.push(UI.el("td", { class: "num mono", text: s.price == null ? "—" : UI.fmtNum(s.price) }));
    tds.push(statusCell(s));
    return UI.el("tr", { class: s.flagged ? "flagged" : "" }, tds);
  }

  function skeleton() {
    var tbody = document.getElementById("tbody");
    UI.clear(tbody);
    for (var i = 0; i < 8; i++) {
      var tds = [];
      for (var c = 0; c < 7; c++) tds.push(UI.el("td", { class: "sk-row" }, [UI.el("div", { class: "shimmer sk-bar", style: "width:" + (40 + ((i * 7 + c) % 5) * 12) + "%" })]));
      tbody.appendChild(UI.el("tr", {}, tds));
    }
  }

  function emptyState(colspan) {
    return UI.el("tr", {}, [
      UI.el("td", { colspan: String(colspan) }, [
        UI.el("div", { class: "state" }, [
          UI.el("div", {
            class: "ic",
            html: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
          }),
          UI.el("div", { class: "msg", text: "Nothing matches these filters" }),
          UI.el("div", { class: "hint", text: "Try a wider window, clear the flag filter, or switch market." }),
        ]),
      ]),
    ]);
  }

  function renderTable() {
    var view = computeView();
    renderKpis(view);
    renderHead();

    var tbody = document.getElementById("tbody");
    UI.clear(tbody);
    var cols = columns().length;

    if (view.length === 0) {
      tbody.appendChild(emptyState(cols));
      document.getElementById("tbl-ft").hidden = true;
      updateTitle(0);
      return;
    }

    var slice = view.slice(0, shown);
    slice.forEach(function (s) { tbody.appendChild(signalRow(s)); });

    // pagination footer
    var ft = document.getElementById("tbl-ft");
    document.getElementById("tbl-count").textContent =
      "Showing " + slice.length + " of " + view.length;
    var more = document.getElementById("btn-more");
    if (view.length > shown) { ft.hidden = false; more.hidden = false; more.textContent = "Show " + Math.min(PAGE, view.length - shown) + " more"; }
    else if (view.length > PAGE) { ft.hidden = false; more.hidden = true; }
    else { ft.hidden = true; }

    updateTitle(view.length);
  }

  function updateTitle(n) {
    var mkt = filters.market === "BOTH" ? "US + India" : filters.market === "IN" ? "India" : "US";
    document.getElementById("tbl-title").textContent = "Signals · " + mkt;
    var win = filters.days >= 99 ? "all upcoming" : "next " + filters.days + " days";
    document.getElementById("tbl-sub").textContent =
      n + " names · " + win + " · flagged first, biggest pre-earnings move on top";
  }

  // ---- source trail -------------------------------------------------------

  function renderTrail() {
    var trail = document.getElementById("trail");
    UI.clear(trail);
    function row(k, v) {
      return UI.el("div", { class: "row" }, [
        UI.el("span", { class: "k", text: k }),
        UI.el("span", { class: "v", html: v }),
      ]);
    }
    var counts = (META && META.counts) || {};
    trail.appendChild(row("Calendar", "<b>US</b> Finnhub · <b>India</b> BSE Forthcoming Results"));
    trail.appendChild(row("Prices", "TradingView (bulk) · muns <b>/stock-data</b> fallback"));
    trail.appendChild(row("Timing", "India — real filing time from BSE outcomes when published; US — Finnhub session bucket (BMO/AMC)"));
    var when = META && META.generated_at ? new Date(META.generated_at).toLocaleString() : "—";
    trail.appendChild(row("Last refresh", "<b>" + when + "</b> · auto every 30 min on weekdays"));
    trail.appendChild(row("Universe", "<b>" + (counts.tracked != null ? counts.tracked : ALL.IN.length + ALL.US.length) + "</b> names tracked · priced for the near-term window"));
  }

  // ---- header freshness ---------------------------------------------------

  function renderFreshness() {
    var el = document.getElementById("freshness");
    if (!META || !META.generated_at) { el.textContent = "Not run yet"; return; }
    el.innerHTML = "Updated <b>" + new Date(META.generated_at).toLocaleString() + "</b>";
  }

  // ---- controls -----------------------------------------------------------

  function onSort(key) {
    if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
    else { sort.key = key; sort.dir = key === "ticker" || key === "company" || key === "market" ? "asc" : "desc"; }
    shown = PAGE;
    renderTable();
  }

  function setSeg(groupId, attr, value) {
    var group = document.getElementById(groupId);
    Array.prototype.forEach.call(group.querySelectorAll("button"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute(attr) === String(value)));
    });
  }

  function wire() {
    // market
    document.getElementById("seg-market").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      filters.market = b.getAttribute("data-market");
      setSeg("seg-market", "data-market", filters.market);
      sort = { key: "default", dir: "desc" };
      shown = PAGE; renderTable();
    });
    // window
    document.getElementById("seg-range").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      filters.days = Number(b.getAttribute("data-days"));
      setSeg("seg-range", "data-days", filters.days);
      shown = PAGE; renderTable();
    });
    // status
    document.getElementById("sel-status").addEventListener("change", function (e) {
      filters.status = e.target.value; shown = PAGE; renderTable();
    });
    // flagged toggle
    document.getElementById("chk-flagged").addEventListener("change", function (e) {
      filters.flagged = e.target.checked; shown = PAGE; renderTable();
    });
    // search (debounced)
    var t = null;
    document.getElementById("search").addEventListener("input", function (e) {
      var v = e.target.value;
      clearTimeout(t);
      t = setTimeout(function () { filters.q = v.trim(); shown = PAGE; renderTable(); }, 300);
    });
    // show more
    document.getElementById("btn-more").addEventListener("click", function () {
      shown += PAGE; renderTable();
    });
    // flagged KPI -> isolate all flagged everywhere
    var kf = document.getElementById("kpi-flagged");
    function isolateFlagged() {
      filters.flagged = true; filters.market = "BOTH"; filters.days = 99; filters.status = "ALL";
      document.getElementById("chk-flagged").checked = true;
      setSeg("seg-market", "data-market", "BOTH");
      setSeg("seg-range", "data-days", 99);
      document.getElementById("sel-status").value = "ALL";
      sort = { key: "default", dir: "desc" }; shown = PAGE; renderTable();
    }
    kf.addEventListener("click", isolateFlagged);
    kf.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); isolateFlagged(); } });
  }

  // ---- boot ---------------------------------------------------------------

  function boot() {
    skeleton();
    wire();
    Promise.all([
      loadJson("metadata.json", null),
      loadJson("signals.json", { signals: [] }),
    ]).then(function (r) {
      META = r[0];
      var grouped = { US: [], IN: [] };
      (((r[1] && r[1].signals) || [])).forEach(function (s) {
        if (!grouped[s.market]) grouped[s.market] = [];
        grouped[s.market].push(s);
      });
      ALL = grouped;
      renderFreshness();
      renderTrail();
      renderTable();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
