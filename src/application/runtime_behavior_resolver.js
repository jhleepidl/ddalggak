import {
  readHarnessApprovalPolicy,
  readHarnessAuditFlags,
  readHarnessHumanInterfacePolicy,
  readHarnessMotifPolicy,
  readHarnessExecutionModePolicy,
  readHarnessParticipantPolicy,
  readHarnessToolPolicy,
  resolveHarnessRuntimePolicy,
} from './harness_runtime_behavior.js';
import { normalizeRuntimeExecutionPolicy } from './runtime_execution_policy.js';

export const OPENHARNESS_RUNTIME_BEHAVIOR_SCHEMA_VERSION = 'openharness.runtime_behavior/v1';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function resolveRuntimeBehavior(source = null) {
  const policy = resolveHarnessRuntimePolicy(source);
  return {
    schema_version: OPENHARNESS_RUNTIME_BEHAVIOR_SCHEMA_VERSION,
    runtime_policy: policy,
    audit: readHarnessAuditFlags(policy),
    tool: readHarnessToolPolicy(policy),
    approval: readHarnessApprovalPolicy(policy),
    participant: readHarnessParticipantPolicy(policy),
    human_interface: readHarnessHumanInterfacePolicy(policy),
    motif: readHarnessMotifPolicy(policy),
    execution_mode: readHarnessExecutionModePolicy(policy),
    runtime_execution: normalizeRuntimeExecutionPolicy(asObject(policy.runtime_execution || policy.runtimeExecution)),
  };
}

export function ensureRuntimeBehavior(runtime = null, { runtimePolicy = null } = {}) {
  const target = asObject(runtime);
  const behavior = resolveRuntimeBehavior(runtimePolicy || target);
  target.runtimeBehavior = behavior;
  target.runtime_behavior = behavior;
  return behavior;
}

export function resolveRuntimePolicyForRuntime(runtime = null, fallback = null) {
  return resolveHarnessRuntimePolicy(fallback || runtime || null);
}
