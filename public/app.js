/* Shelfwatch operator interface.
   Everything on the page and in the scene is derived from a run document and
   the trace lines behind it. Nothing here is a pre-written answer. */

const $ = (id) => document.getElementById(id);
const D = Math.PI;
const SHIFT_MIN = 480;
const BUDGET_CALLS = 250;
const BUDGET_FRAME_MS = 20;
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const HZ = -2.3;

const hh = (m) =>
  String((22 + Math.floor(m / 60)) % 24).padStart(2, "0") + ":" + String(Math.floor(m % 60)).padStart(2, "0");
const wallClock = (iso) => (iso ? String(iso).slice(11, 23) : "—");
const hexNum = (c) => "#" + Number(c).toString(16).padStart(6, "0");
const dash = (v, fallback = "not in the run document") => (v === null || v === undefined || v === "" ? fallback : String(v));
const sm = (a, b, x) => {
  const p = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return p * p * (3 - 2 * p);
};
const da = (a, b) => {
  let d = (b - a) % (2 * D);
  if (d > D) d -= 2 * D;
  if (d < -D) d += 2 * D;
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* ── crew and places ─────────────────────────────────────────────────── */

const AGENTS = [
  { id: "Foreman", role: "Planner", color: 0xe0a43a, hair: 0x2b1d12, skin: 0xe8c4a0, home: "deskF", bay: -1 },
  { id: "Ledger", role: "Reconciler", color: 0x3a8fd6, hair: 0x151515, skin: 0xc58c5e, home: "deskL", bay: 5 },
  { id: "Assay", role: "Adjudicator", color: 0xd9534f, hair: 0x6b3d1f, skin: 0xf0d2b6, home: "deskA", bay: 9 },
  { id: "Anchor", role: "Memory keeper", color: 0x8a63d2, hair: 0x1a1a22, skin: 0x9a6a45, home: "deskM", bay: -5 },
];

/* Where each real trace action takes its agent. Actions not listed keep the
   agent at their own desk, so the scene follows the trace instead of a script. */
const ACTION_PLACE = {
  Foreman: { open_shift: "deskF", delegate: "delegatee", revise_plan: "wb", close_shift: "print", plan: "wb" },
  Ledger: { propose_matches: "deskL", query: "deskL", re_query: "cons" },
  Assay: { critique: "tblE", adjudicate: "tblW", escalate: "recpt" },
  Anchor: { memory_lookup: "rack", record_outcome: "deskM", learn: "rack" },
};

const PLACES = {
  ent: { p: [2, 8.6], f: D, v: [[2, HZ]] },
  deskF: { p: [-2.1, 0.55], f: 0, v: [[-2.1, HZ]] },
  deskL: { p: [0.1, 0.55], f: 0, v: [[0.1, HZ]] },
  deskA: { p: [-2.1, 3.45], f: D, v: [[-3.9, HZ], [-3.9, 5.2], [-2.1, 5.2]] },
  deskM: { p: [0.1, 3.45], f: D, v: [[-3.9, HZ], [-3.9, 5.2], [0.1, 5.2]] },
  tblW: { p: [-4.4, -6.6], f: D / 2, v: [[-2.5, HZ], [-2.5, -4.6], [-4.4, -4.6]] },
  tblE: { p: [-0.6, -6.6], f: -D / 2, v: [[-2.5, HZ], [-2.5, -4.6], [-0.6, -4.6]] },
  wb: { p: [2, -7.6], f: D, v: [[2, HZ], [2, -5]] },
  cons: { p: [6.3, -6.9], f: D, v: [[6.3, HZ], [6.3, -4.6]] },
  rack: { p: [5.5, -7.6], f: D, v: [[5.5, HZ], [5.5, -4.6]] },
  shelf: { p: [10.3, 3.3], f: D / 2, v: [[10.3, HZ]] },
  print: { p: [8.8, -0.3], f: D, v: [[7.6, HZ], [7.6, -0.3]] },
  recpt: { p: [6.8, 5.9], f: 0, v: [[2, HZ], [2, 5.2], [6.8, 5.2]] },
};

const KIND_LABEL = {
  notice: "Notice id",
  source: "Source system",
  class: "Recall class",
  lot: "Lot",
  barcode: "Barcode",
};
const SOURCE_NAME = {
  fda_enforcement: "FDA enforcement report",
  fda_adverse_event: "FDA adverse event report",
  second_agency: "Second agency notice",
  open_food_facts: "Open Food Facts crosswalk",
  donation_ledger: "Synthetic donation ledger",
};

/* ── night model ─────────────────────────────────────────────────────── */

let night = null;

function findConformance(source) {
  let out = null;
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 4 || out) return;
    for (const [k, v] of Object.entries(node)) {
      if (/conformance/i.test(k) && (typeof v === "string" || typeof v === "number")) out = String(v);
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(source, 0);
  return out;
}

function facetKind(facet) {
  const i = String(facet).indexOf(":");
  return i < 0 ? "notice" : String(facet).slice(0, i);
}
function facetValue(facet) {
  const i = String(facet).indexOf(":");
  return i < 0 ? String(facet) : String(facet).slice(i + 1);
}

function buildNight(doc, runRecord) {
  const rawEvents = runRecord?.events || [];
  const events = rawEvents.map((e, i) => ({
    ...e,
    minute: rawEvents.length < 2 ? 0 : Math.round((SHIFT_MIN * i) / (rawEvents.length - 1)),
  }));
  const byAction = (a) => events.filter((e) => e.action === a);
  const open = byAction("open_shift")[0];
  const close = byAction("close_shift")[0];
  const floor = open?.detail?.auto_action_floor ?? null;

  const stats = doc?.stats
    ? { ...doc.stats }
    : {
        notices_in: open?.detail?.notices ?? byAction("critique").length,
        actions_out: close?.detail?.actions_out ?? null,
        escalation_count: byAction("escalate").length,
        rejection_count: close?.detail?.rejection_count ?? events.filter((e) => e.verdict === "reject").length,
        revision_count: byAction("revise_plan").length,
        memory_hits: events.find((e) => e.action === "memory_lookup")?.detail?.memory_hits ?? null,
      };

  const minuteFor = (actionId) => {
    const e = events.find((x) => x.target === actionId && (x.action === "adjudicate" || x.action === "escalate"));
    return e ? e.minute : null;
  };
  const entityFor = (index) => {
    for (let i = index + 1; i < events.length; i++) {
      if (events[i].action === "record_outcome") return String(events[i].target || "");
      if (events[i].agent === "Assay") break;
    }
    return "";
  };

  let pull;
  if (doc?.pull_list) {
    pull = doc.pull_list.map((p) => ({
      action_id: p.action_id,
      product_name: p.product_name,
      action: p.action,
      confidence: p.confidence,
      status: p.status,
      evidence: (p.evidence || []).slice(),
      what_would_change: p.what_would_change ?? null,
      minute: minuteFor(p.action_id),
      entity: null,
      fromTraceOnly: false,
    }));
  } else {
    pull = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.action === "adjudicate" || e.action === "escalate")
      .map(({ e, i }) => ({
        action_id: e.target,
        product_name: entityFor(i).replace(/^ent:/, "") || e.target.replace(/^act:/, ""),
        action: null,
        confidence: e.confidence ?? null,
        status: e.verdict === "auto_action" ? "auto_action" : "escalated",
        evidence: ["notice:" + String(e.target || "").replace(/^act:/, "")],
        what_would_change: null,
        minute: e.minute,
        entity: entityFor(i),
        fromTraceOnly: true,
      }));
  }

  const escalations = doc?.escalations
    ? doc.escalations.map((x) => ({ ...x, minute: minuteFor(x.action_id) }))
    : byAction("escalate").map((e) => ({
        action_id: e.target,
        reason: `confidence ${e.confidence} below the auto-action floor ${e.detail?.floor ?? floor}`,
        confidence: e.confidence ?? null,
        minute: e.minute,
      }));

  const records = new Map();
  for (const p of pull) {
    for (const facet of p.evidence) {
      const kind = facetKind(facet);
      const key = kind + ":" + facetValue(facet);
      if (!records.has(key)) records.set(key, { key, kind, value: facetValue(facet), usedBy: [] });
      records.get(key).usedBy.push(p.action_id);
    }
  }
  const sourceRecords = [...records.values()];

  const memory = events
    .filter((e) => e.agent === "Anchor")
    .map((e) => ({
      ts: e.ts,
      minute: e.minute,
      action: e.action,
      target: e.target,
      verdict: e.verdict,
      confidence: e.confidence ?? null,
      detail: e.detail || null,
    }));

  const conformance =
    findConformance(doc) || findConformance({ open: open?.detail, close: close?.detail }) || null;

  return {
    doc: doc || null,
    runId: doc?.run_id ?? runRecord?.run_id ?? null,
    scenarioId: doc?.scenario_id ?? open?.target ?? close?.target ?? null,
    file: runRecord?.file ?? doc?.log_path ?? null,
    backend: doc?.reasoning_backend ?? open?.detail?.reasoning_backend ?? close?.detail?.reasoning_backend ?? null,
    sampleMode: doc?.sample_mode ?? open?.detail?.sample_mode ?? null,
    floor: doc ? (floor ?? 0.7) : floor,
    startedAt: doc?.started_at ?? events[0]?.ts ?? null,
    finishedAt: doc?.finished_at ?? close?.ts ?? null,
    traceOnly: !doc,
    stats,
    events,
    pull,
    escalations,
    sourceRecords,
    memory,
    rejections: events.filter((e) => e.verdict === "reject" || e.verdict === "rework"),
    closeMinute: close ? close.minute : SHIFT_MIN,
    conformance,
  };
}

function placeFor(agentId, event) {
  const map = ACTION_PLACE[agentId] || {};
  if (!event) return AGENTS.find((a) => a.id === agentId).home;
  if (map[event.action] === "delegatee") {
    const target = AGENTS.find((a) => a.id === event.target);
    return target ? target.home : AGENTS.find((a) => a.id === agentId).home;
  }
  return map[event.action] || AGENTS.find((a) => a.id === agentId).home;
}

