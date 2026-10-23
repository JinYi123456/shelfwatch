---
name: run-gate
description: Run the acceptance gate for a Shelfwatch phase. Use when a phase is claimed to be finished, and before any new phase is started. Orchestrates the gate-auditor, trace-reader and ui-critic subagents, then returns one verdict.
disable-model-invocation: true
---

# Run a phase gate

Argument: the phase number, e.g. `/run-gate 4`.

1. Read `shelfwatch-prep/AGENTS.md` and locate the gate for that phase in
   `shelfwatch-prep/PHASES.md`.
2. Delegate in parallel:
   - **gate-auditor** — reproduce every check in the gate from a clean state and
     actively try to falsify it.
   - **trace-reader** — audit the most recent run's `logs/*.jsonl` for genuine
     collaboration and honest evidence. Run the phase's scenario first if no run
     exists yet.
   - **ui-critic** — only when the phase touches the interface. Open the running
     app with the browser tools rather than reading its source.
3. Collect the three verdicts without editing them. Do not summarise a failure
   into a caution.
4. Output one block:

   ```
   PHASE <n> GATE — PASS | FAIL | INCOMPLETE
   Passed:   <checks, with the command that proved each>
   Failed:   <checks, with observed vs required>
   Unverified: <checks nobody could run>
   Required fixes, in order of impact: <list>
   ```

5. **INCOMPLETE** is the answer whenever a check could not be run. Never report
   PASS with unverified items remaining. On FAIL, stop: do not start the next
   phase and do not proceed on a promise to fix it later.
