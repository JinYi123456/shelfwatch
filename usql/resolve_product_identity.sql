-- resolve_product_identity
-- Data layer execution order: query 1 of 7 (after setup_register_sources.sql
-- and shelfwatch_recall.usql). One statement, sent intact.
--
-- Parameters rendered by src/data/zetaris-adapter.js:
--   names[], brands[], barcodes[], min_score, limit
--
-- Returns candidate product identities from the Open Food Facts crosswalk,
-- best match first. ODbL attribution is returned on every row because the row
-- is a redistribution of crosswalk data.
WITH crosswalk AS (
    SELECT
        record_key,
        identity_key,
        external_id,
        product_name,
        brand,
        barcode,
        hazard_text AS categories,
        event_date,
        endpoint,
        licence,
        attribution,
        product_name AS match_name,
        brand AS match_brand,
        hazard_text AS match_hazard,
        lot_text AS match_lot
    FROM lightning.metastore.shelfwatch.shelfwatch_recall.source_record
    WHERE source_id = 'open_food_facts'
),
scored AS (
    SELECT
        crosswalk.*,
        ROUND(
              0.60 * (CASE WHEN {{NAME_MATCH}} THEN 1 ELSE 0 END)
            + 0.22 * (CASE WHEN {{BRAND_MATCH}} THEN 1 ELSE 0 END)
            + 0.18 * (CASE WHEN barcode IN ({{BARCODE_LIST}}) THEN 1 ELSE 0 END)
            + 0.10 * (CASE WHEN {{HAZARD_MATCH}} THEN 1 ELSE 0 END),
            4
        ) AS match_score
    FROM crosswalk
    WHERE {{NAME_MATCH}}
       OR {{BRAND_MATCH}}
       OR barcode IN ({{BARCODE_LIST}})
)
SELECT
    identity_key,
    product_name AS canonical_name,
    brand,
    barcode,
    categories,
    event_date AS record_date,
    match_score,
    record_key AS source_ref,
    endpoint,
    licence,
    attribution
FROM scored
WHERE match_score >= {{MIN_SCORE}}
ORDER BY match_score DESC, identity_key ASC
LIMIT {{LIMIT}}
