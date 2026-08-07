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

  // Defaults on open: India · next 3 days · Upcoming · sorted by soonest earnings.
  var DEFAULT_SORT = { key: "earnings", dir: "asc" };
  var filters = { market: "IN", days: 3, status: "pre_earnings", flagged: false, q: "" };
  var sort = { key: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir };
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

  // Relative countdown to a future instant: "in 5h", "in 2d", "now".
  function countdown(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "now";
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return "in " + d + "d";
    if (h >= 1) return "in " + h + "h";
    return "in " + Math.max(1, m) + "m";
  }

  // Short date in the market's timezone, e.g. "Aug 11".
  function fmtShortTZ(iso, market) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString("en-US", { timeZone: MARKET_TZ[market] || "UTC", day: "numeric", month: "short" });
    } catch (e) {
      return "";
    }
  }

  // Relative day to an earnings DATE (date-only): "today" / "tomorrow" / "in 2d".
  // null if the date is past or unparseable.
  function relDay(dateStr) {
    var off = daysFrom(dateStr);
    if (off === null || off < 0) return null;
    if (off === 0) return "today";
    if (off === 1) return "tomorrow";
    return "in " + off + "d";
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
      case "earnings": return Date.parse((s.earnings_date || "9999-12-31") + "T00:00:00Z") || Infinity;
      case "concall": return s.concall_datetime_utc ? Date.parse(s.concall_datetime_utc) : Infinity;
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
        return cmp(a, b, "earnings", "asc");
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
    cols.push({ key: "earnings", label: "Earnings" });
    cols.push({ key: "concall", label: "Concall", cls: "hide-sm" });
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

  var EXT_SVG =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';

  // Earnings = the RESULT: its date always, plus the real filing time once the
  // result is confirmed out (US shows its session bucket). For upcoming names we
  // append a relative-day hint ("tomorrow"), since the exact result time is not
  // published in advance — only the date is.
  function earningsCell(s) {
    var kids = [UI.el("span", { class: "edate", text: fmtDate(s.earnings_date) })];
    var suffix = null;
    var strong = false;
    if (s.earnings_time_confirmed) {
      var t = fmtClock(s.earnings_datetime_utc, s.market);
      if (t) { suffix = t; strong = true; } // actual filing time
    }
    if (suffix === null && s.market === "US" && s.timing && s.timing !== "UNKNOWN") {
      suffix = s.timing; strong = true; // US session bucket (BMO/AMC)
    }
    if (suffix === null) suffix = relDay(s.earnings_date); // upcoming: "tomorrow"/"in 2d"
    if (suffix) kids.push(UI.el("span", { class: strong ? "etime" : "cd", text: " · " + suffix }));
    return UI.el("td", { class: "when" }, kids);
  }

  // Concall = the (usually later) management call: its OWN date + time + live
  // countdown + a link to the invite. Its own date is shown so it never conflicts
  // with the earnings date. "—" when we have no concall for this name.
  function concallCell(s) {
    if (!s.concall_datetime_utc) return UI.el("td", { class: "hide-sm" }, [UI.el("span", { class: "dash", text: "—" })]);
    var t = fmtClock(s.concall_datetime_utc, s.market);
    var d = fmtShortTZ(s.concall_datetime_utc, s.market);
    var kids = [UI.el("span", { class: "mono", title: s.concall_title || "Scheduled concall", text: d + " · " + t })];
    var cd = countdown(s.concall_datetime_utc);
    if (cd) kids.push(UI.el("span", { class: "cd", "data-iso": s.concall_datetime_utc, text: " · " + cd }));
    if (s.concall_url)
      kids.push(UI.el("a", { class: "ext", href: s.concall_url, target: "_blank", rel: "noopener", title: "Open concall invite", html: EXT_SVG }));
    return UI.el("td", { class: "when hide-sm" }, kids);
  }

  function signalRow(s) {
    var tds = [];
    if (filters.market === "BOTH")
      tds.push(UI.el("td", {}, [UI.el("span", { class: "mkt " + s.market, text: s.market === "IN" ? "IN" : "US" })]));
    tds.push(tickerCell(s));
    tds.push(UI.el("td", { class: "company hide-sm", title: s.company || "" , text: s.company || "—" }));
    tds.push(earningsCell(s));
    tds.push(concallCell(s));
    tds.push(moveCell(s.change_1d_pct));
    tds.push(UI.el("td", { class: "num mono", text: s.price == null ? "—" : UI.fmtNum(s.price) }));
    tds.push(statusCell(s));
    return UI.el("tr", { class: s.flagged ? "flagged" : "" }, tds);
  }

  function skeleton() {
    var tbody = document.getElementById("tbody");
    UI.clear(tbody);
    var ncol = columns().length;
    for (var i = 0; i < 8; i++) {
      var tds = [];
      for (var c = 0; c < ncol; c++) tds.push(UI.el("td", { class: "sk-row" }, [UI.el("div", { class: "shimmer sk-bar", style: "width:" + (40 + ((i * 7 + c) % 5) * 12) + "%" })]));
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

  // ---- alerts (preview) ---------------------------------------------------
  // An alert = a name reporting TODAY that FLAGGED (ran up ≥3% before earnings)
  // and hasn't reported yet — i.e. actionable right now. Future dates aren't
  // alerts yet; they surface on their own day. Previews the email payload;
  // actual sending is wired later (pipeline step 04).

  function alertQueue() {
    return ALL.IN.concat(ALL.US)
      .filter(function (s) {
        return s.flagged && s.status !== "reported" && daysFrom(s.earnings_date) === 0;
      })
      .sort(function (a, b) { return (num(b.change_1d_pct) || -1e9) - (num(a.change_1d_pct) || -1e9); });
  }

  function money(s) {
    if (s.price == null) return "";
    return (s.market === "IN" ? "₹" : "$") + UI.fmtNum(s.price);
  }

  function renderAlertBadge() {
    var n = alertQueue().length;
    var badge = document.getElementById("alert-count");
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
  }

  function alertItem(s) {
    // Headline = the pre-earnings RUN-UP that triggered the flag (peak while
    // pre_earnings), which is what "flagged before earnings" means — always
    // positive. The live 1D can differ (may have pulled back); shown below.
    var runup = num(s.peak_change_1d_pct);
    if (runup === null) runup = num(s.change_1d_pct) || 0;
    var head = UI.el("div", { class: "ai-head" }, [
      UI.el("span", { class: "mkt " + s.market, text: s.market }),
      UI.el("span", { class: "ai-tk", text: s.ticker || "—" }),
      UI.el("span", { class: "move pos big", title: "Pre-earnings run-up", text: "▲ +" + runup.toFixed(2) + "%" }),
    ]);
    var lines = [];
    if (s.company) lines.push(s.company);
    var when = fmtDate(s.earnings_date);
    var rd = relDay(s.earnings_date); if (rd) when += " (" + rd + ")";
    lines.push("Earnings: " + when);
    if (s.concall_datetime_utc)
      lines.push("Concall: " + fmtShortTZ(s.concall_datetime_utc, s.market) + " · " + fmtClock(s.concall_datetime_utc, s.market));
    // live move, so a pulled-back name reads honestly (e.g. ran up +4.95%, now -3.82%)
    var live = num(s.change_1d_pct);
    if (live !== null) lines.push("Now: " + (live > 0 ? "+" : "") + live.toFixed(2) + "%");
    if (s.price != null) lines.push("Price: " + money(s));
    var body = UI.el("div", { class: "ai-body" }, lines.map(function (t) { return UI.el("div", { text: t }); }));
    return UI.el("div", { class: "alert-item" }, [head, body]);
  }

  function openAlerts() {
    var q = alertQueue();
    var body = document.getElementById("alerts-body");
    UI.clear(body);
    if (q.length === 0) {
      body.appendChild(UI.el("div", { class: "state" }, [
        UI.el("div", { class: "msg", text: "No alerts for today" }),
        UI.el("div", { class: "hint", text: "A name lands here when it reports today AND ran up ≥3% beforehand. Upcoming dates show on their own day." }),
      ]));
    } else {
      q.forEach(function (s) { body.appendChild(alertItem(s)); });
    }
    document.getElementById("alerts-count-line").textContent =
      q.length + " stock" + (q.length === 1 ? "" : "s") + " reporting today · flagged before earnings";
    document.getElementById("alerts-modal").hidden = false;
  }
  function closeAlerts() { document.getElementById("alerts-modal").hidden = true; }

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
      sort = { key: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir };
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
      sort = { key: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir }; shown = PAGE; renderTable();
    }
    kf.addEventListener("click", isolateFlagged);
    kf.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); isolateFlagged(); } });

    // reflect the default status in the dropdown
    document.getElementById("sel-status").value = filters.status;

    // alerts preview
    document.getElementById("btn-alerts").addEventListener("click", openAlerts);
    document.getElementById("alerts-close").addEventListener("click", closeAlerts);
    document.getElementById("alerts-modal").addEventListener("click", function (e) {
      if (e.target.id === "alerts-modal") closeAlerts(); // backdrop click
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAlerts(); });
  }

  // ---- boot ---------------------------------------------------------------

  function boot() {
    skeleton();
    wire();
    // Keep scheduled-time countdowns live without re-fetching.
    setInterval(function () {
      Array.prototype.forEach.call(document.querySelectorAll(".cd[data-iso]"), function (el) {
        el.textContent = " · " + countdown(el.getAttribute("data-iso"));
      });
    }, 60000);
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
      renderAlertBadge();
      renderTable();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
