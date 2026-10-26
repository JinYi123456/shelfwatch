#!/usr/bin/env node
/**
 * Engine conformance harness for the memory side of Shelfwatch.
 * Runs the World Model and H-MEM engines end to end on temporary
 * directories and asserts behaviour against the engine specifications:
 * cold start, learning, provenance, trust-ledger append-only semantics,
 * outcome feedback, and determinism. All printed numbers are measured
 * from live engine runs, not fixtures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAppendOnlyStore, AppendOnlyError, ChainTamperError } from "../src/engines/store.js";
import { openWorldModel, normalizeText } from "../src/engines/world-model.js";
import { openHMem } from "../src/engines/hmem.js";

const NIGHT_1 = "night-1 22:00";
const DAWN_1 = "night-1 06:00";
const NIGHT_2 = "night-2 22:00";

const P1_CANON = "Sunrise Harvest Organic Apple Sauce 24 oz Jar";
const MENTION_1 = "sunrise applesauce 24 oz";
const MENTION_PB = "cedar mill crunchy peanut butter 16 oz jar";

const PRODUCTS = [
  {
    key: "apple-sauce",
    events: [
      {
        kind: "observation.recall_notice",
        source: "fda_enforcement",
        at: NIGHT_1,
        summary: "Class I recall notice — organic apple sauce 24 oz jar, listeria",
        product: { name: P1_CANON },
      },
      {
        kind: "observation.adverse_event_mention",
        source: "fda_adverse_event",
        at: NIGHT_1,
        summary: "Adverse event report mentions Sunrise Harvest Applesauce 24 oz Glass Jar",
        product: { name: "Sunrise Harvest Applesauce 24 oz Glass Jar" },
      },
      {
        kind: "observation.donation_ledger_line",
        source: "donation_ledger",
        at: NIGHT_1,
        summary: "Ledger line Sunrise Harvest Applesauce 24 oz Glass Jar, lot 4471",
        product: { name: "Sunrise Harvest Applesauce 24 oz Glass Jar" },
      },
      {
        kind: "observation.crosswalk_hit",
        source: "open_food_facts",
        at: NIGHT_1,
        summary: "Open Food Facts crosswalk: gtin 48001234 jar 24 oz",
        product: { name: P1_CANON },
        aliases: ["Sunrise Harvest Organic Apple Sauce (24 oz jar)"],
        links: [{ type: "connects_to", to_name: "Sunrise Harvest Applesauce 24 oz Glass Jar" }],
      },
    ],
  },
  {
    key: "oat-drink",
    events: [
      {
        kind: "observation.recall_notice",
        source: "second_agency",
        at: NIGHT_1,
        summary: "Class II recall notice — oat drink, unsweetened 1 L carton",
        product: { name: "Brookfield Oat Drink Unsweetened 1 L" },
      },
      {
        kind: "observation.crosswalk_hit",
        source: "open_food_facts",
        at: NIGHT_1,
        summary: "Open Food Facts crosswalk: gtin 50112345 oat drink carton",
        product: { name: "Brookfield Oat Drink Unsweetened 1 L" },
        aliases: ["Brookfield Oat Unsweetened Carton"],
      },
    ],
  },
  {
    key: "peanut-butter",
    events: [
      {
        kind: "observation.recall_notice",
        source: "fda_enforcement",
        at: NIGHT_1,
        summary: "Class I recall notice — crunchy peanut butter 16 oz, aflatoxin",
        product: { name: "Cedar Mill Crunchy Peanut Butter 16 oz" },
      },
      {
        kind: "observation.donation_ledger_line",
        source: "donation_ledger",
        at: NIGHT_1,
        summary: "Ledger line Cedar Mill Crunchy Peanut Butter, 16 oz, lot 882",
        product: { name: "Cedar Mill Crunchy Peanut Butter 16 oz" },
      },
    ],
  },
  {
    key: "almond-butter",
    events: [
      {
        kind: "observation.crosswalk_hit",
        source: "open_food_facts",
        at: NIGHT_1,
        summary: "Open Food Facts crosswalk: gtin 50198765 almond butter tub",
        product: { name: "Cedar Mill Creamy Almond Butter 16 oz" },
        aliases: ["Cedar Mill Almond Butter Tub"],
      },
      {
        kind: "observation.donation_ledger_line",
        source: "donation_ledger",
        at: NIGHT_1,
        summary: "Ledger line Cedar Mill Almond Butter 16 oz, lot 91",
        product: { name: "Cedar Mill Almond Butter 16 oz" },
      },
    ],
  },
  {
    key: "whole-milk",
    events: [
      {
        kind: "observation.recall_notice",
        source: "second_agency",
        at: NIGHT_1,
        summary: "Class II recall notice — whole milk 24 oz bottle, pasteurisation fault",
        product: { name: "Golden Valley Whole Milk 24 oz" },
      },
      {
        kind: "observation.adverse_event_mention",
        source: "fda_adverse_event",
        at: NIGHT_1,
        summary: "Adverse event report mentions Golden Valley milk bottle",
        product: { name: "Golden Valley Whole Milk 24 oz" },
      },
    ],
  },
];

const RECALL_PRODUCT_KEY = `product:${normalizeText(P1_CANON)}`;

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shelfwatch-engines-${tag}-`));
}

function openPair(dir) {
  const store = openAppendOnlyStore(path.join(dir, "state"));
  const world = openWorldModel({ store });
  const hmem = openHMem({ store });
  return { store, world, hmem };
}

async function ingestNightOne(dir) {
  const pair = openPair(dir);
  for (const product of PRODUCTS) {
    for (const ev of product.events) {
      const { event, duplicate } = pair.world.appendEvent({
        ...ev,
        agentId: "Anchor",
        runId: "shift-1",
      });
      if (!duplicate) await pair.hmem.mineEvent(event, { at: ev.at, actor: "Anchor", runId: "shift-1" });
    }
  }
  return pair;
}

/**
 * Two-shift scenario: resolve on night 1, confirm the match, consolidate at
 * dawn, resolve the same mention on night 2. Everything is computed by the
 * engines from the ingested events.
 */
