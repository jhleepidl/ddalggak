# ddalggak Deployment Setup Guide

This guide is for turning a local development runtime into a deployable, user-operable Telegram agent runtime.

## 1. Recommended deployment shape

Use one Telegram-facing orchestrator and many model nodes.

```text
Telegram user/chat
  ↓
one ddalggak orchestrator process
  ↓
provider/model nodes
  - Gemini CLI on the orchestrator host
  - Codex CLI on the orchestrator host
  - local Ollama on the orchestrator host
  - remote Ollama / OpenAI-compatible endpoints on other machines
  - external API providers
```

Do not run multiple independent ddalggak bot processes with the same Telegram bot token. Telegram update delivery is a single stream per bot token. Use a single owner process for production and attach remote models over HTTP.

Recommended environments:

```text
prod bot token      → production orchestrator only
staging bot token   → staging/test orchestrator
local dev bot token → developer machine
```

Remote model machines do not need a Telegram bot. They only expose an LLM endpoint to the orchestrator.

## 2. Minimal `.env` for first production run

Start with a small surface:

```env
RUNS_DIR=runs
MEMORY_MODE=local
MEMORY_SEED_MODE=adaptive_compact

TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=...
TELEGRAM_REQUIRE_MENTION_IN_GROUP=false
MAX_CONCURRENCY=1
MAX_PARALLEL_PER_RUN=3
CHAT_VERBOSE=false
CHAT_SHOW_MODEL_BADGE=true

CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never

GEMINI_APPROVAL_MODE=default
GEMINI_MODEL=auto
GEMINI_MODEL_POOL=gemini-2.5-flash,gemini-2.5-pro,auto
GEMINI_CONTEXT_MODE=isolated
GEMINI_CONTEXT_REUSE=stable
GEMINI_FORCE_FILE_STORAGE=true
MAX_CONCURRENT_GEMINI=1
GEMINI_MIN_INTERVAL_MS=2000

PROVIDER_FAILOVER_ENABLED=true
GEMINI_CAPACITY_FAILOVER_ENABLED=true
GEMINI_CAPACITY_FAILOVER_PROVIDER=codex
CODEX_ASSIST_SANDBOX_MODE=read-only
CODEX_ASSIST_APPROVAL_POLICY=never

# Optional local model
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:12b
```

Add GoC later:

```env
GOC_API_BASE=http://127.0.0.1:8000
GOC_UI_BASE=http://127.0.0.1:5173
GOC_SERVICE_KEY=
GOC_SYNC_MODE=late
GOC_SYNC_BOOTSTRAP_MEMORY=0
GOC_UI_LINK_MODE=telegram_auth
```

## 3. CLI login / authentication

### Gemini CLI

For personal or Code Assist-license use, install Gemini CLI and run it once on the orchestrator host:

```bash
gemini
```

Choose Google sign-in when prompted. If your organization requires a Google Cloud project, set it before running:

```bash
export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"
gemini
```

Server-only hosts are still possible, but the first OAuth flow usually needs a browser-capable login path. Practical options:

```text
- SSH with port/browser forwarding if supported by your environment.
- Run the login once in an interactive shell for the same OS user that runs the service.
- Use an API-key based provider node instead of Gemini CLI for headless deployments.
```

### Codex CLI

Install Codex CLI on the orchestrator host and authenticate once as the same OS user that runs ddalggak:

```bash
codex
# or, if your installed Codex CLI version exposes it:
codex login
```

Keep Codex in a controlled sandbox mode for Telegram-driven runs. Recommended defaults:

```env
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
CODEX_ASSIST_SANDBOX_MODE=read-only
CODEX_ASSIST_APPROVAL_POLICY=never
```

For shared deployments, do not ask end users to log into CLI tools on the server. The deployment owner should connect provider credentials, and users should interact only through Telegram/GoC access control.

## 4. Ollama local model setup

Install Ollama on the same machine as ddalggak, then pull a model:

```bash
ollama pull gemma3:12b
ollama serve
```

