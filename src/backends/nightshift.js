import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:8088";
const RETRY_DELAY_MS = 1000;

function stateDir(env) {
  if (env.METERLESS_STATE_DIR) return env.METERLESS_STATE_DIR;
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "ai.meterless.runtime");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ai.meterless.runtime");
  }
  return "/var/lib/meterless";
}

export function resolveCredential(env = process.env) {
  const fromEnv = (env.NIGHTSHIFT_API_KEY || env.METERLESS_TOKEN || "").trim();
  if (fromEnv && !fromEnv.startsWith("REPLACE_")) return { token: fromEnv, source: "env" };
  const file = env.NIGHTSHIFT_TOKEN_FILE || path.join(stateDir(env), "proxy-token");
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token) return { token, source: file };
  } catch {}
  return { token: "", source: "none" };
}

export function createNightshiftClient(env = process.env, fetchImpl = globalThis.fetch) {
  const base = (env.NIGHTSHIFT_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const appId = env.NIGHTSHIFT_APP || "shelfwatch";
  const defaultModel = env.NIGHTSHIFT_MODEL || "meterless/auto";

  function headers() {
    const { token } = resolveCredential(env);
    if (!token) {
      throw new Error(
        "No Nightshift credential: set NIGHTSHIFT_API_KEY (or METERLESS_TOKEN), " +
          "or run Meterless Nightshift on this machine."
      );
    }
    return {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "meterless-app": appId,
      "meterless-scope": env.NIGHTSHIFT_SCOPE || "user",
    };
  }

  async function request(method, endpoint, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(base + endpoint, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? safeJson(text) : {};
      if (response.status === 429) {
        if (timeoutMs > RETRY_DELAY_MS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          return request(method, endpoint, body, timeoutMs - RETRY_DELAY_MS);
        }
        throw new Error("Nightshift rate limited the request (429).");
      }
      if (!response.ok) {
        const detail = parsed?.error?.meterless_detail || parsed?.error?.message || text.slice(0, 200);
        const err = new Error(`Nightshift ${method} ${endpoint} failed (${response.status}): ${detail}`);
        err.status = response.status;
        err.code = parsed?.error?.code || parsed?.error?.meterless_detail || "http_error";
        throw err;
      }
      return { parsed, elapsedMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  async function models() {
    const { parsed } = await request("GET", "/v1/models", undefined, 10_000);
    return (parsed.data || []).map((m) => ({
      id: m.id,
      name: m.meterless?.name,
      disposition: m.meterless?.disposition,
      contextWindow: m.contextWindow,
    }));
  }

  async function complete({ model, messages, maxTokens = 900, temperature = 0.2, timeoutMs = 90_000, reasoningEffort } = {}) {
    const requested = model || defaultModel;
    const payload = { model: requested, messages, max_tokens: maxTokens, temperature, stream: false };
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
    const { parsed, elapsedMs } = await request("POST", "/v1/chat/completions", payload, timeoutMs);
    const choice = parsed.choices?.[0];
    if (!choice?.message?.content) throw new Error(`Nightshift returned no content for ${requested}.`);
    const route = parsed.meterless || {};
    return {
      text: String(choice.message.content),
      finishReason: choice.finish_reason,
      reasoning: choice.message.reasoning_content,
      usage: parsed.usage || {},
      latencyMs: elapsedMs,
      route: {
        requested: route.requested_model || requested,
        provider: route.provider_model || null,
        handledBy: route.routed_model || route.provider_model || parsed.model || requested,
        requestId: route.request_id || parsed.id || null,
        mode: route.mode || null,
      },
    };
  }

  return { base, appId, defaultModel, models, complete, resolveCredential: () => resolveCredential(env) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