async function playTwoShifts(dir) {
  const { store, world, hmem } = await ingestNightOne(dir);

  const night1 = world.resolveMention(MENTION_1);
  const decision = world.recordResolution(MENTION_1, night1, { at: NIGHT_1, agentId: "Anchor", runId: "shift-1" });
  await hmem.mineEvent(decision.event, { at: NIGHT_1, actor: "Anchor" });

  // The duty officer's brief carries the proposed pairing, so the recall
  // query names both the crosswalk product key and the resolved entity id.
  const query = {
    text: MENTION_1,
    entities: [RECALL_PRODUCT_KEY, night1.entity_id],
    tags: ["mined", "identity"],
    domain: "identity",
  };
  const recall1 = hmem.recall(query, { at: NIGHT_1, actor: "Assay" });
  for (const hit of recall1.memories.slice(0, 3)) {
    hmem.feedback(hit.id, "helpful", { at: NIGHT_1, actor: "Assay" });
  }

  const outcome = world.recordOutcome({
    outcome: "correct",
    mention_text: MENTION_1,
    entity_id: night1.entity_id,
    at: NIGHT_1,
    agentId: "Anchor",
    runId: "shift-1",
  });
  await hmem.mineEvent(outcome.event, { at: NIGHT_1, actor: "Anchor" });

  const consolidation = hmem.consolidate({ at: DAWN_1, actor: "Anchor" });

  const night2 = world.resolveMention(MENTION_1);
  const decision2 = world.recordResolution(MENTION_1, night2, { at: NIGHT_2, agentId: "Anchor", runId: "shift-2" });
  await hmem.mineEvent(decision2.event, { at: NIGHT_2, actor: "Anchor" });
  const recall2 = hmem.recall(query, { at: NIGHT_2, actor: "Assay" });

  return { store, world, hmem, night1, night2, recall1, recall2, consolidation };
}

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

// 1 — cold start: an empty model resolves with low confidence and records
// the evidence gap as a decision event.
{
  const dir = makeTempDir("cold");
  const world = openWorldModel({ dir });
  const r = world.resolveMention(MENTION_1);
  world.recordResolution(MENTION_1, r, { at: NIGHT_1, agentId: "Anchor", runId: "shift-0" });
  const ent = world.getEntity(r.entity_id);
  record(
    "cold start: low-confidence resolution, evidence recorded",
    r.confidence < 0.3 &&
      r.match_basis === "provisional_no_support" &&
      r.evidence.event_ids.length === 0 &&
      world.eventCount() === 1 &&
      ent &&
      ent.state === "emerging",
    `confidence ${r.confidence}, basis ${r.match_basis}, decision events ${world.eventCount()}, entity state ${ent?.state}`
  );
}

// 2 — learning: night 2 resolves the same mention with higher confidence
// and measurably fewer candidate lookups.
{
  const dir = makeTempDir("learn");
  const play = await playTwoShifts(dir);
  const drop = play.night1.candidate_lookups - play.night2.candidate_lookups;
  record(
    "learning: confidence up, candidate lookups down",
    play.night2.confidence > play.night1.confidence &&
      drop > 0 &&
      play.night1.confidence < 0.7 &&
      play.night2.confidence >= 0.7 &&
      play.night2.match_basis === "learned_alias",
    `confidence ${play.night1.confidence} -> ${play.night2.confidence} (+${(play.night2.confidence - play.night1.confidence).toFixed(4)}); lookups ${play.night1.candidate_lookups} -> ${play.night2.candidate_lookups} (drop ${drop})`
  );
}

