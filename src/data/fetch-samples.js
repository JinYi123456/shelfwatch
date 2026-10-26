#!/usr/bin/env node
/**
 * Build the cached samples the local data layer reads.
 *
 *   node src/data/fetch-samples.js [--only source_id] [--refresh]
 *                                  [--timeout ms] [--retry-wait ms]
 *
 * Key-free public endpoints only, small pages, every file capped to a few tens
 * of records. Idempotent: an existing cache file is left untouched unless
 * --refresh is passed. Fail-soft: an endpoint that cannot be reached leaves the
 * previous cache in place and is reported, never replaced with invented rows.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCES, sourceById } from "./sources.js";
import { extractLots, hazardTerms, toIsoDate } from "./local-executor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_RETRY_WAIT_MS = 60000;

function parseArgs(argv) {
  const args = { only: null, refresh: false, timeoutMs: DEFAULT_TIMEOUT_MS, retryWaitMs: DEFAULT_RETRY_WAIT_MS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--only") args.only = argv[++i];
    else if (flag === "--refresh") args.refresh = true;
    else if (flag === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (flag === "--retry-wait") args.retryWaitMs = Number(argv[++i]);
    else if (flag === "--help") {
      process.stderr.write(
        "usage: node src/data/fetch-samples.js [--only <source_id>] [--refresh] [--timeout ms] [--retry-wait ms]\n"
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (args.only) sourceById(args.only);
  return args;
}

function log(line) {
  process.stderr.write(`${line}\n`);
}

function list(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null && String(v).trim());
  if (value === undefined || value === null || String(value).trim() === "") return [];
  return [value];
}

function dig(payload, dotted) {
  let current = payload;
  for (const part of dotted.split(".")) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) current = current.map((item) => item?.[part]);
    else current = current[part];
  }
  return current;
}

function firstText(...values) {
  for (const value of values) {
    for (const item of list(value)) {
      const text = String(item).trim();
      if (text) return text;
    }
  }
  return null;
}

function clip(text, max = 240) {
  const value = foldToAscii(text);
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * Cached text is English only. Accent marks are folded away and anything
 * outside the printable Latin range is dropped; where a source offers an
 * English-language field (for example product_name_en) the normalizer uses
 * that in preference to the language-agnostic one.
 */
function foldToAscii(text) {
  const value = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return value.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
}

/** English-language category tags ("en:sliced-breads") as readable text. */
function englishTags(tags) {
  return list(tags)
    .filter((tag) => /^en:[a-z0-9]+(-[a-z0-9]+)*$/.test(String(tag)))
    .map((tag) => tag.slice(3).replace(/-/g, " "))
    .slice(0, 6);
}

/**
 * Open Food Facts records the languages its text arrives in as a
 * "en:english": field-count map. A product with no recorded languages is kept;
 * one recorded only in other languages is dropped, so the cache stays English.
 */
function hasEnglishText(record) {
  const languages = record.languages;
  if (!languages || typeof languages !== "object" || Array.isArray(languages)) return true;
  const keys = Object.keys(languages);
  if (keys.length === 0) return true;
  return keys.some((key) => /(:en|:english)$/i.test(key) && Number(languages[key]) > 0);
}

/** Names read out of a free-text description: first labelled clause. */
function nameFromDescription(text) {
  const value = String(text || "");
  const labelled = value.match(/^\s*([^.;]{3,80})[.;]/);
  const candidate = labelled ? labelled[1] : value.split(/[.;]/)[0];
  return clip(candidate.replace(/\b(Generic Name|Intended use|Condition|Shelf life|Type of packaging|Net weight)\b.*/i, ""), 80);
}