/* Every piece of scene and panel state is a pure function of the minute. */
function derived(min) {
  const perAgent = {};
  for (const a of AGENTS) {
    let k = -1;
    night.events.forEach((e, i) => {
      if (e.agent === a.id && e.minute <= min) k = i;
    });
    const event = k < 0 ? null : night.events[k];
    perAgent[a.id] = { k, event, place: placeFor(a.id, event) };
  }
  const decided = night.pull.filter((p) => (p.minute ?? SHIFT_MIN) <= min);
  const auto = decided.filter((p) => p.status === "auto_action");
  const esc = decided.filter((p) => p.status === "escalated");
  const planLines = buildPlan();
  const planState = planLines.map((l) => (l.minute <= min ? (l.minute + 24 > min ? "now" : "done") : "next"));
  const occupancy = {};
  for (const a of AGENTS) occupancy[perAgent[a.id].place] = (occupancy[perAgent[a.id].place] || 0) + 1;
  return {
    min,
    clock: hh(min),
    perAgent,
    occupancy,
    pallets: auto.map((p, i) => ({ i, prog: sm(p.minute ?? 0, (p.minute ?? 0) + 14, min), item: p })),
    slips: esc.map((p, i) => ({ i, prog: sm(p.minute ?? 0, (p.minute ?? 0) + 10, min), item: p })),
    counts: { auto: auto.length, esc: esc.length },
    planState,
    planSignature: planState.join("|"),
    printed: min >= night.closeMinute,
    handover: min >= SHIFT_MIN,
    floorText: (() => {
      const below = decided.filter((p) => typeof p.confidence === "number" && p.confidence < (night.floor ?? 0.7));
      if (!below.length) return `Auto-action floor ${(night.floor ?? 0.7).toFixed(2)} — nothing below it yet at ${hh(min)}`;
      return `${below.length} action${below.length > 1 ? "s" : ""} below the ${(night.floor ?? 0.7).toFixed(2)} floor — escalated, not actioned`;
    })(),
    floorLow: true,
  };
}

function buildPlan() {
  const first = (a) => night.events.find((e) => e.action === a);
  const rejections = night.rejections;
  const lines = [];
  const open = first("open_shift");
  if (open) lines.push({ text: `Read ${night.stats.notices_in} notices`, minute: open.minute });
  const del = first("delegate");
  if (del) lines.push({ text: `Delegate reconciliation to ${del.target}`, minute: del.minute });
  const prop = first("propose_matches");
  if (prop) lines.push({ text: `Match identities across ${new Set(night.pull.map((p) => facetKind(p.evidence[1] || ""))).size} facet kinds`, minute: prop.minute });
  const crit = first("critique");
  if (crit) lines.push({ text: `Critique each proposal against policy`, minute: crit.minute });
  if (rejections.length)
    lines.push({
      text: `Rework ${rejections.length} rejection${rejections.length > 1 ? "s" : ""}: ${rejections[0].detail?.reason || rejections[0].verdict}`,
      minute: rejections[rejections.length - 1].minute,
      flag: true,
    });
  const adj = night.events.find((e) => e.action === "adjudicate" || e.action === "escalate");
  if (adj) lines.push({ text: `Adjudicate against the ${(night.floor ?? 0.7).toFixed(2)} floor`, minute: adj.minute });
  const mem = first("record_outcome");
  if (mem) lines.push({ text: "Write outcomes to memory", minute: mem.minute });
  if (open) lines.push({ text: `Print ${dash(night.stats.actions_out, "?")} actions for the desk`, minute: night.closeMinute });
  return lines;
}

/* ── panels ──────────────────────────────────────────────────────────── */

function renderStatus() {
  const n = night;
  $("stMode").textContent = "mode: " + (n.sampleMode === null ? "not recorded" : n.sampleMode ? "sample" : "live");
  $("stMode").className = "chip " + (n.sampleMode === false ? "k" : "");
  $("stConformance").textContent =
    "engine conformance: " + (n.conformance ? n.conformance : "not carried by the run document");
  $("stConformance").className = "chip " + (n.conformance ? "k" : "");
  $("stBackend").textContent = "reasoning backend: " + dash(n.backend, "not recorded");
  $("stFloor").textContent = "auto-action floor: " + (n.floor == null ? "—" : Number(n.floor).toFixed(2));
  $("stActions").innerHTML =
    "actions out <b>" + esc(dash(n.stats.actions_out, "—")) + "</b> · rejections <b>" +
    esc(n.stats.rejection_count ?? "—") + "</b> · revisions <b>" + esc(n.stats.revision_count ?? "—") + "</b>";
  $("stEscalations").innerHTML =
    "escalations <b>" + esc(dash(n.stats.escalation_count, "—")) + "</b> · notices in <b>" +
    esc(dash(n.stats.notices_in, "—")) + "</b>";
  $("stMemory").innerHTML = "memory hits <b>" + esc(dash(n.stats.memory_hits, "—")) + "</b>";
  $("stRun").textContent =
    "run " + (n.runId ? String(n.runId).slice(0, 8) : "—") + " · " + (n.traceOnly ? "recorded trace, no run document" : "run document + trace");
  $("stRun").className = "chip " + (n.doc ? "k" : "");
}

function rowMarkup(item, index) {
  const belowFloor = typeof item.confidence === "number" && item.confidence < (night.floor ?? 0.7);
  const conf = typeof item.confidence === "number" ? item.confidence.toFixed(2) : "no confidence in this record";
  const classFacet = item.evidence.find((f) => facetKind(f) === "class");
  const cls = classFacet ? facetValue(classFacet) : null;
  const facets = item.evidence
    .map((f) => `<li class="facet" data-facet="${esc(f)}">${esc(facetKind(f))}:${esc(facetValue(f))}</li>`)
    .join("");
  const missing = item.fromTraceOnly
    ? `<li class="missing">action verb: not in the trace</li><li class="missing">source / class / lot facets: run document only</li>`
    : "";
  return `<button class="row reveal${belowFloor ? " esc" : ""}" type="button" data-id="${esc(item.action_id)}" style="--i:${index}">
    <span class="who">${esc(item.product_name)}</span>
    <span class="meta">
      <span class="tagsev${cls === "I" ? " c1" : ""}">class ${esc(cls || "not in record")}</span>
      <span class="tagsev ${belowFloor ? "escv" : "act"}">${esc(item.status === "auto_action" ? dash(item.action, "actioned") : item.status)}</span>
      <span class="conf${belowFloor ? " low" : ""}">${esc(conf)}</span>
    </span>
    <span class="verb">${esc(item.action_id)} · decided ${esc(item.minute == null ? "no decision event" : hh(item.minute))}</span>
    <span class="bar${belowFloor ? " low" : ""}" style="--w:${typeof item.confidence === "number" ? item.confidence * 100 : 0}%"><i></i><u></u></span>
    <ul class="facets">${facets}${missing}</ul>
    <span class="flip"><b>What would change this answer:</b> ${esc(dash(item.what_would_change, "the run document for this night does not carry a counterfactual"))}</span>
  </button>`;
}

function renderPull() {
  const list = $("pullList");
  list.innerHTML = night.pull.map((p, i) => `<li>${rowMarkup(p, i)}</li>`).join("") || `<li class="row">No actions in this run.</li>`;
  $("traceNote").hidden = !night.traceOnly;
  $("traceNote").textContent = night.traceOnly
    ? "Replay of a recorded trace. This night's run document was written to stdout, not to disk, so columns the trace does not carry are marked rather than filled in. Start a shift to get the complete document."
    : "";
  $("escalList").innerHTML = night.escalations.length
    ? `<h3>Escalations</h3><ul>${night.escalations
        .map(
          (x, i) =>
            `<li style="--i:${i}"><span class="tagsev escv">below floor</span><span class="why">${esc(x.action_id)} — ${esc(x.reason)}</span><span class="conf low">${esc(typeof x.confidence === "number" ? x.confidence.toFixed(2) : "—")}</span></li>`
        )
        .join("")}</ul>`
    : `<h3>Escalations</h3><p class="none">Nothing fell below the ${(night.floor ?? 0.7).toFixed(2)} floor in this run.</p>`;
  list.querySelectorAll(".row[data-id]").forEach((r) => {
    r.addEventListener("click", () => selectRow(r.dataset.id, r));
    r.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectRow(r.dataset.id, r);
      }
    });
  });
  $("escalList").querySelectorAll("li").forEach((li, i) => li.classList.add("reveal"));
}

function renderSources() {
  $("srcGrid").innerHTML = night.sourceRecords
    .map(
      (s, i) =>
        `<button class="src reveal" type="button" data-key="${esc(s.key)}" style="--i:${i}">
      <span class="kind">${esc(KIND_LABEL[s.kind] || s.kind)}</span>
      <span class="val">${esc(s.value)}</span>
      <span class="for">${esc(
        s.kind === "source"
          ? SOURCE_NAME[s.value] || s.value
          : s.usedBy.length + " pull-list item" + (s.usedBy.length > 1 ? "s" : "")
      )}</span>
    </button>`
    )
    .join("");
  $("srcGrid").querySelectorAll(".src").forEach((b) =>
    b.addEventListener("click", () => {
      const item = night.pull.find((p) => p.action_id === b.dataset.key) || night.pull.find((p) => p.evidence.some((f) => f === b.dataset.key || f.endsWith(":" + b.querySelector(".val").textContent)));
      const row = [...$("pullList").querySelectorAll(".row[data-id]")].find((r) => r.dataset.id === item?.action_id);
      if (row) selectRow(item.action_id, row, [b.dataset.key]);
    })
  );
}

let selectedId = null;

function selectRow(actionId, rowEl, forcedKeys) {
  selectedId = selectedId === actionId && !forcedKeys ? null : actionId;
  const item = night.pull.find((p) => p.action_id === selectedId);
  const keys = forcedKeys || (item ? item.evidence.map((f) => facetKind(f) + ":" + facetValue(f)) : []);
  for (const r of $("pullList").querySelectorAll(".row[data-id]")) r.classList.toggle("on", !!item && r.dataset.id === item.action_id);
  for (const s of $("srcGrid").querySelectorAll(".src")) s.classList.toggle("hl", keys.includes(s.dataset.key));
  for (const f of $("pullList").querySelectorAll(".facet")) f.classList.toggle("hit", keys.includes(f.dataset.facet));
  drawThreads(!!item, keys);
  if (item && !forcedKeys) {
    const card = $("srcGrid").querySelector(`.src[data-key="${CSS.escape(keys[0] || "")}"]`);
    if (card) card.scrollIntoView({ block: "nearest" });
  }
}

function drawThreads(on, keys) {
  const svg = $("threads");
  svg.textContent = "";
  if (!on) return;
  const host = $("pullzoneInner");
  const hb = host.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${hb.width} ${hb.height}`);
  const row = $("pullList").querySelector(`.row[data-id="${CSS.escape(selectedId)}"]`);
  if (!row) return;
  const rb = row.getBoundingClientRect();
  const x0 = rb.right - hb.left;
  const y0 = rb.top - hb.top + rb.height / 2;
  keys.forEach((key, i) => {
    const card = $("srcGrid").querySelector(`.src[data-key="${CSS.escape(key)}"]`);
    if (!card) return;
    const cb = card.getBoundingClientRect();
    const x1 = cb.left - hb.left;
    const y1 = cb.top - hb.top + cb.height / 2;
    const midx = Math.min(Math.max(x0, x1) + 18, hb.width - 6);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x0} ${y0} C ${midx} ${y0}, ${midx - 40} ${y1}, ${x1} ${y1}`);
    path.style.animationDelay = i * 60 + "ms";
    svg.appendChild(path);
  });
}

