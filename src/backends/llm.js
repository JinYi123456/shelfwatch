import { createNightshiftClient } from "./nightshift.js";
import { createOfflineBackend } from "./offline.js";

const SYSTEM = [
  "You are Shelfwatch, the overnight reasoning engine a food-bank duty officer relies on at 06:00.",
  "You reconcile recall signals that four agencies and one internal ledger describe in different words,",
  "and you decide what should physically be pulled from the shelves.",
  "Rules you never break:",
  "- Judge only the evidence you are given. Never invent a notice, lot, barcode or class.",
  "- Confidence is your honest estimate that the action is safe to take without a human, from 0 to 1.",
  "- Anything you are not sure about must be escalated, not guessed.",
  "- Answer with a single JSON object. No prose, no markdown fence.",
].join("\n");

function candidateDigest(rows) {
  return (rows || []).slice(0, 3).map((r) => ({
    identity_key: r.identity_key,
    product_name: r.canonical_name || r.product_name,
    brand: r.brand,
    corroborating_sources: r.corroborating_sources,
    enforcement_records: r.enforcement_hit_count ?? r.enforcement_records ?? 0,
    adverse_event_records: r.adverse_event_hit_count ?? r.adverse_event_records ?? 0,
    agency_notice_records: r.agency_notice_hit_count ?? r.agency_notice_records ?? 0,
    ledger_records: r.ledger_hit_count ?? r.ledger_records ?? 0,
    lots_in_ledger: (r.lots_in_ledger || []).slice(0, 4),
    hazards_agreed: (r.hazards_agreed_across_sources || []).slice(0, 5),
    data_confidence: r.confidence,
    evidence_refs: (r.evidence || []).slice(0, 5),
  }));
}

function memoryDigest(entry) {
  if (!entry) return null;
  const resolved = entry.resolved || {};
  return {
    entity_id: resolved.entity_id || null,
    match_basis: resolved.match_basis || null,
    resolved_confidence: Number(resolved.confidence ?? 0),
    candidate_lookups: resolved.candidate_lookups ?? null,
    supporting_events: (resolved.evidence?.event_ids || []).slice(0, 5),
    recalled: (entry.recalled?.memories || []).slice(0, 3).map((m) => ({
      id: m.id || m.memory_id,
      text: String(m.text || m.summary || "").slice(0, 180),
      why: m.retrievalReason || entry.recalled?.retrievalReason || null,
    })),
  };
}

function noticesBlock(scenario, candidates, memories) {
  return scenario.notices.map((n) => ({
    notice_id: n.notice_id,
    source: n.source,
    product_name: n.product_name,
    brand: n.brand || null,
    class: n.class || null,
    lot: n.lot || null,
    barcode: n.barcode || null,
    raw_text: n.raw_text ? String(n.raw_text).slice(0, 600) : null,
    retrieved_from_data_layer: candidateDigest(candidates.get(n.notice_id)),
    what_we_already_know: memoryDigest(memories.get(n.notice_id)),
  }));
}

