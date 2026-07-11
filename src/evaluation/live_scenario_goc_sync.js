import { GocClient } from '../goc_client.js';

function sanitizeRun(run = {}) {
  return {
    schema_version: run.schema_version,
    evaluation_id: run.evaluation_id,
    run_id: run.run_id,
    scenario_id: run.scenario_id,
    scenario_title: run.scenario_title,
    harness_variant_id: run.harness_variant_id,
    harness_variant_hash: run.harness_variant_hash,
    provider: run.provider,
    model: run.model,
    reasoning_effort: run.reasoning_effort,
    cli_version: run.cli_version,
    runtime_signature: run.runtime_signature,
    repetition: run.repetition,
    dry_run: run.dry_run === true,
    passed: run.passed === true,
    score: Number(run.score || 0),
    duration_ms: Number(run.duration_ms || 0),
    workspace_diff: run.workspace_diff || {},
    deterministic_evaluation: run.deterministic_evaluation || {},
    semantic_evaluation: run.semantic_evaluation || null,
    provider_result: {
      ok: run.provider_result?.ok === true,
      exit_code: run.provider_result?.exit_code ?? null,
      duration_ms: Number(run.provider_result?.duration_ms || 0),
      usage: run.provider_result?.usage || {},
      cost_usd: Number(run.provider_result?.cost_usd || 0),
      llm_trace_id: run.provider_result?.llm_trace_id || null,
    },
    completed_at: run.completed_at,
  };
}

export function buildHarnessEvaluationSyncPayload(summary = {}) {
  return {
    schema_version: summary.schema_version,
    evaluation_id: summary.evaluation_id,
    suite: summary.suite,
    status: summary.status,
    started_at: summary.started_at,
    finished_at: summary.finished_at,
    scenario_count: Number(summary.scenario_count || 0),
    total_run_count: Number(summary.total_run_count || 0),
    passed_run_count: Number(summary.passed_run_count || 0),
    failed_run_count: Number(summary.failed_run_count || 0),
    variant_results: Array.isArray(summary.variant_results) ? summary.variant_results : [],
    recommendation: summary.recommendation || null,
    runs: Array.isArray(summary.runs) ? summary.runs.map(sanitizeRun) : [],
  };
}

export async function syncHarnessEvaluationToGoc(summary = {}, { client = null, optional = true } = {}) {
  let target = client;
  try {
    target = target || new GocClient();
  } catch (error) {
    if (optional) return { synced: false, skipped: true, error: String(error?.message || error) };
    throw error;
  }
  if (typeof target.ingestHarnessEvaluationRun !== 'function') {
    if (optional) return { synced: false, skipped: true, error: 'GocClient does not support harness evaluation ingest' };
    throw new Error('GocClient does not support harness evaluation ingest');
  }
  try {
    const result = await target.ingestHarnessEvaluationRun(buildHarnessEvaluationSyncPayload(summary));
    return { synced: true, result };
  } catch (error) {
    if (optional) return { synced: false, skipped: false, error: String(error?.message || error) };
    throw error;
  }
}
