/**
 * World Model Agent Engine — event-sourced entity graph (headless).
 * Aggregate shape: hybrid timeline/stream (spec 4.1) — an append-only event
 * log of observations, decisions and outcomes; entity canon is recomputed on
 * read, never mutated in place (spec 3 "one canonical store, many derived
 * views"; spec 16 "mutable aggregates ... recompute it").
 */
import path from "node:path";
import { openAppendOnlyStore, stableHash, contentHash } from "./store.js";

const EVENTS_STREAM = "world_events";

export const EVENT_KINDS = [
  "observation.recall_notice",
  "observation.adverse_event_mention",
  "observation.donation_ledger_line",
  "observation.crosswalk_hit",
  "decision.identity_resolution",
  "outcome.identity_match_correct",
  "outcome.identity_match_wrong",
];

/** Relationship types named in spec 4.4. */
export const RELATIONSHIP_TYPES = [
  "mentions",
  "cites",
  "owns",
  "reports_to",
  "connects_to",
  "causes",
  "depicts",
  "produced_by_agent",
];

/** Provenance-weighted canon (spec 11.2): each source carries its own trust. */
export const SOURCE_TRUST = {
  fda_enforcement: 0.95,
  second_agency: 0.8,
  fda_adverse_event: 0.55,
  open_food_facts: 0.75,
  donation_ledger: 0.65,
};

const BLOCK_FLOOR = 0.3;
const PROVISIONAL_FLOOR = 0.35;

export function normalizeText(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenize(str) {
  return new Set(normalizeText(str).split(" ").filter(Boolean));
}

function bigramBag(str) {
  const s = normalizeText(str).replace(/\s+/g, "");
  const bag = new Map();
  for (let i = 0; i + 1 < s.length; i++) {
    const bg = s.slice(i, i + 2);
    bag.set(bg, (bag.get(bg) || 0) + 1);
  }
  return bag;
}

function diceCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const [k, v] of a) inter += Math.min(v, b.get(k) || 0);
  let ta = 0;
  let tb = 0;
  for (const v of a.values()) ta += v;
  for (const v of b.values()) tb += v;
  return (2 * inter) / (ta + tb);
}

function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

function textSimilarity(normA, tokA, bagA, normB, tokB, bagB) {
  if (normA && normA === normB) return 1;
  return Math.max(diceCoefficient(bagA, bagB), overlapCoefficient(tokA, tokB));
}

function entityIdFor(name) {
  return `ent_${stableHash(normalizeText(name))}`;
}

