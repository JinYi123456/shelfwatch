#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = path.join(root, "examples");
const logsDir = path.join(root, "logs");
const cli = path.join(root, "src", "cli", "shift.js");

const failures = [];
const notes = [];

function check(ok, label, detail = "") {
  if (ok) {
    notes.push(`ok    ${label}`);
    return true;
  }
  failures.push(`FAIL  ${label}${detail ? " — " + detail : ""}`);
  return false;
}

function runScenario(file) {
  const res = spawnSync(process.execPath, [cli, "--scenario", file], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SAMPLE_MODE: "true" },
  });
  if (res.status !== 0) {
    return { error: `exit ${res.status}: ${(res.stderr || "").split("\n").pop()}` };
  }
  try {
    return { result: JSON.parse(res.stdout) };
  } catch (err) {
    return { error: `stdout is not a single JSON document: ${err.message}` };
  }
}

const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
check(files.length >= 3, "at least three scenarios in examples/", `found ${files.length}`);

const results = new Map();
for (const f of files) {
  const { result, error } = runScenario(path.join(examplesDir, f));
  if (!check(!error, `scenario ${f} runs and stdout parses as JSON`, error || "")) continue;
  results.set(f, result);

  check(
    typeof result.reasoning_backend === "string" && result.reasoning_backend.length > 0,
    `${f}: records reasoning_backend`,
    result.reasoning_backend
  );
  check(result.sample_mode === true, `${f}: ran in sample mode`);

  const below = (result.pull_list || []).filter(
    (a) => typeof a.confidence === "number" && a.confidence < 0.7 && a.status !== "escalated"
  );
  check(below.length === 0, `${f}: nothing below the 0.70 floor was auto-actioned`,
    below.map((b) => `${b.action_id}@${b.confidence}`).join(", "));

  const logFile = result.log_path && fs.existsSync(result.log_path) ? result.log_path : null;
  if (check(!!logFile, `${f}: JSONL trace file exists`, result.log_path)) {
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const actions = new Set(lines.map((l) => l.action));
    const agents = new Set(lines.map((l) => l.agent));
    check(actions.has("delegate"), `${f}: trace contains a delegate handoff`);
    check(agents.size >= 3, `${f}: trace shows at least three agents`, [...agents].join(", "));
    check(lines.length >= 5, `${f}: trace has multiple records`, String(lines.length));
    if (f.includes("low-confidence")) {
      check(actions.has("escalate"), "low-confidence scenario: trace contains an escalation");
    }
  }
}

const statStrings = new Set(
  [...results.values()].map((r) => JSON.stringify(r.stats))
);
check(
  results.size >= 3 && statStrings.size === results.size,
  "anti-hardcoding: every scenario produces different stats",
  [...statStrings].join(" | ")
);

const server = spawn(process.execPath, [path.join(root, "src", "server.js")], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, SAMPLE_MODE: "true" },
});
let serverOutput = "";
server.stderr.on("data", (d) => (serverOutput += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try {
      const h = await fetch("http://127.0.0.1:8787/health");
      if (h.ok) { up = true; break; }
    } catch {
      /* not listening yet */
    }
  }
  check(up, "server starts and answers GET /health", serverOutput.slice(0, 200));

  if (up) {
    const body = fs.readFileSync(path.join(examplesDir, files[0]), "utf8");
    const r = await fetch("http://127.0.0.1:8787/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const j = await r.json().catch(() => null);
    check(r.status === 200 && j && Array.isArray(j.pull_list), "POST /run returns a result document");
    const bad = await fetch("http://127.0.0.1:8787/not-a-route");
    check(bad.status === 404, "unknown route is rejected with 404");
  }
} catch (err) {
  check(false, "server checks completed", err.message);
} finally {
  server.kill();
}

console.log(notes.join("\n"));
if (failures.length) {
  console.error("\n" + failures.join("\n"));
  console.error(`\nVERIFY FAILED — ${failures.length} problem(s).`);
  process.exit(1);
}
console.log("\nVERIFY PASSED");