Use the native Ollama endpoint:

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:12b
```

Then verify from Telegram:

```text
/models
/models health
/models route reviewer 민감한 내부 코드 변경을 로컬 모델로 리뷰해줘
```

The runtime also still supports Ollama's OpenAI-compatible endpoint style:

```env
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=gemma3:12b
```

## 5. Remote Ollama / another device

Remote Ollama is a model node, not a second Telegram bot.

On the model machine:

```bash
ollama pull qwen2.5-coder:14b
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

On the ddalggak orchestrator machine, create `config/model_nodes.json`:

```json
{
  "nodes": [
    {
      "id": "remote_ollama_coder",
      "label": "Remote Ollama Coder Box",
      "provider": "openai_compatible",
      "runtime": "ollama",
      "base_url": "http://192.168.1.50:11434",
      "model": "qwen2.5-coder:14b",
      "enabled": true,
      "capabilities": {
        "chat": true,
        "structured_json": true,
        "code": true
      },
      "permissions": {
        "memory_read": "project_scoped",
        "memory_write": "write_intent_only",
        "workspace_read": true,
        "workspace_write": false
      },
      "cost_profile": { "tier": "free", "billing": "local_network" },
      "latency_profile": { "tier": "slow" },
      "quality_profile": { "tier": "good", "coding": "good" },
      "privacy_profile": {
        "tier": "private_lan",
        "data_boundary": "lan_endpoint",
        "sends_context_off_device": true
      },
      "routing": {
        "priority": 60,
        "prefer_for": ["code_review", "builder", "reviewer"],
        "avoid_for": ["highly_sensitive_memory"]
      },
      "role_bias": ["builder", "review", "code"]
    }
  ]
}
```

Then set:

```env
DDALGGAK_MODEL_NODES_CONFIG=./config/model_nodes.json
```

Security notes:

```text
- Do not expose Ollama directly to the public internet without an authenticated reverse proxy/VPN.
- Prefer LAN/VPN/Tailscale/WireGuard for remote model machines.
- Mark privacy_profile honestly: LAN is not the same as local_device.
- Keep workspace_write=false unless a model node is explicitly allowed to mutate files through a controlled execution provider.
```


## 6. CLI model catalog refresh

ddalggak keeps a machine-readable discovered model catalog, but discovery stays off the user request path.
A background scheduler checks periodically and only opens provider `/model` surfaces when the runtime is idle.
The normal refresh interval is once per day; a provider CLI version change can trigger an earlier refresh at the next idle window.
The generated file is loaded before `config/model_nodes.json`, so hand-written config can override discovered rows with the same `id`.

```env
MODEL_CATALOG_REFRESH_ENABLED=true
MODEL_CATALOG_REFRESH_INTERVAL_MS=86400000
MODEL_CATALOG_REFRESH_CHECK_INTERVAL_MS=300000
MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS=30000
MODEL_CATALOG_REFRESH_IDLE_MIN_MS=60000
MODEL_CATALOG_REFRESH_CLI_VERSION_CHECK_INTERVAL_MS=3600000
MODEL_CATALOG_REFRESH_ON_CLI_VERSION_CHANGE=true
CODEX_CLI_MODEL_DISCOVERY_ENABLED=true
CLAUDE_CLI_MODEL_DISCOVERY_ENABLED=true
ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED=true
MODEL_BENCHMARK_MIN_RUNS=3
MODEL_NODES_DISCOVERED_CONFIG=./config/model_nodes.discovered.json
GEMINI_CLI_MODEL_DISCOVERY_ENABLED=false
CLI_MODEL_DISCOVERY_TIMEOUT_MS=12000
```

Manual refresh and status:

```bash
npm run models:refresh
npm run models:status
node scripts/discover_model_nodes.js --kind all --refresh
node scripts/discover_model_nodes.js --kind codex --stdout
node scripts/discover_model_nodes.js --kind claude --stdout
node scripts/discover_model_nodes.js --kind antigravity --stdout
```

Telegram:

