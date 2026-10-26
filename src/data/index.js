/**
 * Data layer entry point.
 *
 * One interface, two interchangeable engines: a live Zetaris instance when the
 * environment provides one, the cached-JSON local executor otherwise. Both
 * engines answer the same named queries with the same parameters, so nothing
 * above this module needs to know which one is in use.
 */

import fs from "node:fs";
import path from "node:path";

import { createLocalExecutor, QUERY_NAMES as LOCAL_QUERY_NAMES } from "./local-executor.js";
import { createZetarisAdapter, isConfigured, readConfiguration, USQL_DIR } from "./zetaris-adapter.js";
import { SOURCES, SCENARIO_SOURCE_ALIASES, sourcesForScenarioSource } from "./sources.js";

/** The named queries the product may ask the data layer. */
export const QUERY_NAMES = [
  "resolve_product_identity",
  "match_enforcement_notices",
  "match_adverse_events",
  "match_agency_notices",
  "match_donation_ledger",
  "reconcile_signals",
  "source_coverage",
];

/** Parameter contract shared by both engines. */
export const QUERY_CONTRACT = {
  resolve_product_identity: {
    params: ["names", "brands", "barcodes", "limit", "min_score", "as_of"],
    describes: "Candidate product identities from the crosswalk, best match first.",
  },
  match_enforcement_notices: {
    params: ["names", "brands", "barcodes", "lots", "keywords", "classes", "limit", "as_of"],
    describes: "FDA enforcement (recall) records that match the supplied identity signals.",
  },
  match_adverse_events: {
    params: ["names", "brands", "keywords", "limit", "min_score", "as_of"],
    describes: "Free-text adverse event reports that mention the product; the disagreeing voice.",
  },
  match_agency_notices: {
    params: ["names", "brands", "keywords", "jurisdictions", "limit", "min_score", "as_of"],
    describes: "Second agency outbreak notices related to the product, hazard or region.",
  },
  match_donation_ledger: {
    params: ["names", "brands", "barcodes", "lots", "limit", "min_score", "as_of"],
    describes: "Synthetic donation ledger holdings for the product, with quantities.",
  },
  reconcile_signals: {
    params: ["names", "brands", "barcodes", "lots", "keywords", "classes", "jurisdictions", "limit", "as_of"],
    describes: "Cross-source reconciliation: one row per resolved identity with corroboration, conflicts and confidence.",
  },
  source_coverage: {
    params: ["source_ids", "as_of"],
    describes: "Provenance and availability of every cached source, used for graceful fallback decisions.",
  },
};

function assertContract(usqlDir) {
  for (const name of QUERY_NAMES) {
    if (!LOCAL_QUERY_NAMES.includes(name)) {
      throw new Error(`Local executor has no implementation for query ${name}.`);
    }
    if (!fs.existsSync(path.join(usqlDir, `${name}.sql`))) {
      throw new Error(`No usql statement for query ${name} in ${usqlDir}.`);
    }
  }
  for (const name of LOCAL_QUERY_NAMES) {
    if (!QUERY_NAMES.includes(name)) {
      throw new Error(`Local executor implements ${name}, which is not part of the query contract.`);
    }
  }
}

/**
 * @param {Record<string,string>} env
 * @param {{ forceBackend?: "zetaris" | "local", dataDir?: string, usqlDir?: string, log?: Function }} options
 * @returns {{ backend: "zetaris" | "local", queryNames: string[], query: Function, configuration: object }}
 */
export function createDataLayer(env = process.env, options = {}) {
  const usqlDir = options.usqlDir || USQL_DIR;
  assertContract(usqlDir);

  const wantZetaris = options.forceBackend ? options.forceBackend === "zetaris" : isConfigured(env);
  if (options.forceBackend === "zetaris" && !isConfigured(env)) {
    throw new Error(
      "Zetaris backend requested but ZETARIS_BASE_URL, ZETARIS_API_KEY and ZETARIS_ORG_ID are not all set."
    );
  }

  if (wantZetaris) {
    const adapter = createZetarisAdapter(env, { ...options, usqlDir });
    return {
      backend: "zetaris",
      queryNames: QUERY_NAMES,
      sources: SOURCES,
      configuration: { endpoint: adapter.endpoint, usqlDir },
      query: (name, params = {}) => adapter.query(name, params),
    };
  }

  const executor = createLocalExecutor(options);
  return {
    backend: "local",
    queryNames: QUERY_NAMES,
    sources: SOURCES,
    configuration: { dataDir: executor.dataDir, usqlDir },
    query: async (name, params = {}) => {
      if (!QUERY_NAMES.includes(name)) throw new Error(`Unknown data-layer query: ${name}`);
      return executor.query(name, params);
    },
    warnings: () => executor.warnings,
  };
}

export { SOURCES, SCENARIO_SOURCE_ALIASES, sourcesForScenarioSource };
