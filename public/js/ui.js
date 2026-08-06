// ui.js — tiny DOM + formatting helpers. No dependencies.
// Exposed as window.RadarUI so app.js (a classic script) can use it.
(function (global) {
  "use strict";

  // 3.2 -> "+3.2%", -1 -> "-1.00%", null -> "—".
  function fmtPct(n, digits) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    digits = digits == null ? 2 : digits;
    var num = Number(n);
    return (num > 0 ? "+" : "") + num.toFixed(digits) + "%";
  }

  // 1234.5 -> "1,234.50", null -> "—".
  function fmtNum(n, digits) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    digits = digits == null ? 2 : digits;
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  // el("td", { class: "p-2", text: "hi" }, [childNodes]) -> HTMLElement.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.indexOf("on") === 0 && typeof v === "function")
        node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    });
    var kids = children == null ? [] : Array.isArray(children) ? children : [children];
    kids.forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Remove all child nodes of `node`.
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  global.RadarUI = { fmtPct: fmtPct, fmtNum: fmtNum, el: el, clear: clear };
})(window);
