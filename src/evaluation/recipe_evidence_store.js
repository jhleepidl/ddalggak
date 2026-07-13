import fs from 'node:fs';
import path from 'node:path';

function clean(value = '', maxLen = 1200) {
  const text = String(value ?? '').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }

export function resolveRecipeEvidencePath({ evidencePath = '', baseDir = '' } = {}) {
  const explicit = clean(evidencePath || process.env.RECIPE_EVIDENCE_PATH || '', 1200);
  if (explicit) return path.resolve(explicit);
  return path.resolve(baseDir || process.cwd(), 'runs', 'recipe_evidence.json');
}

export function readRecipeEvidenceStore(options = {}) {
  const filePath = resolveRecipeEvidencePath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      schema_version: 'ai_rooms.recipe_evidence_store/v1',
      updated_at: clean(parsed.updated_at || nowIso(), 100),
      recipes: asObject(parsed.recipes),
      __file: filePath,
    };
  } catch {
    return { schema_version: 'ai_rooms.recipe_evidence_store/v1', updated_at: nowIso(), recipes: {}, __file: filePath };
  }
}

function writeRecipeEvidenceStore(store, options = {}) {
  const filePath = resolveRecipeEvidencePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    schema_version: 'ai_rooms.recipe_evidence_store/v1',
    updated_at: nowIso(),
    recipes: asObject(store.recipes),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { ...payload, __file: filePath };
}

export function recordRecipeEvaluationObservation({ recipeIds = [], result = {}, evidencePath = '', baseDir = '' } = {}) {
  const ids = [...new Set(asArray(recipeIds).map((value) => clean(value, 160)).filter(Boolean))];
  if (ids.length === 0 || result?.dry_run === true) return null;
  const runtimeSignature = clean(result.runtime_signature, 1200);
  if (!runtimeSignature) return null;
  const store = readRecipeEvidenceStore({ evidencePath, baseDir });
  for (const recipeId of ids) {
    const recipeState = asObject(store.recipes[recipeId]);
    const signatures = asObject(recipeState.runtime_signatures);
    const current = asObject(signatures[runtimeSignature]);
    const liveRuns = Math.max(0, Number(current.live_runs || 0)) + 1;
    const passedRuns = Math.max(0, Number(current.passed_runs || 0)) + (result.passed === true ? 1 : 0);
    const scoreTotal = Number(current.score_total || 0) + Number(result.score || 0);
    const deterministicChecks = asArray(result?.deterministic_evaluation?.checks);
    const policyViolations = Math.max(0, Number(current.policy_violations || 0))
      + deterministicChecks.filter((row) => row?.passed === false && /forbidden|policy|approval/i.test(String(row?.name || ''))).length;
    signatures[runtimeSignature] = {
      runtime_signature: runtimeSignature,
      provider: clean(result.provider, 80),
      model: clean(result.model, 240),
      reasoning_effort: clean(result.reasoning_effort, 80),
      cli_version: clean(result.cli_version, 300),
      live_runs: liveRuns,
      passed_runs: passedRuns,
      success_rate: liveRuns > 0 ? passedRuns / liveRuns : 0,
      average_score: liveRuns > 0 ? scoreTotal / liveRuns : 0,
      score_total: scoreTotal,
      policy_violations: policyViolations,
      last_evaluation_id: clean(result.evaluation_id, 220),
      last_run_id: clean(result.run_id, 300),
      last_observed_at: clean(result.completed_at || nowIso(), 100),
    };
    store.recipes[recipeId] = {
      latest_runtime_signature: runtimeSignature,
      runtime_signatures: signatures,
    };
  }
  return writeRecipeEvidenceStore(store, { evidencePath, baseDir });
}

export function getCurrentRecipeEvidence(recipeId = '', options = {}) {
  const id = clean(recipeId, 160);
  if (!id) return null;
  const store = readRecipeEvidenceStore(options);
  const recipeState = asObject(store.recipes[id]);
  const signature = clean(recipeState.latest_runtime_signature, 1200);
  const row = signature ? asObject(asObject(recipeState.runtime_signatures)[signature]) : null;
  if (!row || Object.keys(row).length === 0) return null;
  return {
    source: 'local_live_scenario_runtime',
    current: true,
    runtime_signature: signature,
    provider: clean(row.provider, 80),
    model: clean(row.model, 240),
    reasoning_effort: clean(row.reasoning_effort, 80),
    cli_version: clean(row.cli_version, 300),
    live_runs: Math.max(0, Number(row.live_runs || 0)),
    passed_runs: Math.max(0, Number(row.passed_runs || 0)),
    success_rate: Number(row.success_rate || 0),
    average_score: Number(row.average_score || 0),
    policy_violations: Math.max(0, Number(row.policy_violations || 0)),
    last_observed_at: clean(row.last_observed_at, 100),
  };
}
