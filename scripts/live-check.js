import { createNightshiftClient } from "../src/backends/nightshift.js";

const env = process.env;
const client = createNightshiftClient(env);
const credential = client.resolveCredential();

function line(label, value) {
  console.log(String(label).padEnd(26, " ") + value);
}

console.log("NIGHTSHIFT LIVE CHECK");
line("runtime", client.base);
line("app id", client.appId);
line("credential", credential.source === "env" ? "from environment" : credential.source === "none" ? "NOT FOUND" : "from local runtime token file");
line("requested model", env.NIGHTSHIFT_MODEL || client.defaultModel);

if (credential.source === "none") {
  console.log("\nFAIL  no credential available; start Meterless Nightshift or set NIGHTSHIFT_API_KEY");
  process.exit(1);
}

let lanes;
try {
  lanes = await client.models();
} catch (error) {
  console.log(`\nFAIL  GET /v1/models — ${error.message}`);
  process.exit(1);
}
line("lanes published", String(lanes.length));
const nemotron = lanes.filter((l) => /nemotron/i.test(l.id) || /nemotron/i.test(l.name || ""));
line("nemotron lanes", nemotron.length ? nemotron.map((l) => l.id).slice(0, 4).join(", ") : "none");

const model = env.NIGHTSHIFT_MODEL || nemotron[0]?.id || "meterless/auto";
line("lane for request", model);

try {
  const result = await client.complete({
    model,
    messages: [
      { role: "system", content: "You are a terse test probe. Answer exactly as asked." },
      { role: "user", content: "Reply with the single word: ready" },
    ],
    maxTokens: 40,
    timeoutMs: 120_000,
  });
  line("reply", JSON.stringify(result.text.trim().slice(0, 120)));
  line("handled by", result.route.handledBy);
  line("provider model", result.route.provider || "-");
  line("request id", result.route.requestId || "-");
  line("latency", `${result.latencyMs} ms`);
  line("tokens", `${result.usage.prompt_tokens || "?"} in / ${result.usage.completion_tokens || "?"} out`);
  console.log("\nPASS  a real request passed through Nightshift and returned a result");
} catch (error) {
  if (error.code === "no_provider_configured") {
    console.log("\nBLOCKED  Nightshift is reachable but no model provider is configured.");
    console.log("           Add a cloud key in Nightshift Setup > Providers, or install a local model.");
    process.exit(2);
  }
  console.log(`\nFAIL  ${error.message}`);
  process.exit(1);
}
