import { installTeamBlueprintToSession } from './team_blueprint_runtime.js';
import { buildHarnessPackageRef, normalizeHarnessPackage, normalizeHarnessRuntimePolicy } from '../shared/openharness_contracts.js';
import { normalizeRuntimeExecutionPolicy } from './runtime_execution_policy.js';
import { ensureRuntimeBehavior } from './runtime_behavior_resolver.js';
import { attachRuntimeHarnessState, ensureRuntimeSessionState } from './runtime_session_state.js';

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function cleanText(value = '', { maxLen = 256 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function cleanState(value = 'pending') {
  return String(value || '').trim().toLowerCase() === 'active' ? 'active' : 'pending';
}

function nowIso() {
  return new Date().toISOString();
}

function hasRuntimeExecutionConfig(value = null) {
  const row = asObject(value);
  return Object.keys(row).some((key) => {
    const nested = row[key];
    return nested && typeof nested === 'object' ? Object.keys(nested).length > 0 : nested != null;
  });
}

function resolveRuntimeExecutionFallback(runtime = null, runtimePolicy = null) {
  const policy = asObject(runtimePolicy);
  const runtimeExecution = asObject(policy.runtime_execution || policy.runtimeExecution);
  if (!hasRuntimeExecutionConfig(runtimeExecution)) return null;
  const current = asObject(runtime?.runtime_execution || runtime?.runtimeExecution || runtime?.runtime_execution_policy || runtime?.runtimeExecutionPolicy);
  if (hasRuntimeExecutionConfig(current)) return null;
  return normalizeRuntimeExecutionPolicy(runtimeExecution);
}


function summarizeSkillPackages(items = []) {
  const rows = Array.isArray(items) ? items : [];
  return rows.slice(0, 32).map((item) => {
    const row = asObject(item);
    return {
      id: cleanText(row.id || row.skill_id || row.skillId || '', { maxLen: 128 }) || undefined,
      name: cleanText(row.name || row.title || '', { maxLen: 160 }) || undefined,
      version: cleanText(row.version || '', { maxLen: 64 }) || undefined,
    };
  }).filter((row) => row.id || row.name);
}

export function getInstalledHarnessPackageState(sessionStore, chatId) {
  if (!sessionStore || typeof sessionStore.get !== 'function') return {};
  return asObject(sessionStore.get(chatId)?.openharness_install_state);
}

export function applyInstalledHarnessPackageToRuntime(runtime = null, { installState = null } = {}) {
  if (!runtime || typeof runtime !== 'object') return runtime;
  const state = asObject(installState);
  if (Object.keys(state).length === 0) {
    runtime.openharnessInstallState = state;
    return runtime;
  }
  const packageRef = asObject(state.package_ref);
  if (Object.keys(packageRef).length > 0) {
    runtime.harnessPackageRef = packageRef;
    runtime.harnessPackage = packageRef;
  }
  if (state.harness_spec && typeof state.harness_spec === 'object') runtime.harnessSpec = state.harness_spec;
  if (state.runtime_policy && typeof state.runtime_policy === 'object') runtime.harnessRuntimePolicy = state.runtime_policy;
  if (state.harness_summary && typeof state.harness_summary === 'object') runtime.harnessSummary = state.harness_summary;
  if (state.execution_binding && typeof state.execution_binding === 'object') runtime.harnessExecutionBinding = state.execution_binding;
  if (state.trace_contract && typeof state.trace_contract === 'object') runtime.harnessTraceContract = state.trace_contract;
  if (state.sync_contract && typeof state.sync_contract === 'object') runtime.harnessSyncContract = state.sync_contract;
  const runtimeExecutionFallback = resolveRuntimeExecutionFallback(runtime, state.runtime_policy);
  if (runtimeExecutionFallback) {
    runtime.runtime_execution = runtimeExecutionFallback;
    runtime.runtimeExecution = runtimeExecutionFallback;
    runtime.runtimeExecutionPolicy = runtimeExecutionFallback;
  }
  runtime.openharnessInstallState = state;
  attachRuntimeHarnessState(runtime, { packageRef, runtimePolicy: state.runtime_policy });
  ensureRuntimeBehavior(runtime, { runtimePolicy: state.runtime_policy });
  ensureRuntimeSessionState(runtime, { runtimePolicy: state.runtime_policy });
  return runtime;
}

export async function installHarnessPackageToSession({ sessionStore, chatId, harnessPackage = {}, runtime = null, applyState = 'pending', source = 'package_import' } = {}) {
  if (!sessionStore || typeof sessionStore.upsert !== 'function' || typeof sessionStore.get !== 'function') {
    throw new Error('installHarnessPackageToSession requires sessionStore');
  }
  const pkg = normalizeHarnessPackage(harnessPackage);
  const cleanApplyState = cleanState(applyState || pkg?.execution_binding?.apply_state);
  const teamInstall = await installTeamBlueprintToSession({
    sessionStore,
    chatId,
    manifest: pkg.team_manifest || {},
    runtime,
    applyState: cleanApplyState,
  });

  const runtimePolicy = normalizeHarnessRuntimePolicy(pkg, { fallbackPackage: pkg });

  const installState = {
    package_ref: buildHarnessPackageRef(pkg),
    package_hash: pkg.package_hash,
    apply_state: cleanApplyState,
    source: cleanText(source || 'package_import', { maxLen: 96 }) || 'package_import',
    installed_at: nowIso(),
    metadata: asObject(pkg.metadata),
    compatibility: asObject(pkg.compatibility),
    runtime_policy: runtimePolicy,
    execution_binding: asObject(pkg.execution_binding),
    trace_contract: asObject(pkg.trace_contract),
    sync_contract: asObject(pkg.sync_contract),
    harness_spec: asObject(pkg.harness_spec),
    harness_summary: asObject(pkg.harness_summary),
    skill_packages: summarizeSkillPackages(pkg.skill_packages),
  };

  sessionStore.upsert(chatId, (session) => ({
    ...(session && typeof session === 'object' ? session : {}),
    openharness_package_ref: installState.package_ref,
    openharness_install_state: installState,
    openharness_harness_spec: installState.harness_spec,
    openharness_runtime_policy: installState.runtime_policy,
    openharness_harness_summary: installState.harness_summary,
    openharness_last_installed_at: installState.installed_at,
  }));

  if (runtime) applyInstalledHarnessPackageToRuntime(runtime, { installState });
  return {
    package: pkg,
    package_ref: installState.package_ref,
    apply_state: cleanApplyState,
    install_state: installState,
    team_install: teamInstall,
    session_state: sessionStore.get(chatId) || {},
  };
}

export async function pullHarnessPackageToSession({ client = null, threadId = '', sessionStore, chatId, runtime = null, applyState = 'pending', source = 'goc_pull' } = {}) {
  if (!client || typeof client.getHarnessPackage !== 'function') {
    throw new Error('pullHarnessPackageToSession requires client.getHarnessPackage');
  }
  const pkg = await client.getHarnessPackage(threadId);
  return await installHarnessPackageToSession({ sessionStore, chatId, harnessPackage: pkg, runtime, applyState, source });
}
