# Shelfwatch

Overnight recall triage for a food-bank duty officer. Shelfwatch watches the
night's incoming recall signals, reconciles the different names four systems use
for the same product, and produces a morning pull list that traces every line
back to the record that caused it.

## Requirements

- Node.js 18 or newer, no other runtime dependencies
- No API keys needed while `SAMPLE_MODE=true` (the default)

## Setup

```bash
cp .env.example .env
npm install
npm run verify
```

`npm install` exists so a clean clone behaves like a normal project; the package
has zero runtime dependencies.

## Run a shift

```bash
npm run shift -- --scenario examples/scenario-bread-mismatch.json
```

- stdout carries the result JSON and nothing else
- the execution trace is written to stderr and to `logs/run-<timestamp>.jsonl`
- no interactive prompts, so the same command works in CI

Or over HTTP:

```bash
npm start
# POST http://127.0.0.1:8787/run   with the scenario JSON (or { "scenario": ... })
# GET  http://127.0.0.1:8787/health
```

## How a run works

Four roles cooperate on one loop rather than a fixed pipeline:

| Callsign | Role | Responsibility |
|---|---|---|
| Foreman | Planner | decomposes the shift, delegates, revises the plan after a rejection |
| Ledger | Reconciler | queries the data layer across sources, proposes identity matches |
| Assay | Adjudicator | checks each proposed action against policy, rejects and demands rework |
| Anchor | Memory keeper | entity graph, learned mappings, outcome feedback, conflicts |

A rejection is a normal outcome: the planner revises, the query re-runs, and the
trace shows the revision. Confidence below the **auto-action floor of 0.70** is
never actioned — it is escalated with the reason attached.

## Sample mode

`SAMPLE_MODE=true` (default) runs the complete pipeline with no network and no
credentials. It swaps the reasoning **backend**, never the stages: planner,
reconciler, adjudicator, memory and escalation all still execute and still emit
real traces, with `OfflineBackend` doing deterministic rule evaluation, scoring
and entity resolution in place of a hosted model. `SAMPLE_MODE=false` selects
`LlmBackend`. Every result records `reasoning_backend`, so the reader always
knows which one ran.

## Verify

```bash
npm run verify
```

Runs every scenario in `examples/`, checks that stdout is a single parseable JSON
document, asserts that the 0.70 floor is never bypassed, asserts that each
scenario yields different statistics (the anti-hardcoding check), confirms a
JSONL trace with handoffs between at least three agents including a rejection and
an escalation, and smoke-tests the HTTP entry point. Exits non-zero on any
failure.

## Layout

```
src/          pipeline, agents, backends, server, CLI
schemas/      JSON Schema for scenario input and run result
data/         cached public samples, synthetic ledger, source notes
examples/     scenario inputs and their expected shape
logs/         JSONL traces (generated)
public/       interface
scripts/      verify harness
```

## Data sources

FDA enforcement (drug and food), FDA adverse event reports, a second agency
notice set, Open Food Facts as the product-identity crosswalk (ODbL — attribute
and share-alike), and a synthetic donation ledger that is labelled as synthetic.
See `data/README.md`.

## Status

The run contract, backends, logger, CLI, HTTP entry point and verification
harness are in place. The hosted data layer, the memory engines, live model
calls and the operator interface are not yet wired: `LlmBackend` returns a
clear "not configured" result rather than pretending to have called a model.
Example scenarios are synthetic and exist to exercise the contract.

## Licence

Not yet declared.