function renderMemory() {
  const rows = night.memory;
  $("memTable").innerHTML =
    `<thead><tr><th>Real time</th><th>Shift</th><th>Action</th><th>Target</th><th>Verdict</th><th class="num">Confidence</th><th>Detail</th></tr></thead><tbody>` +
    (rows.length
      ? rows
          .map(
            (m) =>
              `<tr><td><span class="v">${esc(wallClock(m.ts))}</span></td><td><span class="v">${esc(hh(m.minute))}</span></td><td>${esc(m.action)}</td><td><span class="v">${esc(m.target)}</span></td>` +
              `<td class="${m.verdict === "hit" || m.verdict === "auto_action" ? "hit" : m.verdict === "miss" || m.verdict === "escalated" ? "rej" : ""}">${esc(dash(m.verdict, "—"))}</td>` +
              `<td class="num">${esc(typeof m.confidence === "number" ? m.confidence.toFixed(4) : "—")}</td>` +
              `<td><span class="v">${esc(m.detail ? JSON.stringify(m.detail) : "")}</span></td></tr>`
          )
          .join("")
      : `<tr><td colspan="7">No Anchor activity in this trace.</td></tr>`) +
    `</tbody>`;
  $("memStats").innerHTML = [
    `<span class="chip">memory hits <b>${esc(dash(night.stats.memory_hits, "—"))}</b></span>`,
    `<span class="chip">outcomes recorded <b>${rows.filter((m) => m.action === "record_outcome").length}</b></span>`,
    `<span class="chip">entities touched <b>${new Set(rows.filter((m) => String(m.target).startsWith("ent:")).map((m) => m.target)).size}</b></span>`,
    `<span class="chip">run document <b>${night.doc ? "captured" : "not persisted"}</b></span>`,
  ].join("");
}

function renderRuns(runs) {
  const rows = runs.slice(0, 12);
  $("runsTable").innerHTML =
    `<thead><tr><th>Night</th><th>Run id</th><th>Scenario</th><th>Backend</th><th class="num">Events</th><th>Trace file</th><th></th></tr></thead><tbody>` +
    (rows.length
      ? rows
          .map(
            (r) =>
              `<tr><td><span class="v">${esc(wallClock(r.started_ts))}</span></td><td><span class="v">${esc((r.run_id || "—").slice(0, 8))}</span></td><td>${esc(r.scenario_id || "—")}</td><td>${esc(r.reasoning_backend || "—")}</td><td class="num">${esc(r.event_count)}</td><td><span class="v">${esc(r.file)}</span></td>` +
              `<td><button type="button" data-run="${esc(r.run_id)}">${r.run_id === night?.runId ? "loaded" : "Replay"}</button></td></tr>`
          )
          .join("")
      : `<tr><td colspan="7">No traces in <code>logs/</code>.</td></tr>`) +
    `</tbody>`;
  $("runsTable")
    .querySelectorAll("button[data-run]")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        const rec = runs.find((r) => r.run_id === b.dataset.run);
        if (rec) loadTrace(rec);
      })
    );
}

function searchIndex() {
  const idx = [];
  for (const s of night.sourceRecords)
    idx.push(["Source", `${KIND_LABEL[s.kind] || s.kind}: ${s.value}`, (SOURCE_NAME[s.value] || "") + " · cited by " + s.usedBy.join(", ")]);
  for (const p of night.pull)
    idx.push([
      "Decision",
      `${p.product_name} · ${p.action_id}`,
      `${p.status} at ${typeof p.confidence === "number" ? p.confidence.toFixed(2) : "no confidence"} · ${hh(p.minute ?? 0)}`,
    ]);
  for (const e of night.escalations) idx.push(["Escalation", e.action_id, `${e.reason} · ${hh(e.minute ?? 0)}`]);
  for (const m of night.memory) idx.push(["Memory", `${m.action} ${m.target}`, `${m.verdict || "no verdict"} · real time ${wallClock(m.ts)}`]);
  for (const e of night.events)
    idx.push([
      "Crew activity",
      `${e.agent} · ${e.action} → ${e.target}`,
      `${e.verdict || "no verdict"}${typeof e.confidence === "number" ? " · confidence " + e.confidence : ""} · ${hh(e.minute)} (real time ${wallClock(e.ts)})`,
    ]);
  return idx;
}

function runSearch() {
  const q = $("query").value.trim().toLowerCase();
  const all = searchIndex();
  const hits = (q ? all.filter((x) => (x[1] + " " + x[2]).toLowerCase().includes(q)) : all).slice(0, 24);
  $("results").innerHTML = hits.length
    ? hits.map((x, i) => `<li class="reveal" style="--i:${Math.min(i, 8)}"><span class="kind">${esc(x[0])}</span><span class="head">${esc(x[1])}</span><span class="body">${esc(x[2])}</span></li>`).join("")
    : `<li><span class="emptyResult">Nothing in this night matched “${esc($("query").value)}”.</span></li>`;
}

function renderLimits() {
  const notes = [
    "Sample mode runs the deterministic offline backend. It is rule evaluation over cached payloads, not a hosted model; every result states which backend produced it.",
    "The shift clock is event order compressed onto 22:00–06:00. The trace timestamps are real execution times and are shown on every log row; the pipeline does not record per-event shift times.",
    "A recorded trace does not carry the run document. Nights replayed from logs/ therefore show the pull list, evidence facets and counterfactuals only where the trace itself records them.",
    "Engine conformance is shown only when the run output carries it. When it does not, the status strip says so instead of scoring the run.",
    "Scenario fields not present in the run output — brand, distribution, raw complaint text, prior memory trust — cannot be displayed here, so they are not displayed.",
    "This interface is a view over the run output. The same result comes from npm run shift -- --scenario <file> with no browser open.",
  ];
  $("limitsList").innerHTML = notes.map((x) => `<li>${esc(x)}</li>`).join("");
  $("contract").textContent = JSON.stringify(
    {
      run_id: night.runId,
      scenario_id: night.scenarioId,
      reasoning_backend: night.backend,
      sample_mode: night.sampleMode,
      stats: night.stats,
      log_path: night.file,
      pull_list: night.doc ? night.doc.pull_list : "not persisted for this night",
      escalations: night.escalations,
      trace_events: night.events.length,
    },
    null,
    1
  );
}

function renderLog(minute, rebuild) {
  const ol = $("log");
  const upto = night.events.filter((e) => e.minute <= minute);
  if (rebuild) {
    ol.textContent = "";
    renderLog.count = 0;
  }
  for (; renderLog.count < upto.length; renderLog.count++) {
    const e = upto[renderLog.count];
    const li = document.createElement("li");
    const verdictClass = e.verdict === "reject" || e.verdict === "rework" || e.verdict === "escalated" ? "rej" : e.verdict ? "okk" : "";
    li.innerHTML =
      `<time title="real execution time" datetime="${esc(e.ts || "")}">${esc(hh(e.minute))}</time>` +
      `<span class="ag">${esc(e.agent)}</span> · ${esc(e.action)} → ${esc(e.target)}` +
      (typeof e.confidence === "number" ? ` · ${esc(e.confidence.toFixed(4))}` : "") +
      (e.verdict ? ` <span class="${verdictClass}">${esc(e.verdict)}</span>` : "") +
      (e.detail ? `<br><time>${esc(wallClock(e.ts))}</time><span class="mono">${esc(JSON.stringify(e.detail))}</span>` : "");
    if (!RM && renderLog.count === upto.length - 1) li.classList.add("flipIn");
    ol.prepend(li);
    while (ol.children.length > 60) ol.lastChild.remove();
  }
  $("logCount").textContent = `${upto.length} of ${night.events.length} events`;
}
renderLog.count = 0;

function renderRail() {
  const hours = [];
  for (let m = 0; m <= SHIFT_MIN; m += 120) hours.push(`<span>${esc(hh(m))}</span>`);
  $("railHours").innerHTML = hours.join("");
  $("railMarks").innerHTML = night.events
    .map((e, i) => {
      const cls = e.verdict === "reject" || e.verdict === "rework" || e.verdict === "escalated" ? "rust" : e.verdict === "auto_action" || e.verdict === "hit" ? "acc" : "";
      const label = `${e.agent} · ${e.action} → ${e.target}${typeof e.confidence === "number" ? " · " + e.confidence : ""}${e.verdict ? " · " + e.verdict : ""}`;
      return `<button class="mark ${cls}" type="button" style="left:${(e.minute / SHIFT_MIN) * 100}%" data-min="${e.minute}" title="${esc(label)}" aria-label="${esc(hh(e.minute) + " " + label)}"><i></i></button>`;
    })
    .join("");
  $("railMarks")
    .querySelectorAll(".mark")
    .forEach((b) =>
      b.addEventListener("click", () => {
        setMinute(Number(b.dataset.min));
      })
    );
}

function renderCrewRows() {
  $("crew").innerHTML = AGENTS.map(
    (a, i) =>
      `<button class="crewRow reveal" type="button" role="listitem" data-agent="${esc(a.id)}" style="--i:${i}">
     <span class="dot" style="background:${esc(hexNum(a.color))}"></span>
     <span><b>${esc(a.id)}</b><small>${esc(a.role)}</small><em>on the way in</em></span>
   </button>`
  ).join("");
  $("crew")
    .querySelectorAll(".crewRow")
    .forEach((b) =>
      b.addEventListener("click", () => {
        const a = AGENTS.find((x) => x.id === b.dataset.agent);
        setFocus(focus === a ? null : a);
      })
    );
}

/* ── three.js scene ──────────────────────────────────────────────────── */

let renderer = null,
  scene = null,
  camera = null,
  controls = null,
  hemi = null,
  sun = null,
  gl = false;
let cardsGroup = null,
  board = null,
  bctx = null,
  btex = null,
  sheet = null,
  stex = null,
  sctx = null,
  ledMesh = null,
  blink = () => {},
  pullLabel = null,
  cardSlots = [],
  warmPlanes = [];
const crewObjs = [];
let palletPool = [],
  slipPool = [],
  ringMesh = null;
let T = window.THREE;
let pickTargets = [];

const SB = [],
  GB = [],
  LED = [];
const GLASS = { transparent: true, opacity: 0.2 };
const SLIP_MAX = 6;

function colorize(g, c) {
  const k = new T.Color(c);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = k.r;
    a[i * 3 + 1] = k.g;
    a[i * 3 + 2] = k.b;
  }
  g.setAttribute("color", new T.BufferAttribute(a, 3));
  return g;
}

