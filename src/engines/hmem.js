/**
 * H-MEM Agent Engine — headless hierarchical memory (spec v1.0).
 * Tiers (spec 5): short_term / working / long_term with warm-start hydration.
 * Canonical record (spec 4): id, content, type, layer, timestamp, lastAccessed,
 * accessCount, tags, embedding, score, confidence, source, domain, namespace,
 * entities, relatedTo, supersedes, derivedFrom, agentId, runId, taskId.
 * Every mutation is an appended version record plus a trust-ledger line
 * (spec 11.1); nothing in this module rewrites history.
 * Time is caller-supplied ('at'); decay is applied at read/consolidation
 * time and never persisted on load, so state hashes stay clock-free.
 */
import path from "node:path";
import { openAppendOnlyStore, stableHash, contentHash } from "./store.js";

const MEMORIES_STREAM = "hm_memories";
const LEDGER_STREAM = "hm_trust_ledger";
const PROPOSALS_STREAM = "hm_proposals";
const BACKUPS_STREAM = "hm_sleep_backups";

/** Spec 4: memory types. */
export const MEMORY_TYPES = ["personal", "factual", "preference", "general", "procedural"];
/** Spec 5: storage tiers. */
export const LAYERS = ["short_term", "working", "long_term"];
/** Spec 11.1: ledger actions. */
export const LEDGER_ACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "feedback",
  "promote",
  "demote",
  "merge",
  "conflict_detected",
  "conflict_resolved",
  "sleep",
];
/** Spec 9: dream proposal types. */
export const PROPOSAL_TYPES = ["insight", "domain", "invariant"];

/** Spec 15: operational defaults, tuned per domain for a per-shift cadence. */
export const DEFAULTS = {
  topN: 5,
  // Spec 15 recommends tuning; 0.35 over-compresses this small per-shift
  // corpus, so the threshold sits at 0.3.
  threshold: 0.3,
  relatedness: 0.35,
  dreamClusterMinSize: 2,
  dreamMaxProposalsPerType: 8,
  autoApproveCluster: 3,
  autoApproveConfidence: 0.7,
  entityCapPerMemory: 10,
  relatedLinksCap: 5,
  layerWeight: { long_term: 1.0, working: 0.85, short_term: 0.6 },
  promote: {
    // Spec 15 windows assume weeks of runtime; these are the shortened
    // per-shift steps a night-shift cadence needs.
    short_term: { min_confidence: 0.6, min_access: 2 },
    working: { min_confidence: 0.7, min_access: 3 },
  },
  demoteBelow: 0.4,
  archiveBelow: 0.25,
  consolidateWindowSteps: 6,
  synthesizeSimilarity: 0.9,
};

const FEEDBACK_RULES = {
  // Spec 11.2: helpful -> access+confidence up; not_helpful -> small decrease;
  // wrong -> larger decrease + `review` tag.
  helpful: { confidence: +0.1, access: 1, tag: null },
  not_helpful: { confidence: -0.05, access: 0, tag: null },
  wrong: { confidence: -0.25, access: 0, tag: "review" },
};

const CORRECTION_WORDS = /\b(wrong|not_helpful|instead|correction|corrected|contradicts)\b/;
const DOMAIN_LEXICON = {
  recall: ["recall", "notice", "enforcement", "class", "pull", "list", "triage", "hold", "escalate"],
  identity: ["identity", "alias", "crosswalk", "product", "barcode", "mapping", "entity", "match", "mention"],
  safety: ["adverse", "event", "illness", "symptom", "report", "safety", "harm"],
  inventory: ["donation", "ledger", "pallet", "lot", "stock", "cold", "store", "warehouse"],
};

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(str) {
  return normalize(str).split(" ").filter(Boolean);
}

const EMBEDDING_DIMS = 64;

