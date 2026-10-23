/**
 * OfflineBackend — deterministic reasoner for SAMPLE_MODE.
 * Scores and entity keys are computed from the scenario input.
 * Never returns a canned final answer independent of input.
 */

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Stable 32-bit mix from a string — used only as a feature hash, not as an answer. */
function mix(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function classWeight(cls) {
  if (cls === "I") return 0.28;
  if (cls === "II") return 0.18;
  if (cls === "III") return 0.1;
  return 0.12;
}

function sourceWeight(source) {
  if (source === "fda_enforcement") return 0.22;
  if (source === "second_agency") return 0.18;
  if (source === "fda_adverse_event") return 0.1;
  if (source === "open_food_facts") return 0.16;
  if (source === "donation_ledger") return 0.14;
  return 0.1;
}

function memoryBoost(scenario, entityKey) {
  const hits = scenario.prior_memory_hits || [];
  for (const hit of hits) {
    if (hit.entity_key === entityKey) {
      return Math.min(0.2, Number(hit.trust ?? 0.15));
    }
  }
  return 0;
}

function scoreNotice(scenario, notice) {
  const norm = normalizeName(notice.product_name);
  const entityKey = `ent:${norm || "unknown"}`;
  const lotBit = notice.lot ? 0.08 : 0;
  const barcodeBit = notice.barcode ? 0.06 : 0;
  const textBit = notice.raw_text && notice.raw_text.length > 40 ? 0.05 : 0;
  // Tiny input-dependent jitter from content hash so equal-looking stubs still vary by payload.
  const jitter = (mix(notice.notice_id + "|" + norm) % 1000) / 10000;

  let confidence =
    0.25 +
    classWeight(notice.class) +
    sourceWeight(notice.source) +
    lotBit +
    barcodeBit +
    textBit +
    memoryBoost(scenario, entityKey) +
    jitter;

  confidence = Math.max(0.05, Math.min(0.99, confidence));

  let proposed = "monitor";
  if (notice.class === "I" && confidence >= 0.7) proposed = "pull";
  else if (notice.class === "I") proposed = "escalate";
  else if (notice.class === "II" && confidence >= 0.7) proposed = "hold";
  else if (confidence < 0.7) proposed = "escalate";

  const evidence = [
    `notice:${notice.notice_id}`,
    `source:${notice.source}`,
    `class:${notice.class || "unknown"}`,
  ];
  if (notice.lot) evidence.push(`lot:${notice.lot}`);
  if (notice.barcode) evidence.push(`barcode:${notice.barcode}`);

  return {
    notice_id: notice.notice_id,
    product_name: notice.product_name,
    entity_key: entityKey,
    confidence: Number(confidence.toFixed(4)),
    evidence,
    proposed_action: proposed,
  };
}

/**
 * @returns {import('./interface.js').ReasoningBackend}
 */
export function createOfflineBackend() {
  return {
    name: "offline",
    async proposeMatches(ctx) {
      const { scenario, logger } = ctx;
      const matches = scenario.notices.map((n) => scoreNotice(scenario, n));
      logger.event({
        agent: "Ledger",
        action: "propose_matches",
        target: "offline_backend",
        verdict: "ok",
        detail: { count: matches.length, reasoning_backend: "offline" },
      });
      return matches;
    },
    async critique(ctx, match) {
      const { logger, autoActionFloor } = ctx;
      // Reject thin evidence near the floor: forces a revision path from input shape.
      const thin =
        match.evidence.length < 4 &&
        match.confidence >= autoActionFloor - 0.15 &&
        match.confidence < autoActionFloor + 0.12;

      if (thin) {
        logger.event({
          agent: "Assay",
          action: "critique",
          target: match.notice_id,
          verdict: "reject",
          confidence: match.confidence,
          detail: { reason: "insufficient_evidence_fields" },
        });
        const revised = {
          ...match,
          confidence: Number(Math.max(0.05, match.confidence - 0.12).toFixed(4)),
          evidence: [...match.evidence, "revision:requested_more_fields"],
          proposed_action: "escalate",
        };
        return {
          ok: false,
          reason: "insufficient_evidence_fields",
          revised,
        };
      }

      logger.event({
        agent: "Assay",
        action: "critique",
        target: match.notice_id,
        verdict: "accept",
        confidence: match.confidence,
      });
      return { ok: true };
    },
  };
}
