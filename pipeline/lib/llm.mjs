// llm.mjs — minimal multi-provider LLM client.
//
// NOT wired into the pipeline yet. This just establishes the calling pattern for
// a later step (step 6: insider + news overlay may summarize filings/headlines).
// Keys are OPTIONAL — if none are configured, callLLM throws a clear, catchable
// error so callers can degrade gracefully.
//
// Providers (in preference order):
//   - Anthropic  — header: x-api-key + anthropic-version   env: ANTHROPIC_API_KEY
//   - Mistral    — header: Authorization: Bearer            env: MISTRAL_API_KEY
//
// We call the HTTP APIs directly (no SDK) to keep the scaffold dependency-free.

import { fetchJson } from "./http.mjs";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";

const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 4096);

// Providers with a key present, in preference order.
export function availableProviders() {
  const providers = [];
  if (process.env.ANTHROPIC_API_KEY) providers.push("anthropic");
  if (process.env.MISTRAL_API_KEY) providers.push("mistral");
  return providers;
}

async function callAnthropic(system, user) {
  const data = await fetchJson(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  // `content` is an array of blocks; concatenate the text blocks.
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, provider: "anthropic" };
}

async function callMistral(system, user) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const data = await fetchJson(MISTRAL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({ model: MISTRAL_MODEL, messages }),
  });
  const text = data.choices?.[0]?.message?.content || "";
  return { text, provider: "mistral" };
}

// callLLM(system, user, opts?) -> { text, provider }
// Uses opts.provider if given, else the first available provider. Throws if no
// key is configured so callers can catch and no-op.
export async function callLLM(system, user, opts = {}) {
  const candidates = opts.provider ? [opts.provider] : availableProviders();
  if (candidates.length === 0) {
    throw new Error(
      "callLLM: no LLM provider configured (set ANTHROPIC_API_KEY or MISTRAL_API_KEY)"
    );
  }
  const provider = candidates[0];
  // TODO(step 6): fall back to the next provider on transient failure.
  if (provider === "anthropic") return callAnthropic(system, user);
  if (provider === "mistral") return callMistral(system, user);
  throw new Error(`callLLM: unknown provider "${provider}"`);
}

// extractJson(text): best-effort parse of a JSON object/array from an LLM reply,
// tolerating ```json fences and surrounding prose. Returns null on failure.
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the first {...} or [...] span in the text.
    const span = candidate.match(/[[{][\s\S]*[\]}]/);
    if (!span) return null;
    try {
      return JSON.parse(span[0]);
    } catch {
      return null;
    }
  }
}