export function openWorldModel(options = {}) {
  if (!options.dir && !options.store) throw new Error("openWorldModel needs {dir} or {store}.");
  const store = options.store || openAppendOnlyStore(path.join(options.dir, "state"));
  const worldName = options.name || "shelfwatch";

  let derived = null;

  function freshState() {
    return {
      name: worldName,
      /** entity_id -> entity record (identity/semantics/aggregates/provenance/lifecycle) */
      entities: new Map(),
      /** normalized alias -> entity_id (names seen on observations) */
      observationAliases: new Map(),
      /** normalized alias -> {entity_id, event_id, support} learned from correct outcomes */
      learnedAliases: new Map(),
      /** `${norm}::${entity_id}` -> pair trust, fed back by outcomes */
      pairTrust: new Map(),
      /** typed edge records, provenance-stamped (spec 4.4) */
      edges: [],
      eventIds: new Set(),
    };
  }

  function bumpEntity(state, id, seedName, event, at) {
    let ent = state.entities.get(id);
    if (!ent) {
      ent = {
        id,
        // Identity layer: stable handle + canonical aliases (spec 4.2).
        name: seedName,
        type: "product",
        aliases: new Map([[normalizeText(seedName), seedName]]),
        // Semantics layer.
        description: "",
        tags: new Set(),
        // Continuity anchors (spec 7.3): fingerprint hash over normalized name tokens.
        anchors: { fingerprint: null },
        // Aggregates (spec 4.2).
        mention_count: 0,
        first_seen_at: at,
        last_seen_at: at,
        sources: new Set(),
        event_ids: [],
        // Provenance.
        discovered_at: at,
        created_from_event: event,
        // Lifecycle.
        state: "emerging",
        confidence: 0,
        // Agent attribution (spec 4.2, headless addition).
        agent_id: null,
        run_id: null,
      };
      state.entities.set(id, ent);
    }
    return ent;
  }

  function foldEvent(state, record) {
    const at = record.at;
    const eventId = record.event_id;
    if (record.kind.startsWith("observation.")) {
      const product = record.product || {};
      const names = [product.name, ...(record.aliases || [])].filter(Boolean);
      for (const name of names) {
        const id = entityIdFor(name);
        const ent = bumpEntity(state, id, name, eventId, at);
        ent.mention_count += 1;
        ent.last_seen_at = at;
        ent.aliases.set(normalizeText(name), name);
        if (record.source) ent.sources.add(record.source);
        if (product.brand) ent.aliases.set(normalizeText(product.brand), product.brand);
        if (record.summary && record.summary.length > ent.description.length) {
          ent.description = record.summary;
        }
        for (const t of record.tags || []) ent.tags.add(t);
        ent.agent_id = record.agentId || ent.agent_id;
        ent.run_id = record.runId || ent.run_id;
        ent.event_ids.push(eventId);
        state.observationAliases.set(normalizeText(name), id);
        state.edges.push({
          from: eventId,
          to: id,
          type: "mentions",
          direction: "directed",
          properties: { weight: 1, confidence: sourceTrustFor(record.source), valid_from: at },
          provenance: { event_id: eventId, source: record.source },
        });
      }
      for (const link of record.links || []) {
        if (!RELATIONSHIP_TYPES.includes(link.type)) continue;
        const to = link.to_id || (link.to_name ? entityIdFor(link.to_name) : null);
        if (!to) continue;
        // Cross-source merge detection (spec 9.1): a crosswalk hit names the
        // same product under another source's spelling, so the linked name
        // becomes an alias of this entity while the typed edge is kept.
        if (link.to_name && link.type === "connects_to") {
          const primary = state.entities.get(entityIdFor(product.name || ""));
          if (primary) {
            primary.aliases.set(normalizeText(link.to_name), link.to_name);
            if (!state.observationAliases.has(normalizeText(link.to_name))) {
              state.observationAliases.set(normalizeText(link.to_name), primary.id);
            }
          }
        }
        state.edges.push({
          from: entityIdFor(product.name || ""),
          to,
          type: link.type,
          direction: link.direction || "undirected",
          properties: { weight: link.weight ?? 1, confidence: sourceTrustFor(record.source), valid_from: at },
          provenance: { event_id: eventId, source: record.source },
        });
      }
    } else if (record.kind === "decision.identity_resolution") {
      if (record.provisional_name) {
        const id = record.resolved_entity_id;
        const ent = bumpEntity(state, id, record.provisional_name, eventId, at);
        ent.mention_count += 1;
        ent.last_seen_at = at;
        ent.aliases.set(normalizeText(record.provisional_name), record.provisional_name);
        ent.event_ids.push(eventId);
        state.observationAliases.set(normalizeText(record.provisional_name), id);
      } else {
        const ent = state.entities.get(record.resolved_entity_id);
        if (ent) ent.event_ids.push(eventId);
      }
    } else if (record.kind === "outcome.identity_match_correct") {
      const key = pairKey(record.mention_norm, record.entity_id);
      state.pairTrust.set(key, Math.min(0.9, (state.pairTrust.get(key) ?? 0.75) + 0.1));
      const learned = state.learnedAliases.get(record.mention_norm) || {
        entity_id: record.entity_id,
        event_ids: [],
        support: 0,
      };
      learned.support += 1;
      learned.event_ids.push(eventId);
      state.learnedAliases.set(record.mention_norm, learned);
    } else if (record.kind === "outcome.identity_match_wrong") {
      const key = pairKey(record.mention_norm, record.entity_id);
      // Spec 11.2 (H-MEM): "wrong" causes a larger decrease; here the pairing
      // drops under the propose floor so the resolver stops auto-proposing it.
      state.pairTrust.set(key, Math.max(0, (state.pairTrust.get(key) ?? 0.8) - 0.55));
    }
  }

  function sourceTrustFor(source) {
    return SOURCE_TRUST[source] ?? 0.5;
  }

  function pairKey(norm, id) {
    return `${norm}::${id}`;
  }

  function derive() {
    if (derived) return derived;
    const state = freshState();
    for (const record of store.readRecords(EVENTS_STREAM)) {
      if (state.eventIds.has(record.event_id)) continue;
      state.eventIds.add(record.event_id);
      foldEvent(state, record);
    }
    // Canonical reconstruction of lifecycle + confidence from provenance.
    for (const ent of state.entities.values()) {
      const srcs = [...ent.sources];
      const avgTrust = srcs.length
        ? srcs.reduce((a, s) => a + sourceTrustFor(s), 0) / srcs.length
        : 0.5;
      ent.anchors.fingerprint = `sha256:${stableHash(normalizeText([...ent.aliases.keys()].sort().join("|")))}`;
      ent.confidence = Number(
        Math.min(
          0.95,
          0.3 + 0.15 * Math.min(3, srcs.length) + 0.2 * avgTrust + 0.1 * Math.min(4, ent.mention_count) / 4
        ).toFixed(4)
      );
      ent.state = srcs.length >= 2 || ent.mention_count >= 3 ? "active" : "emerging";
      ent.tags = [...ent.tags].sort();
      ent.sources = srcs;
      ent.avg_source_trust = Number(avgTrust.toFixed(4));
    }
    derived = state;
    return state;
  }

  function events() {
    return store.readRecords(EVENTS_STREAM);
  }

  function appendEvent(input) {
    if (!EVENT_KINDS.includes(input.kind)) {
      throw new Error(`Unknown world-model event kind '${input.kind}'.`);
    }
    if (!input.at) throw new Error("World-model events need a caller-supplied 'at' marker.");
    const record = {
      kind: input.kind,
      at: input.at,
      source: input.source || null,
      summary: input.summary || null,
      product: input.product || null,
      aliases: input.aliases || null,
      tags: input.tags || null,
      links: input.links || null,
      mention_text: input.mention_text || null,
      mention_norm: input.mention_text ? normalizeText(input.mention_text) : null,
      resolved_entity_id: input.resolved_entity_id || null,
      provisional_name: input.provisional_name || null,
      entity_id: input.entity_id || null,
      confidence: input.confidence ?? null,
      basis: input.basis || null,
      evidence_event_ids: input.evidence_event_ids || null,
      candidate_lookups: input.candidate_lookups ?? null,
      pair_trust_before: input.pair_trust_before ?? null,
      pair_trust_after: input.pair_trust_after ?? null,
      agentId: input.agentId || null,
      runId: input.runId || null,
      taskId: input.taskId || null,
    };
    record.event_id = `evt_${stableHash(contentHash(record))}`;
    // Idempotent ingest (spec 3): re-running the same event changes nothing.
    if (derive().eventIds.has(record.event_id)) {
      return { event: record, duplicate: true };
    }
    const entry = store.append(EVENTS_STREAM, record);
    derived = null;
    return { event: { ...record, seq: entry.seq }, duplicate: false };
  }

  function blocked(state, norm, id) {
    const t = state.pairTrust.get(pairKey(norm, id));
    return t !== undefined && t < BLOCK_FLOOR;
  }

  function resolveMention(text) {
    const state = derive();
    const norm = normalizeText(text);
    const tok = tokenize(text);
    const bag = bigramBag(text);
    let candidateLookups = 0;

    const pairTrustOf = (id) => state.pairTrust.get(pairKey(norm, id));

    // 1. Learned alias anchored by confirmed outcomes — one direct lookup.
    const learned = state.learnedAliases.get(norm);
    if (learned && !blocked(state, norm, learned.entity_id)) {
      const ent = state.entities.get(learned.entity_id);
      if (ent) {
        candidateLookups = 1;
        const confidence = Number(
          Math.min(
            0.95,
            0.42 +
              0.28 * ent.avg_source_trust +
              0.12 * Math.min(1, (ent.sources.length - 1) / 3) +
              0.08 * Math.min(1, learned.support / 2) +
              0.1 * Math.min(1, (ent.mention_count - 1) / 6)
          ).toFixed(4)
        );
        return {
          entity_id: ent.id,
          name: ent.name,
          confidence,
          match_basis: "learned_alias",
          candidate_lookups: candidateLookups,
          evidence: {
            event_ids: ent.event_ids.slice(0, 8),
            alias_provenance_event_ids: learned.event_ids,
            matched_alias: norm,
            avg_source_trust: ent.avg_source_trust,
            supporting_sources: ent.sources,
            fingerprint: ent.anchors.fingerprint,
          },
        };
      }
    }

    // 2. Similarity scan over every entity — one lookup per comparison.
    let best = null;
    for (const ent of state.entities.values()) {
      candidateLookups += 1;
      if (blocked(state, norm, ent.id)) continue;
      let sim = 0;
      let matchedAlias = null;
      for (const [aliasNorm, aliasRaw] of ent.aliases) {
        const s = textSimilarity(norm, tok, bag, aliasNorm, tokenize(aliasRaw), bigramBag(aliasRaw));
        if (s > sim) {
          sim = s;
          matchedAlias = aliasNorm;
        }
      }
      if (!best || sim > best.sim) best = { ent, sim, matchedAlias };
    }

    if (best && best.sim >= PROVISIONAL_FLOOR) {
      const ent = best.ent;
      const pairTrust = pairTrustOf(ent.id) ?? 0.8;
      // Pure similarity matches stay below the 0.70 auto-action floor until a
      // confirmed outcome teaches the alias — an unconfirmed text match is
      // never auto-actioned.
      const raw =
        (0.15 +
          0.3 * best.sim +
          0.15 * ent.avg_source_trust +
          0.1 * Math.min(1, (ent.sources.length - 1) / 3)) *
        (pairTrust >= 0.6 ? 1 : 0.7);
      const confidence = Number(Math.max(0.05, Math.min(0.69, raw)).toFixed(4));
      return {
        entity_id: ent.id,
        name: ent.name,
        confidence,
        match_basis: "similarity_scan",
        candidate_lookups: candidateLookups,
        evidence: {
          event_ids: ent.event_ids.slice(0, 8),
          matched_alias: best.matchedAlias,
          similarity: Number(best.sim.toFixed(4)),
          avg_source_trust: ent.avg_source_trust,
          supporting_sources: ent.sources,
          fingerprint: ent.anchors.fingerprint,
        },
      };
    }

    // 3. Provisional entity, emerging, with the evidence gap recorded (spec 4.2 lifecycle).
    const id = entityIdFor(norm);
    const existing = state.entities.get(id);
    const provisionalName = existing ? existing.name : String(text).trim();
    const confidence = Number(
      (existing ? 0.2 : 0.12) + (existing ? 0.05 * Math.min(1, existing.mention_count / 4) : 0)
    ).toFixed(4);
    return {
      entity_id: id,
      name: provisionalName,
      confidence,
      match_basis: "provisional_no_support",
      candidate_lookups: candidateLookups,
      evidence: {
        event_ids: existing ? existing.event_ids.slice(0, 8) : [],
        supporting_sources: existing ? existing.sources : [],
        note: "No observation event supports this mention; a provisional entity is proposed.",
      },
      provisional_name: existing ? null : provisionalName,
    };
  }

  /** Persist a resolution decision so the evidence path is reconstructable (spec 11.2 audit). */
  function recordResolution(mentionText, resolution, options = {}) {
    return appendEvent({
      kind: "decision.identity_resolution",
      at: options.at,
      mention_text: mentionText,
      resolved_entity_id: resolution.entity_id,
      provisional_name: resolution.provisional_name || null,
      confidence: resolution.confidence,
      basis: resolution.match_basis,
      evidence_event_ids: resolution.evidence.event_ids,
      candidate_lookups: resolution.candidate_lookups,
      agentId: options.agentId,
      runId: options.runId,
      taskId: options.taskId,
    });
  }

  /** Outcome feedback into trust (spec 3: "decisions and outcomes" appended). */
  function recordOutcome({ outcome, mention_text, entity_id, at, agentId, runId, taskId }) {
    const state = derive();
    const norm = normalizeText(mention_text);
    const key = pairKey(norm, entity_id);
    const before = state.pairTrust.get(key) ?? 0.8;
    const after =
      outcome === "correct"
        ? Math.min(0.9, before + 0.1)
        : outcome === "wrong"
          ? Math.max(0, before - 0.55)
          : (() => {
              throw new Error(`Unknown outcome '${outcome}'; expected 'correct' or 'wrong'.`);
            })();
    const { event, duplicate } = appendEvent({
      kind: outcome === "correct" ? "outcome.identity_match_correct" : "outcome.identity_match_wrong",
      at,
      mention_text,
      entity_id,
      pair_trust_before: Number(before.toFixed(4)),
      pair_trust_after: Number(after.toFixed(4)),
      agentId,
      runId,
      taskId,
    });
    return { event, duplicate, pair_trust_before: Number(before.toFixed(4)), pair_trust_after: Number(after.toFixed(4)) };
  }

  function getEntity(id) {
    const state = derive();
    const ent = state.entities.get(id);
    if (!ent) return null;
    return {
      ...ent,
      aliases: [...ent.aliases.entries()].map(([norm, raw]) => ({ norm, raw })),
      tags: ent.tags,
      anchors: { ...ent.anchors, normalized_name: [...ent.aliases.keys()][0] || null },
    };
  }

  function listEntities(filter = {}) {
    let ents = [...derive().entities.values()];
    if (filter.type) ents = ents.filter((e) => e.type === filter.type);
    if (filter.state) ents = ents.filter((e) => e.state === filter.state);
    return ents.map((e) => ({ id: e.id, name: e.name, state: e.state, confidence: e.confidence, mention_count: e.mention_count }));
  }

  function getRelationships(id) {
    return derive().edges.filter((edge) => edge.from === id || edge.to === id);
  }

  function getPairTrust(mentionText, id) {
    return derive().pairTrust.get(pairKey(normalizeText(mentionText), id)) ?? null;
  }

  return {
    name: worldName,
    appendEvent,
    events,
    resolveMention,
    recordResolution,
    recordOutcome,
    getEntity,
    listEntities,
    getRelationships,
    getPairTrust,
    entityCount: () => derive().entities.size,
    eventCount: () => store.count(EVENTS_STREAM),
    stateHash: () => store.stateHash(),
  };
}