function mergeGeos(list) {
  let nv = 0,
    ni = 0;
  for (const g of list) {
    nv += g.attributes.position.count;
    ni += g.index.count;
  }
  const pos = new Float32Array(nv * 3),
    nor = new Float32Array(nv * 3),
    col = new Float32Array(nv * 3),
    idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
  let vo = 0,
    io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + vo;
    vo += g.attributes.position.count;
    io += ix.length;
  }
  const m = new T.BufferGeometry();
  m.setAttribute("position", new T.BufferAttribute(pos, 3));
  m.setAttribute("normal", new T.BufferAttribute(nor, 3));
  m.setAttribute("color", new T.BufferAttribute(col, 3));
  m.setIndex(new T.BufferAttribute(idx, 1));
  return m;
}

function buildScene() {
  try {
    if (!T || !T.OrbitControls) throw new Error("no three.js");
    renderer = new T.WebGLRenderer({ canvas: $("scene"), antialias: false, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFShadowMap;
  } catch (err) {
    gl = false;
    buildShim();
    return;
  }
  gl = true;
  scene = new T.Scene();
  camera = new T.PerspectiveCamera(40, 1, 0.1, 300);
  camera.position.set(25, 21, 31);
  controls = new T.OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, enableZoom: true, maxPolarAngle: 1.45, minDistance: 8, maxDistance: 60, autoRotate: false, autoRotateSpeed: 0.5 });
  controls.target.set(0, 1, 4);
  if (controls.listenToKeyEvents) controls.listenToKeyEvents(renderer.domElement);
  renderer.domElement.style.touchAction = "pan-y";

  hemi = new T.HemisphereLight(0xcfe3ff, 0x6a5a48, 0.6);
  sun = new T.DirectionalLight(0xffffff, 1);
  scene.add(hemi, sun);
  sun.position.set(12, 22, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 28, bottom: -18, far: 80 });
  sun.shadow.camera.updateProjectionMatrix();

  const mat = (c, o) => new T.MeshLambertMaterial(Object.assign({ color: c }, o));
  const box = (w, h, d, c, x, y, z, o, dyn) => {
    if (!dyn && (!o || o === GLASS || o.emissiveIntensity <= 0.05)) {
      const g = new T.BoxGeometry(w, h, d);
      g.translate(x, y + h / 2, z);
      colorize(g, c);
      (o === GLASS ? GB : SB).push(g);
      return null;
    }
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat(c, o));
    m.position.set(x, y + h / 2, z);
    m.castShadow = !o || !!dyn;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  const wl = (x0, z0, x1, z1, h, y, c, o) => box(Math.abs(x1 - x0) || 0.16, h, Math.abs(z1 - z0) || 0.16, c, (x0 + x1) / 2, y, (z0 + z1) / 2, o);
  const gw = (x0, z0, x1, z1) => {
    wl(x0, z0, x1, z1, 0.5, 0.2, 0xf3f5f6);
    wl(x0, z0, x1, z1, 1.9, 0.7, 0x9fd3e6, GLASS);
  };
  const zn = (x0, x1, z0, z1, c) => box(x1 - x0, 0.03, z1 - z0, c, (x0 + x1) / 2, 0.2, (z0 + z1) / 2);
  const sign = (txt, x, y, z) => {
    const k = document.createElement("canvas");
    k.width = 256;
    k.height = 64;
    const g = k.getContext("2d");
    g.fillStyle = "rgba(16,32,43,.9)";
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = "#e8f1f5";
    g.font = "bold 26px monospace";
    g.textAlign = "center";
    g.fillText(txt, 128, 42);
    const s = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(k) }));
    s.scale.set(3.2, 0.8, 1);
    s.position.set(x, y, z);
    scene.add(s);
  };

  box(32, 0.8, 22, 0x18262f, 0, -0.8, 0);
  box(30, 0.1, 20, 0x2f6f58, 0, -0.1, 0);
  box(28, 0.2, 18, 0xdde4e8, 0, 0, 0);
  box(32, 0.8, 9, 0x18262f, 0, -0.8, 15.5);
  box(30, 0.1, 10, 0x2c353d, 0, -0.1, 15);
  box(12, 0.8, 4, 0x18262f, 22, -0.8, 17.6);
  box(12, 0.1, 4, 0x2c353d, 22, -0.1, 17.6);
  box(2, 0.05, 4, 0xb9c1c7, 2, 0, 10);
  for (const [x, z] of [[-15.2, -7], [-15.2, 0], [-15.2, 6], [15.3, -8], [15.3, 8], [-9, 9.4], [-7, -9.9], [10, -9.9], [0, -9.9]]) {
    box(0.3, 0.8, 0.3, 0x5b4632, x, 0, z);
    const c = new T.ConeGeometry(1.1, 2.6, 7);
    c.translate(x, 1.9, z);
    colorize(c, 0x2f8f62);
    SB.push(c);
  }
  [[-14, -8.4, -9, -3.5, 0xc8a679], [-6, 1, -9, -4, 0x9fb0be], [3, 8, -9, -4, 0x44525d], [10, 14, -2, 9, 0xaab3ba], [-14, -8.4, 3.5, 9, 0xe8dcc4], [4.6, 9.4, 5.6, 9, 0xd7c8b0], [8.1, 9.5, -1.7, -1, 0xcfd6db]].forEach((z) => zn(z[0], z[1], z[2], z[3], z[4]));
  zn(10, 10.15, -2, 9, 0xe0b030);
  zn(1, 3, 8, 9, 0x3a4650);
  [-5, -1, 5, 9].forEach((x) => {
    box(0.08, 0.02, 3.8, 0xf3f5f6, x - 2, 0, 14.4);
    box(0.08, 0.02, 3.8, 0xf3f5f6, x + 2, 0, 14.4);
  });
  gw(-14, -9, 14, -9);
  gw(-14, -9, -14, 9);
  wl(-14, 9, 1, 9, 0.5, 0.2, 0xf3f5f6);
  wl(3, 9, 14, 9, 0.5, 0.2, 0xf3f5f6);
  wl(14, -9, 14, 9, 0.5, 0.2, 0xf3f5f6);
  gw(-8.4, -9, -8.4, -5);
  gw(-8.4, -4, -8.4, -3.5);
  gw(-14, -3.5, -8.4, -3.5);
  gw(-6, -9, -6, -4);
  gw(1, -9, 1, -4);
  gw(-6, -4, -3.5, -4);
  gw(-1.5, -4, 1, -4);
  gw(3, -9, 3, -4);
  gw(8, -9, 8, -4);
  gw(3, -4, 4.5, -4);
  gw(6.5, -4, 8, -4);
  [["Director", -11.2, 3.3, -6], ["Evidence room", -2.5, 3.3, -6.6], ["Records & memory", 5.5, 3.3, -6.6], ["Whiteboard", 2, 3.3, -6.6], ["Print & labels", 8.8, 2.7, -1.4], ["Reception", 6.8, 2.7, 7], ["Cold storage", 12.4, 3.8, 2.5], ["Break area", -11.2, 2.7, 6], ["Crew pods", -1, 2.7, 2], ["Staff parking", -6, 2.4, 19]].forEach((a) => sign(...a));

  const screens = [];
  const podBuild = (cx, cz, lit) => {
    box(4.4, 0.1, 1.8, 0xeef1f3, cx, 0.85, cz);
    box(0.1, 0.85, 1.6, 0x93a1ab, cx - 2, 0.2, cz);
    box(0.1, 0.85, 1.6, 0x93a1ab, cx + 2, 0.2, cz);
    box(4.2, 0.18, 0.04, 0xb8c3cb, cx, 0.95, cz);
    [-1.1, 1.1].forEach((dx) =>
      [-1, 1].forEach((s) => {
        if (lit) screens.push(box(0.9, 0.55, 0.05, 0x1b252d, cx + dx, 1.0, cz + s * 0.5, { emissive: 0x3a8fd6, emissiveIntensity: 0.4 }));
        else box(0.9, 0.55, 0.05, 0x1b252d, cx + dx, 1.0, cz + s * 0.5);
        box(0.7, 0.1, 0.7, 0x3d4b56, cx + dx, 0.35, cz + s * 1.85);
        box(0.7, 0.6, 0.1, 0x3d4b56, cx + dx, 0.45, cz + s * 2.2);
      })
    );
  };
  podBuild(-1, 2, true);
  podBuild(5, 2, false);

  box(2.8, 0.9, 1, 0xb08a60, -11.2, 0.2, -5.2);
  box(0.7, 0.1, 0.7, 0x3d4b56, -11.2, 0.35, -6.7);
  box(2.4, 0.5, 0.9, 0x5d7a8a, -12.6, 0.2, -4.2);
  const table = new T.CylinderGeometry(1.6, 1.6, 0.12, 24);
  table.translate(-2.5, 1.1, -6.6);
  colorize(table, 0xf3f5f6);
  SB.push(table);
  box(0.5, 0.9, 0.5, 0x3d4b56, -2.5, 0.2, -6.6);

  cardsGroup = new T.Group();
  cardsGroup.position.set(-2.5, 2.6, -6.6);
  scene.add(cardsGroup);
  const cardCols = ["#d9534f", "#e0a43a", "#8a63d2", "#3a8fd6"];
  cardSlots = [];
  for (let i = 0; i < 4; i++) {
    const k = document.createElement("canvas");
    k.width = 256;
    k.height = 160;
    const g = k.getContext("2d");
    const texture = new T.CanvasTexture(k);
    const m = new T.Mesh(new T.PlaneGeometry(1.1, 0.69), new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide }));
    const a = (i * D) / 2;
    m.position.set(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95);
    m.rotation.y = -a + D / 2;
    cardsGroup.add(m);
    cardSlots.push({ g, texture, colour: cardCols[i] });
  }
  refreshCards();

  [3.9, 5.1, 6.3, 7.2].forEach((x) => {
    box(0.9, 2.3, 0.9, 0x2a3640, x, 0.2, -8.4);
    for (let i = 0; i < 5; i++) {
      const g = new T.BoxGeometry(0.5, 0.05, 0.03);
      g.translate(x, 0.7 + i * 0.38 + 0.025, -7.93);
      colorize(g, 0x4fd1b0);
      LED.push(g);
    }
  });
  box(3, 0.9, 0.8, 0xb8c3cb, -11.5, 0.2, 8.4);
  box(0.4, 0.5, 0.4, 0x1b252d, -11.8, 1.1, 8.4);
  box(0.8, 1.9, 0.8, 0xe8edf0, -13.4, 0.2, 8.4);
  box(0.9, 0.5, 2.2, 0x8a63d2, -13.3, 0.2, 5);
  box(0.2, 0.9, 2.2, 0x8a63d2, -13.8, 0.2, 5);
  box(1.2, 0.7, 1.2, 0xc9a77c, -10.8, 0.2, 5.2);

  const rackSlots = [];
  [-0.5, 1.8, 4.1, 6.4].forEach((z) => {
    box(0.08, 2.5, 1.6, 0x6c7a85, 11.7, 0.2, z);
    box(0.08, 2.5, 1.6, 0x6c7a85, 13.1, 0.2, z);
    for (let l = 0; l < 3; l++) {
      box(1.4, 0.08, 1.6, 0x93a1ab, 12.4, 0.5 + l * 0.8, z);
      rackSlots.push([12.4, 0.58 + l * 0.8, z]);
    }
  });

  box(3, 0.9, 0.8, 0xb08a60, 6.8, 0.2, 7);
  box(0.8, 0.5, 0.6, 0x3d4b56, 6.8, 0.35, 8.6);
  box(1.4, 0.9, 0.7, 0xdfe5e9, 8.8, 0.2, -1.35);
  box(1.2, 0.08, 0.5, 0x3d4b56, 8.8, 1.1, -1.35);
  box(2.1, 1.5, 0.08, 0xf3f5f6, 2, 1.15, -8.9);
  {
    const k = document.createElement("canvas");
    k.width = 512;
    k.height = 360;
    bctx = k.getContext("2d");
    btex = new T.CanvasTexture(k);
    board = new T.Mesh(new T.PlaneGeometry(1.95, 1.37), new T.MeshBasicMaterial({ map: btex }));
    board.position.set(2, 1.9, -8.84);
    scene.add(board);
  }
  {
    const k = document.createElement("canvas");
    k.width = 256;
    k.height = 320;
    sctx = k.getContext("2d");
    stex = new T.CanvasTexture(k);
    sheet = new T.Mesh(new T.PlaneGeometry(0.7, 0.9), new T.MeshBasicMaterial({ map: stex, side: T.DoubleSide }));
    sheet.rotation.x = -D / 2;
    sheet.position.set(8.8, 1.17, -1.35);
    sheet.visible = false;
    scene.add(sheet);
  }

  palletPool = rackSlots.map((slot, i) => {
    const m = new T.Mesh(new T.BoxGeometry(1.1, 0.5, 1.1), mat([0xd9b27c, 0xc99a5f, 0xe3c79a][i % 3]));
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.slot = slot;
    m.position.set(slot[0], slot[1] + 0.25, slot[2]);
    scene.add(m);
    return m;
  });
  slipPool = [];
  for (let i = 0; i < SLIP_MAX; i++) {
    const m = new T.Mesh(new T.BoxGeometry(0.4, 0.04, 0.3), mat(0xb4320c));
    m.position.set(6.2 + i * 0.28, 1.16, 7);
    m.visible = false;
    scene.add(m);
    slipPool.push(m);
  }
  pullLabel = box(0.5, 0.02, 0.35, 0x0f9f7c, 11.4, 1.4, 5.6, undefined, true);
  pullLabel.visible = false;

  ringMesh = new T.Mesh(new T.CylinderGeometry(0.9, 0.9, 0.03, 18), new T.MeshBasicMaterial({ color: 0x5fd6e8, transparent: true, opacity: 0.5 }));
  ringMesh.visible = false;
  scene.add(ringMesh);

  {
    const wm = new T.Mesh(
      mergeGeos(
        [[-11.2, -6, 6, 5.5], [-2.5, -6.5, 7, 5], [5.5, -6.5, 5, 5], [-1, 2, 8, 5.5], [6.8, 7.2, 5, 3.5], [-11, 6, 6, 5.5], [8.8, -1.4, 3, 2.5]].map((w) => {
          const g = new T.PlaneGeometry(w[2], w[3]);
          g.rotateX(-D / 2);
          g.translate(w[0], 0.25, w[1]);
          colorize(g, 0xffffff);
          return g;
        })
      ),
      new T.MeshBasicMaterial({ color: 0xffb45e, transparent: true, opacity: 0.3, blending: T.AdditiveBlending, depthWrite: false })
    );
    scene.add(wm);
    warmPlanes.push(wm);
  }
  {
    const stat = new T.Mesh(mergeGeos(SB), new T.MeshLambertMaterial({ vertexColors: true }));
    stat.castShadow = true;
    stat.receiveShadow = true;
    scene.add(stat);
    const glass = new T.Mesh(mergeGeos(GB), new T.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.2, depthWrite: false }));
    scene.add(glass);
    ledMesh = new T.Mesh(mergeGeos(LED), new T.MeshBasicMaterial({ vertexColors: true }));
    scene.add(ledMesh);
    blink = () => {
      const c = ledMesh.geometry.attributes.color;
      for (let i = 0; i < LED.length; i++) {
        const on = Math.random() > 0.4;
        for (let v = 0; v < 24; v++) c.setXYZ(i * 24 + v, on ? 0.31 : 0.05, on ? 0.82 : 0.1, on ? 0.69 : 0.09);
      }
      c.needsUpdate = true;
    };
  }

  const car = (c) => {
    const ps = [];
    const bx = (w, h, d, col, x, y, z) => {
      const q = new T.BoxGeometry(w, h, d);
      q.translate(x, y, z);
      colorize(q, col);
      ps.push(q);
    };
    bx(1.9, 0.55, 3.6, c, 0, 0.55, 0);
    bx(1.6, 0.5, 1.8, 0x9fd3e6, 0, 1.05, -0.2);
    bx(0.4, 0.15, 0.05, 0xfff3c0, -0.6, 0.6, 1.8);
    bx(0.4, 0.15, 0.05, 0xfff3c0, 0.6, 0.6, 1.8);
    [[-0.95, 1.2], [0.95, 1.2], [-0.95, -1.2], [0.95, -1.2]].forEach((p) => {
      const w = new T.CylinderGeometry(0.33, 0.33, 0.25, 10);
      w.rotateZ(D / 2);
      w.translate(p[0], 0.33, p[1]);
      colorize(w, 0x111111);
      ps.push(w);
    });
    const g = new T.Group();
    const q = new T.Mesh(mergeGeos(ps), new T.MeshLambertMaterial({ vertexColors: true }));
    q.castShadow = true;
    g.add(q);
    scene.add(g);
    return g;
  };

  const person = (c, hair, skin) => {
    const g = new T.Group();
    const ps = [];
    const pt = (geo, col, x, y, z) => {
      geo.translate(x, y, z);
      colorize(geo, col);
      ps.push(geo);
    };
    pt(new T.CylinderGeometry(0.3, 0.36, 0.85, 10), c, 0, 0.9, 0);
    pt(new T.SphereGeometry(0.27, 10, 8), skin, 0, 1.58, 0);
    pt(new T.SphereGeometry(0.29, 10, 6, 0, 2 * D, 0, D * 0.55), hair, 0, 1.6, -0.02);
    const torso = new T.Mesh(mergeGeos(ps), new T.MeshLambertMaterial({ vertexColors: true }));
    torso.castShadow = true;
    g.add(torso);
    const limb = (x, y, w, h, col) => {
      const q = new T.Group();
      q.position.set(x, y, 0);
      const m = new T.Mesh(new T.BoxGeometry(w, h, w), mat(col));
      m.position.y = -h / 2;
      q.add(m);
      g.add(q);
      return q;
    };
    const doc = new T.Mesh(new T.BoxGeometry(0.4, 0.05, 0.3), mat(0xffffff));
    doc.position.set(0, 1.0, 0.5);
    doc.visible = false;
    g.add(doc);
    scene.add(g);
    return { g, torso, doc, lL: limb(-0.14, 0.45, 0.16, 0.45, 0x2a3640), lR: limb(0.14, 0.45, 0.16, 0.45, 0x2a3640), aL: limb(-0.4, 1.25, 0.13, 0.6, c), aR: limb(0.4, 1.25, 0.13, 0.6, c) };
  };

  crewObjs.length = 0;
  AGENTS.forEach((a, i) => {
    initActor(a, person(a.color, a.hair, a.skin), car(a.color));
    if (screens[i]) a.screen = screens[i];
  });
  pickTargets = crewObjs.map((a) => a.torso);
}

