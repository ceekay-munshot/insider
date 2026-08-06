// Cloudflare Worker entry point.
//
// Serves the static ./public site via the ASSETS binding and exposes a tiny API
// surface. Secret keys (Finnhub, muns, LLM) will live in Worker env vars and back
// private routes added in later steps — never shipped to the browser.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check.
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    // TODO(step 3+): private data routes that use secret keys server-side,
    // e.g. GET /api/prices?ticker=... proxying Finnhub/muns without exposing keys.
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: "not_implemented" }, { status: 404 });
    }

    // Everything else: static assets from ./public.
    return env.ASSETS.fetch(request);
  },
};
