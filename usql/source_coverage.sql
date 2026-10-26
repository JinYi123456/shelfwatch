-- source_coverage
-- Data layer execution order: query 7 of 7. One statement, sent intact.
--
-- Parameters rendered by src/data/zetaris-adapter.js: limit, as_of
--
-- One row per registered source: how much it currently holds, how fresh its
-- newest record is, and what that means for a decision. The agents read this
-- before deciding whether a conclusion is safe to auto-action, so a missing or
-- stale source is visible to them instead of silently absent. Every count is
-- aggregated from source_record as it stands.
WITH coverage AS (
    SELECT
        source_id,
        COUNT(*) AS record_count,
        COUNT(DISTINCT identity_key) AS distinct_identities,
        MIN(event_date) AS earliest_event,
        MAX(event_date) AS latest_event,
        MAX(endpoint) AS endpoint,
        MAX(licence) AS licence
    FROM lightning.metastore.shelfwatch.shelfwatch_recall.source_record
    GROUP BY source_id
),
registered AS (
    SELECT 'fda_food_enforcement' AS source_id, 'FDA food enforcement reports' AS source_label,
           'U.S. Food and Drug Administration' AS agency
    UNION ALL
    SELECT 'fda_drug_enforcement', 'FDA drug enforcement reports',
           'U.S. Food and Drug Administration'
    UNION ALL
    SELECT 'fda_adverse_events', 'FDA adverse event reports',
           'U.S. Food and Drug Administration'
    UNION ALL
    SELECT 'cdc_outbreak_notices', 'CDC outbreak notices',
           'U.S. Centers for Disease Control and Prevention'
    UNION ALL
    SELECT 'open_food_facts', 'Open Food Facts product crosswalk', 'Open Food Facts contributors'
    UNION ALL
    SELECT 'donation_ledger', 'Donation ledger holdings', 'This product (synthetic)'
)
SELECT
    registered.source_id,
    registered.source_label,
    registered.agency,
    COALESCE(coverage.record_count, 0) AS record_count,
    COALESCE(coverage.distinct_identities, 0) AS distinct_identities,
    coverage.earliest_event,
    coverage.latest_event,
    coverage.endpoint,
    coverage.licence,
    CASE
        WHEN coverage.source_id IS NULL THEN 'unavailable'
        WHEN COALESCE(coverage.record_count, 0) = 0 THEN 'empty'
        ELSE 'available'
    END AS status,
    CASE
        WHEN coverage.source_id IS NULL THEN 'exclude this source from the decision and say so'
        WHEN coverage.latest_event < {{AS_OF}} THEN 'older than the shift date; treat as corroborating only'
        ELSE 'usable'
    END AS guidance
FROM registered
LEFT JOIN coverage ON coverage.source_id = registered.source_id
ORDER BY status ASC, record_count DESC, registered.source_id ASC
LIMIT {{LIMIT}}