function initActor(a, body, carGroup) {
  Object.assign(a, body, {
    tagEl: makeTag(a.id, a.color),
    bayX: a.bay,
    car: carGroup,
    k: -2,
    v: 0,
    spot: a.home,
    st: "pre",
    arrived: false,
    out: false,
    sit: false,
  });
  a.torso.userData.agent = a.id;
  crewObjs.push(a);
}

const vec3 = (x, y, z) => ({
  x,
  y,
  z,
  set(a, b, c) {
    this.x = a;
    this.y = b;
    this.z = c;
  },
});

/* No WebGL, no three.js: the same actors exist as coordinate holders so the
   floor plan, the crew panel and every list keep working. */
function buildShim() {
  crewObjs.length = 0;
  const stubPerson = () => ({
    g: { position: vec3(0, 0.2, 0), rotation: { y: 0 }, visible: false },
    torso: { userData: {}, parent: { visible: true }, position: vec3(0, 0, 0) },
    doc: { visible: false },
    lL: { rotation: { x: 0 } },
    lR: { rotation: { x: 0 } },
    aL: { rotation: { x: 0 } },
    aR: { rotation: { x: 0 } },
  });
  const stubCar = () => ({ position: vec3(26, 0, 17.6), rotation: { y: -D / 2 } });
  AGENTS.forEach((a) => initActor(a, stubPerson(), stubCar()));
  pickTargets = [];
}

function makeTag(name, color) {
  const el = document.createElement("div");
  el.className = "tag";
  el.innerHTML = `<b style="background:${hexNum(color)}">${esc(name)}</b><p></p>`;
  $("tags").appendChild(el);
  return el;
}

function say(obj, text) {
  const p = obj.tagEl.querySelector("p");
  p.textContent = text || "";
  p.style.display = text ? "block" : "none";
}

/* ── scene state application ─────────────────────────────────────────── */

let t = 0,
  paused = false,
  spd = 1,
  ho = false,
  hold = 0,
  focus = null,
  mode = "3d",
  vis = true,
  autoRotate = false,
  arrived = false;
let lastPlanSig = null,
  lastSheetState = null;