function labeledBarcodes(...texts) {
  const found = new Set();
  for (const raw of texts) {
    const text = String(raw || "");
    for (const match of text.matchAll(/\b(?:upc|gtin|ean|barcode|code)\s*[#:=]?\s*(\d[\d-]{6,18}\d)/gi)) {
      const digits = match[1].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 14) found.add(digits);
    }
  }
  return [...found];
}

function buildUrl(endpoint, count) {
  const url = new URL(endpoint.url);
  for (const [key, template] of Object.entries(endpoint.params || {})) {
    url.searchParams.append(key, String(template).replace("{max_records}", String(count)));
  }
  return url;
}

async function requestJson(url, { headers = {}, timeoutMs, retryWaitMs, label }) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      attempts.push({ url: url.toString(), status: response.status, ms: Date.now() - started });
      if (response.ok) {
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return { ok: false, error: `${label}: response body is not JSON (HTTP ${response.status})`, attempts };
        }
        return { ok: true, payload, status: response.status, attempts };
      }
      const retryable = response.status === 429 || response.status === 502 || response.status === 503;
      if (!retryable || attempt === 1) {
        return { ok: false, error: `${label}: HTTP ${response.status} ${clip(text, 120)}`, attempts, status: response.status };
      }
    } catch (err) {
      attempts.push({ url: url.toString(), status: null, ms: Date.now() - started, error: err.message });
      if (attempt === 1) return { ok: false, error: `${label}: ${err.message}`, attempts };
    }
    log(`  ${label}: transient failure, waiting ${Math.round(retryWaitMs / 1000)} s before one retry`);
    await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
  }
  return { ok: false, error: `${label}: exhausted attempts`, attempts };
}

/* ---------------------------- normalizers ---------------------------- */

function normalizeEnforcement(record, sourceId, index) {
  const openfda = record.openfda || {};
  const brand = firstText(openfda.brand_name, openfda.generic_name, record.recalling_firm) || "unattributed";
  const productName =
    firstText(openfda.product_title, openfda.brand_name, openfda.generic_name) ||
    nameFromDescription(record.product_description);
  const detail = `${record.reason_for_recall || ""} ${record.product_description || ""}`.trim();
  const barcodes = [
    ...labeledBarcodes(record.product_description),
    ...list(openfda.upc_id).map((v) => String(v).replace(/\D/g, "")).filter((d) => d.length >= 8),
  ];
  return {
    record_id: `${sourceId}:${record.recall_number || `row-${index}`}`,
    external_id: record.recall_number || null,
    product_name: clip(productName, 90),
    brand: clip(brand, 80),
    detail_text: clip(detail),
    identity: {
      barcodes: [...new Set(barcodes)],
      lots: extractLots(record.code_info, record.product_description).slice(0, 6),
      codes: [...new Set([...list(openfda.package_ndc), ...list(openfda.product_ndc)])].slice(0, 6),
    },
    recall_class: pickClassValue(record.classification),
    hazard_terms: hazardTerms(detail, record.status),
    jurisdiction: clip(firstText(record.distribution_pattern, record.state, record.country), 120),
    event_date: toIsoDate(record.recall_initiation_date || record.center_classification_date || record.report_date),
    extra: {
      recalling_firm: clip(firstText(record.recalling_firm), 90),
      reason_for_recall: clip(firstText(record.reason_for_recall), 160),
      status: firstText(record.status),
      product_type: firstText(record.product_type),
      voluntary_mandated: firstText(record.voluntary_mandated),
      ndc_codes: [...new Set([...list(openfda.package_ndc), ...list(openfda.product_ndc)])].slice(0, 6),
      report_date: toIsoDate(record.report_date),
    },
  };
}

function pickClassValue(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/CLASS\s*(I{1,3})\b/);
  return match ? match[1] : "unknown";
}