```text
/models refresh
/models discover codex
/models discover claude
/models discover antigravity
/models discover gemini
```

Important: Codex and Gemini CLI `/model` are interactive UI surfaces, not a stable
machine-readable catalog API. ddalggak treats the output as best-effort discovery.
If parsing fails, startup continues and existing catalog/config entries remain valid.
For production, keep a curated `config/model_nodes.json` for cost, quality, privacy,
workspace-write permission, and routing policy overrides.

## 7. Model node routing properties

Each model node can declare properties used by the planner and selector:

```json
{
  "cost_profile": {
    "tier": "free|very_cheap|cheap|medium|expensive|premium",
    "billing": "local|local_network|metered",
    "input_per_1m_usd": 0.15,
    "output_per_1m_usd": 0.60
  },
  "latency_profile": {
    "tier": "instant|fast|medium|slow|very_slow",
    "startup": "cold_start_possible"
  },
  "quality_profile": {
    "tier": "draft|standard|good|strong|frontier",
    "coding": "standard|good|strong",
    "reasoning": "standard|good|strong"
  },
  "privacy_profile": {
    "tier": "local_private|private_lan|external_api",
    "data_boundary": "local_device|lan_endpoint|external_provider",
    "sends_context_off_device": false
  },
  "routing": {
    "priority": 50,
    "prefer_for": ["review", "draft", "private_context"],
    "avoid_for": ["deployment", "credential"]
  }
}
```

Current selector policy:

```text
private/sensitive work → prefer local_private / no off-device context
cheap/low-risk drafts  → prefer cheap/free nodes
urgent work            → prefer fast nodes
hard/architectural work → prefer stronger quality tier
code/builder work      → require code capability and, when needed, workspace_write permission
```

This is intentionally conservative. Agents may propose model choices, but the runtime can reject a node when required capabilities or permissions are missing.

## 8. Smoke checks

Test tiers:

```bash
# deterministic unit/contract tests; no authenticated provider calls
npm test

# bounded subprocess, local HTTP, filesystem, and archive tests
npm run test:integration

# whole-runtime and release hygiene smoke
npm run test:system

# release gate
npm run test:all
```

`npm run test:live` delegates to the all-model scenario harness and remains plan-only unless `--execute` is supplied.

```bash
node --check src/providers/openai_compatible.js
node --check src/application/model_node_registry.js
node --check src/application/model_node_selector.js
node --check src/application/telegram_provider_execution.js
node --check src/adapters/telegram/commands.js

node --test \
  test/openai_compatible_provider.test.js \
  test/model_node_registry.test.js \
  test/model_node_selector.test.js
```

Telegram checks:

```text
/models
/models health
/models route researcher 최신 리서치 초안을 저렴하게 만들어줘
/models route reviewer 민감한 프로젝트 메모리를 로컬에서 검토해줘
/agents suggest 로컬 모델과 Codex를 섞어서 구현-검토 루프를 운영하고 싶어
```

## 9. Two deployment/account modes

### Mode A — distributed source install

Each user clones the source and runs ddalggak on their own machine.

```text
user device
  ├─ ddalggak orchestrator
  ├─ Telegram bot token owned by that user/deployment
  ├─ Gemini CLI login owned by that OS user
  ├─ Codex CLI login owned by that OS user
  └─ optional Ollama/local models
```

This is the simplest trust model. Credentials, CLI caches, workspaces, and local model data stay on the user's device. The tradeoff is that every user must perform setup.

### Mode B — hosted orchestrator with provider accounts

You run one ddalggak server, but want some execution to use each end user's own provider account.

This is possible only with an explicit per-user credential boundary. Do **not** put multiple users' CLI auth into one shared Unix home directory.

Recommended hierarchy:

```text
hosted ddalggak control server
  ├─ Telegram bot token: owned by the deployment
  ├─ user/session registry
  ├─ per-user provider connector
  │   ├─ preferred: API key / OAuth connector stored in secret manager
  │   ├─ acceptable for trusted users: per-user OS account/container with isolated HOME
  │   └─ not recommended: shared ~/.codex or ~/.gemini credential files
  └─ model nodes
      ├─ owner-paid default providers
      ├─ user-owned API provider nodes
      └─ local/remote Ollama nodes
```

