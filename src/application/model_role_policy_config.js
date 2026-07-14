import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') { return String(value ?? '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export const CANONICAL_MODEL_ROLES = Object.freeze([
  'concierge_router',
  'source_grounder',
  'code_executor',
  'verifier_critic',
  'idle_structurer',
  'delivery_synthesizer',
]);

const ROLE_SET = new Set(CANONICAL_MODEL_ROLES);

function normalizeRoleName(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeAssignment(role, rawAssignment = {}) {
  const assignment = asObject(rawAssignment);
  const provider = clean(assignment.provider).toLowerCase();
  const model = clean(assignment.model);
  const nodeId = clean(assignment.node_id || assignment.nodeId);
  const selection = clean(assignment.selection || assignment.strategy || '');
  if (!provider && !model && !nodeId && !selection) {
    throw new Error(`Model role ${role} requires provider, model, node_id, or selection`);
  }
  return {
    provider,
    model,
    node_id: nodeId,
    selection: selection || undefined,
  };
}

export function normalizeModelRolePolicyDocument(rawDocument = {}, { sourcePath = '', sha256 = '' } = {}) {
  const raw = asObject(rawDocument);
  const canonicalRoles = asObject(raw.roles);
  const descriptorAssignments = asObject(raw.assignments);
  const assignmentArray = Array.isArray(raw.default_assignment)
    ? Object.fromEntries(raw.default_assignment
        .map((row) => [normalizeRoleName(row?.role || row?.model_role || ''), row])
        .filter(([role]) => role))
    : {};
  const roleSource = Object.keys(canonicalRoles).length
    ? canonicalRoles
    : (Object.keys(descriptorAssignments).length
      ? descriptorAssignments
      : (Object.keys(assignmentArray).length ? assignmentArray : raw));
  const assignments = {};
  for (const [rawRole, rawAssignment] of Object.entries(roleSource)) {
    if (rawRole.startsWith('_')) continue;
    const role = normalizeRoleName(rawRole);
    if (!ROLE_SET.has(role)) throw new Error(`Unsupported model role in model-role policy: ${rawRole}`);
    assignments[role] = normalizeAssignment(role, rawAssignment);
  }
  if (!Object.keys(assignments).length) throw new Error('Model-role policy contains no model-role assignments');

  const governance = {
    room_override_mode: 'role_by_role_merge',
    room_policy_learning: 'proposal_then_trial_then_approval',
    durable_model_policy_change: 'trial_then_user_or_goc_approval',
    provider_secret_export: 'never',
    ...asObject(raw.governance),
  };
  const policyId = clean(raw.policy_id || raw.policyId || (sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : 'ad_hoc_model_role_policy'));
  const scope = clean(raw.scope || 'ad_hoc');
  const revision = Number.isFinite(Number(raw.revision)) ? Math.max(1, Math.floor(Number(raw.revision))) : 1;
  const defaultAssignment = Object.entries(assignments).map(([role, assignment]) => ({
    role,
    provider: assignment.provider,
    model: assignment.model,
    node_id: assignment.node_id,
    selection: assignment.selection,
    purpose: `Model-role assignment from ${policyId}`,
  }));

  return {
    schema_version: 'ddalggak.model_role_policy_descriptor/v1',
    path: sourcePath ? path.resolve(sourcePath) : null,
    sha256: clean(sha256) || null,
    policy_id: policyId,
    scope,
    revision,
    parent_policy_id: clean(raw.parent_policy_id || raw.parentPolicyId) || null,
    title: clean(raw.title) || policyId,
    strategy: clean(raw.strategy || 'room_scoped_model_portfolio'),
    assignments,
    governance,
    model_policy: {
      schema_version: 'ddalggak.room_model_role_policy/v1',
      policy_id: policyId,
      policy_scope: scope,
      policy_revision: revision,
      parent_policy_id: clean(raw.parent_policy_id || raw.parentPolicyId) || null,
      strategy: clean(raw.strategy || 'room_scoped_model_portfolio'),
      default_assignment: defaultAssignment,
      governance,
    },
  };
}

export function loadModelRolePolicyFile(filePath = '') {
  const resolvedPath = path.resolve(filePath);
  const bytes = fs.readFileSync(resolvedPath);
  const raw = JSON.parse(bytes.toString('utf8'));
  return normalizeModelRolePolicyDocument(raw, {
    sourcePath: resolvedPath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

export function applyModelRolePolicyToEnv(policy = {}, env = process.env) {
  const assignments = asObject(policy.assignments || policy);
  for (const [role, rawAssignment] of Object.entries(assignments)) {
    const assignment = asObject(rawAssignment);
    const prefix = `DDALGGAK_MODEL_ROLE_${String(role).toUpperCase()}_`;
    const provider = clean(assignment.provider).toLowerCase();
    const model = clean(assignment.model);
    const nodeId = clean(assignment.node_id || assignment.nodeId);
    if (provider) env[`${prefix}PROVIDER`] = provider;
    else delete env[`${prefix}PROVIDER`];
    if (model) env[`${prefix}MODEL`] = model;
    else delete env[`${prefix}MODEL`];
    if (nodeId) env[`${prefix}NODE_ID`] = nodeId;
    else delete env[`${prefix}NODE_ID`];
  }
  return policy;
}