function normalizeAdverseEvent(record, sourceId, index) {
  const drugs = list(dig(record, "patient.drug"));
  const medicinal = drugs.map((d) => d?.medicinalproduct).filter(Boolean);
  const brandNames = drugs.flatMap((d) => list(d?.openfda?.brand_name));
  const genericNames = drugs.flatMap((d) => list(d?.openfda?.generic_name));
  const indications = drugs.map((d) => d?.drugindication).filter(Boolean);
  const ndcCodes = [
    ...new Set([
      ...drugs.flatMap((d) => [...list(d?.openfda?.product_ndc), ...list(d?.productndc), ...list(d?.openfda?.package_ndc)]),
    ]),
  ];
  const symptoms = list(dig(record, "patient.reaction")).flatMap((r) => list(r?.symptomterm));
  const productName = firstText(medicinal, brandNames, genericNames) || "unspecified product";
  const detail = clip(
    [
      productName ? `reported product: ${productName}` : null,
      indications.length ? `reported indication: ${indications.join(", ")}` : null,
      symptoms.length ? `reported reactions: ${symptoms.slice(0, 10).join(", ")}` : null,
      record.serious === "1" ? "report classified serious" : null,
    ]
      .filter(Boolean)
      .join("; ")
  );
  return {
    record_id: `${sourceId}:${record.safetyreportid || `row-${index}`}`,
    external_id: record.safetyreportid || null,
    product_name: clip(productName, 90),
    brand: clip(firstText(brandNames, genericNames, drugs.map((d) => d?.drugmanufacturername)), 80) || "unattributed",
    detail_text: detail,
    identity: {
      barcodes: [],
      lots: [],
      codes: ndcCodes.slice(0, 6),
    },
    recall_class: "unknown",
    hazard_terms: hazardTerms(detail),
    jurisdiction: null,
    event_date: toIsoDate(record.receivedate || record.transmissiondate),
    extra: {
      serious: record.serious === "1" ? "yes" : record.serious === "2" ? "no" : null,
      symptom_terms: symptoms.slice(0, 12).map((s) => clip(s, 60)),
      indication: clip(firstText(indications), 120),
      drugs_reported: drugs.length,
      transmission_date: toIsoDate(record.transmissiondate),
    },
  };
}

function normalizeOutbreakNotice(record, sourceId, index) {
  const pathogens = list(record.pathogens).flatMap((p) => list(p?.name || p));
  const locations = list(record.locations).flatMap((l) => list(l?.name || l));
  const productName = firstText(record.title, record.headline) || "untitled notice";
  const detail = clip(firstText(record.description, record.summary) || productName);
  return {
    record_id: `${sourceId}:${record.id || record.documentId || `row-${index}`}`,
    external_id: firstText(record.id, record.documentId),
    product_name: clip(productName, 120),
    brand: null,
    detail_text: detail,
    identity: { barcodes: [], lots: [], codes: pathogens.slice(0, 6).map((p) => clip(p, 60)) },
    recall_class: "unknown",
    hazard_terms: hazardTerms(`${pathogens.join(" ")} ${detail}`),
    jurisdiction: clip(locations.join(", ") || firstText(record.state), 120),
    event_date: toIsoDate(record.updated_at || record.published_at || record.effectiveDate),
    extra: {
      pathogens: pathogens.slice(0, 8).map((p) => clip(p, 60)),
      locations: locations.slice(0, 8).map((l) => clip(l, 60)),
      url: firstText(record.url, record.link),
    },
  };
}

function normalizeNorsOutbreak(record, sourceId, index) {
  const vehicle = firstText(record.food_vehicle, record.food_contaminated_ingredient);
  const etiology = firstText(record.etiology) || "unspecified agent";
  const productName = vehicle ? `${vehicle} (${etiology})` : `${etiology} outbreak, ${record.state || "location not recorded"}`;
  const detail = clip(
    [
      `${firstText(record.primary_mode) || "unspecified"} transmission`,
      `agent ${etiology}${record.serotype_or_genotype ? ` / ${record.serotype_or_genotype}` : ""}`,
      vehicle ? `food vehicle ${vehicle}` : null,
      record.ifsac_category ? `category ${record.ifsac_category}` : null,
      firstText(record.setting) ? `setting ${record.setting}` : null,
    ]
      .filter(Boolean)
      .join("; ")
  );
  return {
    record_id: `${sourceId}:${[record.year, record.state, etiology, index].filter(Boolean).join("-")}`,
    external_id: [record.year, record.state, etiology].filter(Boolean).join("/"),
    product_name: clip(productName, 120),
    brand: null,
    detail_text: detail,
    identity: { barcodes: [], lots: [], codes: list(record.serotype_or_genotype).slice(0, 4).map((s) => clip(s, 60)) },
    recall_class: "unknown",
    hazard_terms: hazardTerms(detail),
    jurisdiction: firstText(record.state),
    event_date: toIsoDate(`${record.year}${String(record.month || "1").padStart(2, "0")}01`),
    extra: {
      etiology: clip(etiology, 60),
      serotype_or_genotype: clip(firstText(record.serotype_or_genotype), 60),
      primary_mode: clip(firstText(record.primary_mode), 40),
      setting: clip(firstText(record.setting), 80),
      food_vehicle: clip(vehicle, 80),
      ifsac_category: clip(firstText(record.ifsac_category), 60),
      illnesses: firstText(record.illnesses),
      hospitalizations: firstText(record.hospitalizations),
      deaths: firstText(record.deaths),
    },
  };
}

