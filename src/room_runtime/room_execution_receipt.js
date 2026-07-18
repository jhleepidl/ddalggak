import { cleanText, sha256 } from './fs_utils.js';
import { stableJson } from './room_contract.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function manifestMap(rows = []) {
  return new Map(asArray(rows).map((row) => [String(row?.path || ''), row]).filter(([key]) => key));
}

export function hashWorkspaceManifest(rows = []) {
  return sha256(stableJson(asArray(rows)));
}

export function diffWorkspaceManifests(before = [], after = []) {
  const left = manifestMap(before);
  const right = manifestMap(after);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = [];
  for (const filePath of paths) {
    const previous = left.get(filePath);
    const current = right.get(filePath);
    if (!previous) changes.push({ path: filePath, change: 'added', after: current });
    else if (!current) changes.push({ path: filePath, change: 'deleted', before: previous });
    else if (stableJson(previous) !== stableJson(current)) changes.push({ path: filePath, change: 'modified', before: previous, after: current });
  }
  return changes;
}

function normalizeValidation(value = {}, index = 0) {
  const row = typeof value === 'string' ? { name: value } : asObject(value);
  const name = cleanText(row.name || row.command || row.check || `validation-${index + 1}`).slice(0, 1000);
  if (!name) return null;
  return {
    name,
    status: cleanText(row.status || 'reported').toLowerCase().slice(0, 80),
    ...(cleanText(row.evidence || row.summary || row.output || '') ? { evidence: cleanText(row.evidence || row.summary || row.output).slice(0, 4000) } : {}),
  };
}

function normalizeArtifact(value = {}, index = 0) {
  const row = typeof value === 'string' ? { path: value } : asObject(value);
  const location = cleanText(row.path || row.uri || row.location || row.name || '').slice(0, 4000);
  if (!location) return null;
  return {
    artifact_id: cleanText(row.artifact_id || row.id || `artifact-${index + 1}`).slice(0, 160),
    location,
    kind: cleanText(row.kind || 'file').toLowerCase().slice(0, 80),
    ...(cleanText(row.description || '') ? { description: cleanText(row.description).slice(0, 2000) } : {}),
  };
}

function normalizeClaim(value = {}, index = 0) {
  const row = typeof value === 'string' ? { claim: value } : asObject(value);
  const claim = cleanText(row.claim || row.text || row.summary || '').slice(0, 3000);
  if (!claim) return null;
  return {
    claim_id: cleanText(row.claim_id || row.id || `claim-${index + 1}`).slice(0, 160),
    claim,
    evidence: asArray(row.evidence).map((item) => cleanText(item).slice(0, 2000)).filter(Boolean).slice(0, 16),
  };
}

export function buildExecutionReceipt({
  spec = {},
  stage = {},
  parsed = {},
  execution = {},
  streamSummary = {},
  projectedEvents = [],
  startedAt = '',
  completedAt = '',
} = {}) {
  const structured = asObject(parsed.structured);
  const workspaceEvidence = asObject(execution.workspace_evidence);
  const beforeManifest = asArray(workspaceEvidence.canonical_before);
  const afterManifest = asArray(workspaceEvidence.canonical_after);
  const fileChanges = diffWorkspaceManifests(beforeManifest, afterManifest).slice(0, 2000);
  const result = asObject(execution.result);
  const receipt = {
    schema_version: 'ai_rooms.execution_receipt/v1',
    receipt_id: `${cleanText(spec.run_id)}:${cleanText(stage.stage_id)}`,
    run_id: cleanText(spec.run_id),
    room_id: cleanText(spec.room_id),
    stage_id: cleanText(stage.stage_id),
    stage_kind: cleanText(stage.kind || stage.stage_id),
    role: cleanText(stage.role),
    provider: cleanText(stage.provider),
    provider_adapter_version: 'room_provider_adapter/v1',
    requested_model: result.requested_model || null,
    resolved_model: result.resolved_model || null,
    input_contract: {
      schema_version: spec.room_contract?.schema_version || null,
      revision: spec.room_contract?.contract_revision || null,
      hash: spec.room_contract?.contract_hash || spec.contract_hash || null,
    },
    capability_contract: {
      required: asArray(stage.required_capabilities),
      access: stage.access || null,
    },
    timing: {
      started_at: startedAt || null,
      completed_at: completedAt || new Date().toISOString(),
      duration_ms: Number(result.durationMs || 0) || null,
    },
    process: {
      ok: result.ok === true,
      exit_code: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null,
      timed_out: result.timedOut === true,
      aborted: result.aborted === true,
      output_event_count: Number(result.outputEventCount || streamSummary.chunk_count || 0),
    },
    workspace: {
      canonical_root: execution.canonical_workspace_root || spec.workspace_root || null,
      execution_root: execution.execution_root || null,
      snapshot: execution.snapshot === true,
      revision_before: workspaceEvidence.canonical_revision_before || hashWorkspaceManifest(beforeManifest),
      revision_after: workspaceEvidence.canonical_revision_after || hashWorkspaceManifest(afterManifest),
      files_changed: fileChanges,
    },
    observed_activity: asArray(projectedEvents).slice(0, 200).map((event) => ({
      kind: cleanText(event.kind || event.output_kind).slice(0, 80),
      message: cleanText(event.message).slice(0, 1000),
      stream: cleanText(event.stream).slice(0, 20),
      sequence: Number(event.sequence || 0),
    })),
    reported: {
      contract_observed: parsed.contract_observed === true,
      summary: cleanText(structured.summary).slice(0, 4000),
      decisions: asArray(structured.decisions).map((item) => cleanText(item).slice(0, 2400)).filter(Boolean).slice(0, 64),
      validations: asArray(structured.validations).map(normalizeValidation).filter(Boolean).slice(0, 64),
      artifacts: asArray(structured.artifacts).map(normalizeArtifact).filter(Boolean).slice(0, 64),
      claims: asArray(structured.claims).map(normalizeClaim).filter(Boolean).slice(0, 64),
      blocking_issues: asArray(structured.blocking_issues).map((item) => cleanText(item).slice(0, 2400)).filter(Boolean).slice(0, 64),
      resolved_issues: asArray(structured.resolved_issues).map((item) => cleanText(item).slice(0, 2400)).filter(Boolean).slice(0, 64),
      next_actions: asArray(structured.next_actions).map((item) => cleanText(item).slice(0, 2400)).filter(Boolean).slice(0, 64),
      checkpoint: asObject(structured.checkpoint),
    },
    status: structured.blocking_issues?.length ? 'completed_with_blockers' : parsed.contract_observed ? 'completed' : 'completed_unstructured',
    raw_result_file: execution.raw_file || null,
    created_at: completedAt || new Date().toISOString(),
  };
  receipt.receipt_hash = sha256(stableJson(receipt));
  return receipt;
}

export function summarizeExecutionReceipt(receipt = {}) {
  const row = asObject(receipt);
  return {
    receipt_id: row.receipt_id || null,
    stage_id: row.stage_id || null,
    provider: row.provider || null,
    status: row.status || null,
    receipt_hash: row.receipt_hash || null,
    workspace_revision_after: row.workspace?.revision_after || null,
    file_change_count: asArray(row.workspace?.files_changed).length,
    validation_count: asArray(row.reported?.validations).length,
    artifact_count: asArray(row.reported?.artifacts).length,
    blocker_count: asArray(row.reported?.blocking_issues).length,
  };
}
