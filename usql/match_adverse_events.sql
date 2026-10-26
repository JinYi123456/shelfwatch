-- match_adverse_events
-- Data layer execution order: query 3 of 7. One statement, sent intact.
--
-- Parameters rendered by src/data/zetaris-adapter.js:
--   names[], brands[], keywords[], limit
--
-- Free-text adverse event reports that mention the product. These reports carry
-- no recall class and no product code, so they are matched on text and returned
-- as text: this is the voice that can disagree with the enforcement record.
WITH base AS (
    SELECT
        record_key,
        identity_key,
        external_id AS report_number,
        product_name AS reported_product,
        brand,
        hazard_text,
        event_date AS received_date,
        endpoint,
        licence,
        product_name AS match_name,
        brand AS match_brand,
        hazard_text AS match_hazard,
        lot_text AS match_lot
    FROM lightning.metastore.shelfwatch.shelfwatch_recall.source_record
    WHERE source_id = 'fda_drug_event'
),
scored AS (
    SELECT
        base.*,
        ROUND(
              0.55 * (CASE WHEN {{NAME_MATCH}} THEN 1 ELSE 0 END)
            + 0.20 * (CASE WHEN {{BRAND_MATCH}} THEN 1 ELSE 0 END)
            + 0.25 * (CASE WHEN {{HAZARD_MATCH}} THEN 1 ELSE 0 END),
            4
        ) AS match_score
    FROM base
    WHERE {{NAME_MATCH}}
       OR {{BRAND_MATCH}}
)
SELECT
    report_number,
    identity_key,
    reported_product,
    brand,
    hazard_text AS report_text,
    received_date,
    CASE WHEN {{HAZARD_MATCH}} THEN 'text_agrees_with_signal' ELSE 'text_only' END AS reading,
    match_score,
    record_key AS source_ref,
    endpoint,
    licence
FROM scored
WHERE match_score > 0
ORDER BY match_score DESC, received_date DESC, report_number ASC
LIMIT {{LIMIT}}