Practical policy:

```env
# Hosted server default: use deployment-owner provider credentials.
PROVIDER_ACCOUNT_MODE=deployment_owner

# Experimental hosted BYO-account mode. Requires your own user/session + secret boundary.
# Do not enable until per-user HOME/container isolation or a proper secret store exists.
PROVIDER_ACCOUNT_MODE=per_user_isolated
```

For production, prefer API-key/OAuth connector style provider nodes over browser-login CLI caches. CLI account caches are operationally convenient for one owner account, but they are awkward and risky for multi-tenant account delegation.

## 10. ChatGPT/Codex provider bridge

Older ddalggak builds treated `provider=chatgpt` as a manual copy/paste workflow:

```text
ddalggak → prints a huge ChatGPT prompt in Telegram → user copies it into ChatGPT → pastes JSON back
```

That path is now legacy and disabled by default. Use Codex CLI as the executable bridge for ChatGPT/Codex-account-backed work:

```env
CHATGPT_PROVIDER_BRIDGE=codex
CHATGPT_CODEX_SANDBOX_MODE=read-only
CHATGPT_CODEX_APPROVAL_POLICY=never
# Optional Codex profile/model alias if your Codex config exposes one.
CHATGPT_CODEX_PROFILE=
```

If you explicitly need the old copy/paste workflow for debugging:

```env
CHATGPT_PROVIDER_BRIDGE=manual
CHATGPT_MANUAL_FALLBACK_ENABLED=true
AUTO_SUGGEST_GPT_PROMPT=false
```

Even when enabled, the manual prompt is compacted and attached as a markdown file when the Telegram client supports documents; it should not spam the chat with many split messages.

## 11. Model dispatch policy

Model routing should treat each model as a node with explicit properties instead of a flat `model=name` string.

Recommended dimensions:

```text
cost_profile     free / cheap / medium / expensive / premium
latency_profile  instant / fast / medium / slow / very_slow
quality_profile  draft / standard / good / strong / frontier
privacy_profile  local_private / private_lan / dedicated_cloud / external_api
capabilities     chat / code / structured_json / vision / embedding / tool_calling
permissions      memory_read / memory_write / workspace_read / workspace_write
routing          prefer_for / avoid_for / priority
```

Routing examples:

```text
sensitive memory review     → local_private or private_lan node
cheap draft/summarization   → free/cheap local or small API model
urgent status answer        → fast low-latency model
hard architecture review    → strong/frontier reasoning model
code editing                → Codex builder with workspace-write, or local coder only if workspace_write is allowed
financial/news claims       → researcher/verifier with freshness/evidence capability; avoid stale local-only models unless sources are provided
```

Use Telegram to inspect routing decisions:

```text
/models
/models health
/models route reviewer 민감한 내부 코드 변경을 로컬에서 검토해줘
/models route builder 빠르게 작은 UI 패치를 만들어줘
/models route researcher 최신 금융 뉴스 기반 리스크 요약을 만들어줘
```

## 12. Model catalog, discovery, and routing policy

`ddalggak` should not pick models from a free-text name alone. Each model node should carry approximate metadata, even if the values are rough tiers rather than exact benchmarks:

```json
{
  "id": "remote_ollama_coder",
  "runtime": "ollama",
  "base_url": "http://192.168.1.50:11434",
  "model": "qwen2.5-coder:14b",
  "cost_profile": { "tier": "free", "billing": "local_compute" },
  "latency_profile": { "tier": "slow" },
  "quality_profile": { "tier": "good", "coding": "good" },
  "privacy_profile": {
    "tier": "trusted_private",
    "data_boundary": "user_controlled_remote",
    "sends_context_off_device": true,
    "trusted_context": true,
    "allow_private_context": true
  },
  "limits": { "context_tokens": 32768, "max_concurrent": 1 },
  "routing": { "priority": 60, "prefer_for": ["private_context", "reviewer"] }
}
```