// 3 — provenance: every recalled hit names the world-model source event ids,
// and the resolution evidence ids exist in the event log.
{
  const dir = makeTempDir("prov");
  const play = await playTwoShifts(dir);
  const eventIds = new Set(
    play.store.readRecords("world_events").map((e) => e.event_id)
  );
  const hits = play.recall2.memories;
  const provenanceOk =
    hits.length >= 1 &&
    hits.every(
      (h) =>
        Array.isArray(h.provenance?.source_event_ids) &&
        h.provenance.source_event_ids.length > 0 &&
        h.provenance.source_event_ids.every((id) => eventIds.has(id))
    ) &&
    hits.every((h) => h.retrievalReason.length > 0);
  const evidenceOk = play.night2.evidence.event_ids.every((id) => eventIds.has(id));
  record(
    "provenance: recalled hits name source event ids",
    provenanceOk && evidenceOk,
    `${hits.length} hit(s); reasons ${hits.map((h) => h.retrievalReason.join("+")).slice(0, 2).join(" | ") || "none"}; night-2 evidence ids ${play.night2.evidence.event_ids.length}`
  );
}

// 4 — the trust ledger is append-only: a seq rewrite is refused on append,
// and a byte-level history rewrite is refused on read.
{
  const dir = makeTempDir("ledger");
  const play = await playTwoShifts(dir);
  const entries = play.store.readEntries("hm_trust_ledger");
  let refusedAppend = false;
  try {
    play.store.append("hm_trust_ledger", { ...entries[0].record, actor: "rewrite-attempt", _seq: 1 });
  } catch (err) {
    refusedAppend = err instanceof AppendOnlyError;
  }
  const file = path.join(dir, "state", "hm_trust_ledger.jsonl");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.record.action = "delete";
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  let refusedRead = false;
  try {
    openHMem({ dir }).verifyLedger();
  } catch (err) {
    refusedRead = err instanceof ChainTamperError;
  }
  record(
    "trust ledger append-only: rewrite refused",
    refusedAppend && refusedRead,
    `append rewrite refused: ${refusedAppend}; tampered history refused on read: ${refusedRead} (ledger had ${entries.length} entries)`
  );
}

// 5 — a wrong match reported as an outcome lowers pair trust and the engine
// stops auto-proposing that pairing.
{
  const dir = makeTempDir("wrong");
  const { world } = await ingestNightOne(dir);
  const entities = world.listEntities();
  const peanut = entities.find((e) => e.name.toLowerCase().includes("peanut"));
  const first = world.resolveMention(MENTION_PB);
  const outcome = world.recordOutcome({
    outcome: "wrong",
    mention_text: MENTION_PB,
    entity_id: first.entity_id,
    at: NIGHT_1,
    agentId: "Anchor",
    runId: "shift-1",
  });
  const recheck = world.resolveMention(MENTION_PB);
  record(
    "wrong outcome: trust down, pairing not re-proposed",
    first.entity_id === peanut?.id &&
      outcome.pair_trust_after < outcome.pair_trust_before &&
      world.getPairTrust(MENTION_PB, peanut.id) === outcome.pair_trust_after &&
      recheck.entity_id !== peanut?.id &&
      recheck.name.toLowerCase().includes("almond"),
    `resolved to ${peanut?.name}; trust ${outcome.pair_trust_before} -> ${outcome.pair_trust_after}; re-resolution proposed '${recheck.name}' (${recheck.entity_id}), never ${peanut?.id}`
  );
}

// 6 — determinism: the same event sequence produces the same state hash and
// the same measured behaviour.
{
  const dirA = makeTempDir("det-a");
  const dirB = makeTempDir("det-b");
  const a = await playTwoShifts(dirA);
  const b = await playTwoShifts(dirB);
  const same =
    a.store.stateHash() === b.store.stateHash() &&
    a.world.stateHash() === b.world.stateHash() &&
    a.hmem.stateHash() === b.hmem.stateHash() &&
    a.night2.confidence === b.night2.confidence &&
    a.night2.candidate_lookups === b.night2.candidate_lookups;
  record(
    "determinism: identical event sequence, identical state hash",
    same,
    `hash A ${a.store.stateHash().slice(0, 18)}… == hash B ${b.store.stateHash().slice(0, 18)}…`
  );
}

for (const dir of fs.readdirSync(os.tmpdir())) {
  if (dir.startsWith("shelfwatch-engines-")) {
    fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
  }
}

const width = 52;
console.log("SHELFWATCH ENGINE CONFORMANCE — World Model + H-MEM + store");
console.log("-".repeat(width + 30));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
}
const passed = results.filter((r) => r.ok).length;
console.log("-".repeat(width + 30));
console.log(`ENGINES CONFORMANCE ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