function refreshCards() {
  if (!gl || !cardSlots.length) return;
  const counts = {};
  for (const s of night.sourceRecords) {
    const label = KIND_LABEL[s.kind] || s.kind;
    counts[label] = (counts[label] || 0) + 1;
  }
  const kinds = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, cardSlots.length);
  cardSlots.forEach((slot, i) => {
    const g = slot.g;
    const entry = kinds[i];
    g.fillStyle = "#f7f9fa";
    g.fillRect(0, 0, 256, 160);
    g.fillStyle = slot.colour;
    g.fillRect(0, 0, 256, 26);
    g.fillStyle = "#10202b";
    g.font = "bold 22px monospace";
    g.textAlign = "center";
    g.fillText(entry ? entry[0] : "no facet", 128, 78);
    g.fillStyle = "#5c6873";
    g.font = "18px monospace";
    g.fillText(entry ? `${entry[1]} records` : "nothing cited", 128, 112);
    slot.texture.needsUpdate = true;
  });
}

function drawBoard(plan, state) {
  const g = bctx;
  g.fillStyle = "#f7f9fa";
  g.fillRect(0, 0, 512, 360);
  g.fillStyle = "#10202b";
  g.font = "bold 24px monospace";
  g.fillText("Tonight's plan", 20, 34);
  g.font = "18px monospace";
  plan.forEach((p, i) => {
    const y = 74 + i * 36;
    if (y > 348) return;
    g.fillStyle = p.flag ? "#b4320c" : state[i] === "next" ? "#8a939b" : state[i] === "now" ? "#0f6f5c" : "#101418";
    g.fillText((state[i] === "done" || state[i] === "now" ? "[x] " : "[ ] ") + (i + 1) + ". " + p.text.slice(0, 44), 20, y);
    if (state[i] === "now") {
      g.fillStyle = "#5fd6e8";
      g.fillRect(12, y - 14, 4, 18);
    }
  });
  btex.needsUpdate = true;
}

function drawSheet() {
  const g = sctx;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 256, 320);
  g.fillStyle = "#101418";
  g.font = "bold 17px monospace";
  g.fillText("Pull list", 12, 24);
  g.font = "12px monospace";
  night.pull.slice(0, 9).forEach((p, i) => g.fillText(`${i + 1}. ${String(p.product_name).slice(0, 26)} ${typeof p.confidence === "number" ? p.confidence.toFixed(2) : ""}`, 12, 54 + i * 26));
  g.fillStyle = "#5c6873";
  g.fillText(`${night.pull.length} actions · ${night.escalations.length} escalated`, 12, 296);
  stex.needsUpdate = true;
}

function applyScene(s) {
  if (!gl) return;
  const k = s.min / SHIFT_MIN;
  scene.background = new T.Color(0x0b1220).lerp(new T.Color(0xbfdcea), k);
  hemi.intensity = 0.35 + 0.45 * k;
  sun.intensity = 0.2 + 0.9 * k;
  sun.color.setRGB(0.7 + 0.3 * k, 0.78 + 0.22 * k, 0.75 + 0.25 * k);
  warmPlanes.forEach((w) => (w.material.opacity = 0.32 * (1 - k)));

  const plan = buildPlan();
  if (s.planSignature !== lastPlanSig) {
    lastPlanSig = s.planSignature;
    drawBoard(plan, s.planState);
  }

  palletPool.forEach((m, i) => {
    const [sx, sy, sz] = m.userData.slot;
    const p = s.pallets[i];
    if (!p) {
      m.position.set(sx, sy + 0.25, sz);
      m.rotation.y = 0;
      return;
    }
    const gx = 11.4,
      gz = 4.6 + (i % 3) * 1.15;
    m.position.set(sx + (gx - sx) * p.prog, sy + 0.25 - 0.05 * p.prog + Math.sin(p.prog * D) * 0.3, sz + (gz - sz) * p.prog);
    m.rotation.y = p.prog * 0.4;
  });
  const staged = Math.min(s.pallets.length, palletPool.length);
  pullLabel.visible = s.printed && staged > 0;
  pullLabel.position.set(11.4, 1.05, 4.2);

  slipPool.forEach((m, i) => {
    const p = s.slips[i];
    m.visible = !!p;
    if (p) {
      m.rotation.y = -D / 2 + p.prog * D / 2;
      m.position.y = 1.16 + Math.sin(p.prog * D) * 0.12;
    }
  });

  sheet.visible = s.printed;
  const travel = s.handover ? 1 : 0;
  if (sheet.visible) sheet.position.set(8.8 - 2 * travel, 1.17 - 0.05 * travel, -1.35 + 8.35 * travel);
  if (lastSheetState !== s.printed) {
    lastSheetState = s.printed;
    drawSheet();
  }

  const meeting = Object.entries(s.occupancy).find(([, n]) => n > 1);
  if (meeting && PLACES[meeting[0]]) {
    const [x, z] = PLACES[meeting[0]].p;
    ringMesh.visible = true;
    ringMesh.position.set(x, 0.27, z);
  } else ringMesh.visible = false;
}

function applyPanels(s) {
  $("clock").textContent = s.clock;
  $("scrub").value = String(Math.round(s.min));
  $("railProgress").style.transform = `scaleX(${(s.min / SHIFT_MIN).toFixed(4)})`;
  $("floorLine").textContent = s.floorText;
  $("floorLine").classList.toggle("low", s.counts.esc > 0);
  for (const a of crewObjs) {
    const st = s.perAgent[a.id];
    const txt = st.event ? `${st.event.action} → ${st.event.target}` : "waiting at the desk";
    if (!a.rowEl || !a.rowEl.isConnected) a.rowEl = document.querySelector(`.crewRow[data-agent="${a.id}"]`);
    if (a.rowEl) {
      a.rowEl.querySelector("em").textContent = txt;
      a.rowEl.classList.toggle("busy", !!st.event);
    }
    say(a, txt + (typeof st.event?.confidence === "number" ? " · " + st.event.confidence.toFixed(2) : ""));
  }
  const capped = gl && palletPool.length && s.pallets.length > palletPool.length;
  $("viewNote").textContent = s.handover
    ? `06:00 — shift closed. ${dash(night.stats.actions_out, "—")} actions, ${dash(night.stats.escalation_count, "—")} escalations on the desk.` +
      (capped ? ` Only ${palletPool.length} of ${s.pallets.length} staged pallets fit the rack face.`
        : "")
    : `${s.clock} — ${Object.values(s.perAgent).filter((x) => x.event).length} of 4 crew acting on the trace` +
      (capped ? ` · rack face shows ${palletPool.length} of ${s.pallets.length} staged pallets` : "");
}

function poseAt(a, s, min) {
  const st = s.perAgent[a.id];
  const place = PLACES[st.place] || PLACES[a.home];
  a.k = st.k;
  a.cur = st.place;
  a.spot = st.place;
  a.q = [];
  a.sit = /^desk/.test(st.place);
  a.g.visible = true;
  a.g.position.set(place.p[0], a.sit ? 0.05 : 0.2, place.p[1]);
  a.g.rotation.y = place.f;
  a.face = place.f;
  a.doc.visible = !a.sit;
  a.st = "work";
  a.v = 0;
  a.lL.rotation.x = a.lR.rotation.x = a.sit ? -1.5 : 0;
  a.aL.rotation.x = a.aR.rotation.x = a.sit ? -1.2 : 0;
  a.car.position.set(a.bayX, 0, 14.4);
  a.car.rotation.y = D;
  a.cq = [];
  a.out = false;
  a.arrived = true;
}

function resetCar(a) {
  a.car.position.set(26, 0, 17.6);
  a.car.rotation.y = -D / 2;
  a.cq = [[a.bayX, 17.6], [a.bayX, 14.4]];
  a.st = "pre";
  a.dl = crewObjs.indexOf(a) * 3;
  a.g.visible = false;
  a.cur = "ent";
  a.k = -2;
  a.out = false;
  a.v = 0;
  a.arrived = false;
  a.q = [];
  say(a, "");
  if (RM) {
    a.car.position.set(a.bayX, 0, 14.4);
    a.car.rotation.y = D;
    a.st = "park";
    a.cw = 0.05;
  }
}

function poseHandoverLeave() {
  crewObjs.forEach((a) => {
    a.st = "gone";
    a.g.visible = false;
    a.q = [];
    a.cq = [];
    a.car.position.set(a.bayX, 0, 14.4);
    say(a, "");
  });
  arrived = true;
}

function setMinute(m) {
  t = Math.min(1, Math.max(0, m / SHIFT_MIN));
  const min = t * SHIFT_MIN;
  const s = derived(min);
  paused = true;
  $("btnPlay").textContent = "Resume";
  ho = false;
  hold = 0;
  $("fade").style.opacity = "0";
  if (s.handover) {
    ho = true;
    poseHandoverLeave();
  } else {
    crewObjs.forEach((a) => poseAt(a, s, min));
  }
  arrived = true;
  applyScene(s);
  applyPanels(s);
  renderLog(min, true);
  paint();
  return s;
}

function replay() {
  t = 0;
  ho = false;
  hold = 0;
  paused = false;
  arrived = false;
  $("fade").style.opacity = "0";
  $("btnPlay").textContent = "Pause";
  crewObjs.forEach(resetCar);
  const s = derived(0);
  applyScene(s);
  applyPanels(s);
  renderLog(0, true);
  paint();
}

/* ── animation loop, controls, perf ─────────────────────────────────── */

function swing(o, w) {
  o.lL.rotation.x = w * 0.7;
  o.lR.rotation.x = -w * 0.7;
  o.aL.rotation.x = -w * 0.5;
  o.aR.rotation.x = w * 0.5;
}
function drive(o, dt, sd) {
  const q = o.cq[0];
  if (!q) return true;
  const c = o.car;
  const dx = q[0] - c.position.x,
    dz = q[1] - c.position.z,
    dist = Math.hypot(dx, dz);
  if (dist < 0.15) o.cq.shift();
  else if (sd) {
    const v = Math.min(dist, Math.max(1.2, Math.min(7, dist * 1.6)) * dt * sd);
    c.position.x += (dx / dist) * v;
    c.position.z += (dz / dist) * v;
    c.rotation.y += da(c.rotation.y, Math.atan2(dx, dz)) * Math.min(1, dt * 5);
  }
  return false;
}
function walk(o, dt, sd) {
  const q = o.q[0];
  if (!q) {
    o.v = 0;
    return true;
  }
  o.v = o.v || 0;
  const g = o.g;
  const dx = q[0] - g.position.x,
    dz = q[1] - g.position.z,
    dist = Math.hypot(dx, dz);
  if (dist < 0.1) {
    o.q.shift();
    if (!o.q.length) {
      o.v = 0;
      swing(o, 0);
      return true;
    }
    return false;
  }
  if (sd) {
    o.v += (2.4 - o.v) * Math.min(1, dt * 5);
    const v = Math.min(dist, o.v * dt * sd);
    g.position.x += (dx / dist) * v;
    g.position.z += (dz / dist) * v;
    g.rotation.y += da(g.rotation.y, Math.atan2(dx, dz)) * Math.min(1, dt * 8);
    o.ph = (o.ph || 0) + dt * 9 * sd;
    const w = Math.sin(o.ph);
    swing(o, w);
    g.position.y = 0.2 + Math.abs(w) * 0.05;
  }
  return false;
}
function step(a, k) {
  const e = k < 0 ? null : night.events[k];
  const placeId = e ? placeFor(a.id, e) : a.home;
  const from = PLACES[a.cur],
    to = PLACES[placeId];
  a.spot = placeId;
  a.q = !from || from === to ? [] : [...from.v.slice().reverse(), ...to.v, to.p];
  a.st = "move";
  a.g.visible = true;
  a.g.position.y = 0.2;
  a.doc.visible = !/^desk/.test(placeId);
  say(a, "");
  a.cur = placeId;
  if (RM) {
    a.g.position.set(to.p[0], 0.2, to.p[1]);
    a.q = [];
  }
}