For remote Ollama boxes that you own/control, `trusted_private + user_controlled_remote` means private project context is allowed to leave the orchestrator machine and go to that endpoint. Do not use this label for public, shared, or unknown endpoints.

Discovery helpers:

```bash
# Preview all local/remote Ollama models and write a config file.
node scripts/discover_model_nodes.js \
  --kind ollama \
  --url http://192.168.1.50:11434 \
  --trusted-context true \
  --output config/model_nodes.discovered.json

# Or preview from Telegram without writing server files.
/models discover ollama http://192.168.1.50:11434 trusted
```

`/models` shows the stored catalog tiers. `/models route [role] <goal>` previews routing with the current cost/latency/quality/privacy settings.

What can be auto-discovered:

- Ollama: `/api/tags` gives installed models and basic details; `/api/show` gives model details and often the Modelfile/context parameters. Use this to bootstrap node entries.
- OpenAI-compatible APIs: `/models` can list model identifiers when the endpoint supports it, but usually not enough pricing/context/quality metadata for safe routing. Add tiers manually.
- Gemini CLI and Codex CLI: both expose interactive model selection (`/model`) and startup flags, but they should still be represented in `model_nodes.json` or static defaults for cost/latency/quality routing. Treat CLI-discovered availability as health/capability evidence, not as the sole routing source.


## 13. Agent packages: export, publish candidate, clone

The long-term sharing unit is an **agent package**, not raw chat memory. A package is a portable contract that can be installed into another Telegram chat or GoC thread.

A package may include:

```text
- role contracts / standing agents
- skill references
- runtime rule references
- interaction contract / team handoff pattern
- model policy hints
- memory surface contract
- evaluation notes
```

A package must not include:

```text
- private chat memory
- uploaded files or run logs
- credential bindings
- provider auth state
- CLI login state
```

Telegram commands:

```text
/agents export
/agents publish-candidate
/agents packages
/agents package <package_id>
/agents clone <package_id>
```

Local registry path:

```env
AGENT_PACKAGE_REGISTRY_PATH=config/agent_packages.json
```

Clone policy defaults:

```text
private_memory: fresh_on_clone
credential_binding: never_copy
provider_state: never_copy
runtime_logs: never_copy
```

This means an agent that worked well in one chat can be reused in another chat as a reusable role/skill/rule/team contract, while the target chat gets its own fresh private memory. If public reusable knowledge is needed, attach it later as a separately reviewed knowledge pack instead of copying source private memory.

The first implementation is local-registry based. A future GoC-backed marketplace/publish flow should add review status, provenance, versioning, eval score, package signatures, and compatibility checks before public sharing.

## 14. Legacy ChatGPT copy/paste cleanup

Manual ChatGPT copy/paste is a legacy emergency/debug workflow. It should not be part of normal routing.

Defaults:

```env
CHATGPT_PROVIDER_BRIDGE=codex
CHATGPT_MANUAL_FALLBACK_ENABLED=false
AUTO_SUGGEST_GPT_PROMPT=false
```

With these defaults, `provider=chatgpt` should execute through the Codex bridge/model-node path rather than generating a Telegram prompt for manual copying. The old `/gptprompt`, `/gptapply`, and `/gptdone` commands remain guarded for emergency debugging only and are not advertised in normal help.

## Task-loop execution policy

`/task loop <goal>` now installs an explicit task-loop runtime execution policy instead of reusing the default `/chat` artifact policy.

Task-loop defaults:

```text
execution_mode=task_loop
workspace_write=allowed_in_workspace
artifact_delivery=allowed_when_task_requires
legacy_manual_fallback=disabled
```

This means implementation agents may create or update files inside the run workspace when the bounded loop needs implementation, diagnosis, tests, or verification. The approval boundary is still active for deployment, credential/API binding, destructive writes, large irreversible changes, financial recommendation logic, and canonical memory switches.

