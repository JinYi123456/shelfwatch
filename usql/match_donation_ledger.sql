-- match_donation_ledger
-- Data layer execution order: query 5 of 7. One statement, sent intact.
--
-- Parameters rendered by src/data/zetaris-adapter.js:
--   names[], brands[], barcodes[], lots[], limit
--
-- What the product actually holds: donations of this product, by lot, with the
-- unit counts a pull list has to account for. The ledger is synthetic and is
-- labelled as such on every row.
WITH base AS (
    SELECT
        donation_id,
        identity_key,
        product_name,
        brand,
        barcode,
        lot_text,
        quantity_units,
        received_on,
        site,
        storage_zone,
        donor,
        data_origin,
        product_name AS match_name,
        brand AS match_brand,
        lot_text AS match_lot,
        lot_text AS match_hazard,
        site AS match_jurisdiction
    FROM lightning.metastore.shelfwatch.shelfwatch_recall.donation_holding
),
scored AS (
    SELECT
        base.*,
        ROUND(
              0.42 * (CASE WHEN {{NAME_MATCH}} THEN 1 ELSE 0 END)
            + 0.18 * (CASE WHEN {{BRAND_MATCH}} THEN 1 ELSE 0 END)
            + 0.28 * (CASE WHEN barcode IN ({{BARCODE_LIST}}) THEN 1 ELSE 0 END)
            + 0.32 * (CASE WHEN lot_text IN ({{LOT_LIST}}) OR {{LOT_MATCH}} THEN 1 ELSE 0 END),
            4
        ) AS match_score
    FROM base
    WHERE {{NAME_MATCH}}
       OR {{BRAND_MATCH}}
       OR barcode IN ({{BARCODE_LIST}})
       OR lot_text IN ({{LOT_LIST}})
)
SELECT
    donation_id,
    identity_key,
    product_name,
    brand,
    lot_text AS lot,
    barcode,
    quantity_units,
    received_on,
    site,
    storage_zone,
    donor,
    data_origin,
    match_score,
    CONCAT('donation_ledger:', donation_id) AS source_ref,
    'local filestore table loaded from the product export (see usql/setup_register_sources.sql)' AS endpoint,
    'Synthetic data' AS licence
FROM scored
WHERE match_score > 0
ORDER BY match_score DESC, quantity_units DESC, donation_id ASC
LIMIT {{LIMIT}}
