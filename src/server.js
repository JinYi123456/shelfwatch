#!/usr/bin/env node
import http from "node:http";
import { runShift } from "./pipeline/run-shift.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

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

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, service: "shelfwatch" });
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
      detail: { endpoints: ["POST /run", "GET /health"] },
    }) + "\n"
  );
});