The runtime records the decision in:

```text
runs/<jobId>/local_memory/execution_policy_resolutions.jsonl
runs/<jobId>/local_memory/agent_activity.jsonl
runs/<jobId>/local_memory/agent_handoffs.jsonl
```

Legacy ChatGPT manual copy/paste fallback is disabled for task-loop execution. Configure `CHATGPT_PROVIDER_BRIDGE=codex` or a model node for executable ChatGPT-like review/synthesis.

## 16. Skill / rule import and performance-based reuse

Default coder/reviewer guidance now includes `skill.karpathy_coding_guidelines.v1` under `skills/karpathy_coding_guidelines`.
It is intentionally compact: think first, keep changes simple, make surgical edits, and verify before claiming success.

Runtime usage:

```text
/skill list
/skill score
/skill import /path/to/skill_dir
/skill import /path/to/package.json
/rule import /path/to/rules.json
```

External imports are local-path or pasted-JSON only by default. Remote URL import is disabled so operators can download, inspect, and approve third-party skill/rule packages before they affect the runtime.

A combined skill/rule package can look like this:

```json
{
  "skills": [
    {
      "id": "skill.example_review.v1",
      "slug": "example_review",
      "name": "Example Review Skill",
      "description": "Compact review checklist.",
      "compatible_roles": ["reviewer"],
      "instructions_ref": "SKILL.md"
    }
  ],
  "rules": [
    {"text": "Do not perform unrelated refactors.", "topic": "agent_behavior"}
  ]
}
```

Reuse scoring is stored in `config/skill_rule_performance.json` or `SKILL_RULE_PERFORMANCE_PATH`.
The skill resolver merges those scores into skill ranking metadata, so skills with higher success/verification and lower override/regression rates are selected more often for matching role/task/model contexts.


## Semantic Board v1

`ddalggak` now mirrors memory/skill/rule-like runtime objects into a typed Semantic Board. Markdown and HTML are treated as projections; the board stores machine-readable cards, links, and event logs.

Default global board path:

```env
SEMANTIC_BOARD_DIR=config/semantic_board
```

Run-scoped boards live under:

```text
runs/<jobId>/local_memory/semantic_board/
  board_manifest.json
  cards.json
  links.json
  board_events.jsonl
```

Useful Telegram commands:

```text
/board
/board cards [limit] [skill_card|rule_card|memory_card]
/board mirror
/board export
/board import <local_path|json>
/board projection [card_type,...]
```

Skill/rule imports are mirrored automatically. The default Karpathy coding guidelines skill is mirrored from the local skill catalog when `/board` or `/board mirror` is called.


## Primitive Context Substrate / MVCC

`ddalggak` now has an experimental primitive context substrate that sits underneath Semantic Board, skill/rule performance, memory materialization, and future RDB/VDB/HTML projections. The substrate is intentionally append-only on the write hot path:

```text
Agent/User/Tool write intent
→ light schema/lane check
→ append context operation or proposal
→ publish MVCC snapshot pointer
→ async projection/materialization refresh
```

Default local paths:

```text
config/context_substrate/
  substrate_manifest.json
  operations.jsonl
  proposals.jsonl
  atoms_current.json
  links_current.json
  snapshots/ctx_*.json
  projection_cache/*.json
```

Run-scoped paths live under `runs/<jobId>/local_memory/context_substrate/`.

Telegram commands:

```text
/context
/context ops [limit]
/context proposals [limit]
/context projection [role] [task_type] [goal]
/context mirror-board
/context mirror-to-board
/context compact
```

Fast/normal low-risk writes commit directly. High-risk writes such as learned rule activation, package publish, canonical memory switch, destructive writes, or high-risk external/financial claims are stored as proposals and require review. RDB/VDB/HTML/Semantic Board views should write back through structured context operations rather than directly mutating the source of truth.


For the idle-only discovery and benchmark lifecycle, see `docs/MODEL_DISCOVERY_LIFECYCLE.md`.
