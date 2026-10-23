/**
 * LlmBackend — Meterless Nightshift (OpenAI-compatible).
 * Phase 1: present behind the same interface; throws if invoked without config.
 * Live calls belong in later phases once Nightshift access is verified.
 */

export function createLlmBackend(env = process.env) {
  const baseUrl = env.NIGHTSHIFT_BASE_URL || "";
  const apiKey = env.NIGHTSHIFT_API_KEY || "";
  const model = env.NIGHTSHIFT_MODEL || "";

  return {
    name: "llm",
    async proposeMatches() {
      if (!baseUrl || !apiKey || apiKey.startsWith("REPLACE_")) {
        throw new Error(
          "LlmBackend requires NIGHTSHIFT_BASE_URL and NIGHTSHIFT_API_KEY (Phase 0 access)."
        );
      }
      throw new Error(
        `LlmBackend not implemented for live calls in Phase 1 (model=${model || "unset"}).`
      );
    },
    async critique() {
      throw new Error("LlmBackend critique not implemented in Phase 1.");
    },
  };
}