let lastNow = 0,
  frameMs = null,
  overBudgetSince = null;
const perf = { calls: 0, tris: 0 };

function stats(ms) {
  const el = $("perf");
  const ft = ms == null ? "n/a" : ms.toFixed(1) + " ms";
  if (mode === "3d" && gl) {
    const info = renderer.info.render;
    perf.calls = info.calls;
    perf.tris = info.triangles;
    el.textContent = `draw calls ${info.calls}/${BUDGET_CALLS} · triangles ${(info.triangles / 1000).toFixed(1)}k · frame ${ft}`;
    el.style.color = info.calls > BUDGET_CALLS || (ms != null && ms > BUDGET_FRAME_MS) ? "#ffb4a2" : "#9fd8e6";
  } else {
    perf.calls = 0;
    perf.tris = 0;
    el.textContent = `2D plan · draw calls n/a · frame ${ft}`;
    el.style.color = "#9fd8e6";
  }
}

function placeTags() {
  const w = $("view").clientWidth,
    h = $("view").clientHeight;
  const project = (obj, ref, lift) => {
    const v = ref.position.clone();
    v.y += lift;
    v.project(camera);
    obj.tagEl.style.display = v.z < 1 ? "block" : "none";
    obj.tagEl.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-100%)`;
  };
  for (const a of crewObjs) {
    if (!a.g.visible && a.st !== "drive" && a.st !== "park" && a.st !== "pre") {
      a.tagEl.style.display = "none";
      continue;
    }
    const useCar = a.st === "pre" || a.st === "drive" || a.st === "park";
    project(a, useCar ? a.car : a.g, useCar ? 1.6 : 2.1);
  }
}

function paint() {
  if (mode === "3d" && gl) {
    placeTags();
    controls.update();
    renderer.render(scene, camera);
  } else if (mode === "2d") draw2d();
}

let sampleFrames = 0,
  sampleAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const real = lastNow ? now - lastNow : 16;
  lastNow = now;
  if (!vis || !night) return;
  sampleFrames++;
  sampleAcc += real;
  if (sampleFrames >= 30) {
    frameMs = sampleAcc / sampleFrames;
    sampleFrames = 0;
    sampleAcc = 0;
    if (mode === "3d" && gl) {
      if (frameMs > 33) {
        if (overBudgetSince === null) overBudgetSince = now;
        else if (now - overBudgetSince > 2000) setMode("2d", true);
      } else overBudgetSince = null;
    }
  }
  const dt = Math.min(real / 1000, 0.05);
  const sd = paused ? 0 : spd;
  const min = t * SHIFT_MIN;
  const s = derived(min);

  if (sd && !ho && arrived && t < 1) t = Math.min(1, t + (dt * sd) / 110);
  if (t >= 1 && !ho) {
    ho = true;
    hold = 14;
    crewObjs.forEach((a) => {
      const to = PLACES[a.spot] || PLACES[a.home];
      a.st = "exit";
      a.q = [...to.v.slice().reverse(), [2, 11.4], [a.bayX + 1.5, 11.4], [a.bayX + 1.5, 14.4]];
      a.sit = false;
      a.g.position.y = 0.2;
      a.doc.visible = false;
      say(a, "");
    });
  }
  if (ho && sd) {
    hold -= dt;
    if (!RM && hold < 2.2) $("fade").style.opacity = "1";
    if (hold <= 0) {
      $("fade").style.opacity = "0";
      replay();
      return;
    }
  }

  applyScene(s);
  applyPanels(s);
  if (!ho) renderLog(min, false);
  if (gl && !RM) {
    cardsGroup.rotation.y += dt * 0.5 * sd;
    if (Math.random() < 0.04) blink();
  }

  for (const a of crewObjs) {
    if (a.st === "pre") {
      if (sd && (a.dl -= dt * sd) <= 0) a.st = "drive";
    } else if (a.st === "drive") {
      if (drive(a, dt, sd)) {
        if (a.out) {
          a.st = "gone";
          a.g.visible = false;
          a.car.position.set(26, 0, 17.6);
        } else {
          a.st = "park";
          a.cw = 1.1;
        }
      }
    } else if (a.st === "park") {
      if (sd && (a.cw -= dt * sd) <= 0) {
        a.g.position.set(a.bayX + 1.5, 0.2, 14);
        a.g.rotation.y = D;
        a.g.visible = true;
        a.cur = "ent";
        a.v = 0;
        const kk = s.perAgent[a.id].k;
        a.k = kk;
        step(a, kk);
        a.q = [[a.bayX + 1.5, 11.4], [2, 11.4], ...a.q];
        a.arrived = true;
      }
    } else if (a.st === "exit") {
      if (walk(a, dt, sd)) {
        a.g.visible = false;
        a.st = "drive";
        a.out = true;
        a.cq = [[a.bayX, 17.6], [26, 17.6]];
      }
    } else if (a.st === "move" || a.st === "work") {
      const kk = s.perAgent[a.id].k;
      if (kk !== a.k && !ho) {
        a.k = kk;
        step(a, kk);
      }
      if (a.st === "move") {
        if (walk(a, dt, sd)) {
          a.st = "work";
          a.sit = /^desk/.test(a.spot);
          a.face = (PLACES[a.spot] || PLACES[a.home]).f;
        }
      } else {
        const face = (PLACES[a.spot] || PLACES[a.home]).f;
        a.g.rotation.y += da(a.g.rotation.y, face) * Math.min(1, dt * 6);
        if (a.sit) {
          a.g.position.y = 0.05;
          a.lL.rotation.x = a.lR.rotation.x = -1.5;
          const ty = Math.sin(now / 1000 * 9 + crewObjs.indexOf(a)) * 0.12;
          a.aL.rotation.x = -1.2 + ty;
          a.aR.rotation.x = -1.2 - ty;
        } else {
          a.lL.rotation.x = a.lR.rotation.x = 0;
          a.aL.rotation.x = Math.sin(now / 1000 * 2 + crewObjs.indexOf(a)) * 0.1;
          a.aR.rotation.x = -0.5 + Math.sin(now / 1000 * 3 + crewObjs.indexOf(a)) * 0.3;
        }
        if (a.screen) a.screen.material.emissiveIntensity = a.sit ? 1 : 0.35;
      }
    }
  }
  if (crewObjs.every((a) => a.arrived || a.st === "gone")) arrived = true;

  if (gl && mode === "3d") {
    if (focus && focus.g.visible) {
      const p = focus.g.position;
      controls.target.lerp(new T.Vector3(p.x, 1, p.z), 0.06);
    }
    controls.autoRotate = autoRotate && !paused && !focus;
  }
  paint();
  stats(frameMs);
}

/* ── 2D floor plan ───────────────────────────────────────────────────── */
const NS = "http://www.w3.org/2000/svg";
const planRooms = [
  ["Director", -14, -8.4, -9, -3.5],
  ["Evidence room", -6, 1, -9, -4],
  ["Whiteboard", 1, 3, -9, -4],
  ["Records & memory", 3, 8, -9, -4],
  ["Crew pods", -3.2, 7.2, 0.9, 4.1],
  ["Print", 8.1, 9.5, -1.7, -1],
  ["Cold storage", 10, 14, -2, 9],
  ["Break area", -14, -8.4, 3.5, 9],
  ["Reception", 4.6, 9.4, 5.6, 9],
  ["Staff parking", -10, 12, 12.2, 16.2],
];
function buildPlan2d() {
  const fp = $("plan");
  fp.setAttribute("viewBox", "-15 -10 30 31");
  for (const r of planRooms) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", r[1]);
    rect.setAttribute("y", r[3]);
    rect.setAttribute("width", r[2] - r[1]);
    rect.setAttribute("height", r[4] - r[3]);
    rect.setAttribute("fill", "#16222e");
    rect.setAttribute("stroke", "#2f6f8c");
    rect.setAttribute("stroke-width", "0.08");
    fp.appendChild(rect);
    const tx = document.createElementNS(NS, "text");
    tx.setAttribute("x", r[1] + 0.3);
    tx.setAttribute("y", r[3] + 0.9);
    tx.setAttribute("fill", "#9db0be");
    tx.setAttribute("font-size", "0.8");
    tx.textContent = r[0];
    fp.appendChild(tx);
  }
  for (const a of crewObjs) {
    a.dot = document.createElementNS(NS, "circle");
    a.dot.setAttribute("r", "0.55");
    a.dot.setAttribute("fill", hexNum(a.color));
    a.dot.setAttribute("stroke", "#e6eef3");
    a.dot.setAttribute("stroke-width", "0.08");
    fp.appendChild(a.dot);
    a.lb = document.createElementNS(NS, "text");
    a.lb.setAttribute("fill", "#e6eef3");
    a.lb.setAttribute("font-size", "0.7");
    a.lb.setAttribute("text-anchor", "middle");
    a.lb.textContent = a.id;
    fp.appendChild(a.lb);
  }
}
function draw2d() {
  for (const a of crewObjs) {
    const inCar = a.st === "pre" || a.st === "drive" || a.st === "park" || a.st === "gone";
    const p = inCar ? a.car.position : a.g.position;
    const shown = a.g.visible || (inCar && a.st !== "gone");
    a.dot.style.display = a.lb.style.display = shown ? "" : "none";
    a.dot.setAttribute("cx", p.x);
    a.dot.setAttribute("cy", p.z);
    a.lb.setAttribute("x", p.x);
    a.lb.setAttribute("y", p.z - 0.9);
  }
}

function setMode(m, auto) {
  mode = m === "3d" && !gl ? "2d" : m;
  $("scene").style.display = mode === "3d" ? "block" : "none";
  $("plan").style.display = mode === "2d" ? "block" : "none";
  if (mode === "2d") for (const a of crewObjs) a.tagEl.style.display = "none";
  $("btnView").textContent = "View: " + (mode === "3d" ? "3D" : "2D plan");
  if (auto) {
    $("btnView").textContent += " (auto)";
    $("banner").style.display = "block";
    $("banner").textContent = "Frame time stayed over the 33 ms budget, so the office switched to the 2D floor plan. Every control and panel still works.";
  } else if (!auto) $("banner").style.display = "none";
  if (mode === "2d") buildPlan2dIfNeeded();
  paint();
  stats(frameMs);
}
let plan2dBuilt = false;
function buildPlan2dIfNeeded() {
  if (plan2dBuilt || !crewObjs.length) return;
  buildPlan2d();
  plan2dBuilt = true;
}

function setFocus(a) {
  focus = a;
  for (const c of crewObjs) c.rowEl && c.rowEl.classList.toggle("on", c === focus);
  $("btnUnfollow").textContent = focus ? `Follow: ${focus.id}` : "Follow: none";
}

/* ── sizing with a warm-up frame ─────────────────────────────────────── */
function size() {
  if (!gl) return;
  const v = $("view");
  const w = Math.max(1, v.clientWidth),
    h = Math.max(1, v.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  if (mode === "2d") draw2d();
}

/* ── data loading ────────────────────────────────────────────────────── */
let runsCache = [];

function showEmpty(message) {
  document.body.classList.remove("booting");
  $("empty").hidden = false;
  for (const id of ["office", "shiftband", "pullzone", "memory", "night", "limits"]) $(id).hidden = true;
  if (message) {
    $("emptyEyebrow").textContent = "Cannot read the product";
    $("emptyTitle").textContent = "The page will not draw a night it cannot read.";
    $("emptyBody").textContent = "Start the server with npm start, then reload. Nothing below is faked while this state lasts.";
    $("emptyError").hidden = false;
    $("emptyError").textContent = message;
  } else {
    $("emptyEyebrow").textContent = "No shift on record";
    $("emptyTitle").textContent = "Nothing has run yet, so there is nothing to show.";
    $("emptyBody").textContent =
      "The office is a view over a completed run: the crew only move when the trace says they did. logs/ holds no readable trace of a shift, and the run document is only returned to whoever starts a shift.";
    $("btnRunEmpty").hidden = false;
  }
}

function reveal(n) {
  document.body.classList.remove("booting");
  $("empty").hidden = true;
  for (const id of ["office", "shiftband", "pullzone", "memory", "night", "limits"]) $(id).hidden = false;
  $("emptyError").hidden = true;
  night = n;
  selectedId = null;
  renderStatus();
  renderCrewRows();
  renderPull();
  renderSources();
  renderMemory();
  renderRuns(runsCache);
  renderLimits();
  renderRail();
  $("query").value = "";
  runSearch();
  if (!sceneReady) {
    buildScene();
    sceneReady = true;
    size();
    setMode(gl ? "3d" : "2d", false);
  } else refreshCards();
  buildPlan2dIfNeeded();
  lastPlanSig = null;
  lastSheetState = null;
  applyScene(derived(0));
  if (gl) {
    drawBoard(buildPlan(), buildPlan().map(() => "next"));
    drawSheet();
  }
  replay();
  if (!loopStarted) {
    loopStarted = true;
    requestAnimationFrame(frame);
  }
}

let sceneReady = false;
let loopStarted = false;

async function loadRuns() {
  const res = await fetch("/runs", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("GET /runs answered " + res.status);
  const body = await res.json();
  runsCache = (body.runs || []).filter((r) => r.events && r.events.length);
  return runsCache;
}

function loadTrace(rec) {
  const n = buildNight(null, rec);
  const keepFocus = focus;
  reveal(n);
  setFocus(keepFocus);
  selectRow(null);
}

async function runNight() {
  for (const b of [$("btnRun"), $("btnRunEmpty")]) b.disabled = true;
  document.body.classList.add("busy");
  $("emptyError").hidden = true;
  const hint = $("emptyHint");
  const oldHint = hint ? hint.textContent : "";
  if (hint) hint.textContent = "Running: planner, reconciler, adjudicator, memory and escalation are executing and writing a real trace.";
  try {
    const scenario = await fetch("example-scenario.json").then((r) => r.json());
    const res = await fetch("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario }),
    });
    const doc = await res.json().catch(() => null);
    if (!res.ok || !doc || !Array.isArray(doc.pull_list)) {
      throw new Error("POST /run answered " + res.status + (doc && doc.error ? ": " + doc.error : ""));
    }
    let rec = null;
    for (let i = 0; i < 8 && !rec; i++) {
      await sleep(i ? 300 : 120);
      await loadRuns();
      rec = runsCache.find((r) => r.run_id === doc.run_id) || null;
    }
    reveal(buildNight(doc, rec));
    $("btnRun").title = "Runs the example scenario in examples/ through POST /run again.";
  } catch (err) {
    $("emptyError").hidden = false;
    $("emptyError").textContent = "Could not start a shift: " + String(err && err.message ? err.message : err);
    if (!night) $("emptyError").hidden = false;
  } finally {
    for (const b of [$("btnRun"), $("btnRunEmpty")]) b.disabled = false;
    document.body.classList.remove("busy");
    if (hint) hint.textContent = oldHint;
  }
}

/* ── wiring ──────────────────────────────────────────────────────────── */
function wire() {
  $("btnRunEmpty").addEventListener("click", runNight);
  $("btnRun").addEventListener("click", runNight);
  $("btnPlay").addEventListener("click", (e) => {
    paused = !paused;
    e.currentTarget.textContent = paused ? "Resume" : "Pause";
  });
  $("btnSpeed").addEventListener("click", (e) => {
    spd = spd === 1 ? 2 : spd === 2 ? 4 : 1;
    e.currentTarget.textContent = `Speed ${spd}×`;
  });
  $("btnReplay").addEventListener("click", replay);
  $("btnView").addEventListener("click", () => setMode(mode === "3d" ? "2d" : "3d", false));
  $("btnSpin").addEventListener("click", (e) => {
    autoRotate = !autoRotate;
    e.currentTarget.textContent = "Auto-orbit: " + (autoRotate ? "on" : "off");
    e.currentTarget.setAttribute("aria-pressed", String(autoRotate));
  });
  $("btnHome").addEventListener("click", () => {
    setFocus(null);
    if (gl) {
      controls.target.set(0, 1, 4);
      camera.position.set(25, 21, 31);
    }
  });
  $("btnUnfollow").addEventListener("click", () => setFocus(null));
  $("scrub").addEventListener("input", (e) => setMinute(Number(e.target.value)));
  $("query").addEventListener("input", runSearch);

  addEventListener("resize", size);
  if (window.ResizeObserver) new ResizeObserver(size).observe($("view"));
  $("srcGrid").addEventListener("scroll", () => {
    if (selectedId) {
      const item = night.pull.find((p) => p.action_id === selectedId);
      if (item) drawThreads(true, item.evidence.map((f) => facetKind(f) + ":" + facetValue(f)));
    }
  });
  if (window.IntersectionObserver)
    new IntersectionObserver((entries) => (vis = entries[0].isIntersecting), { threshold: 0 }).observe($("view"));
  document.addEventListener("visibilitychange", () => (vis = !document.hidden && vis));

  const cv = $("scene");
  let down = null;
  cv.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  cv.addEventListener("pointerup", (e) => {
    if (!down || !gl) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6 || mode !== "3d") return;
    const r = cv.getBoundingClientRect();
    const ndc = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickTargets.filter((m) => m.parent && m.parent.visible), false)[0];
    if (hit) {
      const a = crewObjs.find((c) => c.id === hit.object.userData.agent);
      setFocus(focus === a ? null : a);
    } else setFocus(null);
  });
  $("plan").addEventListener("pointerdown", (e) => {
    if (!night) return;
    const r = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * 30 - 15;
    const sy = ((e.clientY - r.top) / r.height) * 31 - 10;
    let best = null,
      bd = 1e9;
    for (const a of crewObjs) {
      const p = a.st === "pre" || a.st === "drive" || a.st === "park" ? a.car.position : a.g.position;
      const d = Math.hypot(p.x - sx, p.z - sy);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    if (best && bd < 1.4) setFocus(focus === best ? null : best);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setFocus(null);
    if (e.target === $("scene") && (e.key === "[" || e.key === "]")) {
      t = Math.min(1, Math.max(0, t + (e.key === "]" ? 0.02 : -0.02)));
      setMinute(Math.round(t * SHIFT_MIN));
    }
  });
}

/* ── deterministic hooks for checking the scene against the trace ────── */
window.__shelfwatch = {
  setMinute: (m) => {
    setMinute(m);
    return window.__shelfwatch.state();
  },
  renderOnce: () => {
    paint();
    stats(frameMs);
    return { mode, drawCalls: perf.calls, triangles: perf.tris, frameTimeMs: frameMs };
  },
  state: () => {
    const min = Math.round(t * SHIFT_MIN);
    const s = derived(min);
    return {
      minute: min,
      clock: s.clock,
      drawCalls: mode === "3d" && gl ? renderer.info.render.calls : null,
      drawCallBudget: BUDGET_CALLS,
      triangles: mode === "3d" && gl ? renderer.info.render.triangles : null,
      frameTimeMs: frameMs == null ? null : Number(frameMs.toFixed(2)),
      mode,
      camera: gl ? { x: +camera.position.x.toFixed(2), y: +camera.position.y.toFixed(2), z: +camera.position.z.toFixed(2), tx: +controls.target.x.toFixed(2), tz: +controls.target.z.toFixed(2) } : null,
      following: focus ? focus.id : null,
      statusStrip: $("status").textContent.replace(/\s+/g, " ").trim(),
      pullRows: $("pullList").querySelectorAll(".row[data-id]").length,
      threadPaths: $("threads").querySelectorAll("path").length,
      highlightedSources: $("srcGrid").querySelectorAll(".src.hl").length,
      events: night ? night.events.length : 0,
      palletsStaged: s.pallets.filter((p) => p.prog > 0.99).length,
      slipsOnCounter: s.slips.length,
      plan: s.planSignature,
      printed: s.printed,
      handover: s.handover,
      agents: Object.fromEntries(
        crewObjs.map((a) => [a.id, { spot: a.spot, x: +a.g.position.x.toFixed(2), z: +a.g.position.z.toFixed(2), visible: a.g.visible, state: a.st }])
      ),
      logRows: $("log").children.length,
      selected: selectedId,
    };
  },
};

/* ── boot ────────────────────────────────────────────────────────────── */
async function boot() {
  wire();
  let runs = [];
  try {
    runs = await loadRuns();
  } catch (err) {
    showEmpty("The interface could not read the server: " + String(err && err.message ? err.message : err));
    return;
  }
  if (!runs.length) {
    showEmpty();
    return;
  }
  reveal(buildNight(null, runs[0]));
}

boot();
