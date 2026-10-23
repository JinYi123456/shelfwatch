#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runShift } from "../pipeline/run-shift.js";

function parseArgs(argv) {
  const out = { scenario: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario" || a === "-s") {
      out.scenario = argv[++i];
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage: npm run shift -- --scenario <file>",
    "",
    "Runs one overnight triage scenario. Writes JSON to stdout summary",
    "channel via the final object, and a JSONL trace under logs/.",
    "No interactive prompts. SAMPLE_MODE defaults to true (OfflineBackend).",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + "\n");
    process.exit(0);
  }
  if (!args.scenario) {
    process.stderr.write(usage() + "\n");
    process.exit(2);
  }

  const filePath = path.resolve(args.scenario);
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`Scenario not found: ${filePath}\n`);
    process.exit(2);
  }

  let scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    process.stderr.write(`Invalid scenario JSON: ${err.message}\n`);
    process.exit(2);
  }

  const result = await runShift(scenario);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
