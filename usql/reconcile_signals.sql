-- reconcile_signals
-- Data layer execution order: query 6 of 7. One statement, sent intact.
--
-- Parameters rendered by src/data/zetaris-adapter.js:
--   names[], brands[], barcodes[], lots[], keywords[], classes[], jurisdictions[], limit
--
-- Cross-source reconciliation in one pass. Every source record is scored
-- against the identity signals on its own terms, the surviving rows are grouped
-- by reconciled identity, and each group reports which sources corroborated it
-- and how strongly. Confidence is computed from the corroboration that actually
-- exists in the data; no table of expected answers sits behind this statement.
WITH hits AS (
    SELECT
        source_id,
        identity_key,
        external_id,
        product_name,
        brand,
        recall_class,
        hazard_text,
        jurisdiction,
        lot_text,
        barcode,
        event_date,
        endpoint,
        licence,
        ROUND(
              0.46 * (CASE WHEN {{NAME_MATCH}} THEN 1 ELSE 0 END)
            + 0.16 * (CASE WHEN {{BRAND_MATCH}} THEN 1 ELSE 0 END)
            + 0.18 * (CASE WHEN barcode IN ({{BARCODE_LIST}}) THEN 1 ELSE 0 END)
            + 0.12 * (CASE WHEN {{LOT_MATCH}} THEN 1 ELSE 0 END)
            + 0.08 * (CASE WHEN {{HAZARD_MATCH}} THEN 1 ELSE 0 END)
            , 4) AS match_score
    FROM lightning.metastore.shelfwatch.shelfwatch_recall.source_record
    WHERE {{NAME_MATCH}}
       OR {{BRAND_MATCH}}
       OR barcode IN ({{BARCODE_LIST}})
       OR {{LOT_MATCH}}
),
per_source AS (
    SELECT
        identity_key,
        source_id,
        COUNT(*) AS records,
        MAX(match_score) AS best_score,
        MAX(event_date) AS last_seen,
        MAX(product_name) AS product_name,
        MAX(brand) AS brand,
        MAX(recall_class) AS worst_class,
        MAX(endpoint) AS endpoint,
        MAX(licence) AS licence
    FROM hits
    WHERE match_score > {{MIN_SCORE}}
    GROUP BY identity_key, source_id
),
grouped AS (
    SELECT
        identity_key,
        COUNT(DISTINCT source_id) AS corroborating_sources,
        SUM(records) AS record_count,
        MAX(best_score) AS strongest_match,
        MAX(last_seen) AS latest_event,
        SUM(CASE WHEN source_id IN ('fda_food_enforcement', 'fda_drug_enforcement') THEN records ELSE 0 END) AS enforcement_records,
        SUM(CASE WHEN source_id = 'fda_adverse_events' THEN records ELSE 0 END) AS adverse_event_records,
        SUM(CASE WHEN source_id = 'cdc_outbreak_notices' THEN records ELSE 0 END) AS agency_notice_records,
        SUM(CASE WHEN source_id = 'open_food_facts' THEN records ELSE 0 END) AS crosswalk_records,
        SUM(CASE WHEN source_id = 'donation_ledger' THEN records ELSE 0 END) AS ledger_records,
        MAX(product_name) AS product_name,
        MAX(brand) AS brand,
        MAX(worst_class) AS recall_class,
        MAX(endpoint) AS endpoint,
        MAX(licence) AS licence
    FROM per_source
    GROUP BY identity_key
)
SELECT
    identity_key,
    COALESCE(product_name, identity_key) AS product_name,
    brand,
    corroborating_sources,
    record_count,
    strongest_match,
    ROUND(CASE WHEN 0.30 * corroborating_sources + 0.45 * strongest_match > 0.95
              THEN 0.95 ELSE 0.30 * corroborating_sources + 0.45 * strongest_match END, 4) AS confidence,
    enforcement_records,
    adverse_event_records,
    agency_notice_records,
    crosswalk_records,
    ledger_records,
    CASE WHEN crosswalk_records = 0 THEN 'identity_unresolved' ELSE 'identity_resolved' END AS identity_status,
    CASE WHEN adverse_event_records > 0 AND enforcement_records = 0
         THEN 'reports_without_notice' ELSE 'consistent' END AS conflict,
    recall_class,
    latest_event,
    endpoint,
    licence
FROM grouped
ORDER BY confidence DESC, corroborating_sources DESC, record_count DESC, identity_key ASC
LIMIT {{LIMIT}}
