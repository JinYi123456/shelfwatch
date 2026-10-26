-- match_enforcement_notices
-- Data layer execution order: query 2 of 7. One statement, sent intact.
--
-- Parameters rendered by src/data/zetaris-adapter.js:
--   names[], brands[], barcodes[], lots[], keywords[], classes[], limit
--
-- FDA enforcement (recall) records that match the supplied identity signals,
-- from both the food and the drug endpoint. Each row cites the endpoint and
-- licence it arrived under.
WITH base AS (
    SELECT
        record_key,
        source_id,
        identity_key,
        external_id AS recall_number,
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
        product_name AS match_name,
        brand AS match_brand,
        hazard_text AS match_hazard,
        lot_text AS match_lot
    FROM lightning.metastore.shelfwatch.shelfwatch_recall.source_record
    WHERE source_id IN ('fda_food_enforcement', 'fda_drug_enforcement')
),
scored AS (
    SELECT
        base.*,
        ROUND(
              0.50 * (CASE WHEN {{NAME_MATCH}} THEN 1 ELSE 0 END)
            + 0.18 * (CASE WHEN {{BRAND_MATCH}} THEN 1 ELSE 0 END)
            + 0.20 * (CASE WHEN barcode IN ({{BARCODE_LIST}}) THEN 1 ELSE 0 END)
            + 0.16 * (CASE WHEN lot_text IN ({{LOT_LIST}}) OR {{LOT_MATCH}} THEN 1 ELSE 0 END)
            + 0.08 * (CASE WHEN {{HAZARD_MATCH}} THEN 1 ELSE 0 END)
            + 0.04 * (CASE WHEN {{CLASS_MATCH}} THEN 1 ELSE 0 END),
            4
        ) AS match_score
    FROM base
    WHERE {{NAME_MATCH}}
       OR {{BRAND_MATCH}}
       OR barcode IN ({{BARCODE_LIST}})
       OR lot_text IN ({{LOT_LIST}})
)
SELECT
    recall_number,
    source_id,
    identity_key,
    product_name,
    brand,
    recall_class,
    hazard_text AS reason_for_recall,
    jurisdiction AS distribution_pattern,
    lot_text,
    barcode,
    event_date,
    match_score,
    record_key AS source_ref,
    endpoint,
    licence
FROM scored
WHERE match_score > 0
ORDER BY match_score DESC, event_date DESC, recall_number ASC
LIMIT {{LIMIT}}
