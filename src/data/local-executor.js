/**
 * Local executor - answers the named reconciliation queries against the cached
 * JSON samples in data/, with no network access.
 *
 * It implements the same query contract as the Zetaris adapter: identical names,
 * identical parameters, comparable rows. Nothing here is keyed to a known
 * scenario; every row is produced by matching the caller's signals against the
 * cached records and scoring the match.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCES, sourceById } from "./sources.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(HERE, "..", "..", "data");

const STOPWORDS = new Set([
  "the", "of", "and", "for", "with", "a", "an", "to", "in", "on", "or", "us",
  "usa", "inc", "llc", "ltd", "co", "corp", "company", "product", "products",
  "item", "pack", "packaging", "new", "see", "description", "generic", "name",
  "unknown", "n", "na", "not", "applicable",
]);

const HAZARD_VOCABULARY = [
  "listeria", "listerin", "salmonella", "eshcherichia", "e coli", "campylobacter",
  "cronobacter", "norovirus", "hepatitis", "botulism", "clostridium", "vibrio",
  "undeclared", "allergen", "allergic", "peanut", "tree nut", "milk", "egg",
  "soy", "wheat", "sesame", "fish", "crustacean", "shellfish", "gluten",
  "glass", "metal", "foreign material", "plastic fragment", "stone",
  "contamination", "contaminated", "pathogen", "spoilage", "toxine", "toxin",
  "lead", "cadmium", "aflatoxin", "pesticide", "drug", "overdose", "mislabeling",
  "wrong product", "recall", "outbreak", "illness", "hospitalization", "death",
];

const MIN_MATCH_SCORE = 0.12;

export function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[()\/,;:.]+/g, " ")
    .replace(/[^a-z0-9%\- ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenize(value) {
  const normalized = normalizeName(value);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function extractBarcodes(...texts) {
  const found = new Set();
  for (const raw of texts) {
    const text = String(raw || "");
    for (const match of text.matchAll(/\b\d[\d\s-]{6,20}\d\b/g)) {
      const digits = match[0].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 14) found.add(digits);
    }
  }
  return [...found];
}

export function extractLots(...texts) {
  const found = new Set();
  for (const raw of texts) {
    const text = String(raw || "");
    for (const match of text.matchAll(/\b(?:lot|batch|case)\s*[#:]?\s*([A-Za-z0-9][\w.-]{2,24})/gi)) {
      found.add(match[1].toUpperCase());
    }
    for (const match of text.matchAll(/\b[A-Z]{1,3}[- ]?\d{3,6}[A-Z]?[- ]?\d{0,4}\b/g)) {
      const token = match[0].replace(/\s/g, "").toUpperCase();
      if (!/^\d+$/.test(token)) found.add(token);
    }
  }
  return [...found];
}

export function hazardTerms(...texts) {
  const haystack = texts.map((t) => normalizeName(t)).join(" ");
  const hits = new Set();
  for (const term of HAZARD_VOCABULARY) {
    if (haystack.includes(term)) hits.add(term);
  }
  return [...hits];
}

/** openFDA dates arrive as YYYYMMDD; other sources use YYYY or YYYY-MM. */
export function toIsoDate(value) {
  const text = String(value || "").trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  if (/^\d{4}$/.test(text)) return `${text}-01-01`;
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}

function recordRef(sourceId, externalId, fallbackIndex) {
  return `${sourceId}:${externalId || `row-${fallbackIndex}`}`;
}

