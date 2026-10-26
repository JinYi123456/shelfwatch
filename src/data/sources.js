/**
 * Source definitions for the reconciliation layer.
 *
 * Every entry is declarative only: how the source is reached, which fields of
 * its payload carry product identity, and what licence the data arrives under.
 * Fetching lives in fetch-samples.js, matching lives in local-executor.js.
 */

export const CACHE_CAP = 24;

export const SOURCES = [
  {
    id: "fda_drug_enforcement",
    title: "FDA drug enforcement reports",
    agency: "U.S. Food and Drug Administration",
    role: "Enforcement voice - regulated consumer products",
    scenario_sources: ["fda_enforcement"],
    cache_file: "data/fda-drug-enforcement.json",
    max_records: CACHE_CAP,
    endpoint: {
      method: "GET",
      url: "https://api.fda.gov/drug/enforcement.json",
      response_path: "results",
      params: {
        limit: "{max_records}",
        sort: "recall_initiation_date:desc",
      },
      notes:
        "Sorting is only accepted on non-analyzed fields; recall_initiation_date is the accepted key.",
    },
    identity_fields: {
      product_name: ["openfda.brand_name", "openfda.generic_name", "openfda.product_title", "product_description"],
      brand: ["openfda.brand_name", "recalling_firm"],
      code: ["openfda.package_ndc", "openfda.product_ndc", "openfda.rxcui"],
      lot: ["code_info"],
      recall_class: ["classification"],
      hazard_text: ["reason_for_recall", "product_description"],
      jurisdiction: ["distribution_pattern"],
      external_id: ["recall_number"],
      event_date: ["recall_initiation_date", "center_classification_date", "report_date"],
    },
    licence: {
      name: "U.S. Government public data",
      citation: "https://api.fda.gov/drug/enforcement.json",
      terms: ["https://open.fda.gov/terms/", "https://open.fda.gov/license/"],
      attribution_required: false,
      note: "Public recall data served by openFDA. The endpoint that produced the records is recorded with every cache file and must be cited wherever the records are shown.",
    },
  },
  {
    id: "fda_food_enforcement",
    title: "FDA food enforcement reports",
    agency: "U.S. Food and Drug Administration",
    role: "Enforcement voice - food products",
    scenario_sources: ["fda_enforcement"],
    cache_file: "data/fda-food-enforcement.json",
    max_records: CACHE_CAP,
    endpoint: {
      method: "GET",
      url: "https://api.fda.gov/food/enforcement.json",
      response_path: "results",
      params: {
        limit: "{max_records}",
        sort: "recall_initiation_date:desc",
      },
      notes:
        "The openfda block is frequently empty for food records, so product identity is read from the free-text product_description first.",
    },
    identity_fields: {
      product_name: ["openfda.brand_name", "product_description"],
      brand: ["openfda.brand_name", "recalling_firm"],
      code: ["openfda.upc_id"],
      lot: ["code_info"],
      recall_class: ["classification"],
      hazard_text: ["reason_for_recall", "product_description"],
      jurisdiction: ["distribution_pattern"],
      external_id: ["recall_number"],
      event_date: ["recall_initiation_date", "center_classification_date", "report_date"],
    },
    licence: {
      name: "U.S. Government public data",
      citation: "https://api.fda.gov/food/enforcement.json",
      terms: ["https://open.fda.gov/terms/", "https://open.fda.gov/license/"],
      attribution_required: false,
      note: "Public recall data served by openFDA. The endpoint that produced the records is recorded with every cache file and must be cited wherever the records are shown.",
    },
  },
  {
    id: "fda_drug_event",
    title: "FDA adverse event reports",
    agency: "U.S. Food and Drug Administration",
    role: "Second, disagreeing voice - free-text consumer reports, no product code",
    scenario_sources: ["fda_adverse_event"],
    cache_file: "data/fda-adverse-events.json",
    max_records: CACHE_CAP,
    endpoint: {
      method: "GET",
      url: "https://api.fda.gov/drug/event.json",
      response_path: "results",
      params: {
        limit: "{max_records}",
        sort: "receivedate:desc",
      },
      notes:
        "Sorting is accepted on receivedate, not on received_date; the raw payload uses the un-underscored field names.",
    },
    identity_fields: {
      product_name: ["patient.drug.medicinalproduct", "patient.drug.openfda.brand_name", "patient.drug.openfda.generic_name"],
      brand: ["patient.drug.openfda.brand_name", "patient.drug.openfda.manufacturer_name"],
      code: ["patient.drug.openfda.product_ndc", "patient.drug.productndc"],
      lot: [],
      recall_class: [],
      hazard_text: ["patient.reaction.symptomterm", "patient.drug.drugindication", "serious"],
      jurisdiction: ["receiver"],
      external_id: ["safetyreportid"],
      event_date: ["receivedate", "transmissiondate"],
    },
    licence: {
      name: "U.S. Government public data",
      citation: "https://api.fda.gov/drug/event.json",
      terms: ["https://open.fda.gov/terms/", "https://open.fda.gov/license/"],
      attribution_required: false,
      note: "Public adverse-event reports served by openFDA. Reports are unvalidated consumer text and carry no recall classification.",
    },
  },
  {
    id: "cdc_outbreak_notices",
    title: "Second agency outbreak notices",
    agency: "U.S. Centers for Disease Control and Prevention",
    role: "Second agency - independent outbreak signal",
    scenario_sources: ["second_agency"],
    cache_file: "data/cdc-outbreak-notices.json",
    max_records: CACHE_CAP,
    endpoint: {
      method: "GET",
      url: "https://tools.cdc.gov/api/v2/resources/outbreak-notices",
      response_path: "results",
      params: {
        pagenum: "1",
        max: "{max_records}",
        offset: "0",
      },
      notes:
        "The resource rejects a limit parameter; paging is driven by its own pagenum, max and offset parameters. Requested first at cache-build time; it answered every parameter combination with meta.status 400 Invalid API Request.",
    },
    fallback_endpoint: {
      method: "GET",
      url: "https://data.cdc.gov/resource/5xkq-dg7x.json",
      response_path: "",
      params: {
        $limit: "{max_records}",
        $where: "primary_mode='Food' AND year>='2019'",
        $order: "year DESC, state ASC",
      },
      notes:
        "CDC outbreak records published on the CDC open data portal (dataset 5xkq-dg7x, NORS outbreak records 1994-2022). Used as the second-agency notice set when the outbreak-notices resource refuses programmatic access.",
      licence: {
        name: "U.S. Government public data",
        citation: "https://data.cdc.gov/resource/5xkq-dg7x.json",
        terms: ["https://data.cdc.gov/about-our-data"],
        attribution_required: false,
        note: "CDC open data portal records. Cite the dataset id and endpoint wherever the records are shown.",
      },
      identity_fields: {
        product_name: ["food_vehicle", "food_contaminated_ingredient"],
        brand: [],
        code: [],
        lot: ["serotype_or_genotype"],
        recall_class: [],
        hazard_text: ["etiology", "setting", "primary_mode"],
        jurisdiction: ["state"],
        external_id: [],
        event_date: ["year", "month"],
      },
    },
    identity_fields: {
      product_name: ["title", "description"],
      brand: [],
      code: [],
      lot: ["pathogens"],
      recall_class: [],
      hazard_text: ["description", "pathogens"],
      jurisdiction: ["locations"],
      external_id: ["id"],
      event_date: ["updated_at", "published_at"],
    },
    licence: {
      name: "U.S. Government public data",
      citation: "https://tools.cdc.gov/api/v2/resources/outbreak-notices",
      terms: ["https://www.cdc.gov/other/mcp.html"],
      attribution_required: false,
      note: "Public CDC outbreak notices. The endpoint that actually served the cached rows is recorded in the cache provenance and must be cited wherever the rows are shown.",
    },
  },
  {
    id: "open_food_facts",
    title: "Open Food Facts product catalogue",
    agency: "Open Food Facts (community database)",
    role: "Product-identity crosswalk - names, brands, categories, barcodes",
    scenario_sources: ["open_food_facts"],
    cache_file: "data/open-food-facts.json",
    max_records: CACHE_CAP,
    endpoint: {
      method: "GET",
      url: "https://world.openfoodfacts.org/api/v2/search",
      response_path: "products",
      params: {
        page_size: "{max_records}",
        page: "1",
        countries_tags: "en:united-states",
        fields: "code,product_name,product_name_en,brands,categories_tags,quantity,nutriscore_grade,last_modified_t,creator,languages",
      },
      headers: {
        "user-agent": "Shelfwatch data cache (product identity lookups)",
      },
      notes:
        "API v2 search. A named user agent is required for fair use; the endpoint throttles aggressively (HTTP 503), so requests are spaced and retried once. The cache uses the English product_name_en field and en: category tags so the stored text stays English.",
    },
    identity_fields: {
      product_name: ["product_name_en", "product_name"],
      brand: ["brands"],
      code: ["code"],
      lot: [],
      recall_class: [],
      hazard_text: ["categories_tags", "allergens_tags", "traces_tags"],
      jurisdiction: ["countries_tags"],
      external_id: ["code"],
      event_date: ["last_modified_t"],
    },
    licence: {
      name: "ODbL (Open Data Commons Open Database License)",
      citation: "https://world.openfoodfacts.org/data",
      terms: ["https://opendatacommons.org/licenses/odbl/"],
      attribution_required: true,
      attribution_text:
        "Product identity data written by and licensed from Open Food Facts contributors under the ODbL. See https://world.openfoodfacts.org/data",
      note: "ODbL requires attribution of Open Food Facts contributors and share-alike for any combined database that is redistributed. Attribution text travels with the cached file and with every row the crosswalk returns.",
    },
  },
  {
    id: "donation_ledger",
    title: "Donation ledger (synthetic)",
    agency: "Shelfwatch product data - synthetic",
    role: "Own record of what was received and where it went",
    scenario_sources: ["donation_ledger"],
    cache_file: "data/donation-ledger.json",
    max_records: 48,
    synthetic: true,
    endpoint: null,
    identity_fields: {
      product_name: ["product_name"],
      brand: ["brand"],
      code: ["barcode"],
      lot: ["lot"],
      recall_class: [],
      hazard_text: ["storage_zone"],
      jurisdiction: ["site"],
      external_id: ["donation_id"],
      event_date: ["received_on"],
    },
    licence: {
      name: "Synthetic data",
      citation: "generated locally by src/data/fetch-samples.js",
      terms: [],
      attribution_required: false,
      note: "Synthetic. Not exported from any real food-bank system. Record count and limitations are stated in data/README.md and in the cache file provenance.",
    },
  },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);

export function sourceById(id) {
  const found = SOURCES.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown source id: ${id}`);
  return found;
}

/** Maps a scenario notice source label to the physical sources that back it. */
export const SCENARIO_SOURCE_ALIASES = SOURCES.reduce((acc, source) => {
  for (const label of source.scenario_sources) {
    acc[label] = [...(acc[label] || []), source.id];
  }
  return acc;
}, {});

export function sourcesForScenarioSource(label) {
  return SCENARIO_SOURCE_ALIASES[label] || [];
}
