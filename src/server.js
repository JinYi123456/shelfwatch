#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShift } from "./pipeline/run-shift.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(repoRoot, "public");
const logsDir = path.join(repoRoot, "logs");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        reject(new Error("Empty body."));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Body must be JSON: " + err.message));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Maps a request path onto a file inside public/, or null when it escapes it. */
function staticFile(urlPath) {
  const raw = urlPath.split("?")[0].split("#")[0];
  let rel;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const target = path.resolve(publicDir, rel === "/" ? "index.html" : rel.slice(1));
  const prefix = publicDir + path.sep;
  return target === publicDir || target.startsWith(prefix) ? target : null;
}

function serveStatic(req, res, urlPath) {
  const file = staticFile(urlPath);
  if (!file) {
    send(res, 400, { error: "Unsafe path." });
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": file.startsWith(path.join(publicDir, "vendor"))
      ? "public, max-age=86400"
      : "no-cache",
    Vary: "Accept",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

function readTraceEvents(file) {
  const events = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* a half-written line is skipped rather than reported as an event */
    }
  }
  return events;
}

/** Every recorded night: file name, run id and the real trace lines behind it. */
function listRuns() {
  let names = [];
  try {
    names = fs.readdirSync(logsDir).filter((f) => /^run-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    const file = path.join(logsDir, name);
    let events;
    try {
      if (!fs.statSync(file).isFile()) continue;
      events = readTraceEvents(file);
    } catch {
      continue;
    }
    const opened = events.find((e) => e.action === "open_shift");
    const closed = events.find((e) => e.action === "close_shift");
    runs.push({
      file: `logs/${name}`,
      run_id: events.find((e) => e.run_id)?.run_id ?? null,
      scenario_id: opened?.target ?? closed?.target ?? null,
      reasoning_backend: opened?.detail?.reasoning_backend ?? closed?.detail?.reasoning_backend ?? null,
      started_ts: events[0]?.ts ?? null,
      finished_ts: events[events.length - 1]?.ts ?? null,
      event_count: events.length,
      events,
    });
  }
  runs.sort((a, b) => String(b.started_ts || "").localeCompare(String(a.started_ts || "")));
  return runs;
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "GET" && urlPath === "/health") {
    send(res, 200, { ok: true, service: "shelfwatch" });
    return;
  }

  if (req.method === "GET" && (urlPath === "/runs" || urlPath === "/runs/")) {
    send(res, 200, { runs: listRuns() });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (serveStatic(req, res, urlPath)) return;
    send(res, 404, { error: "Not found. Use POST /run with a scenario JSON body." });
    return;
  }

  if (req.method === "POST" && (req.url === "/run" || req.url === "/run/")) {
    try {
      const body = await readJson(req);
      const scenario = body.scenario || body;
      const result = await runShift(scenario);
      send(res, 200, result);
    } catch (err) {
      send(res, 400, { error: String(err.message || err) });
    }
    return;
  }

  send(res, 404, { error: "Not found. Use POST /run with a scenario JSON body." });
});

server.listen(port, host, () => {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      agent: "server",
      action: "listen",
      target: `http://${host}:${port}`,
      verdict: "ok",
      detail: { endpoints: ["POST /run", "GET /health", "GET /runs", "GET / (public/)"] },
    }) + "\n"
  );
});
