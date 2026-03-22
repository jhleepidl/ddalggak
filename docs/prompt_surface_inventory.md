# Prompt Surface Inventory

This document tracks the main prompt surfaces used by ddalggak so they can be reviewed without hunting through the codebase.

## Primary runtime prompt surfaces

### 1. Controller / next-step planning
- File: `src/prompts.js`
- Entry points:
  - `orchestratorNotes(...)`
  - `buildChatGPTNextStepPrompt(...)`
- Purpose:
  - turn job context + shared docs + recent conversation into a machine-executable JSON plan
- Main risks:
  - duplicated KB instructions
  - long shared-doc dumps
  - examples drifting from actual action schema

### 2. Telegram execution provider prompts
- File: `src/application/telegram_chat_execution.js`
- Entry points:
  - `geminiResearch(...)`
  - `codexImplement(...)`
  - final synthesis / execution update helpers nearby
- Purpose:
  - dispatch role-aware provider prompts for research, implementation, synthesis
- Current guardrails:
  - long direct task text is compacted before prompt injection
  - provider workspace support files (`GEMINI.md`, `.codex/instructions.md`) carry durable context
  - role-aware KB guidance is injected in compact form
- Main risks:
  - retry/resume reusing stale task phrasing
  - role memo / KB contract duplication between inline prompt and support files
  - over-broad shared tracking docs in provider prompts

### 3. Freeform team / blueprint generation
- File: `src/application/freeform_team_planner.js`
- Entry points:
  - `buildPlannerPrompt(...)`
  - refinement prompt builders in the same module
- Purpose:
  - convert a natural-language team request into a concrete TeamBlueprint/team config
- Main risks:
  - schema hint drift
  - too much catalog detail inflating planner prompts
  - role/tool defaults drifting from runtime capability reality

### 4. Supervisor / route planning
- File: `src/chat/supervisor_router.js`
- Entry points:
  - router prompt builders around `buildRouterPrompt(...)`
- Purpose:
  - decide the next executable actions and agent routing
- Main risks:
  - action schema verbosity
  - duplicated child-action examples
  - drift between prompt examples and actual executor support

### 5. CLI workspace contract prompts
- File: `src/application/cli_workspace_contract.js`
- Entry points:
  - `writeGeminiMemoryFile(...)`
  - `writeCodexInstructionFile(...)`
- Purpose:
  - preload durable provider context into workspace support files instead of repeating it inline
- Main risks:
  - user artifact pollution if support files leak into artifact candidate lists
  - support files becoming too verbose and recreating full-history bloat

## Memory / KB prompt surfaces

### 6. Knowledge-base contract rendering
- Files:
  - `src/knowledge_base/runtime.js`
  - `src/knowledge_base/profile.js`
- Entry points:
  - `buildRoleMemoryContract(...)`
  - `buildAgentKnowledgeBaseGuidance(...)`
  - `renderKnowledgeBaseContractMarkdown(...)`
- Purpose:
  - expose role-aware read/write surfaces and concrete filenames
- Main risks:
  - policy metadata existing without runtime enforcement
  - alias resolution hiding surface mismatches

## Prompt hygiene rules

1. Prefer stable workspace support files for durable context.
2. Keep inline provider prompts focused on the current step.
3. Do not duplicate full role memo + KB contract both inline and in support files.
4. Use concrete KB filenames, not made-up tracking docs.
5. Compact long task text before injecting it into provider prompts.
6. Keep action-schema examples aligned with real executor behavior.
7. Exclude internal support files from artifact candidate surfaces.

## Current cleanup status

- Provider prompts now rely more on workspace support files and less on duplicated inline role/context blocks.
- Role-aware memory contract information is used for prompt guidance and tracking-write rerouting.
- Internal support files like `GEMINI.md`, `.codex/*`, and `.orchestrator/*` are excluded from artifact candidate lists.

## Next recommended cleanup

1. Split the large supervisor/router schema examples into reusable fragments.
2. Reduce catalog verbosity in freeform team planner prompts.
3. Move more prompt fragments into shared builders so policy wording stays consistent.
4. Record per-surface prompt token contribution in telemetry, not only total prompt size.


## Latest audit findings

### Biggest remaining prompt surfaces

1. `supervisor_router`
   - Still one of the largest prompts because it carries action schema + runtime roster + team recommendation + context summary in one shot.
   - New change: the prompt is now tagged in telemetry as `supervisor_router` so `/status prompt` can separate it from provider prompts.

2. `team_create_planner` / `team_refine_planner`
   - These prompts were previously hard to inspect in runtime telemetry.
   - New change: they now emit `planner_prompt` telemetry rows with `surface_id` values `team_create_planner` and `team_refine_planner`.
   - Runtime catalog / skill registry / preset registry payloads are compacted before prompt assembly to reduce drift and prompt bloat.

3. Provider execution prompts (`geminiResearch`, `codexImplement`, agent execution)
   - The biggest repeat cost is still local context + KB contract + task body.
   - Recent work already reduced duplicate role memo / workspace support file overlap, but shared summary duplication still exists across multi-agent loops.

### Recommended next prompt cleanup

1. Move repeated JSON schema examples into shared prompt fragments where possible.
2. Replace long prose rules with shorter canonical policy bullets reused across router/planner/provider surfaces.
3. Add per-surface token budget targets and fail the build when a surface regresses too far.
4. Keep support-file prompts (`GEMINI.md`, `.codex/instructions.md`) and inline prompts complementary rather than duplicating the same contract.


## Latest audit findings (web-service / builder coverage)

- `team_create_planner` prompt previously allowed only `parallel_research_then_review_then_synthesize | multi_research_adjudication | sequential_pipeline` for `interaction_spec.execution_pattern`. This biased fresh freeform plans toward pipeline shapes and made it impossible for the planner to explicitly choose `builder_reviewer_loop` at create-time.
- Build-heavy requests like "web service", "frontend", "backend", "API", "웹 서비스 개발" were under-detected in some heuristic paths. That let planner/freeform fall back to research-heavy rosters without a builder.
- Hardening added in this pass: build requests now strongly trigger builder coverage across task interpretation, freeform blueprint inference, fallback coverage, and planner prompt constraints.
