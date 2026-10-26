-- =============================================================================
-- Shelfwatch data layer, step 1: register the source endpoints.
--
-- Run each statement separately against the Zetaris SQL Editor or through
-- POST {ZETARIS_BASE_URL}/sql-editor/sqls/run. One statement per call.
-- The CREATE LIGHTNING REST TABLE calls reach the public endpoints from the
-- Zetaris instance, so the instance must have outbound access to them.
--
-- Object names used here are the ones src/data/zetaris-adapter.js and the
-- queries in this directory expect. Keep them if you re-run.
-- =============================================================================

-- Lightning database that holds the REST tables for this product.
CREATE LIGHTNING DATABASE SHELFWATCH_REST DESCRIBE BY 'Shelfwatch recall-triage public sources (REST)';

-- FDA food enforcement (recall) reports. Key-free public openFDA endpoint.
CREATE LIGHTNING REST TABLE fda_food_enforcement_raw FROM SHELFWATCH_REST REQUEST (
    endpoint "https://api.fda.gov/food/enforcement.json?limit=200&sort=recall_initiation_date:desc",
    method "get",
    response_type "json",
    http_encoding "URLENCODED",
    insecure_ssl "false"
) HEADER (
    user-agent "Shelfwatch recall triage (food-bank duty officer)"
) BODY ();

-- FDA drug enforcement (recall) reports.
CREATE LIGHTNING REST TABLE fda_drug_enforcement_raw FROM SHELFWATCH_REST REQUEST (
    endpoint "https://api.fda.gov/drug/enforcement.json?limit=200&sort=recall_initiation_date:desc",
    method "get",
    response_type "json",
    http_encoding "URLENCODED",
    insecure_ssl "false"
) HEADER (
    user-agent "Shelfwatch recall triage (food-bank duty officer)"
) BODY ();

-- FDA adverse event reports: free text, no product code, the disagreeing voice.
-- Sorted on receivedate, the field the endpoint accepts for sorting.
CREATE LIGHTNING REST TABLE fda_drug_event_raw FROM SHELFWATCH_REST REQUEST (
    endpoint "https://api.fda.gov/drug/event.json?limit=200&sort=receivedate:desc",
    method "get",
    response_type "json",
    http_encoding "URLENCODED",
    insecure_ssl "false"
) HEADER (
    user-agent "Shelfwatch recall triage (food-bank duty officer)"
) BODY ();

-- Second agency, primary feed: CDC outbreak notices. The resource pages with its
-- own pagenum / max / offset parameters and rejects a limit parameter.
CREATE LIGHTNING REST TABLE cdc_outbreak_notices_raw FROM SHELFWATCH_REST REQUEST (
    endpoint "https://tools.cdc.gov/api/v2/resources/outbreak-notices?pagenum=1&max=100&offset=0",
    method "get",
    response_type "json",
    http_encoding "URLENCODED",
    insecure_ssl "false"
) HEADER (
    accept "application/json"
) BODY ();

-- Second agency, fallback feed: CDC outbreak records on the CDC open data
-- portal. Registered because the outbreak-notices resource refused
-- programmatic access when this product's cache was built; the fallback stays
-- a CDC endpoint, so the second agency does not change.
CREATE LIGHTNING REST TABLE cdc_open_data_outbreaks_raw FROM SHELFWATCH_REST REQUEST (
    endpoint "https://data.cdc.gov/resource/5xkq-dg7x.json?$limit=200&$where=primary_mode='Food' AND year>='2019'&$order=year DESC",
    method "get",
    response_type "json",
    http_encoding "URLENCODED",
    insecure_ssl "false"
) HEADER (
    accept "application/json"
) BODY ();

-- Open Food Facts: product identity crosswalk (names, brands, categories,
-- barcodes). ODbL: attribution and share-alike apply to anything built on it.
CREATE LIGHTNING REST TABLE open_food_facts_search_raw FROM SHELFWATCH_REST REQUEST (
    endpoint "https://world.openfoodfacts.org/api/v2/search?page_size=100&page=1&countries_tags=en:united-states&fields=code,product_name,product_name_en,brands,categories_tags,quantity,nutriscore_grade,last_modified_t,languages",
    method "get",
    response_type "json",
    http_encoding "URLENCODED",
    insecure_ssl "false"
) HEADER (
    user-agent "Shelfwatch recall triage (product identity lookups)"
) BODY ();

-- Donation ledger: the product's own synthetic record of received donations.
-- It is loaded as a JSON file table from storage the instance can reach. Put
-- the export produced by src/data/fetch-samples.js at the path below. Storage
-- credentials belong to the instance configuration, never in this file.
CREATE LIGHTNING DATABASE SHELFWATCH_LOCAL DESCRIBE BY 'Shelfwatch owned synthetic data (filestore)';

CREATE LIGHTNING FILESTORE TABLE donation_ledger FROM SHELFWATCH_LOCAL FORMAT JSON OPTIONS (
    path "REPLACE_WITH_REACHABLE_STORAGE_PATH/shelfwatch/donation-ledger.json"
);

-- Confirm what the instance inferred before compiling the semantic layer:
SHOW LIGHTNING TABLES SHELFWATCH_REST;
SHOW LIGHTNING TABLES SHELFWATCH_LOCAL;
DESCRIBE DATASOURCE TABLE SHELFWATCH_REST.fda_food_enforcement_raw;
DESCRIBE DATASOURCE TABLE SHELFWATCH_LOCAL.donation_ledger;
