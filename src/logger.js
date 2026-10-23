import fs from "node:fs";
import path from "node:path";

/**
 * Structured run logger: every record goes to stderr and to
 * logs/run-<timestamp>.jsonl. stdout is reserved for the machine-readable
 * result document, so a caller can pipe it straight into a JSON parser.
 */
export function createLogger(logsDir = path.resolve("logs")) {
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logsDir, `run-${stamp}.jsonl`);
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  function write(record) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...record,
    });
    stream.write(line + "\n");
    process.stderr.write(line + "\n");
  }

  return {
    path: logPath,
    event(fields) {
      write(fields);
    },
    close() {
      return new Promise((resolve) => stream.end(resolve));
    },
  };
}