function normalizeOpenFoodFacts(record, sourceId, index) {
  const productName = firstText(record.product_name_en, record.product_name, record.generic_name_en);
  const tags = englishTags(record.categories_tags);
  if (!productName || !record.code) return null;
  if (!hasEnglishText(record)) return null;
  return {
    record_id: `${sourceId}:${record.code}`,
    external_id: firstText(record.code),
    product_name: clip(productName, 90),
    brand: clip(firstText(record.brands), 80) || "unbranded",
    detail_text: clip(`${tags.join(", ") || "uncategorized"}; ${firstText(record.quantity) || "quantity unstated"}`),
    identity: {
      barcodes: [String(record.code).replace(/\D/g, "")],
      lots: [],
      codes: [],
    },
    recall_class: "unknown",
    hazard_terms: hazardTerms(tags.join(" "), record.allergens_tags, record.traces_tags),
    jurisdiction: "united states",
    event_date: toIsoDate(record.last_modified_t),
    extra: {
      categories: clip(tags.join(", "), 120),
      quantity: clip(firstText(record.quantity), 40),
      nutriscore_grade: firstText(record.nutriscore_grade),
      contributor: clip(firstText(record.creator), 40),
    },
  };
}

function normalizeLedgerRecord(record, sourceId) {
  return {
    record_id: `${sourceId}:${record.donation_id}`,
    external_id: record.donation_id,
    product_name: record.product_name,
    brand: record.brand,
    detail_text: clip(`${record.category}; ${record.storage_zone} storage; ${record.quantity_units} units`),
    identity: { barcodes: record.barcode ? [record.barcode] : [], lots: record.lot ? [record.lot] : [] },
    recall_class: "unknown",
    hazard_terms: hazardTerms(record.category, record.product_name),
    jurisdiction: record.site,
    event_date: record.received_on,
    extra: {
      quantity_units: record.quantity_units,
      storage_zone: record.storage_zone,
      donor: record.donor,
      site: record.site,
      category: record.category,
    },
  };
}

const NORMALIZERS = {
  fda_drug_enforcement: (records) => records.map((r, i) => normalizeEnforcement(r, "fda_drug_enforcement", i)),
  fda_food_enforcement: (records) => records.map((r, i) => normalizeEnforcement(r, "fda_food_enforcement", i)),
  fda_drug_event: (records) => records.map((r, i) => normalizeAdverseEvent(r, "fda_drug_event", i)),
  cdc_outbreak_notices: (records, shape) =>
    (shape === "nors"
      ? records.map((r, i) => normalizeNorsOutbreak(r, "cdc_outbreak_notices", i))
      : records.map((r, i) => normalizeOutbreakNotice(r, "cdc_outbreak_notices", i))),
  open_food_facts: (records) =>
    records.map((r, i) => normalizeOpenFoodFacts(r, "open_food_facts", i)).filter(Boolean),
  donation_ledger: (records) => records.map((r) => normalizeLedgerRecord(r, "donation_ledger")),
};

/* --------------------------- donation ledger --------------------------- */

