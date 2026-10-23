# Shelfwatch

Overnight triage agent for a food bank / public-health duty officer.
Theme: **The Night Shift** (Open Agent Hackathon 2026).

Phase 1 delivers the run contract: schemas, CLI, HTTP entry point, JSONL
logger, and a stub Offline reasoning backend. Agent intelligence, Zetaris,
Meterless engines, and the UI come in later phases.

## Requirements

- Node.js 18 or newer
- No API keys required when `SAMPLE_MODE=true` (default)

## Setup

```bash
cp .env.example .env
npm install
```

There are no runtime package installs. Phase 1 has zero npm dependencies;
`npm install` still succeeds and creates a lockfile-free local install.

## Run a shift (programmatic)

```bash
npm run shift -- --scenario examples/scenario-bread-mismatch.json
```

- Writes structured events to **stdout** and to `logs/run-<timestamp>.jsonl`
- Prints a final `---RESULT---` JSON object derived from the scenario input
- No interactive prompts

## HTTP entry point

```bash
npm start
# POST http://127.0.0.1:8787/run  with the scenario JSON (or { "scenario": ... })
```

## Sample mode

`SAMPLE_MODE=true` (default) selects `OfflineBackend`: deterministic scoring,
entity keys, critique, and escalation over the scenario payload. The planner /
reconciler / adjudicator / memory **code paths still run** and emit real
traces. Results record `reasoning_backend: "offline" | "llm"`.

`SAMPLE_MODE=false` selects `LlmBackend` (Meterless Nightshift). Live calls are
not implemented in Phase 1 and require Nightshift access from Phase 0.

## Escalation floor

Confidence below **0.70** is never auto-actioned; it is escalated with a reason.

## Layout

See `src/`, `schemas/`, `examples/`, `data/`, `usql/`, `public/`, `logs/`.

## Limitations (Phase 1)

- No Zetaris queries yet
- No Meterless H-MEM / World Model yet
- No live Nemotron calls yet
- UI is a placeholder directory
- Example scenarios are synthetic labels for contract testing

## AI and Model Usage

Documented fully at submission (Phase 7). Phase 1 uses only the offline stub.
