import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { selectBackend } from "../backends/index.js";

const DEFAULT_FLOOR = 0.7;

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

/**
 * End-to-end stub loop: Foreman -> Ledger -> Assay -> Anchor.
 * Decisions are computed from the scenario via the selected backend.
 */
export async function runShift(scenario, options = {}) {
  validateScenario(scenario);

  const startedAt = new Date().toISOString();
  const runId = options.runId || randomUUID();
  const logger = options.logger || createLogger(options.logsDir);
  const floor =
    typeof scenario.auto_action_floor === "number"
      ? scenario.auto_action_floor
      : DEFAULT_FLOOR;

  const { sampleMode, backend } = options.backend
    ? { sampleMode: options.sampleMode ?? true, backend: options.backend }
    : selectBackend(options.env || process.env);

  logger.event({
    run_id: runId,
    agent: "Foreman",
    action: "open_shift",
    target: scenario.scenario_id,
    verdict: "ok",
    detail: {
      notices: scenario.notices.length,
      reasoning_backend: backend.name,
      sample_mode: sampleMode,
      auto_action_floor: floor,
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

  const ctx = {
    scenario,
    logger: {
      event: (fields) => logger.event({ run_id: runId, ...fields }),
    },
    autoActionFloor: floor,
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
      logger.event({
        run_id: runId,
        agent: "Ledger",
        action: "re_query",
        target: match.notice_id,
        verdict: "ok",
        detail: { after_rejection: true },
      });
      revisionCount += 1;
      revised.push(critique.revised || match);
    } else {
      revised.push(match);
    }
  }
  matches = revised;

  const memoryHits = (scenario.prior_memory_hits || []).length;
  logger.event({
    run_id: runId,
    agent: "Anchor",
    action: "memory_lookup",
    target: "entity_graph",
    verdict: memoryHits > 0 ? "hit" : "miss",
    detail: { memory_hits: memoryHits },
  });

  const pullList = [];
  const escalations = [];

  for (const match of matches) {
    const actionId = `act:${match.notice_id}`;
    let status = "auto_action";
    let action = match.proposed_action || "monitor";
    let confidence = match.confidence;

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
        detail: { floor },
      });
    } else {
      logger.event({
        run_id: runId,
        agent: "Assay",
        action: "adjudicate",
        target: actionId,
        verdict: "auto_action",
        confidence,
      });
    }

    pullList.push({
      action_id: actionId,
      product_name: match.product_name,
      action,
      confidence,
      status,
      evidence: match.evidence,
      what_would_change:
        status === "escalated"
          ? "A stronger class label, lot code, or prior trusted mapping above the floor."
          : "Contradicting adverse-event text or a failed identity match would reopen adjudication.",
    });

    logger.event({
      run_id: runId,
      agent: "Anchor",
      action: "record_outcome",
      target: match.entity_key,
      verdict: status,
      confidence,
    });
  }

  const finishedAt = new Date().toISOString();
  const result = {
    run_id: runId,
    scenario_id: scenario.scenario_id,
    started_at: startedAt,
    finished_at: finishedAt,
    reasoning_backend: backend.name,
    sample_mode: sampleMode,
    pull_list: pullList,
    escalations,
    stats: {
      notices_in: scenario.notices.length,
      actions_out: pullList.length,
      escalation_count: escalations.length,
      rejection_count: rejectionCount,
      revision_count: revisionCount,
      memory_hits: memoryHits,
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
      reasoning_backend: result.reasoning_backend,
    },
  });

  if (logger.close) await logger.close();
  return result;
}
