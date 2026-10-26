/**
 * Zetaris adapter - executes the named reconciliation queries against a live
 * Zetaris instance over the Lightning SQL REST endpoint.
 *
 * Contract (from the platform documentation):
 *   POST {ZETARIS_BASE_URL}/sql-editor/sqls/run
 *   Authorization: Bearer <ZETARIS_API_KEY>, X-Org-ID: <ZETARIS_ORG_ID>,
 *   X-Request-ID: a fresh UUID per call
 *   one statement per call; a multi-table COMPILE USL payload is sent intact
 *   HTTP 429: wait 60 seconds and retry that statement once
 *
 * Unconfigured environments throw. This module never returns invented rows.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const USQL_DIR = path.resolve(HERE, "..", "..", "usql");

const ENV_BASE_KEYS = ["ZETARIS_BASE_URL", "ZETARIS_REST_URL"];
const ENV_KEY_KEYS = ["ZETARIS_API_KEY"];
const ENV_ORG_KEYS = ["ZETARIS_ORG_ID"];

const DEFAULT_TIMEOUT_MS = 30000;
const RATE_LIMIT_WAIT_MS = 60000;

const MAX_LITERAL_LENGTH = 160;

export function readConfiguration(env = process.env) {
  const pick = (keys) => {
    for (const key of keys) {
      const value = env[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  return {
    baseUrl: pick(ENV_BASE_KEYS),
    apiKey: pick(ENV_KEY_KEYS),
    orgId: pick(ENV_ORG_KEYS),
  };
}

export function isConfigured(env = process.env) {
  const config = readConfiguration(env);
  return Boolean(config.baseUrl && config.apiKey && config.orgId);
}

function missingConfigurationMessage() {
  return (
    "Zetaris data layer is not configured. Set ZETARIS_BASE_URL, ZETARIS_API_KEY and " +
    "ZETARIS_ORG_ID in the environment; without them the data layer runs on the local " +
    "executor (src/data/local-executor.js) instead of inventing results."
  );
}

/**
 * Values reach SQL as literals only. Quotes are doubled, control characters and
 * statement separators are removed, and the value is length-clipped so caller
 * text can never terminate or extend the statement.
 */
export function escapeSqlLiteral(value) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/;+/g, " ")
    .replace(/--+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LITERAL_LENGTH);
  return `'${text.replace(/'/g, "''")}'`;
}

function requireInteger(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Parameter ${name} must be a non-negative number.`);
  return String(Math.floor(value));
}

function numberLiteral(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Parameter ${name} must be a non-negative number.`);
  return String(value);
}

/**
 * Renders one usql statement. Supported tokens:
 *   {{LIMIT}}                  integer
 *   {{MIN_SCORE}}              number
 *   {{AS_OF}}                  ISO date literal
 *   {{NAME_MATCH}}, {{BRAND_MATCH}}, {{HAZARD_MATCH}}, {{LOT_MATCH}},
 *   {{CLASS_MATCH}}, {{STATE_MATCH}}
 *                              predicate fragment: an OR-chain of LIKE or IN
 *                              tests built from the caller's term list, applied
 *                              to the fixed column each token documents. An
 *                              empty term list renders as an always-false
 *                              predicate, so the statement stays valid and
 *                              simply matches nothing.
 *   {{NAME_LIST}}, {{BRAND_LIST}}, {{BARCODE_LIST}}, {{LOT_LIST}},
 *   {{STATE_LIST}}             comma-separated quoted literals for IN (...)
 */
export function renderStatement(sql, params = {}) {
  const likeAny = (column, values) => {
    const terms = (values || []).map((v) => String(v)).filter((t) => t.trim());
    if (terms.length === 0) return "1 = 0";
    return terms.map((t) => `lower(${column}) LIKE ${escapeSqlLiteral(`%${t.toLowerCase()}%`)}`).join(" OR ");
  };
  const inList = (values) => {
    const terms = (values || []).map((v) => String(v)).filter((t) => t.trim());
    if (terms.length === 0) return "NULL";
    return terms.map(escapeSqlLiteral).join(", ");
  };
  const classMatch = (values) => {
    const terms = (values || []).map((v) => String(v)).filter((t) => t.trim());
    if (terms.length === 0) return "1 = 0";
    return `recall_class IN (${inList(terms)})`;
  };

  const tokens = {
    LIMIT: requireInteger("limit", params.limit, 20),
    MIN_SCORE: numberLiteral("min_score", params.min_score, 0),
    AS_OF: escapeSqlLiteral(params.as_of || new Date().toISOString().slice(0, 10)),
    NAME_MATCH: likeAny("match_name", params.names),
    BRAND_MATCH: likeAny("match_brand", params.brands),
    HAZARD_MATCH: likeAny("match_hazard", params.keywords),
    LOT_MATCH: likeAny("match_lot", params.lots),
    CLASS_MATCH: classMatch(params.classes),
    STATE_MATCH: likeAny("match_jurisdiction", params.jurisdictions),
    NAME_LIST: inList(params.names),
    BRAND_LIST: inList(params.brands),
    BARCODE_LIST: inList(params.barcodes),
    LOT_LIST: inList(params.lots),
    STATE_LIST: inList(params.jurisdictions),
  };

  const rendered = sql.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => {
    if (!(name in tokens)) throw new Error(`Statement uses unsupported token ${whole}.`);
    return tokens[name];
  });
  const leftovers = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (leftovers) throw new Error(`Statement tokens were not rendered: ${leftovers.join(", ")}`);
  return rendered;
}