const LEDGER_SEED = 20261022;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEDGER_LINES = [
  { category: "milk", name: "Whole Milk", zone: "chill" },
  { category: "bread", name: "Sliced White Bread", zone: "dry" },
  { category: "bread", name: "Rye Loaf", zone: "dry" },
  { category: "cheese", name: "Sliced Mild Cheddar", zone: "chill" },
  { category: "yogurt", name: "Vanilla Yogurt Cup", zone: "chill" },
  { category: "salad", name: "Washed Salad Mix", zone: "chill" },
  { category: "frozen fruit", name: "Frozen Mixed Berries", zone: "frozen" },
  { category: "cereal", name: "Granola Cluster Cereal", zone: "dry" },
  { category: "tortilla chips", name: "Salted Tortilla Chips", zone: "dry" },
  { category: "nut butter", name: "Peanut Butter Jar", zone: "dry" },
  { category: "canned beans", name: "Canned Black Beans", zone: "dry" },
  { category: "juice", name: "Apple Juice Carton", zone: "dry" },
  { category: "ice cream", name: "Vanilla Ice Cream Tub", zone: "frozen" },
  { category: "meat", name: "Ground Turkey Package", zone: "chill" },
];

const LEDGER_BRANDS = [
  "Northfield Provisions",
  "Harbor Valley Bakery",
  "Cedar Hollow Farms",
  "Prairie Gate Foods",
  "Lakeside Dairy Co",
];

const LEDGER_SITES = ["Riverside cold store", "Eastside pantry hub", "Northgate distribution bay"];
const LEDGER_DONORS = [
  "Regional grocery recovery programme",
  "Community drive",
  "Retail overstock transfer",
  "Farmers market rescue",
];

function generateDonationLedger(count) {
  const random = mulberry32(LEDGER_SEED);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const line = LEDGER_LINES[Math.floor(random() * LEDGER_LINES.length)];
    const brand = LEDGER_BRANDS[Math.floor(random() * LEDGER_BRANDS.length)];
    const day = 1 + Math.floor(random() * 27);
    const month = 8 + Math.floor(random() * 3);
    const suffix = String(4000 + Math.floor(random() * 5000));
    rows.push({
      donation_id: `SYN-DON-${String(101 + i)}`,
      product_name: `${brand.split(" ")[0]} ${line.name}`,
      brand,
      category: line.category,
      lot: `SYN-${suffix}`,
      barcode: `2${String(Math.floor(random() * 9) + 0)}${suffix}${String(1000 + Math.floor(random() * 8999))}`.slice(0, 12),
      quantity_units: 6 + Math.floor(random() * 240),
      received_on: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      site: LEDGER_SITES[Math.floor(random() * LEDGER_SITES.length)],
      storage_zone: line.zone,
      donor: LEDGER_DONORS[Math.floor(random() * LEDGER_DONORS.length)],
    });
  }
  return rows;
}

/* ------------------------------- writer ------------------------------- */

function envelopeOf(source, { endpointUrl, records, notes, dataOrigin, shape }) {
  return {
    source_id: source.id,
    title: source.title,
    agency: source.agency,
    endpoint: endpointUrl,
    fetched_at: new Date().toISOString(),
    record_count: records.length,
    max_records: source.max_records,
    data_origin: dataOrigin,
    payload_shape: shape || null,
    licence: source.licence.name,
    licence_citation: source.licence.citation,
    attribution: source.licence.attribution_text || null,
    attribution_required: source.licence.attribution_required,
    notes: notes.filter(Boolean),
    records,
  };
}

function cacheIsFresh(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.records) && typeof parsed.fetched_at === "string" && typeof parsed.endpoint === "string";
  } catch {
    return false;
  }
}

