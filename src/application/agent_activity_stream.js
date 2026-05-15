import fs from 'node:fs';
import path from 'node:path';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function safeAppendJsonl(filePath = '', row = {}) {
  const target = path.resolve(String(filePath || ''));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(row)}\n`, 'utf8');
  return target;
}

export function appendAgentActivityEvent({ jobDir = '', event = '', agentId = '', roleId = '', provider = '', model = '', summary = '', metadata = {} } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir || !event) return null;
  const row = {
    ts: new Date().toISOString(),
    event: clean(event),
    agent_id: clean(agentId) || undefined,
    role_id: clean(roleId) || undefined,
    provider: clean(provider) || undefined,
    model: clean(model) || undefined,
    summary: clean(summary) || undefined,
    metadata: asObject(metadata),
  };
  safeAppendJsonl(path.join(cleanJobDir, 'local_memory', 'agent_activity.jsonl'), row);
  return row;
}

export function appendAgentHandoffEvent({ jobDir = '', fromAgent = '', toAgent = '', messageType = 'handoff', summary = '', payload = {} } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir || (!fromAgent && !toAgent)) return null;
  const row = {
    ts: new Date().toISOString(),
    from_agent: clean(fromAgent) || undefined,
    to_agent: clean(toAgent) || undefined,
    message_type: clean(messageType) || 'handoff',
    summary: clean(summary) || undefined,
    payload: asObject(payload),
  };
  safeAppendJsonl(path.join(cleanJobDir, 'local_memory', 'agent_handoffs.jsonl'), row);
  return row;
}

export function appendExecutionPolicyResolution({ jobDir = '', source = '', agentId = '', roleId = '', runtimeExecutionPolicy = {}, requirements = {}, decision = '' } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return null;
  const row = {
    ts: new Date().toISOString(),
    source: clean(source) || 'runtime',
    agent_id: clean(agentId) || undefined,
    role_id: clean(roleId) || undefined,
    decision: clean(decision) || undefined,
    execution_mode: clean(runtimeExecutionPolicy?.execution_mode || runtimeExecutionPolicy?.executionMode || runtimeExecutionPolicy?.task_loop?.execution_mode || runtimeExecutionPolicy?.taskLoop?.executionMode || '') || undefined,
    workspace_write: clean(runtimeExecutionPolicy?.workspace_write || runtimeExecutionPolicy?.workspaceWrite || runtimeExecutionPolicy?.task_loop?.workspace_write || runtimeExecutionPolicy?.taskLoop?.workspaceWrite || '') || undefined,
    artifact_delivery: clean(runtimeExecutionPolicy?.artifact_delivery || runtimeExecutionPolicy?.artifactDelivery || runtimeExecutionPolicy?.task_loop?.artifact_delivery || runtimeExecutionPolicy?.taskLoop?.artifactDelivery || '') || undefined,
    legacy_manual_fallback: clean(runtimeExecutionPolicy?.legacy_manual_fallback || runtimeExecutionPolicy?.legacyManualFallback || runtimeExecutionPolicy?.task_loop?.legacy_manual_fallback || runtimeExecutionPolicy?.taskLoop?.legacyManualFallback || '') || undefined,
    requirements: asObject(requirements),
  };
  safeAppendJsonl(path.join(cleanJobDir, 'local_memory', 'execution_policy_resolutions.jsonl'), row);
  return row;
}
