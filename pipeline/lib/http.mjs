// http.mjs — fetch helpers with exponential-backoff retry.
//
// Node 22 has a global fetch, so no dependency needed. Transient failures
// (network errors, HTTP 429, HTTP 5xx) are retried 4 times with the backoff
// schedule below; other 4xx statuses fail fast (retrying won't help).

const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000]; // 2s, 4s, 8s, 16s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Core fetch with retry. Returns a Response for 2xx; throws after exhausting retries.
async function fetchWithRetry(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      // Retry transient statuses; fail fast on everything else (e.g. 400/401/404).
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      } else {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `[http] retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay}ms — ${lastErr.message}`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

// GET/POST JSON and parse the response body as JSON.
export async function fetchJson(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  return res.json();
}

// Fetch and return the response body as text (HTML scrapes, CSV, etc.).
export async function fetchText(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}
