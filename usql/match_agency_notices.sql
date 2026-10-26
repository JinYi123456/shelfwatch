-- match_agency_notices
-- Data layer execution order: query 4 of 7. One statement, sent intact.
--
-- Parameters rendered by src/data/zetaris-adapter.js:
--   names[], keywords[], jurisdictions[], limit
--
-- Second agency (CDC) notices related to the product, the hazard or the region.
-- A notice rarely names a branded product, so hazard and region are first-class
-- matching dimensions here rather than an afterthought.
WITH base AS (
    SELECT
        record_key,
        source_id,
        identity_key,
        external_id AS notice_ref,
        product_name,
        hazard_text,
        jurisdiction,
        lot_text AS agent_codes,
        event_date AS notice_date,
        endpoint,
        licence,
        product_name AS match_name,
        brand AS match_brand,
        hazard_text AS match_hazard,
        jurisdiction AS match_jurisdiction,
        lot_text AS match_lot
    FROM lightning.metastore.shelfwatch.shelfwatch_recall.source_record
    WHERE source_id = 'cdc_outbreak_notices'
),
scored AS (
    SELECT
        base.*,
        ROUND(
              0.45 * (CASE WHEN {{NAME_MATCH}} THEN 1 ELSE 0 END)
            + 0.30 * (CASE WHEN {{HAZARD_MATCH}} THEN 1 ELSE 0 END)
            + 0.25 * (CASE WHEN {{STATE_MATCH}} THEN 1 ELSE 0 END),
            4
        ) AS match_score
    FROM base
    WHERE {{NAME_MATCH}}
       OR ({{HAZARD_MATCH}} AND {{STATE_MATCH}})
)
SELECT
    notice_ref,
    identity_key,
    product_name AS headline,
    hazard_text AS notice_text,
    agent_codes,
    jurisdiction AS state,
    notice_date,
    match_score,
    record_key AS source_ref,
    endpoint,
    licence
FROM scored
WHERE match_score >= {{MIN_SCORE}}
ORDER BY match_score DESC, notice_date DESC, notice_ref ASC
LIMIT {{LIMIT}}