async function fetchSource(source, args) {
  const file = path.join(DATA_DIR, path.basename(source.cache_file));
  if (!args.refresh && cacheIsFresh(file)) {
    return { source: source.id, action: "skipped", detail: "cache already present (use --refresh to re-fetch)" };
  }

  if (source.synthetic) {
    const records = NORMALIZERS[source.id](generateDonationLedger(source.max_records));
    fs.writeFileSync(file, `${JSON.stringify(envelopeOf(source, {
      endpointUrl: "local: generated deterministically from a fixed seed (no network)",
      records,
      dataOrigin: "synthetic",
      shape: "generated",
      notes: [
        "Synthetic donation ledger generated by src/data/fetch-samples.js from a fixed seed.",
        "Brands, sites, lots and barcodes are fictional; barcodes use an internal prefix and are not real GTINs.",
        "Record count is stated in this file and in data/README.md.",
      ],
    }), null, 2)}\n`);
    return { source: source.id, action: "generated", records: records.length };
  }

  const attempts = [
    { label: "primary", endpoint: source.endpoint, shape: source.id === "cdc_outbreak_notices" ? "notices" : null },
  ];
  if (source.fallback_endpoint) {
    attempts.push({ label: "fallback", endpoint: source.fallback_endpoint, shape: "nors" });
  }

  const failures = [];
  for (const attempt of attempts) {
    const url = buildUrl(attempt.endpoint, source.max_records);
    const result = await requestJson(url, {
      headers: attempt.endpoint.headers || {},
      timeoutMs: args.timeoutMs,
      retryWaitMs: args.retryWaitMs,
      label: `${source.id} ${attempt.label}`,
    });
    if (!result.ok) {
      failures.push(`${attempt.label}: ${result.error}`);
      continue;
    }
    const apiError = result.payload?.meta?.status >= 400 ? result.payload.meta : null;
    if (apiError) {
      const message = (apiError.message || [{}]).map((m) => m.userMessage).filter(Boolean).join(", ") || "API error";
      failures.push(`${attempt.label}: HTTP 200 with API status ${apiError.status} - ${message}`);
      continue;
    }
    const raw = attempt.endpoint.response_path ? dig(result.payload, attempt.endpoint.response_path) : result.payload;
    const records = list(raw).slice(0, source.max_records);
    if (records.length === 0) {
      failures.push(`${attempt.label}: endpoint answered but returned no rows`);
      continue;
    }
    const normalized = NORMALIZERS[source.id](records, attempt.shape).slice(0, source.max_records);
    if (normalized.length === 0) {
      failures.push(`${attempt.label}: endpoint answered ${records.length} rows but none survived normalization`);
      continue;
    }
    const notes = [
      `Fetched ${records.length} raw rows from the ${attempt.label} endpoint; stored ${normalized.length} normalized records (cap ${source.max_records}).`,
      attempt.endpoint.notes || null,
      source.id === "fda_drug_event"
        ? "Patient demographics are dropped during normalization; only product, indication and reaction text is cached."
        : null,
      source.id === "open_food_facts"
        ? "English-language fields and lowercase en: category tags are used; products whose language map records no English text are dropped, so the cache holds English text only."
        : null,
      attempt.label === "fallback"
        ? "The outbreak-notices resource refused programmatic access, so these second-agency rows come from the CDC open data portal instead; the endpoint recorded here is the one that actually served them."
        : null,
    ];
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        envelopeOf(source, {
          endpointUrl: url.toString(),
          records: normalized,
          dataOrigin: "public",
          shape: attempt.shape || "api",
          notes,
        }),
        null,
        2
      )}\n`
    );
    return {
      source: source.id,
      action: attempt.label === "fallback" ? "fetched-with-fallback" : "fetched",
      records: normalized.length,
      endpoint: url.toString(),
      failed_attempts: failures,
    };
  }

  const kept = fs.existsSync(file);
  return {
    source: source.id,
    action: kept ? "kept-existing-cache" : "failed",
    detail: failures.join(" | "),
    records: kept ? JSON.parse(fs.readFileSync(file, "utf8")).record_count : 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const targets = args.only ? [sourceById(args.only)] : SOURCES;
  const results = [];
  for (const source of targets) {
    log(`fetch ${source.id} ...`);
    try {
      const result = await fetchSource(source, args);
      results.push(result);
      log(`  ${result.action}${result.records ? ` (${result.records} records)` : ""}${result.detail ? ` - ${result.detail}` : ""}`);
    } catch (err) {
      results.push({ source: source.id, action: "error", detail: err.message });
      log(`  error - ${err.message}`);
    }
  }
  const unusable = results.filter((r) => r.action === "failed" || r.action === "error");
  log("");
  log("source            action                    records");
  for (const r of results) {
    log(`${r.source.padEnd(17)} ${r.action.padEnd(23)} ${r.records ?? 0}`);
  }
  log(unusable.length ? `${unusable.length} source(s) have no usable cache.` : "All targeted sources have a usable cache.");
  process.exit(unusable.length ? 1 : 0);
}

main().catch((err) => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
