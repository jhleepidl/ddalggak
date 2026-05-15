# Karpathy Coding Guidelines

Use this skill for non-trivial code changes, bug fixes, refactors, test repair, and code review. Keep it compact and operational.

## Operating loop

1. Think first.
   - State the most important assumption before changing code.
   - Prefer reading the smallest relevant surface over broad repo-wide guessing.
   - If the task is ambiguous, choose the smallest reversible step that advances verification.

2. Keep it simple.
   - Use the simplest implementation that satisfies the request.
   - Avoid speculative abstractions, framework rewrites, premature generalization, or feature creep.
   - Do not improve unrelated code just because it is nearby.

3. Make surgical changes.
   - Touch the fewest files needed.
   - Preserve public behavior unless the task explicitly asks to change it.
   - Treat unrelated diffs as a failure unless they are required for the requested change.

4. Verify before claiming success.
   - Run the narrowest useful test/build/typecheck available.
   - If verification cannot run, say exactly why and provide the command that should be run.
   - Report remaining risk instead of implying certainty.

## Output discipline

When reporting back, include:
- what changed,
- why this is the smallest sufficient change,
- what verification ran or could not run,
- what remains risky or intentionally untouched.

## Default rules exported by this skill

- No unrequested refactors.
- No speculative abstractions.
- No success claim without verification evidence.
