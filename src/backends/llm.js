/**
 * LlmBackend — Meterless Nightshift (OpenAI-compatible).
 * Present behind the same interface as OfflineBackend. Live calls are wired when
 * NIGHTSHIFT_BASE_URL and NIGHTSHIFT_API_KEY are configured.
 */

export function createLlmBackend(env = process.env) {
  const baseUrl = env.NIGHTSHIFT_BASE_URL || "";
  const apiKey = env.NIGHTSHIFT_API_KEY || "";
  const model = env.NIGHTSHIFT_MODEL || "";

  function requireConfig() {
    if (!baseUrl || !apiKey || apiKey.startsWith("REPLACE_")) {
      throw new Error(
        "LlmBackend requires NIGHTSHIFT_BASE_URL and NIGHTSHIFT_API_KEY."
      );
    }
  }

  return {
    name: "llm",
    async proposeMatches() {
      requireConfig();
      throw new Error(
        `LlmBackend live calls are not implemented yet (model=${model || "unset"}).`
      );
    },
    async critique() {
      requireConfig();
      throw new Error("LlmBackend live critique is not implemented yet.");
    },
  };
}
