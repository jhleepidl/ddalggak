# Thread Team Reconciliation

## Purpose
Keep thread membership changes deterministic and verifiable.

## Procedure
1. Normalize membership target (`thread_id`, `conversation_id`, `workspace_id`, `account_id`).
2. Apply requested add/remove/enable/disable mutations.
3. Read back current membership from canonical target.
4. Confirm mutation effect before advancing to reroute/work execution.
5. Surface mismatch diagnostics if readback does not confirm expected state.

## Safety Rules
- Do not claim success before readback confirms expected state.
- Do not silently switch to another thread scope on mismatch.
- Prefer explicit operator-facing diagnostics over retries that hide failures.