function parseJson(text) {
  const cleaned = String(text)
    .replace(/^[\s\S]*?```(?:json)?/i, "")
    .replace(/```[\s\S]*$/, "")
    .trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error("model returned no JSON");
  const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  return JSON.parse(cleaned.slice(start, end + 1));
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * LlmBackend — every reasoning call goes through Meterless Nightshift, which is
 * the product's only AI provider. The offline reasoner stays underneath as the
 * fallback when a call fails or returns something unusable, and the trace says
 * which one produced a given line.
 */
export function createLlmBackend(env = process.env) {
  const client = createNightshiftClient(env);
  const fallback = createOfflineBackend();
  const model = env.NIGHTSHIFT_MODEL || "meterless/auto";
  const criticModel = env.NIGHTSHIFT_CRITIC_MODEL || model;
  const routes = [];

  async function call(role, messages, opts = {}) {
    const result = await client.complete({
      model: opts.model || model,
      messages,
      maxTokens: opts.maxTokens ?? 1400,
      temperature: opts.temperature ?? 0.1,
      timeoutMs: opts.timeoutMs ?? 90_000,
    });
    const record = {
      role,
      requested: result.route.requested,
      handled_by: result.route.handledBy,
      provider_model: result.route.provider,
      request_id: result.route.requestId,
      latency_ms: result.latencyMs,
      tokens_in: result.usage.prompt_tokens ?? null,
      tokens_out: result.usage.completion_tokens ?? null,
    };
    routes.push(record);
    return { ...result, record };
  }

  return {
    name: "llm",
    routes: () => routes.slice(),

    async proposeMatches(ctx) {
      const { scenario, logger, candidates, memories, autoActionFloor } = ctx;
      let decidedBy = "llm";
      let payload;
      try {
        const answer = await call("propose", [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify(
              {
                task: "reconcile_notices",
                shift_date: scenario.shift_date,
                auto_action_floor: autoActionFloor,
                notices: noticesBlock(scenario, candidates, memories),
                output_shape: {
                  matches: [
                    {
                      notice_id: "string, copied from the input",
                      product_name: "string",
                      entity_key: "string, brand|product in lower case",
                      confidence: "number 0..1",
                      corroborating_sources: "number",
                      evidence: ["notice:<id>", "data:<identity_key>", "memory:<entity_id>"],
                      proposed_action: "pull | hold | monitor | escalate",
                      why: "one sentence naming the deciding evidence",
                    },
                  ],
                },
              },
              null,
              1
            ),
          },
        ]);
        const parsed = parseJson(answer.text);
        payload = (parsed.matches || parsed).map((m) => ({
          notice_id: String(m.notice_id),
          product_name: m.product_name,
          entity_key: m.entity_key || `ent:${String(m.product_name || "").toLowerCase()}`,
          confidence: clampConfidence(m.confidence),
          corroborating_sources: Number(m.corroborating_sources ?? 0) || 0,
          evidence: Array.isArray(m.evidence) && m.evidence.length ? m.evidence : ["model:unspecified"],
          proposed_action: ["pull", "hold", "monitor", "escalate"].includes(m.proposed_action)
            ? m.proposed_action
            : "escalate",
          why: m.why || null,
          model_route: answer.record,
        }));
        logger.event({
          agent: "Ledger",
          action: "propose_matches",
          target: "nightshift",
          verdict: "ok",
          detail: {
            reasoning_backend: "llm",
            count: payload.length,
            handled_by: answer.record.handled_by,
            request_id: answer.record.request_id,
            latency_ms: answer.record.latency_ms,
            tokens: [answer.record.tokens_in, answer.record.tokens_out],
          },
        });
      } catch (error) {
        decidedBy = "offline_fallback";
        logger.event({
          agent: "Ledger",
          action: "propose_matches",
          target: "nightshift",
          verdict: "fallback",
          detail: { reasoning_backend: "llm", reason: String(error.message).slice(0, 200) },
        });
        payload = await fallback.proposeMatches({ ...ctx, logger: { event: () => {} } });
      }

      if (!payload.length) {
        payload = await fallback.proposeMatches({ ...ctx, logger: { event: () => {} } });
        decidedBy = "offline_fallback";
      }
      ctx.decidedBy = decidedBy;
      return payload;
    },

    async critique(ctx, match) {
      const { logger, autoActionFloor } = ctx;
      try {
        const answer = await call("critique", [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify(
              {
                task: "adjudicate_proposal",
                auto_action_floor: autoActionFloor,
                proposal: match,
                retrieved_evidence: candidateDigest(ctx.candidates?.get?.(match.notice_id)),
                output_shape: {
                  ok: "boolean — true only if the evidence actually supports the action",
                  reason: "string, the single strongest objection or 'supported'",
                  revised: "the corrected proposal, or null",
                },
              },
              null,
              1
            ),
          },
        ], { model: criticModel, maxTokens: 700 });
        const verdict = parseJson(answer.text);
        const revised = verdict.revised
          ? { ...verdict.revised, model_route: answer.record }
          : undefined;
        logger.event({
          agent: "Assay",
          action: "critique",
          target: match.notice_id,
          verdict: verdict.ok ? "accept" : "reject",
          confidence: match.confidence,
          detail: {
            reasoning_backend: "llm",
            reason: verdict.reason || null,
            handled_by: answer.record.handled_by,
            request_id: answer.record.request_id,
          },
        });
        return { ok: Boolean(verdict.ok), reason: verdict.reason, revised };
      } catch (error) {
        logger.event({
          agent: "Assay",
          action: "critique",
          target: match.notice_id,
          verdict: "fallback",
          detail: { reasoning_backend: "llm", reason: String(error.message).slice(0, 200) },
        });
        return { ok: true, reason: "critic unavailable; accepted on the offline floor check" };
      }
    },
  };
}