export function loadStatement(name, usqlDir = USQL_DIR) {
  const file = path.join(usqlDir, `${name}.sql`);
  if (!fs.existsSync(file)) {
    throw new Error(`No usql statement for query ${name}: expected ${file}`);
  }
  return { file, sql: fs.readFileSync(file, "utf8") };
}

function rowsFromPayload(payload) {
  const data = payload?.data ?? payload?.rows ?? payload?.results ?? [];
  if (!Array.isArray(data)) return [];
  const columns =
    payload?.columns || payload?.columnNames || payload?.meta?.columns || payload?.data?.columns || null;
  const names = Array.isArray(columns)
    ? columns.map((c) => (typeof c === "string" ? c : c.name || c.label || c.fieldName))
    : null;
  return data.map((row, index) => {
    if (!Array.isArray(row)) {
      if (row && typeof row === "object") return row;
      return { value: row };
    }
    if (names && names.length >= row.length) {
      const out = {};
      names.forEach((n, i) => {
        out[n || `col_${i + 1}`] = row[i];
      });
      return out;
    }
    const out = {};
    row.forEach((v, i) => {
      out[`col_${i + 1}`] = v;
    });
    return out;
  });
}

function errorTextFrom(status, body) {
  const trimmed = String(body || "").slice(0, 400);
  try {
    const parsed = JSON.parse(trimmed);
    const message = parsed?.message || parsed?.error || parsed?.detail;
    if (message) return `HTTP ${status}: ${JSON.stringify(message).slice(0, 300)}`;
  } catch {
    /* body is not JSON */
  }
  return `HTTP ${status}: ${trimmed}`;
}

export function createZetarisAdapter(env = process.env, options = {}) {
  const config = readConfiguration(env);
  if (!config.baseUrl || !config.apiKey || !config.orgId) {
    throw new Error(missingConfigurationMessage());
  }
  const timeoutMs = options.timeoutMs || Number(env.ZETARIS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const rateLimitWaitMs = options.rateLimitWaitMs || RATE_LIMIT_WAIT_MS;
  const log = options.log || ((line) => process.stderr.write(`${line}\n`));

  const runUrl = `${config.baseUrl.replace(/\/+$/, "")}/sql-editor/sqls/run`;

  async function post(sql) {
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      const requestId = randomUUID();
      const response = await fetch(runUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "x-org-id": config.orgId,
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          queryId: randomUUID(),
          sql,
          source: "SqlEditor",
          limit: 500,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (response.ok) {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          throw new Error(`Zetaris answered with a non-JSON body for request ${requestId}.`);
        }
        return { payload, requestId };
      }
      if (response.status === 429 || response.status === 502 || response.status === 503) {
        if (attempt === 1) {
          log(`zetaris: HTTP ${response.status}, waiting ${Math.round(rateLimitWaitMs / 1000)} s and retrying the statement once`);
          await new Promise((resolve) => setTimeout(resolve, rateLimitWaitMs));
          continue;
        }
      }
      throw new Error(`${errorTextFrom(response.status, body)} (request ${requestId})`);
    }
    throw new Error("Zetaris request failed after the documented single retry.");
  }

  return {
    backend: "zetaris",
    endpoint: runUrl,
    orgId: config.orgId,
    usqlDir: options.usqlDir || USQL_DIR,
    async query(name, params = {}) {
      const { file, sql } = loadStatement(name, options.usqlDir || USQL_DIR);
      const statement = renderStatement(sql, params);
      const started = Date.now();
      const { payload, requestId } = await post(statement);
      const rows = rowsFromPayload(payload);
      return {
        query: name,
        backend: "zetaris",
        statement_file: path.relative(path.resolve(options.usqlDir || USQL_DIR, ".."), file).replace(/\\/g, "/"),
        request_id: requestId,
        elapsed_ms: Date.now() - started,
        rows,
        row_count: rows.length,
        truncated_at: payload?.truncated ?? null,
      };
    },
  };
}
