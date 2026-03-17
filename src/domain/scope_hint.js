import {
  normalizeScopeHintCore,
  defaultScopeHintForAgent,
  defaultScopeHintForRole,
  resolveEffectiveScopeHint,
  validateScopeHint,
} from './scope_hint_core.js';

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

export function normalizeScopeHintSpec(raw = {}, { fallbackBudget = 1200 } = {}) {
  const row = asObject(raw);
  if (Object.keys(row).length === 0) return null;
  return normalizeScopeHintCore(row, { fallbackBudget });
}

export function normalizeScopeHintCompat(raw = {}) {
  const row = asObject(raw);
  const scope = asObject(row.scope || row.scope_hint || row.scopeHint);
  const lens = asObject(row.lens || row.lens_spec || row.lensSpec);
  const base = Object.keys(scope).length > 0 ? scope : lens;
  if (Object.keys(base).length === 0) return null;
  const fallbackBudget = Number(base.budget_tokens ?? base.budgetTokens) || 1200;
  return normalizeScopeHintSpec(base, { fallbackBudget });
}

export function attachScopeHintCompat(target = {}, scopeHint = null) {
  const row = target && typeof target === 'object' ? { ...target } : {};
  if (!scopeHint || typeof scopeHint !== 'object') return row;
  row.scope = scopeHint;
  row.lens = scopeHint;
  return row;
}

export {
  defaultScopeHintForAgent,
  defaultScopeHintForRole,
  resolveEffectiveScopeHint,
  validateScopeHint,
};