function readCache(dataDir, cacheFile) {
  const full = path.join(dataDir, path.basename(cacheFile));
  if (!fs.existsSync(full)) {
    return { envelope: null, problem: `cache file missing: ${cacheFile}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    return { envelope: null, problem: `cache file unreadable: ${cacheFile} (${err.message})` };
  }
  if (!Array.isArray(parsed.records)) {
    return { envelope: null, problem: `cache file has no records array: ${cacheFile}` };
  }
  return { envelope: parsed, problem: null };
}

/**
 * Weighted token overlap. Tokens that appear across many candidate records
 * carry less weight, so a shared generic word cannot on its own produce a
 * strong match.
 */
function tokenWeights(queryTokens, corpusTokenSets) {
  const total = corpusTokenSets.length || 1;
  const weights = new Map();
  for (const token of new Set(queryTokens)) {
    let documents = 0;
    for (const set of corpusTokenSets) if (set.has(token)) documents += 1;
    weights.set(token, Math.log((total + 1) / (documents + 0.5)));
  }
  return weights;
}

function weightedOverlap(queryTokens, candidateTokens, weights) {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  let matched = 0;
  let overall = 0;
  const matchedTokens = [];
  for (const token of new Set(queryTokens)) {
    const weight = weights.get(token) ?? 1;
    overall += weight;
    if (candidateSet.has(token)) {
      matched += weight;
      matchedTokens.push(token);
    }
  }
  if (overall <= 0) return 0;
  return { score: matched / overall, matchedTokens };
}

function daysBetween(isoA, isoB) {
  const a = Date.parse(isoA || "");
  const b = Date.parse(isoB || "");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round(Math.abs(a - b) / 86400000);
}

function recencyFactor(eventDate, asOf) {
  const days = daysBetween(eventDate, asOf);
  if (days === null) return 0.85;
  if (days <= 120) return 1;
  if (days <= 365) return 0.95;
  if (days <= 365 * 2) return 0.9;
  if (days <= 365 * 5) return 0.8;
  return 0.65;
}

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

/**
 * Splits a scenario into the signals the data layer matches on. This is the
 * only place scenario text is read; the queries themselves stay generic.
 */
export function extractSignals(scenario) {
  const notices = (scenario && scenario.notices) || [];
  const names = new Set();
  const brands = new Set();
  const barcodes = new Set();
  const lots = new Set();
  const keywords = new Set();
  const classes = new Set();
  const jurisdictions = new Set();
  const sourceLabels = new Set();

  for (const notice of notices) {
    if (notice.product_name) names.add(normalizeName(notice.product_name));
    if (notice.brand) brands.add(normalizeName(notice.brand));
    for (const code of extractBarcodes(notice.barcode, notice.raw_text)) barcodes.add(code);
    for (const lot of extractLots(notice.lot, notice.raw_text)) lots.add(lot.toUpperCase());
    for (const term of hazardTerms(notice.raw_text, notice.product_name, notice.distribution)) {
      keywords.add(term);
    }
    if (notice.class && notice.class !== "unknown") classes.add(notice.class);
    if (notice.distribution) jurisdictions.add(normalizeName(notice.distribution));
    if (notice.source) sourceLabels.add(notice.source);
  }

  return {
    scenario_id: scenario && scenario.scenario_id,
    shift_date: (scenario && scenario.shift_date) || null,
    names: [...names],
    brands: [...brands],
    barcodes: [...barcodes],
    lots: [...lots],
    keywords: [...keywords],
    classes: [...classes],
    jurisdictions: [...jurisdictions],
    source_labels: [...sourceLabels],
    notice_count: notices.length,
  };
}

function corpusTokenSets(rows) {
  return rows.map((row) => new Set([...row.name_tokens, ...row.brand_tokens]));
}

class LocalExecutor {
  constructor(options = {}) {
    this.dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this.warnings = [];
    this.cache = new Map();
    this.loadWarnings = [];
  }

  sourceRows(sourceId) {
    if (this.cache.has(sourceId)) return this.cache.get(sourceId);
    const source = sourceById(sourceId);
    const { envelope, problem } = readCache(this.dataDir, source.cache_file);
    if (problem) {
      const warning = `${sourceId}: ${problem}`;
      if (!this.loadWarnings.includes(warning)) this.loadWarnings.push(warning);
      this.cache.set(sourceId, { envelope: null, rows: [] });
      return this.cache.get(sourceId);
    }
    const rows = envelope.records.map((record, index) => this.prepareRow(sourceId, record, index));
    const value = { envelope, rows };
    this.cache.set(sourceId, value);
    return value;
  }

  prepareRow(sourceId, record, index) {
    const nameTokens = tokenize(record.product_name);
    const brandTokens = tokenize(record.brand);
    return {
      source_id: sourceId,
      record_id: record.record_id || recordRef(sourceId, record.external_id, index),
      product_name: record.product_name || "",
      brand: record.brand || "",
      name_tokens: nameTokens,
      brand_tokens: brandTokens,
      normalized_text: normalizeName(`${record.product_name} ${record.brand} ${record.detail_text}`),
      barcodes: record.identity?.barcodes || [],
      lots: record.identity?.lots || [],
      codes: record.identity?.codes || [],
      recall_class: record.recall_class || "unknown",
      hazard_terms: record.hazard_terms || [],
      jurisdiction: record.jurisdiction || "",
      event_date: record.event_date || null,
      external_id: record.external_id || null,
      detail_text: record.detail_text || "",
      extra: record.extra || {},
    };
  }

  /** Scores one row against the caller's signals. */
  scoreRow(row, signals, weightsFor) {
    const matchedOn = [];
    let bestNameOverlap = 0;
    let matchedTokens = [];

    for (const name of signals.names || []) {
      const queryTokens = tokenize(name);
      if (queryTokens.length === 0) continue;
      const overlap = weightedOverlap(queryTokens, row.name_tokens, weightsFor(queryTokens));
      if (overlap.score > bestNameOverlap) {
        bestNameOverlap = overlap.score;
        matchedTokens = overlap.matchedTokens;
      }
    }
    if (bestNameOverlap > 0) matchedOn.push("product_name");

    let brandOverlap = 0;
    for (const brand of signals.brands || []) {
      const queryTokens = tokenize(brand);
      if (queryTokens.length === 0) continue;
      const overlap = weightedOverlap(queryTokens, row.brand_tokens, weightsFor(queryTokens));
      if (overlap.score > brandOverlap) brandOverlap = overlap.score;
    }
    if (brandOverlap > 0) matchedOn.push("brand");

    const barcodeHit = (signals.barcodes || []).find((code) => row.barcodes.includes(code)) || null;
    if (barcodeHit) matchedOn.push("barcode");

    const lotHit = (signals.lots || []).find(
      (lot) => row.lots.map((l) => l.toUpperCase()).includes(String(lot).toUpperCase())
    ) || null;
    if (lotHit) matchedOn.push("lot");

    const hazardHits = (signals.keywords || []).filter((term) => row.hazard_terms.includes(term));
    if (hazardHits.length > 0) matchedOn.push("hazard_text");

    const jurisdictionHit = (signals.jurisdictions || []).find(
      (place) => row.jurisdiction && normalizeName(row.jurisdiction).includes(place)
    ) || null;
    if (jurisdictionHit) matchedOn.push("jurisdiction");

    const classHit = (signals.classes || []).includes(row.recall_class) ? row.recall_class : null;
    if (classHit) matchedOn.push("recall_class");

    const identity = clamp(
      0.72 * bestNameOverlap + 0.28 * brandOverlap + (barcodeHit ? 0.35 : 0) + (lotHit ? 0.12 : 0)
    );
    const support =
      (hazardHits.length > 0 ? 0.14 : 0) +
      (jurisdictionHit ? 0.05 : 0) +
      (classHit ? 0.06 : 0);
    const recency = recencyFactor(row.event_date, this.asOf);
    const score = clamp((identity * 0.82 + support) * recency);

    return {
      score: Number(score.toFixed(4)),
      matched_on: matchedOn,
      identity_evidence:
        bestNameOverlap > 0 || brandOverlap > 0 || Boolean(barcodeHit) || Boolean(lotHit),
      context_evidence: hazardHits.length > 0 && Boolean(jurisdictionHit),
      detail: {
        name_overlap: Number(bestNameOverlap.toFixed(4)),
        brand_overlap: Number(brandOverlap.toFixed(4)),
        matched_tokens: matchedTokens,
        barcode: barcodeHit,
        lot: lotHit,
        hazard_terms: hazardHits,
        jurisdiction: jurisdictionHit,
        recall_class: classHit,
        recency_factor: recency,
      },
    };
  }

  rank(sourceId, signals, options = {}) {
    const { rows } = this.sourceRows(sourceId);
    if (rows.length === 0) return [];
    const sets = corpusTokenSets(rows);
    const weightCache = new Map();
    const weightsFor = (tokens) => {
      const key = tokens.join("|");
      if (!weightCache.has(key)) weightCache.set(key, tokenWeights(tokens, sets));
      return weightCache.get(key);
    };
    const minScore = options.minScore ?? MIN_MATCH_SCORE;
    const accepted = (item) => {
      if (item.score < minScore) return false;
      if (options.requireIdentity && !item.identity_evidence) return false;
      if (
        options.requireIdentityOrContext &&
        !item.identity_evidence &&
        !item.context_evidence
      ) {
        return false;
      }
      return true;
    };
    const scored = rows
      .map((row) => ({ row, ...this.scoreRow(row, signals, weightsFor) }))
      .filter(accepted)
      .sort((a, b) => b.score - a.score || String(a.row.record_id).localeCompare(String(b.row.record_id)));
    return scored.slice(0, options.limit || 10);
  }

  /** Distinct endpoints behind a result set, for citation in traces. */
  endpointsOf(...resultSets) {
    const found = [];
    for (const set of resultSets) found.push(...set);
    return unique(found.map((item) => item?.endpoint).filter(Boolean));
  }

  sourceEnvelope(sourceId) {
    return this.sourceRows(sourceId).envelope;
  }

  provenance(sourceId) {
    const source = sourceById(sourceId);
    const envelope = this.sourceEnvelope(sourceId);
    return {
      source_id: sourceId,
      endpoint: envelope ? envelope.endpoint : source.endpoint ? source.endpoint.url : source.licence.citation,
      licence: envelope ? envelope.licence : source.licence.name,
      attribution: envelope ? envelope.attribution : source.licence.attribution_text || null,
      fetched_at: envelope ? envelope.fetched_at : null,
      cached_records: envelope ? envelope.record_count : 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Named queries - the same names the Zetaris adapter executes.        */
/* ------------------------------------------------------------------ */

function queryResolveProductIdentity(executor, params) {
  const signals = signalsFrom(params);
  const limit = params.limit ?? 8;
  const rows = executor
    .rank("open_food_facts", signals, {
      limit,
      minScore: params.min_score ?? MIN_MATCH_SCORE,
      requireIdentity: true,
    })
    .map(({ row, score, matched_on, detail }) => ({
      identity_key: `${row.brand || "unbranded"}|${row.product_name}`.toLowerCase(),
      canonical_name: row.product_name,
      brand: row.brand,
      barcode: row.barcodes[0] || row.external_id || null,
      categories: row.extra.categories || null,
      package_quantity: row.extra.quantity || null,
      match_score: score,
      matched_on,
      match_terms: detail.matched_tokens,
      record_date: row.event_date,
      source_ref: row.record_id,
      ...executor.provenance("open_food_facts"),
    }));
  return { query: "resolve_product_identity", params: publicParams(params), rows, warnings: executor.loadWarnings.slice() };
}

function queryMatchEnforcementNotices(executor, params) {
  const signals = signalsFrom(params);
  const limit = params.limit ?? 8;
  const collected = [];
  for (const sourceId of ["fda_food_enforcement", "fda_drug_enforcement"]) {
    for (const hit of executor.rank(sourceId, signals, { limit, requireIdentity: true })) collected.push(hit);
  }
  collected.sort((a, b) => b.score - a.score);
  const rows = collected.slice(0, limit).map(({ row, score, matched_on, detail }) => ({
    notice_ref: row.external_id,
    source_id: row.source_id,
    product_name: row.product_name,
    brand: row.brand,
    recalling_firm: row.extra.recalling_firm || null,
    recall_class: row.recall_class,
    reason_for_recall: row.extra.reason_for_recall || row.detail_text,
    status: row.extra.status || null,
    distribution_pattern: row.jurisdiction,
    lots: row.lots,
    barcodes: row.barcodes,
    hazard_terms: row.hazard_terms,
    event_date: row.event_date,
    match_score: score,
    matched_on,
    match_terms: detail.matched_tokens,
    source_ref: row.record_id,
    ...executor.provenance(row.source_id),
  }));
  return { query: "match_enforcement_notices", params: publicParams(params), rows, warnings: executor.loadWarnings.slice() };
}

function queryMatchAdverseEvents(executor, params) {
  const signals = signalsFrom(params);
  const limit = params.limit ?? 8;
  const rows = executor
    .rank("fda_drug_event", signals, { limit, minScore: params.min_score ?? 0.08, requireIdentity: true })
    .map(({ row, score, matched_on, detail }) => ({
      report_ref: row.external_id,
      reported_product: row.product_name,
      brand: row.brand,
      serious: row.extra.serious || null,
      reported_terms: row.hazard_terms,
      symptom_terms: row.extra.symptom_terms || [],
      indication: row.extra.indication || null,
      product_codes: row.codes,
      received_date: row.event_date,
      agreement: row.extra.symptom_terms?.length || row.hazard_terms.length ? "text_signal" : "no_text_signal",
      match_score: score,
      matched_on,
      match_terms: detail.matched_tokens,
      source_ref: row.record_id,
      ...executor.provenance("fda_drug_event"),
    }));
  return { query: "match_adverse_events", params: publicParams(params), rows, warnings: executor.loadWarnings.slice() };
}

function queryMatchAgencyNotices(executor, params) {
  const signals = signalsFrom(params);
  const limit = params.limit ?? 8;
  const rows = executor
    .rank("cdc_outbreak_notices", signals, {
      limit,
      minScore: params.min_score ?? 0.08,
      requireIdentityOrContext: true,
    })
    .map(({ row, score, matched_on, detail }) => ({
      notice_ref: row.external_id,
      headline: row.product_name,
      pathogen: row.extra.etiology || null,
      serotype: row.extra.serotype_or_genotype || null,
      food_vehicle: row.extra.food_vehicle || null,
      setting: row.extra.setting || null,
      state: row.jurisdiction,
      illnesses: row.extra.illnesses || null,
      hospitalizations: row.extra.hospitalizations || null,
      deaths: row.extra.deaths || null,
      agent_codes: row.codes,
      notice_terms: row.hazard_terms,
      notice_date: row.event_date,
      match_score: score,
      matched_on,
      match_terms: detail.matched_tokens,
      source_ref: row.record_id,
      ...executor.provenance("cdc_outbreak_notices"),
    }));
  return { query: "match_agency_notices", params: publicParams(params), rows, warnings: executor.loadWarnings.slice() };
}

function queryMatchDonationLedger(executor, params) {
  const signals = signalsFrom(params);
  const limit = params.limit ?? 10;
  const rows = executor
    .rank("donation_ledger", signals, {
      limit,
      minScore: params.min_score ?? MIN_MATCH_SCORE,
      requireIdentity: true,
    })
    .map(({ row, score, matched_on, detail }) => ({
      donation_ref: row.external_id,
      product_name: row.product_name,
      brand: row.brand,
      lot: row.lots[0] || null,
      barcode: row.barcodes[0] || null,
      quantity_units: row.extra.quantity_units ?? null,
      received_on: row.event_date,
      site: row.jurisdiction,
      storage_zone: row.extra.storage_zone || null,
      donor: row.extra.donor || null,
      match_score: score,
      matched_on,
      match_terms: detail.matched_tokens,
      data_origin: "synthetic",
      source_ref: row.record_id,
      ...executor.provenance("donation_ledger"),
    }));
  return { query: "match_donation_ledger", params: publicParams(params), rows, warnings: executor.loadWarnings.slice() };
}

function querySourceCoverage(executor, params) {
  const wanted = params.source_ids || SOURCES.map((s) => s.id);
  const asOf = params.as_of || null;
  const rows = wanted.map((sourceId) => {
    const source = sourceById(sourceId);
    const envelope = executor.sourceEnvelope(sourceId);
    const ageDays = envelope && asOf ? daysBetween(envelope.fetched_at, asOf) : null;
    return {
      source_id: sourceId,
      title: source.title,
      agency: source.agency,
      endpoint: envelope ? envelope.endpoint : source.endpoint ? source.endpoint.url : source.licence.citation,
      available: Boolean(envelope),
      record_count: envelope ? envelope.record_count : 0,
      fetched_at: envelope ? envelope.fetched_at : null,
      age_days: ageDays,
      data_origin: envelope ? envelope.data_origin : source.synthetic ? "synthetic" : "public",
      licence: envelope ? envelope.licence : source.licence.name,
      attribution_required: source.licence.attribution_required,
      attribution: source.licence.attribution_text || null,
    };
  });
  return {
    query: "source_coverage",
    params: publicParams(params),
    rows,
    warnings: executor.loadWarnings.slice(),
  };
}

const GROUP_RELATION_THRESHOLD = 0.34;

/**
 * Cross-source reconciliation. Each source is matched on its own terms, then
 * every hit is grouped into one identity: the group label comes from the
 * crosswalk row when the crosswalk holds that identity, otherwise from the
 * strongest hit. Confidence is computed from what actually corroborated - never
 * from a fixed table of answers.
 */
function queryReconcileSignals(executor, params) {
  const signals = signalsFrom(params);
  const identityResult = queryResolveProductIdentity(executor, { ...params, limit: params.limit ?? 6 });
  const enforcement = queryMatchEnforcementNotices(executor, { ...params, limit: params.limit ?? 12 });
  const adverse = queryMatchAdverseEvents(executor, { ...params, limit: params.limit ?? 12 });
  const agency = queryMatchAgencyNotices(executor, { ...params, limit: params.limit ?? 12 });
  const ledger = queryMatchDonationLedger(executor, { ...params, limit: params.limit ?? 20 });

  const candidates = [
    ...identityResult.rows.map((row) => ({ label: "open_food_facts", row, name: row.canonical_name, brand: row.brand })),
    ...enforcement.rows.map((row) => ({ label: "fda_enforcement", row, name: row.product_name, brand: row.brand || row.recalling_firm })),
    ...adverse.rows.map((row) => ({ label: "fda_adverse_event", row, name: row.reported_product, brand: row.brand })),
    ...agency.rows.map((row) => ({ label: "second_agency", row, name: row.food_vehicle || row.headline, brand: "" })),
    ...ledger.rows.map((row) => ({ label: "donation_ledger", row, name: row.product_name, brand: row.brand })),
  ].filter((candidate) => candidate.name);

  candidates.sort(
    (a, b) =>
      b.row.match_score - a.row.match_score ||
      String(a.row.source_ref).localeCompare(String(b.row.source_ref))
  );

  const groups = [];
  for (const candidate of candidates) {
    const tokens = tokenize(`${candidate.name} ${candidate.brand || ""}`);
    if (tokens.length === 0) continue;
    let target = null;
    let bestOverlap = 0;
    for (const group of groups) {
      const weights = tokenWeights(group.seed_tokens, [new Set(tokens)]);
      const overlap = weightedOverlap(group.seed_tokens, tokens, weights);
      if (overlap.score >= GROUP_RELATION_THRESHOLD && overlap.score > bestOverlap) {
        bestOverlap = overlap.score;
        target = group;
      }
    }
    if (target) target.members.push(candidate);
    else groups.push({ seed_tokens: tokens, members: [candidate] });
  }

  const rows = groups.map((group) => {
    const byLabel = new Map();
    for (const member of group.members) {
      byLabel.set(member.label, [...(byLabel.get(member.label) || []), member]);
    }
    const pick = (label) => byLabel.get(label) || [];

    const crosswalk = pick("open_food_facts");
    const enforce = pick("fda_enforcement");
    const events = pick("fda_adverse_event");
    const notices = pick("second_agency");
    const holdings = pick("donation_ledger");

    const strongest = group.members[0];
    const label = crosswalk[0]?.row || strongest.row;
    const identityKey = `${normalizeName(label.brand || "")}|${normalizeName(label.product_name || strongest.name)}`;
    const identityStrength = crosswalk.length > 0
      ? crosswalk[0].row.match_score
      : Number((strongest.row.match_score * 0.9).toFixed(4));

    const enforcementClasses = unique(enforce.map((m) => m.row.recall_class).filter((c) => c !== "unknown"));
    const corroborating = [
      enforce.length > 0 ? "fda_enforcement" : null,
      notices.length > 0 ? "second_agency" : null,
      events.length > 0 ? "fda_adverse_event" : null,
      holdings.length > 0 ? "donation_ledger" : null,
      crosswalk.length > 0 ? "open_food_facts" : null,
    ].filter(Boolean);

    const hazardFromEnforcement = unique(enforce.flatMap((m) => m.row.hazard_terms || []));
    const hazardFromNotices = unique(notices.flatMap((m) => m.row.notice_terms || []));
    const hazardFromReports = unique(events.flatMap((m) => m.row.reported_terms || []));
    const agreedHazards = unique([...hazardFromEnforcement, ...hazardFromNotices]).filter((term) =>
      signals.keywords.includes(term)
    );

    const classConflict =
      signals.classes.length > 0 &&
      enforcementClasses.length > 0 &&
      signals.classes.every((c) => !enforcementClasses.includes(c));
    const reportsWithoutEnforcement = events.length > 0 && enforce.length === 0;
    const noticesWithoutEnforcement = notices.length > 0 && enforce.length === 0;

    const corroboration =
      (enforce.length > 0 ? 0.24 : 0) +
      (notices.length > 0 ? 0.12 : 0) +
      (events.length > 0 ? 0.08 : 0) +
      (holdings.length > 0 ? 0.1 : 0) +
      (crosswalk.length > 0 ? 0.08 : 0);
    const penalty = (classConflict ? 0.12 : 0) + (reportsWithoutEnforcement ? 0.06 : 0);
    const confidence = clamp(
      0.1 +
        0.5 * identityStrength +
        corroboration +
        Math.min(0.09, agreedHazards.length * 0.03) -
        penalty,
      0.05,
      0.97
    );

    return {
      identity_key: identityKey,
      canonical_name: strongest.name,
      crosswalk_name: crosswalk.length > 0 ? crosswalk[0].row.canonical_name : null,
      brand: label.brand || strongest.brand || null,
      barcode:
        crosswalk[0]?.row.barcode ||
        enforce[0]?.row.barcodes?.[0] ||
        holdings[0]?.row.barcode ||
        null,
      categories: crosswalk[0]?.row.categories || null,
      recall_classes_seen: enforcementClasses,
      input_classes_seen: signals.classes,
      corroborating_sources: corroborating,
      enforcement_hit_count: enforce.length,
      adverse_event_hit_count: events.length,
      agency_notice_hit_count: notices.length,
      ledger_hit_count: holdings.length,
      crosswalk_hit_count: crosswalk.length,
      exposure_units: holdings.reduce((sum, m) => sum + (m.row.quantity_units || 0), 0),
      lots_in_ledger: unique(holdings.map((m) => m.row.lot).filter(Boolean)),
      hazard_terms_in_enforcement: hazardFromEnforcement.slice(0, 6),
      hazard_terms_in_notices: hazardFromNotices.slice(0, 6),
      hazard_terms_in_reports: hazardFromReports.slice(0, 6),
      hazards_agreed_across_sources: agreedHazards.slice(0, 6),
      class_conflict_with_input: classConflict,
      reports_without_enforcement: reportsWithoutEnforcement,
      notices_without_enforcement: noticesWithoutEnforcement,
      identity_match_score: identityStrength,
      confidence: Number(confidence.toFixed(4)),
      evidence: group.members.slice(0, 6).map((m) => m.row.source_ref),
      endpoints: executor.endpointsOf(group.members.map((m) => m.row)),
      attribution: crosswalk.length > 0 ? crosswalk[0].row.attribution : null,
    };
  });

  rows.sort((a, b) => b.confidence - a.confidence || a.identity_key.localeCompare(b.identity_key));

  return {
    query: "reconcile_signals",
    params: publicParams(params),
    rows: rows.slice(0, params.limit ?? 8),
    sources_queried: [
      "open_food_facts",
      "fda_food_enforcement",
      "fda_drug_enforcement",
      "fda_drug_event",
      "cdc_outbreak_notices",
      "donation_ledger",
    ],
    signals: {
      names: signals.names.length,
      brands: signals.brands.length,
      barcodes: signals.barcodes.length,
      lots: signals.lots.length,
      hazard_keywords: signals.keywords.length,
    },
    warnings: executor.loadWarnings.slice(),
  };
}

function signalsFrom(params) {
  return {
    names: unique(params.names || []),
    brands: unique(params.brands || []),
    barcodes: unique(params.barcodes || []),
    lots: unique(params.lots || []),
    keywords: unique(params.keywords || []),
    classes: unique(params.classes || []),
    jurisdictions: unique(params.jurisdictions || []),
  };
}

function publicParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    out[key] = Array.isArray(value) ? value.length : value;
  }
  return out;
}

const QUERY_IMPLEMENTATIONS = {
  resolve_product_identity: queryResolveProductIdentity,
  match_enforcement_notices: queryMatchEnforcementNotices,
  match_adverse_events: queryMatchAdverseEvents,
  match_agency_notices: queryMatchAgencyNotices,
  match_donation_ledger: queryMatchDonationLedger,
  reconcile_signals: queryReconcileSignals,
  source_coverage: querySourceCoverage,
};

export const QUERY_NAMES = Object.keys(QUERY_IMPLEMENTATIONS);

export function hasImplementation(name) {
  return Object.prototype.hasOwnProperty.call(QUERY_IMPLEMENTATIONS, name);
}

/**
 * @returns {{ backend: string, dataDir: string, query: Function, hasImplementation: Function, warnings: string[] }}
 */
export function createLocalExecutor(options = {}) {
  const executor = new LocalExecutor(options);
  return {
    backend: "local",
    dataDir: executor.dataDir,
    queryNames: QUERY_NAMES,
    hasImplementation,
    query(name, params = {}) {
      if (!hasImplementation(name)) {
        throw new Error(`Unknown data-layer query: ${name}`);
      }
      executor.asOf = params.as_of || null;
      const result = QUERY_IMPLEMENTATIONS[name](executor, params);
      return { ...result, backend: "local" };
    },
    get warnings() {
      return executor.loadWarnings;
    },
  };
}
