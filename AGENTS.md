# Shelfwatch — build contract

Shelfwatch is an overnight recall-triage agent for a food-bank duty officer. It
reconciles fragmented recall signals into a traceable morning pull list. Theme:
**The Night Shift** — the interface is a shift that ran from 22:00 to 06:00, not
a dashboard.

These rules are binding on every change.

## Non-negotiables

1. English only, in every file: code, comments, identifiers, log messages, UI
   copy, sample data, errors.
2. No hardcoded outputs. Never return the same answer regardless of input, never
   match a known scenario to a pre-written result, never store final answers as
   fixtures and present them as generated, never hand-write traces.
3. Logs must reflect real execution. They are the evidence a reviewer uses.
4. No secrets in the repository. Credentials come from environment variables
   only. `.env` is ignored; `.env.example` carries placeholders only. No key may
   appear in logs, screenshots, the demo video or slides.
5. No overclaiming. Do not describe a fixed chain as collaboration, do not claim
   a model ran when it did not, do not claim production readiness. State
   limitations plainly.
6. No personal or confidential data. Public data is cited; synthetic data is
   labelled synthetic.

## Runtime contract

- Runs from a clean clone with one documented command. No manual steps, no
  interactive prompts.
- Two programmatic entry points, both JSON in / JSON out:
  `npm run shift -- --scenario <file>` and `POST /run`.
- **stdout carries the result JSON and nothing else.** Logs go to stderr and to
  `logs/run-<timestamp>.jsonl`.
- Dependencies install at build time; nothing installs at run time. No CDN and no
  runtime asset fetching — the product must work with the network disabled.
- No local GPU. Model access is hosted.
- Bounded runs: target 5–10 minutes. Timeouts — external API 10–30 s, model call
  30–90 s, refinement loop 1–3 min. Iterations are capped; a run cannot hang.
- At least three scenario/result pairs under `examples/`.
- Keep the repository light: small curated samples, no raw archives.

## Sample mode

`SAMPLE_MODE=true` must work with no network and no credentials while still
running real agent logic. Two interchangeable reasoning backends sit behind one
interface: `LlmBackend` (hosted models) and `OfflineBackend` (deterministic rule
evaluation, scoring, constraint checking and entity resolution over cached
payloads). Sample mode swaps the backend, never the pipeline — planner,
reconciler, adjudicator, memory and escalation all still execute and still emit
real traces. Every result records `reasoning_backend`. Returning canned text in
sample mode is a prohibited hardcoded output.

## Architecture

Four agents in one loop with feedback, not a pipeline:

| Callsign | Role | Responsibility |
|---|---|---|
| Foreman | Planner | decomposes the shift, delegates, revises the plan after a rejection |
| Ledger | Reconciler | queries the data layer across sources, proposes identity matches |
| Assay | Adjudicator | checks each proposed action against policy, rejects and demands rework |
| Anchor | Memory keeper | entity graph, learned mappings, outcome feedback, conflict resolution |

Required, and observable in the logs: delegation, critique, at least one genuine
rejection followed by revision and a re-run, branching on confidence, escalation
below the floor, graceful fallback when a source is unreachable, and a memory hit
that reduces work on a later run.

**Auto-action floor: confidence below 0.70 is never actioned.** It is escalated
with the reason. This is a product rule, not a display detail.

Call budget per run: roughly 1–3 planner, 1–5 tool, 1–3 critic, 1 synthesis calls.

## Data

Public, key-free sources, each cached as a small sample so a run survives an
outage: FDA enforcement (drug and food), FDA adverse event reports (free text,
the disagreeing second voice), a second agency notice set, Open Food Facts as the
product-identity crosswalk (ODbL — attribute and share-alike), and a synthetic
donation ledger labelled as such in `data/README.md`.

## Interface

Light paper surfaces with a single petrol accent; the 22:00–06:00 timeline is a
dark band, because the app is the morning desk and the band is the night that
just ended. One accent colour; rust is reserved for Class I severity and
rejections. Hairlines, not shadows — at most two shadowed elements in the product.

The shift timeline is the primary axis and replays the night. Selecting a pull-list
action draws its evidence threads to the specific source records behind it. A crew
panel shows which agent is acting; a trace feed shows critique, retry and escalation
as they happen. A persistent status strip shows mode, engine conformance, reasoning
backend, action and escalation counts.

Motion carries information or it is removed: animate `transform` and `opacity`
only on scrolling surfaces, stagger row reveals 60–80 ms, no `box-shadow`
transitions, no `backdrop-filter` on moving surfaces, no post-processing. Assume
integrated graphics. `prefers-reduced-motion` degrades to cross-fades without
hiding state.

**Every scrollable surface is restyled, including the document scrollbar.** A
visible native scrollbar anywhere is a defect. Keyboard accessible, `aria-live`
on the trace feed, usable at 320 px.

The interface is a view over the run output and must never be the only way to
execute the system.

## Layout

```
src/          agents, backends, data layer, engines, server, cli
schemas/      JSON Schema for scenario input and run result
data/         cached public samples + synthetic ledger + data/README.md
examples/     scenario/result pairs
logs/         JSONL traces (generated; one sample committed)
usql/         data-layer statements in execution order
public/       interface
```

## How to work here

- Implement one requested change at a time; stop and report honestly, including
  what failed and what you could not verify.
- Never weaken a check to make it pass — report the conflict instead.
- Do not add features or abstractions the brief did not ask for.
- No comment restates the code.
- Commit with per-command author flags only; never modify global git config.
