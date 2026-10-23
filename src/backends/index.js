import { createOfflineBackend } from "./offline.js";
import { createLlmBackend } from "./llm.js";

/**
 * Select reasoning backend. SAMPLE_MODE=true (default) uses OfflineBackend.
 * The pipeline is identical; only the backend swaps.
 */
export function selectBackend(env = process.env) {
  const sample =
    String(env.SAMPLE_MODE ?? "true").toLowerCase() !== "false";
  if (sample) {
    return { sampleMode: true, backend: createOfflineBackend() };
  }
  return { sampleMode: false, backend: createLlmBackend(env) };
}