/** Lightweight deterministic embedding (spec 4 "lightweight embedding"). */
function embed(str) {
  const v = new Array(EMBEDDING_DIMS).fill(0);
  for (const t of tokens(str)) {
    const h = parseInt(stableHash(t).slice(0, 8), 16);
    v[h % EMBEDDING_DIMS] += 1;
    v[(h >> 5) % EMBEDDING_DIMS] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => Number((x / norm).toFixed(6)));
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Spec 7: multi-pass domain classification — tags, capability, run, keywords, fallback. */
function classifyDomain(memory) {
  const tagSet = new Set(memory.tags.map(normalize));
  for (const domain of Object.keys(DOMAIN_LEXICON)) {
    if (tagSet.has(domain)) return { domain, pass: "explicit_tags" };
  }
  if (/\b(gtin|\d{8,14})\b|alias|crosswalk|entity/i.test(memory.content)) {
    return { domain: "identity", pass: "capability_detection" };
  }
  const words = new Set(tokens(memory.content));
  let bestDomain = null;
  let bestScore = 0;
  for (const [domain, kws] of Object.entries(DOMAIN_LEXICON)) {
    let score = 0;
    for (const kw of kws) {
      const weight = words.has(kw) ? 2 : 0;
      score += weight + (tagSet.has(kw) ? 1 : 0);
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  if (bestDomain && bestScore > 0) return { domain: bestDomain, pass: "keyword_scoring" };
  return { domain: "general", pass: "heuristic_fallback" };
}

function namespaceFor(domain, memory) {
  if (/match|alias|mention|resolve/i.test(memory.content)) return `${domain}/resolution`;
  if (/notice|recall|report|ledger/i.test(memory.content)) return `${domain}/observations`;
  return `${domain}/general`;
}

export function openHMem(options = {}) {
  if (!options.dir && !options.store) throw new Error("openHMem needs {dir} or {store}.");
  const store = options.store || openAppendOnlyStore(path.join(options.dir, "state"));
  const cfg = { ...DEFAULTS, ...(options.config || {}) };
  const defaultAgent = options.agentId || "Anchor";
  let cache = null;

  function invalidate() {
    cache = null;
  }

  /**
   * Warm start (spec 5): hydrate all tiers, de-duplicate by id, backfill
   * missing embeddings. The forgetting curve from spec 5 is applied as a
   * read-time score decay only — hydration never persists mutations.
   */
  function load() {
    if (cache) return cache;
    const byId = new Map();
    let maxSeq = 0;
    for (const entry of store.readEntries(MEMORIES_STREAM)) {
      const record = entry.record;
      maxSeq = Math.max(maxSeq, entry.seq);
      if (record.deleted) {
        byId.delete(record.id);
        continue;
      }
      byId.set(record.id, { ...record, seq: entry.seq });
    }
    for (const m of byId.values()) {
      if (!m.embedding || m.embedding.length === 0) m.embedding = embed(m.content);
    }
    cache = { memories: byId, seq: maxSeq };
    return cache;
  }

  function ledger(record) {
    store.append(LEDGER_STREAM, record);
  }

  function persist(memory, action, actor, at, details = {}) {
    const entry = store.append(MEMORIES_STREAM, memory);
    const saved = { ...memory, seq: entry.seq };
    ledger({
      memory_id: memory.id,
      action,
      actor: actor || defaultAgent,
      timestamp: at,
      previous_state: details.previous_state ?? null,
      new_state: details.new_state ?? null,
      details: details.details ?? null,
    });
    invalidate();
    return saved;
  }

  function currentMemories() {
    return [...load().memories.values()].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
  }

  /** Spec 6: mining table — which memory type each runtime event yields. */
  function typeForEvent(kind) {
    if (kind.startsWith("observation.")) return "factual";
    if (kind.startsWith("decision.")) return "procedural";
    if (kind.startsWith("outcome.")) return "procedural";
    return "general";
  }

  /**
   * Spec 6: no-model fallback — the engine mines runtime events with direct
   * deterministic capture instead of calling a model; an injected generator
   * may enrich the summary first but is never required.
   */
  async function mineEvent(event, options = {}) {
    const content = [event.kind, event.source ? `source ${event.source}` : null, event.summary, event.mention_text]
      .filter(Boolean)
      .join(". ");
    const entities = [
      event.product?.name ? `product:${normalize(event.product.name)}` : null,
      event.resolved_entity_id || event.entity_id || null,
      ...((event.tags || []).map((t) => `tag:${normalize(t)}`)),
      ...tokens(event.summary || "")
        .filter((t) => /^\d{8,14}$/.test(t))
        .map((t) => `gtin:${t}`),
    ].filter(Boolean);
    const memory = {
      id: `mem_${stableHash(`${normalize(content)}|${event.event_id}`)}`,
      content,
      type: options.type || typeForEvent(event.kind),
      layer: "short_term",
      timestamp: event.at,
      lastAccessed: event.at,
      accessCount: 0,
      tags: ["mined", event.kind],
      embedding: embed(content),
      score: null,
      confidence: Number((0.35 + 0.35 * Math.min(1, entities.length / 3)).toFixed(4)),
      source: `world_model:${event.event_id}`,
      // Provenance (spec 3): every mined memory names its source event ids.
      provenance: { source_event_ids: [event.event_id], source_engine: "world_model" },
      domain: null,
      namespace: null,
      entities: entities.slice(0, cfg.entityCapPerMemory),
      relatedTo: [],
      supersedes: null,
      derivedFrom: [],
      superseded_by: null,
      agentId: event.agentId || defaultAgent,
      runId: event.runId || null,
      taskId: event.taskId || null,
    };
    return add(memory, { generator: options.generator, at: options.at || event.at });
  }

  async function add(input, options = {}) {
    const base = {
      id:
        input.id ||
        `mem_${stableHash(`${normalize(input.content)}|${input.source || "unknown"}`)}`,
      content: input.content,
      type: MEMORY_TYPES.includes(input.type) ? input.type : "general",
      layer: LAYERS.includes(input.layer) ? input.layer : "short_term",
      timestamp: options.at || input.timestamp || null,
      lastAccessed: options.at || input.timestamp || null,
      accessCount: input.accessCount || 0,
      tags: [...new Set(input.tags || [])],
      embedding: embed(input.content),
      score: null,
      confidence: typeof input.confidence === "number" ? input.confidence : 0.5,
      source: input.source || (options.actor || defaultAgent),
      provenance: input.provenance || { source_event_ids: input.source_event_ids || [], source_engine: input.source_engine || "hmem" },
      entities: (input.entities || []).slice(0, cfg.entityCapPerMemory),
      relatedTo: input.relatedTo || [],
      supersedes: input.supersedes || null,
      derivedFrom: input.derivedFrom || [],
      superseded_by: null,
      agentId: input.agentId || options.actor || defaultAgent,
      runId: input.runId || null,
      taskId: input.taskId || null,
    };

    // Optional injected generator enrichment; direct capture is the fallback.
    let content = base.content;
    if (options.generator) {
      try {
        const enriched = await options.generator(
          `Summarise this memory for retrieval in one sentence:\n${base.content}`
        );
        const text = String((enriched && (enriched.text || enriched)) || "").trim();
        if (text && text.length <= 400) content = text;
      } catch {
        // Spec 6: graceful degradation — keep the direct capture.
      }
    }
    base.content = content;
    base.embedding = embed(content);

    // Spec 7: enrichment — domain, namespace, relationships.
    const { domain, pass } = classifyDomain(base);
    base.domain = input.domain || domain;
    base.domain_pass = pass;
    base.namespace = input.namespace || namespaceFor(base.domain, base);

    const state = load();
    const prior = state.memories.get(base.id);
    if (prior && !options.forceNew) {
      return persist({ ...prior, ...base, seq: undefined, updated_at: options.at || base.timestamp }, "update", options.actor, options.at || base.timestamp, {
        previous_state: { layer: prior.layer, confidence: prior.confidence },
        new_state: { layer: base.layer, confidence: base.confidence },
        details: { reason: "re-added by id" },
      });
    }

    // Spec 7: relationship discovery — supersedes on high similarity plus
    // correction language; relatedTo on shared entities and domain affinity.
    for (const other of state.memories.values()) {
      if (other.id === base.id) continue;
      const sim = cosine(other.embedding, base.embedding);
      if (sim >= 0.7 && CORRECTION_WORDS.test(base.content) && !other.superseded_by) {
        base.supersedes = other.id;
        persist({ ...other, superseded_by: base.id }, "update", options.actor, options.at, {
          previous_state: { superseded_by: null },
          new_state: { superseded_by: base.id },
          details: { reason: "supersedes_from_correction_language" },
        });
      }
      const shared = other.entities.filter((e) => base.entities.includes(e));
      if ((shared.length >= 2 || (sim >= 0.5 && other.domain === base.domain)) && base.relatedTo.length < cfg.relatedLinksCap) {
        base.relatedTo.push(other.id);
      }
    }

    // Spec 11.1: every significant action lands in the trust ledger.
    const saved = persist(base, "create", options.actor, options.at || base.timestamp, {
      new_state: { layer: base.layer, confidence: base.confidence },
      details: { type: base.type, domain: base.domain, source: base.source },
    });
    return saved;
  }

  /** Spec 8.1: hybrid retrieval ranking — each named signal contributes. */
  const SIGNAL_WEIGHTS = {
    semantic_similarity: 0.3,
    keyword_overlap: 0.2,
    tag_overlap: 0.1,
    domain_match: 0.1,
    entity_match: 0.15,
    agent_scope: 0.1,
    recency: 0.05,
  };

  function scoreMemory(memory, query, state) {
    const signals = {
      semantic_similarity: cosine(embed(query.text), memory.embedding),
      keyword_overlap: jaccard(tokens(query.text), tokens(memory.content)),
      tag_overlap: query.tags.filter((t) => memory.tags.includes(t)).length / Math.max(1, query.tags.length),
      domain_match: query.domain && memory.domain === query.domain ? 1 : 0,
      entity_match: query.entities.filter((e) => memory.entities.includes(e)).length / Math.max(1, query.entities.length),
      agent_scope: state.runId && memory.runId === state.runId ? 1 : 0,
      recency: 1 / (1 + Math.max(0, state.seq - memory.seq)),
    };
    signals.layer_weight = cfg.layerWeight[memory.layer] ?? 0.6;
    signals.superseded_penalty = memory.superseded_by ? 0.4 : 1;

    let base = 0;
    for (const [signal, weight] of Object.entries(SIGNAL_WEIGHTS)) base += weight * signals[signal];
    const relevance =
      base *
      (0.5 + 0.5 * signals.layer_weight) *
      (0.6 + 0.4 * memory.confidence) *
      signals.superseded_penalty;

    const retrievalReason = [];
    const named = [
      ["semantic_similarity", 0.3],
      ["keyword_overlap", 0.2],
      ["tag_overlap", 0.5],
      ["entity_match", 0.5],
      ["domain_match", 1],
      ["agent_scope", 1],
      ["recency", 0.5],
    ];
    for (const [signal, cutoff] of named) {
      if (signals[signal] >= cutoff) retrievalReason.push(`${signal}=${signals[signal].toFixed(2)}`);
    }
    retrievalReason.push(`layer_weight(${memory.layer})=${signals.layer_weight}`);
    if (memory.superseded_by) retrievalReason.push("superseded_penalty=0.4");
    return { relevance, signals, retrievalReason };
  }

  /** Spec 8.2: structured reinjection payload, not a rendered string. */
  function recall(query, options = {}) {
    const q = typeof query === "string" ? { text: query } : query;
    const opts = { ...options };
    const state = load();
    const queryTags = q.tags || [];
    const queryEntities = (q.entities || []).map(normalize);
    const effectiveTopN = opts.topN ?? cfg.topN;
    const threshold = opts.threshold ?? cfg.threshold;
    const scored = [];
    for (const memory of currentMemories()) {
      const { relevance, signals, retrievalReason } = scoreMemory(
        memory,
        { text: q.text || "", tags: queryTags, domain: q.domain || null, entities: queryEntities },
        { runId: opts.runId || null, seq: state.seq }
      );
      if (relevance >= threshold) scored.push({ memory, relevance, signals, retrievalReason });
    }
    scored.sort((a, b) => b.relevance - a.relevance || (a.memory.id < b.memory.id ? -1 : 1));

    let strategy = "task_focused";
    if (opts.strategy) strategy = opts.strategy;
    else if (scored.some((s) => s.signals.entity_match >= 0.3 || s.signals.semantic_similarity >= 0.5)) strategy = "task_focused";
    else strategy = "comprehensive";
    const take = strategy === "minimal" ? Math.min(2, effectiveTopN) : effectiveTopN;
    const hits = scored.slice(0, take);

    // Spec 11.2: retrieval touches memory; access is credited, audited.
    const at = opts.at || null;
    const payload = hits.map(({ memory, relevance, retrievalReason }) => {
      persist(
        { ...memory, accessCount: memory.accessCount + 1, lastAccessed: at ?? memory.lastAccessed, score: Number(relevance.toFixed(4)), seq: undefined },
        "read",
        opts.actor,
        at,
        { details: { retrievalReason } }
      );
      return {
        id: memory.id,
        content: memory.content,
        type: memory.type,
        layer: memory.layer,
        confidence: memory.confidence,
        relevance_score: Number(relevance.toFixed(4)),
        retrievalReason,
        provenance: memory.provenance,
        source: memory.source,
        derivedFrom: memory.derivedFrom,
        relatedTo: memory.relatedTo,
      };
    });

    return {
      query: q.text,
      selected_strategy: strategy,
      retrievalReason: `hybrid ranking over ${currentMemories().length} memories, threshold ${threshold}`,
      memories: payload,
      trace: { scored: currentMemories().length, above_threshold: scored.length, returned: payload.length },
    };
  }

  /** Spec 11.2: feedback adaptation, then the promote/demote lifecycle. */
  function feedback(memoryId, verdict, options = {}) {
    if (!FEEDBACK_RULES[verdict]) throw new Error(`Unknown feedback verdict '${verdict}'.`);
    const state = load();
    const memory = state.memories.get(memoryId);
    if (!memory) throw new Error(`Unknown memory id '${memoryId}'.`);
    const rule = FEEDBACK_RULES[verdict];
    const previous = { layer: memory.layer, confidence: memory.confidence, accessCount: memory.accessCount, tags: [...memory.tags] };
    const tags = [...new Set([...memory.tags, ...(rule.tag ? [rule.tag] : [])])];
    const updated = {
      ...memory,
      confidence: Number(Math.max(0, Math.min(1, memory.confidence + rule.confidence)).toFixed(4)),
      accessCount: memory.accessCount + rule.access,
      lastAccessed: options.at ?? memory.lastAccessed,
      tags,
      seq: undefined,
    };
    persist(updated, "feedback", options.actor, options.at, {
      previous_state: previous,
      new_state: { layer: updated.layer, confidence: updated.confidence, accessCount: updated.accessCount, tags },
      details: { verdict },
    });
    applyLifecycle(updated.id, options);
    return load().memories.get(memoryId);
  }

  /** Promotion/demotion lifecycle (spec 5 tiers, spec 11.2 closing the loop). */
  function applyLifecycle(memoryId, options = {}) {
    const state = load();
    const memory = state.memories.get(memoryId);
    if (!memory) return;
    const nextLayer = memory.confidence < cfg.demoteBelow ? demoteTarget(memory.layer) : promoteTarget(memory);
    if (!nextLayer || nextLayer === memory.layer) return;
    persist({ ...memory, layer: nextLayer, seq: undefined }, tierActionFor(memory.layer, nextLayer), options.actor, options.at, {
      previous_state: { layer: memory.layer, confidence: memory.confidence },
      new_state: { layer: nextLayer, confidence: memory.confidence },
      details: { reason: "lifecycle_threshold" },
    });
    if (memory.confidence <= 0.05) markDeleted(load().memories.get(memoryId), options, "confidence_floor");
  }

  function tierActionFor(from, to) {
    const order = { short_term: 0, working: 1, long_term: 2 };
    return order[to] > order[from] ? "promote" : "demote";
  }

  function promoteTarget(memory) {
    const rule = cfg.promote[memory.layer];
    if (!rule) return null;
    if (memory.confidence >= rule.min_confidence && memory.accessCount >= rule.min_access) {
      return memory.layer === "short_term" ? "working" : "long_term";
    }
    return null;
  }

  function demoteTarget(layer) {
    if (layer === "long_term") return "working";
    if (layer === "working") return "short_term";
    return null;
  }

  function markDeleted(memory, options, reason) {
    if (!memory) return;
    persist({ ...memory, deleted: true, seq: undefined }, "delete", options.actor, options.at, {
      previous_state: { layer: memory.layer, confidence: memory.confidence },
      details: { reason },
    });
  }

  function relatedness(a, b) {
    const sharedEntities = a.entities.filter((e) => b.entities.includes(e)).length;
    const sharedTags = a.tags.filter((t) => b.tags.includes(t)).length;
    return Math.max(
      cosine(a.embedding, b.embedding),
      Math.min(1, sharedEntities / 2),
      Math.min(1, (sharedTags + (a.domain === b.domain ? 1 : 0) + (a.type === b.type ? 1 : 0)) / 4)
    );
  }

  /** Spec 9: dreaming — deterministic clustering and proposal generation. */
  function dream(options = {}) {
    const at = options.at || null;
    const memories = currentMemories().filter((m) => !m.superseded_by && !m.deleted);
    const used = new Set();
    const proposals = [];
    for (const seed of memories) {
      if (used.has(seed.id)) continue;
      const cluster = [seed];
      used.add(seed.id);
      for (const other of memories) {
        if (used.has(other.id)) continue;
        if (relatedness(seed, other) >= cfg.relatedness) {
          cluster.push(other);
          used.add(other.id);
        }
      }
      if (cluster.length < cfg.dreamClusterMinSize) continue;
      const minConfidence = Math.min(...cluster.map((m) => m.confidence));
      const sharedEntities = cluster
        .flatMap((m) => m.entities)
        .filter((e, i, arr) => arr.indexOf(e) !== i)
        .filter((e, i, arr) => arr.indexOf(e) === i);
      const kinds = new Set(cluster.map((m) => m.type));
      const proposed = [];
      if (sharedEntities.length) {
        proposed.push({
          type: "insight",
          content: `Cluster of ${cluster.length} memories around ${sharedEntities.join(", ")} (${[...kinds].join("/")}).`,
        });
      }
      if (cluster.some((m) => m.tags.includes("feedback") || m.tags.includes("review"))) {
        proposed.push({ type: "invariant", content: `Treat ${cluster[0].domain} mappings without ${sharedEntities.length} shared anchors as review-only.` });
      }
      const domains = cluster.map((m) => m.domain).filter((d) => d !== "general");
      if (domains.length) {
        proposed.push({ type: "domain", content: `Reclassify cluster to ${domains[0]}.`, target_domain: domains[0] });
      }
      for (const p of proposed.slice(0, cfg.dreamMaxProposalsPerType)) {
        const proposal = {
          proposal_id: `drp_${stableHash(contentHash({ ...p, cluster: cluster.map((m) => m.id), at }))}`,
          type: p.type,
          content: p.content,
          target_domain: p.target_domain || null,
          supporting_memory_ids: cluster.map((m) => m.id),
          cluster_size: cluster.length,
          min_confidence: Number(minConfidence.toFixed(4)),
          status: "pending",
          at,
        };
        // Spec 9.1: programmable approval boundary (auto-policy).
        const autoApprove =
          proposal.cluster_size >= cfg.autoApproveCluster && proposal.min_confidence >= cfg.autoApproveConfidence;
        proposal.status = autoApprove ? "approved" : "pending";
        store.append(PROPOSALS_STREAM, proposal);
        proposals.push(proposal);
        if (autoApprove) materializeProposal(proposal, options);
      }
    }
    invalidate();
    return proposals;
  }

  /** Only approved proposals become durable memory (spec 9.1). */
  function materializeProposal(proposal, options) {
    const sources = proposal.supporting_memory_ids.map((id) => load().memories.get(id)).filter(Boolean);
    if (proposal.type === "domain") {
      for (const m of sources) {
        persist({ ...m, domain: proposal.target_domain, namespace: `${proposal.target_domain}/${m.namespace.split("/")[1] || "general"}`, seq: undefined }, "update", options.actor, proposal.at, {
          previous_state: { domain: m.domain },
          new_state: { domain: proposal.target_domain },
          details: { reason: "dream_domain_proposal", proposal_id: proposal.proposal_id },
        });
      }
      return;
    }
    const provenance = {
      source_event_ids: [...new Set(sources.flatMap((m) => m.provenance?.source_event_ids || []))],
      source_engine: "hmem_dream",
      derived_from: sources.map((m) => m.id),
    };
    addSync({
      content: proposal.content,
      type: proposal.type === "invariant" ? "preference" : "factual",
      layer: "long_term",
      tags: ["dream", proposal.type],
      confidence: proposal.min_confidence,
      source: `dream:${proposal.proposal_id}`,
      provenance,
      entities: [...new Set(sources.flatMap((m) => m.entities))].slice(0, cfg.entityCapPerMemory),
      derivedFrom: sources.map((m) => m.id),
      agentId: options.actor || defaultAgent,
    }, proposal.at);
  }

  // Dream materialisation is rule-driven: add() only awaits when a generator
  // is injected, so with no generator its writes complete synchronously.
  function addSync(input, at) {
    void add(input, { at, actor: input.agentId });
  }

  /** Spec 10: sleep — preview, guardrails, execute, backup id, report. */
  function sleepPreview() {
    const state = load();
    const memories = currentMemories();
    const toConsolidate = [];
    const toArchive = [];
    const toSynthesize = [];
    for (const m of memories) {
      const promoted = promoteTarget(m);
      if (promoted) toConsolidate.push({ id: m.id, from: m.layer, to: promoted });
      const stale = state.seq - m.seq >= cfg.consolidateWindowSteps;
      const guardrails =
        m.superseded_by ||
        m.derivedFrom.length ||
        m.relatedTo.length >= 3 ||
        m.layer === "long_term";
      if (m.confidence < cfg.archiveBelow && (m.accessCount === 0 || stale) && !guardrails) {
        toArchive.push({ id: m.id, confidence: m.confidence, accessCount: m.accessCount });
      }
    }
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const sim = cosine(memories[i].embedding, memories[j].embedding);
        if (sim >= cfg.synthesizeSimilarity) {
          toSynthesize.push({ ids: [memories[i].id, memories[j].id], similarity: Number(sim.toFixed(4)) });
        }
      }
    }
    return { toConsolidate, toArchive, toSynthesize };
  }

  function sleep(options = {}) {
    const at = options.at || null;
    const preview = sleepPreview();
    const backupId = `bak_${stableHash(store.stateHash())}`;
    store.append(BACKUPS_STREAM, { backup_id: backupId, at, memories: currentMemories() });
    const actions = [];

    for (const item of preview.toConsolidate) {
      const m = load().memories.get(item.id);
      if (!m) continue;
      persist({ ...m, layer: item.to, seq: undefined }, "promote", options.actor, at, {
        previous_state: { layer: m.layer },
        new_state: { layer: item.to },
        details: { reason: "sleep_consolidation" },
      });
      actions.push({ action: "consolidate", memory_id: item.id, from: item.from, to: item.to });
    }

    for (const group of preview.toSynthesize) {
      const parts = group.ids.map((id) => load().memories.get(id)).filter(Boolean);
      if (parts.length !== group.ids.length) continue;
      const merged = {
        id: `mem_${stableHash(contentHash(group.ids))}`,
        content: parts.map((p) => p.content).join("; "),
        type: parts.some((p) => p.type === "factual") ? "factual" : parts[0].type,
        layer: parts.reduce((a, b) => (LAYERS.indexOf(a.layer) >= LAYERS.indexOf(b.layer) ? a : b)).layer,
        timestamp: at,
        lastAccessed: at ?? parts[0].lastAccessed,
        accessCount: parts.reduce((a, p) => a + p.accessCount, 0),
        tags: [...new Set(parts.flatMap((p) => p.tags))],
        embedding: null,
        score: null,
        confidence: Math.max(...parts.map((p) => p.confidence)),
        source: parts[0].source,
        provenance: {
          source_event_ids: [...new Set(parts.flatMap((p) => p.provenance?.source_event_ids || []))],
          source_engine: "hmem_sleep",
        },
        domain: parts[0].domain,
        namespace: parts[0].namespace,
        entities: [...new Set(parts.flatMap((p) => p.entities))].slice(0, cfg.entityCapPerMemory),
        relatedTo: [...new Set(parts.flatMap((p) => p.relatedTo))].filter((r) => !group.ids.includes(r)).slice(0, cfg.relatedLinksCap),
        supersedes: null,
        derivedFrom: parts.map((p) => p.id),
        superseded_by: null,
        agentId: options.actor || defaultAgent,
        runId: parts[0].runId,
        taskId: parts[0].taskId,
      };
      merged.embedding = embed(merged.content);
      persist(merged, "merge", options.actor, at, { details: { reason: "sleep_synthesis", merged_ids: group.ids } });
      for (const p of parts) markDeleted(load().memories.get(p.id), { ...options, at }, "merged_into_synthesis");
      actions.push({ action: "synthesize", ids: group.ids, into: merged.id });
    }

    for (const item of preview.toArchive) {
      const m = load().memories.get(item.id);
      if (!m || m.deleted) continue;
      markDeleted(m, { ...options, at }, "sleep_archive");
      actions.push({ action: "archive", memory_id: item.id });
    }

    ledger({
      memory_id: "sleep",
      action: "sleep",
      actor: options.actor || defaultAgent,
      timestamp: at,
      details: { backup_id: backupId, counts: { consolidate: preview.toConsolidate.length, synthesize: preview.toSynthesize.length, archive: preview.toArchive.length } },
    });
    invalidate();
    return { backup_id: backupId, actions, counts: { consolidate: preview.toConsolidate.length, synthesize: preview.toSynthesize.length, archive: preview.toArchive.length }, preview };
  }

  /** Between-shift deterministic consolidation: dreaming then sleep. */
  function consolidate(options = {}) {
    return { dream: dream(options), sleep: sleep(options) };
  }

  /** Spec 10: restore-from-backup replays a snapshot as new appended versions. */
  function restore(backupId, options = {}) {
    const backup = store.readRecords(BACKUPS_STREAM).filter((b) => b.backup_id === backupId).pop();
    if (!backup) throw new Error(`No sleep backup '${backupId}'.`);
    const live = new Set(backup.memories.map((m) => m.id));
    for (const m of currentMemories()) {
      if (!live.has(m.id)) markDeleted(m, options, "restored_from_backup");
    }
    for (const m of backup.memories) {
      persist({ ...m, seq: undefined }, "update", options.actor, options.at, {
        details: { reason: "restore_from_backup", backup_id: backupId },
      });
    }
    invalidate();
    return { restored: backup.memories.length, backup_id: backupId };
  }

  function ledgerEntries() {
    return store.readRecords(LEDGER_STREAM);
  }

  function verifyLedger() {
    // readRecords recomputes the hash chain; any rewrite throws ChainTamperError.
    return ledgerEntries();
  }

  return {
    add,
    mineEvent,
    recall,
    feedback,
    applyLifecycle,
    dream,
    sleepPreview,
    sleep,
    consolidate,
    restore,
    ledgerEntries,
    verifyLedger,
    listMemories: currentMemories,
    getMemory: (id) => load().memories.get(id) || null,
    proposals: () => store.readRecords(PROPOSALS_STREAM),
    stateHash: () => store.stateHash(),
  };
}
