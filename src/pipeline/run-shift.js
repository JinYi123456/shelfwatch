import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import { selectBackend } from "../backends/index.js";
import { createDataLayer } from "../data/index.js";
import { openWorldModel } from "../engines/world-model.js";
import { openHMem } from "../engines/hmem.js";

const DEFAULT_FLOOR = 0.7;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MEMORY_MATCH_THRESHOLD = 0.55;

const OBSERVATION_KIND_FOR = {
  fda_food_enforcement: "observation.recall_notice",
  fda_drug_enforcement: "observation.recall_notice",
  fda_adverse_events: "observation.adverse_event_mention",
  cdc_outbreak_notices: "observation.recall_notice",
  open_food_facts: "observation.crosswalk_hit",
  donation_ledger: "observation.donation_ledger_line",
};

function normalizeKey(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Every identity the Ledger retrieved becomes an observation in the entity
 * graph, tagged with the source that produced it. This is what makes the next
 * shift cheaper than this one.
 */
function ingestObservations(worldModel, rows, { runId, at }) {
  let ingested = 0;
  const seen = new Set(
    worldModel
      .events()
      .filter((e) => String(e.kind).startsWith("observation."))
      .map((e) => `${normalizeKey(e.product)}|${e.source}`)
  );
  for (const row of rows || []) {
    const sources = row.corroborating_sources || [];
    const product = row.canonical_name || row.product_name || row.identity_key;
    for (const sourceId of sources) {
      const kind = OBSERVATION_KIND_FOR[sourceId];
      if (!kind) continue;
      const key = `${normalizeKey(product)}|${sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      worldModel.appendEvent({
        kind,
        at,
        source: sourceId,
        summary: `${sourceId} describes ${row.canonical_name || row.product_name || row.identity_key}`,
        product: row.canonical_name || row.product_name || row.identity_key,
        aliases: [row.brand, row.crosswalk_name].filter(Boolean),
        tags: [row.recall_class, ...(row.hazard_terms_in_enforcement || [])].filter(Boolean),
        reference: row.identity_key,
        trust: Number(row.confidence ?? 0.5),
        agentId: "Ledger",
        runId,
        taskId: `ingest:${row.identity_key}`,
      });
      ingested += 1;
    }
  }
  return ingested;
}

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== "object") {
    throw new Error("Scenario must be a JSON object.");
  }
  if (!scenario.scenario_id || typeof scenario.scenario_id !== "string") {
    throw new Error("scenario_id is required.");
  }
  if (!scenario.shift_date || typeof scenario.shift_date !== "string") {
    throw new Error("shift_date is required.");
  }
  if (!Array.isArray(scenario.notices) || scenario.notices.length < 1) {
    throw new Error("notices must be a non-empty array.");
  }
  for (const n of scenario.notices) {
    if (!n.notice_id || !n.source || !n.product_name) {
      throw new Error("Each notice needs notice_id, source, and product_name.");
    }
  }
}

function termsFor(notice) {
  return {
    names: [notice.product_name].filter(Boolean),
    brands: [notice.brand].filter(Boolean),
    barcodes: [notice.barcode].filter(Boolean),
    lots: [notice.lot].filter(Boolean),
    keywords: String(notice.raw_text || "").split(/[^A-Za-z0-9]+/).filter((t) => t.length > 3).slice(0, 8),
    classes: [notice.class].filter(Boolean),
    as_of: scenarioDate(notice),
  };
}

function scenarioDate(notice) {
  return String(notice.issued || notice.event_date || "").slice(0, 10) || undefined;
}

/**
 * One shift: Foreman plans, Ledger queries the data layer, Assay adjudicates,
 * Anchor holds the memory. Every decision below is read out of the data the
 * Ledger retrieved and the memory the Anchor already carries.
 */
export async function runShift(scenario, options = {}) {
  validateScenario(scenario);

  const startedAt = new Date().toISOString();
  const runId = options.runId || randomUUID();
  const logger = options.logger || createLogger(options.logsDir);
  const floor =
    typeof scenario.auto_action_floor === "number" ? scenario.auto_action_floor : DEFAULT_FLOOR;
  const env = options.env || process.env;

  const { sampleMode, backend } = options.backend
    ? { sampleMode: options.sampleMode ?? true, backend: options.backend }
    : selectBackend(env);

  const data = options.data || createDataLayer(env, { dataDir: options.dataDir });
  const stateDir = options.stateDir || path.join(REPO_ROOT, "state");
  const worldModel = options.worldModel || openWorldModel({ dir: path.join(stateDir, "world-model") });
  const memory = options.memory || openHMem({ dir: path.join(stateDir, "h-mem"), agentId: "Anchor" });

  logger.event({
    run_id: runId,
    agent: "Foreman",
    action: "open_shift",
    target: scenario.scenario_id,
    verdict: "ok",
    detail: {
      notices: scenario.notices.length,
      reasoning_backend: backend.name,
      data_backend: data.backend,
      sample_mode: sampleMode,
      auto_action_floor: floor,
    },
  });

  const coverage = await data.query("source_coverage", {});
  logger.event({
    run_id: runId,
    agent: "Ledger",
    action: "check_sources",
    target: data.backend,
    verdict: coverage.rows.every((r) => r.available) ? "ok" : "degraded",
    detail: {
      sources: coverage.rows.length,
      unavailable: coverage.rows.filter((r) => !r.available).map((r) => r.source_id),
    },
  });

  logger.event({
    run_id: runId,
    agent: "Foreman",
    action: "delegate",
    target: "Ledger",
    verdict: "ok",
    detail: { task: "reconcile_notices" },
  });

  const candidates = new Map();
  let queryCount = 0;
  for (const notice of scenario.notices) {
    const result = await data.query("reconcile_signals", { ...termsFor(notice), limit: 3 });
    queryCount += 1;
    candidates.set(notice.notice_id, result.rows || []);
    logger.event({
      run_id: runId,
      agent: "Ledger",
      action: "query_data",
      target: notice.notice_id,
      verdict: (result.rows || []).length ? "hit" : "no_match",
      detail: {
        backend: data.backend,
        query: "reconcile_signals",
        rows: (result.rows || []).length,
        top_identity: result.rows?.[0]?.identity_key || null,
        corroborating_sources: result.rows?.[0]?.corroborating_sources ?? 0,
      },
    });
  }

  const memories = new Map();
  let observations = 0;
  for (const notice of scenario.notices) {
    observations += ingestObservations(worldModel, candidates.get(notice.notice_id), {
      runId,
      at: startedAt,
    });
  }
  logger.event({
    run_id: runId,
    agent: "Anchor",
    action: "ingest_observations",
    target: "entity_graph",
    verdict: "ok",
    detail: { events: observations, entities: worldModel.entityCount() },
  });

  for (const notice of scenario.notices) {
    const resolved = worldModel.resolveMention(notice.product_name);
    const recalled = memory.recall(`${notice.product_name} ${notice.brand || ""}`, { topN: 2, at: startedAt, actor: "Anchor" });
    const resolvedConfidence = Number(resolved.confidence ?? 0);
    const hit = resolvedConfidence >= MEMORY_MATCH_THRESHOLD || recalled.memories.length > 0;
    memories.set(notice.notice_id, { resolved, recalled, resolvedConfidence });
    logger.event({
      run_id: runId,
      agent: "Anchor",
      action: "memory_lookup",
      target: notice.notice_id,
      verdict: hit ? "hit" : "miss",
      confidence: resolvedConfidence,
      detail: {
        entity_id: resolved.entity_id || null,
        basis: resolved.match_basis || null,
        candidate_lookups: resolved.candidate_lookups ?? null,
        evidence: resolved.evidence?.event_ids || [],
        recall: recalled.memories.map((m) => ({ id: m.id || m.memory_id, reason: m.retrievalReason || recalled.retrievalReason })),
        recall_reason: recalled.retrievalReason || null,
      },
    });
  }

  const ctx = {
    scenario,
    logger: { event: (fields) => logger.event({ run_id: runId, ...fields }) },
    autoActionFloor: floor,
    candidates,
    memories,
    dataBackend: data.backend,
  };

  let matches = await backend.proposeMatches(ctx);

  let rejectionCount = 0;
  let revisionCount = 0;
  const revised = [];

  for (const match of matches) {
    const critique = await backend.critique(ctx, match);
    if (!critique.ok) {
      rejectionCount += 1;
      logger.event({
        run_id: runId,
        agent: "Foreman",
        action: "revise_plan",
        target: match.notice_id,
        verdict: "rework",
        detail: { reason: critique.reason },
      });
      const retr = await data.query("reconcile_signals", {
        ...termsFor(scenario.notices.find((n) => n.notice_id === match.notice_id) || {}),
        limit: 5,
      });
      queryCount += 1;
      logger.event({
        run_id: runId,
        agent: "Ledger",
        action: "re_query",
        target: match.notice_id,
        verdict: "ok",
        detail: { after_rejection: true, rows: (retr.rows || []).length },
      });
      revisionCount += 1;
      revised.push(critique.revised || match);
    } else {
      revised.push(match);
    }
  }
  matches = revised;

  const pullList = [];
  const escalations = [];
  const modelRoutes = [];
  let memoryHits = 0;

  for (const match of matches) {
    const actionId = `act:${match.notice_id}`;
    let status = "auto_action";
    let action = match.proposed_action || "monitor";
    let confidence = match.confidence;
    const memoryEntry = memories.get(match.notice_id);
    if (memoryEntry?.resolvedConfidence >= MEMORY_MATCH_THRESHOLD) memoryHits += 1;

    if (confidence < floor) {
      status = "escalated";
      action = "escalate";
      escalations.push({
        action_id: actionId,
        reason: `confidence ${confidence} below auto-action floor ${floor}`,
        confidence,
      });
      logger.event({
        run_id: runId,
        agent: "Assay",
        action: "escalate",
        target: actionId,
        verdict: "escalated",
        confidence,
        detail: { floor, evidence: match.evidence },
      });
    } else {
      logger.event({
        run_id: runId,
        agent: "Assay",
        action: "adjudicate",
        target: actionId,
        verdict: "auto_action",
        confidence,
        detail: { evidence: match.evidence },
      });
    }

    pullList.push({
      action_id: actionId,
      product_name: match.product_name,
      action,
      confidence,
      status,
      evidence: match.evidence,
      corroborating_sources: match.corroborating_sources ?? null,
      memory_entity: memoryEntry?.resolved?.entity_id || null,
      what_would_change:
        status === "escalated"
          ? "A stronger class label, lot code, or prior trusted mapping above the floor."
          : "Contradicting adverse-event text or a failed identity match would reopen adjudication.",
    });

    const graphEntity = memoryEntry?.resolved?.entity_id || match.entity_key;

    worldModel.recordResolution(
      match.product_name,
      { entity_id: graphEntity, confidence, evidence: match.evidence },
      { agentId: "Anchor", runId, at: startedAt }
    );

    memory.add(
      {
        type: "decision",
        layer: "working",
        tags: ["pull-list", status],
        text: `${action} ${match.product_name} at confidence ${confidence}`,
        confidence,
        entities: [graphEntity],
        provenance: { run_id: runId, notice_id: match.notice_id, evidence: match.evidence },
      },
      { at: startedAt, actor: "Anchor" }
    );

    if (status === "auto_action") {
      worldModel.recordOutcome({
        outcome: "correct",
        mention_text: match.product_name,
        entity_id: graphEntity,
        at: startedAt,
      });
      const remembered = memoryEntry?.recalled?.memories?.[0];
      if (remembered) memory.feedback(remembered.id || remembered.memory_id, "helpful", { at: startedAt, actor: "Anchor" });
    }

    logger.event({
      run_id: runId,
      agent: "Anchor",
      action: "record_outcome",
      target: graphEntity,
      verdict: status,
      confidence,
    });

    if (match.model_route) modelRoutes.push({ notice_id: match.notice_id, ...match.model_route });
  }

  const consolidation = memory.consolidate({ at: startedAt });
  const finishedAt = new Date().toISOString();
  const result = {
    run_id: runId,
    scenario_id: scenario.scenario_id,
    started_at: startedAt,
    finished_at: finishedAt,
    reasoning_backend: backend.name,
    data_backend: data.backend,
    sample_mode: sampleMode,
    auto_action_floor: floor,
    pull_list: pullList,
    escalations,
    engines: {
      world_model: {
        entities: worldModel.entityCount(),
        events: worldModel.eventCount(),
        state_hash: worldModel.stateHash(),
      },
      h_mem: {
        memories: memory.listMemories().length,
        ledger_entries: memory.ledgerEntries().length,
        proposals: memory.proposals().length,
      },
    },
    model_routes: modelRoutes,
    stats: {
      notices_in: scenario.notices.length,
      actions_out: pullList.length,
      escalation_count: escalations.length,
      rejection_count: rejectionCount,
      revision_count: revisionCount,
      memory_hits: memoryHits,
      data_queries: queryCount,
      corroborated: pullList.filter((p) => (p.corroborating_sources ?? 0) > 1).length,
      consolidation: {
        insights: consolidation.dream?.proposals?.length ?? consolidation.dream?.length ?? 0,
        slept: Boolean(consolidation.sleep),
      },
    },
    log_path: logger.path,
  };

  logger.event({
    run_id: runId,
    agent: "Foreman",
    action: "close_shift",
    target: scenario.scenario_id,
    verdict: "ok",
    detail: {
      actions_out: result.stats.actions_out,
      escalation_count: result.stats.escalation_count,
      rejection_count: result.stats.rejection_count,
      data_queries: result.stats.data_queries,
      memory_hits: result.stats.memory_hits,
      reasoning_backend: result.reasoning_backend,
      data_backend: result.data_backend,
    },
  });

  if (logger.close) await logger.close();
  return result;
}
