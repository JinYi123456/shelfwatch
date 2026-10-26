#!/usr/bin/env node
/* Interface guard: the page must be served locally, must carry the status strip,
   and must reference nothing outside its own origin. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const PORT = Number(process.env.UI_CHECK_PORT || 8899);
const base = `http://127.0.0.1:${PORT}`;

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

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

/* XML namespace identifiers are names, not fetches. */
const NAMESPACE_OK = /^https?:\/\/www\.w3\.org\/[A-Za-z0-9._/:-]+$/;
const REFERENCE_PATTERNS = [
  /(?:src|href)\s*=\s*["']?\s*https?:\/\//i,
  /url\(\s*["']?https?:\/\//i,
  /@import\s+["']?https?:\/\//i,
  /import(?:\s|\*)[^;]*from\s+["']https?:\/\//i,
  /(?:fetch|XMLHttpRequest|WebSocket|EventSource|open)\s*\(\s*["']https?:\/\//i,
  /new\s+Image\s*\(\s*\)\.src\s*=\s*["']https?:\/\//i,
  /document\.write\s*\(\s*["']<script[^>]*https?:\/\//i,
  /<link[^>]+rel=["']?(?:preload|preconnect|dns-prefetch|modulepreload)/i,
];

function stripComments(text, kind) {
  if (kind === "html") return text.replace(/<!--[\s\S]*?-->/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1 ");
}

function scanOfflineRule(files) {
  let offenders = 0;
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (/(^|\/)NOTICE\.txt$/.test(rel)) continue;
    const ext = path.extname(file).toLowerCase();
    const text = fs.readFileSync(file, "utf8");
    const body = [".js", ".css", ".html"].includes(ext) ? stripComments(text, ext === "html" ? "html" : "code") : text;

    const urls = body.match(/https?:\/\/[^\s"'()<>,;]*/g) || [];
    for (const u of urls) {
      if (NAMESPACE_OK.test(u)) continue;
      offenders++;
      check(false, `no external URL in ${rel}`, u.slice(0, 90));
    }

    const code = ext === ".json" || ext === ".txt" ? body : body;
    for (const re of REFERENCE_PATTERNS) {
      const m = code.match(re);
      if (!m) continue;
      if (String(m[0]).includes("http")) {
        offenders++;
        check(false, `no network resource reference in ${rel}`, String(m[0]).slice(0, 90));
      } else if (/preload|preconnect|dns-prefetch|modulepreload/.test(String(m[0]))) {
        offenders++;
        check(false, `no preload hints in ${rel}`, String(m[0]).slice(0, 90));
      }
    }
  }
  return offenders;
}

function localRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) refs.push(m[1]);
  return refs.filter((r) => !r.startsWith("data:") && !r.startsWith("#") && !/^https?:/.test(r));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Sends the request target verbatim: fetch() would normalise ../ segments and
   the traversal probe would prove nothing. */
function rawStatus(target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: target, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

const files = listFiles(publicDir);
check(files.some((f) => path.basename(f) === "index.html"), "public/index.html exists");
check(files.some((f) => path.basename(f) === "styles.css"), "public/styles.css exists");
check(files.some((f) => path.basename(f) === "app.js"), "public/app.js exists");
check(
  files.some((f) => f.endsWith(path.join("vendor", "three.min.js"))),
  "public/vendor/three.min.js is vendored, not fetched"
);
check(
  files.some((f) => f.endsWith(path.join("vendor", "OrbitControls.js"))),
  "public/vendor/OrbitControls.js is vendored"
);
check(
  files.some((f) => f.endsWith(path.join("vendor", "NOTICE.txt"))),
  "public/vendor/NOTICE.txt records upstream and licence"
);
scanOfflineRule(files);

const server = spawn(process.execPath, [path.join(root, "src", "server.js")], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, SAMPLE_MODE: "true", PORT: String(PORT) },
});
let stderr = "";
server.stderr.on("data", (d) => (stderr += d.toString()));

try {
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(200);
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {
      /* not listening yet */
    }
  }
  check(up, "server answers GET /health", stderr.slice(0, 200));

  const home = await fetch(`${base}/`);
  const html = await home.text();
  check(home.status === 200, "GET / returns 200", String(home.status));
  check(/text\/html/.test(home.headers.get("content-type") || ""), "GET / is served as text/html", home.headers.get("content-type"));
  check(/<html lang="en"/.test(html), "document is English-marked");

  for (const [route, type] of [
    ["/app.js", "text/javascript"],
    ["/styles.css", "text/css"],
    ["/vendor/three.min.js", "text/javascript"],
    ["/vendor/OrbitControls.js", "text/javascript"],
    ["/example-scenario.json", "application/json"],
  ]) {
    const r = await fetch(base + route);
    check(r.status === 200, `GET ${route} returns 200`, String(r.status));
    check(
      (r.headers.get("content-type") || "").includes(type),
      `GET ${route} content type is ${type}`,
      r.headers.get("content-type")
    );
    await r.text();
  }

  const missing = localRefs(html).filter((ref) => {
    const clean = ref.split("?")[0].replace(/^\//, "");
    return !fs.existsSync(path.join(publicDir, clean));
  });
  check(missing.length === 0, "every local asset referenced by index.html exists on disk", missing.join(", "));

  for (const id of ["stMode", "stConformance", "stBackend", "stActions", "stEscalations", "status"]) {
    check(html.includes(`id="${id}"`), `status strip field present in served HTML: #${id}`);
  }
  check(/aria-live="polite"/.test(html), "trace feed is announced through aria-live");
  check(/scrollbar-width/.test(html) || (await (await fetch(`${base}/styles.css`)).text()).includes("scrollbar-width"), "scrollbars are restyled in CSS");
  check(!/hackathon|competition|judge|sponsor|submission|judging/i.test(html), "no event or judging copy in the page");

  const runs = await fetch(`${base}/runs`);
  const runsBody = await runs.json().catch(() => null);
  check(runs.status === 200 && Array.isArray(runsBody?.runs), "GET /runs returns a list of runs");
  if (runsBody?.runs?.length) {
    const first = runsBody.runs[0];
    check(typeof first.run_id === "string" && first.run_id.length > 0, "/runs carries the run id");
    check(typeof first.file === "string" && /^logs\/run-.*\.jsonl$/.test(first.file), "/runs names the trace file", first.file);
    check(Array.isArray(first.events) && first.events.length > 0, "/runs returns the real trace events", String(first.events?.length));
  }

  for (const bad of ["/../package.json", "/%2e%2e%2fpackage.json", "/..%5csrc%5cserver.js", "/%2e%2e/%2e%2e/package.json", "/%2e%2e%2f%2e%2e%2fREADME.md", "/%zz-malformed", "/%00/package.json"]) {
    const status = await rawStatus(bad);
    check(status === 404 || status === 400, `directory traversal refused on ${bad}`, String(status));
  }
  check((await fetch(`${base}/not-a-route`)).status === 404, "unknown route is still a 404");

  const scenario = JSON.parse(fs.readFileSync(path.join(root, "examples", "scenario-class-i-pull.json"), "utf8"));
  const run = await fetch(`${base}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(scenario) });
  const doc = await run.json().catch(() => null);
  check(run.status === 200 && Array.isArray(doc?.pull_list), "POST /run still returns a run document");
  if (doc) {
    check(typeof doc.reasoning_backend === "string", "run document records the reasoning backend");
    const matched = (await (await fetch(`${base}/runs`)).json()).runs.find((r) => r.run_id === doc.run_id);
    check(!!matched, "the new run's trace is listed by GET /runs so the page can replay it");
  }
} catch (err) {
  check(false, "interface checks completed", err.message);
} finally {
  server.kill();
}

console.log(notes.join("\n"));
if (failures.length) {
  console.error("\n" + failures.join("\n"));
  console.error(`\nUI CHECK FAILED — ${failures.length} problem(s).`);
  process.exit(1);
}
console.log("\nUI CHECK PASSED");
