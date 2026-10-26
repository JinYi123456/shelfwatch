import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDataLayer, QUERY_NAMES, QUERY_CONTRACT } from "../src/data/index.js";
import { SOURCES } from "../src/data/sources.js";
import { renderStatement } from "../src/data/zetaris-adapter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const usqlDir = path.join(root, "usql");

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`ok    ${name}${detail ? `  ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}  ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const cacheFiles = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));

await check("every cached source is present", () => {
  const expected = SOURCES.map((s) => path.basename(s.cache_file));
  const missing = expected.filter((f) => !cacheFiles.includes(f));
  assert(missing.length === 0, `missing cache files: ${missing.join(", ")}`);
  return `${expected.length} files`;
});

for (const file of cacheFiles) {
  await check(`${file} carries provenance and is within the size cap`, () => {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    const rows = doc.rows || doc.records || [];
    assert(typeof doc.source_id === "string", "no source_id");
    assert(typeof doc.endpoint === "string" && doc.endpoint.length > 8, "no endpoint");
    assert(!Number.isNaN(Date.parse(doc.fetched_at)), "fetched_at is not a timestamp");
    assert(Number.isInteger(doc.record_count), "record_count is not an integer");
    assert(doc.record_count === rows.length, `record_count ${doc.record_count} != ${rows.length} rows`);
    assert(rows.length <= (doc.max_records || 60), `over the size cap (${rows.length})`);
    assert(rows.length > 0, "empty cache");
    return `${rows.length} records, fetched ${doc.fetched_at.slice(0, 10)}`;
  });
}

await check("Open Food Facts rows carry ODbL attribution", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dataDir, "open-food-facts.json"), "utf8"));
  const text = JSON.stringify(doc);
  assert(/ODbL|Open Database Licence/i.test(text), "licence not recorded");
  assert(/Open Food Facts/i.test(text), "attribution not recorded");
  const withoutAttribution = (doc.rows || []).filter((r) => !r.attribution);
  assert(withoutAttribution.length === 0, `${withoutAttribution.length} rows lack attribution`);
  return "attribution on every row";
});

await check("the donation ledger is labelled synthetic", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dataDir, "donation-ledger.json"), "utf8"));
  const text = JSON.stringify(doc).toLowerCase();
  assert(text.includes("synthetic"), "not labelled synthetic");
  assert(/local:|generated/.test(doc.endpoint), "endpoint does not say it was generated locally");
  return `${doc.record_count} synthetic holdings`;
});

await check("no cached row holds a credential", () => {
  const secret = /(api[_-]?key|bearer|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/i;
  const hits = [];
  for (const file of cacheFiles) {
    const text = fs.readFileSync(path.join(dataDir, file), "utf8");
    if (secret.test(text)) hits.push(file);
  }
  assert(hits.length === 0, `credential-shaped text in ${hits.join(", ")}`);
  return `${cacheFiles.length} files scanned`;
});

const layer = createDataLayer({});

await check("data layer runs offline and exposes the full query contract", () => {
  assert(layer.backend === "local", `backend is ${layer.backend}`);
  assert(layer.queryNames.join(",") === QUERY_NAMES.join(","), "query names disagree");
  return QUERY_NAMES.length + " queries";
});

await check("every query name has a statement file and a documented contract", () => {
  for (const name of QUERY_NAMES) {
    const file = path.join(usqlDir, `${name}.sql`);
    assert(fs.existsSync(file), `no statement for ${name}`);
    assert(QUERY_CONTRACT[name], `no parameter contract for ${name}`);
  }
  return `${QUERY_NAMES.length} statements + contracts`;
});

await check("every statement renders, stays one statement and rejects injection", async () => {
  const params = {
    names: ["whole wheat bread", "O'Gill's"],
    brands: ["Dave's Killer Bread"],
    barcodes: ["0013764027053"],
    lots: ["LOT-1"],
    keywords: ["listeria"],
    classes: ["I"],
    jurisdictions: ["CA"],
    limit: 10,
    min_score: 0.2,
    as_of: "2026-10-26",
  };
  for (const name of QUERY_NAMES) {
    const sql = fs.readFileSync(path.join(usqlDir, `${name}.sql`), "utf8");
    const rendered = renderStatement(sql, params);
    assert(!/\{\{[A-Z_]+\}\}/.test(rendered), `${name} left a token unrendered`);
    const code = rendered.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
    assert(!code.includes(";"), `${name} is not a single statement`);
    assert(/from\s+lightning\.metastore/i.test(rendered), `${name} does not read the semantic layer`);
    const hostile = renderStatement(sql, { ...params, names: ["a' OR 1=1 --"] });
    if (/\{\{NAME_(MATCH|LIST)\}\}/.test(sql)) {
      assert(hostile.includes("''"), `${name} left the quote in the names parameter unescaped`);
    }
    const quotes = (hostile.match(/'/g) || []).length;
    assert(quotes % 2 === 0, `${name} ends with unbalanced quoting after parameter substitution`);
  }
  return `${QUERY_NAMES.length} statements rendered`;
});

const exampleDir = path.join(root, "examples");
const scenarioFiles = fs.readdirSync(exampleDir).filter((f) => f.endsWith(".json"));

await check("the same query on different scenarios returns different rows", async () => {
  const fingerprints = new Set();
  for (const file of scenarioFiles) {
    const scenario = JSON.parse(fs.readFileSync(path.join(exampleDir, file), "utf8"));
    const names = scenario.notices.map((n) => n.product_name);
    const brands = scenario.notices.map((n) => n.brand).filter(Boolean);
    const result = await layer.query("reconcile_signals", { names, brands, limit: 5 });
    assert(Array.isArray(result.rows), `${file}: reconcile_signals returned no rows array`);
    const fp = result.rows.map((r) => `${r.identity_key}:${r.corroborating_sources}`).join("|");
    assert(fp.length > 0, `${file}: empty fingerprint`);
    fingerprints.add(fp);
  }
  assert(
    fingerprints.size === scenarioFiles.length,
    `only ${fingerprints.size} distinct results for ${scenarioFiles.length} scenarios`
  );
  return `${fingerprints.size} distinct reconciliation shapes`;
});

await check("source_coverage reports every source and its freshness", async () => {
  const result = await layer.query("source_coverage", {});
  assert(result.rows.length === SOURCES.length, `expected ${SOURCES.length} rows, got ${result.rows.length}`);
  const unavailable = result.rows.filter((r) => !r.available).map((r) => r.source_id);
  assert(unavailable.length === 0, `unavailable sources: ${unavailable.join(", ")}`);
  return `${result.rows.length} sources covered`;
});

await check("the Zetaris adapter refuses to answer without configuration", () => {
  let message = "";
  try {
    createDataLayer({}, { forceBackend: "zetaris" });
  } catch (error) {
    message = error.message;
  }
  assert(/not all set|not configured/i.test(message), `unexpected failure: ${message || "none"}`);
  return message.slice(0, 60);
});

await check("nothing in the data layer mentions an event or a development tool", () => {
  const banned = /hackathon|open agent|genai\.works|judge|sponsor prize|submission|qoder|cursor|loopwright/i;
  const scanned = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|sql|usql|md|json)$/.test(entry.name)) {
        scanned.push(p);
        if (banned.test(fs.readFileSync(p, "utf8"))) throw new Error(`banned reference in ${p}`);
      }
    }
  };
  walk(path.join(root, "src", "data"));
  walk(usqlDir);
  return `${scanned.length} files clean`;
});

console.log("");
if (failures) {
  console.log(`DATA CHECK FAILED (${failures})`);
  process.exit(1);
}
console.log("DATA CHECK PASSED");
