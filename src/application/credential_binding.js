const credentialVault = new Map();

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function normalizeKey(value = '') {
  return clean(value).toUpperCase();
}

function maskSecret(value = '') {
  const raw = clean(value);
  if (!raw) return '';
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${'*'.repeat(Math.max(4, raw.length - 4))}${raw.slice(-4)}`;
}

function normalizeBindingEntry(raw = {}) {
  const row = asObject(raw);
  const credentialKey = normalizeKey(row.credential_key || row.credentialKey || row.key);
  if (!credentialKey) return null;
  const boundAt = clean(row.bound_at || row.boundAt || row.updated_at || row.updatedAt || new Date().toISOString()) || new Date().toISOString();
  return {
    credential_key: credentialKey,
    source: clean(row.source || 'telegram_command') || 'telegram_command',
    delivery_method: clean(row.delivery_method || row.deliveryMethod || 'session_vault') || 'session_vault',
    last4: clean(row.last4 || ''),
    masked_value: clean(row.masked_value || row.maskedValue || ''),
    bound_at: boundAt,
    updated_at: clean(row.updated_at || row.updatedAt || boundAt) || boundAt,
  };
}

export function normalizeCredentialBindingState(raw = {}) {
  const row = asObject(raw);
  const bindings = [];
  const seen = new Set();
  for (const item of asArray(row.bindings || row.items || row.credentials)) {
    const normalized = normalizeBindingEntry(item);
    if (!normalized) continue;
    const key = normalized.credential_key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(normalized);
  }
  return {
    kind: 'credential_binding_state',
    version: 1,
    bindings,
    bound_keys: bindings.map((entry) => entry.credential_key),
    summary: {
      bound_count: bindings.length,
    },
    updated_at: clean(row.updated_at || row.updatedAt || new Date().toISOString()) || new Date().toISOString(),
  };
}

function getVaultBucket(chatId) {
  const key = clean(chatId);
  if (!key) return null;
  if (!credentialVault.has(key)) credentialVault.set(key, new Map());
  return credentialVault.get(key);
}

export function getBoundCredentialValue(chatId, credentialKey = '') {
  const key = normalizeKey(credentialKey);
  if (!key) return '';
  const bucket = getVaultBucket(chatId);
  const stored = bucket?.get(key);
  if (stored && typeof stored.value === 'string' && stored.value) return stored.value;
  return clean(process.env[key]);
}

export function hasBoundCredential(chatId, credentialKey = '') {
  return !!getBoundCredentialValue(chatId, credentialKey);
}

export function bindCredentialForChat(sessionStore, chatId, credentialKey = '', secretValue = '', { source = 'telegram_command', deliveryMethod = 'session_vault' } = {}) {
  const key = normalizeKey(credentialKey);
  const secret = clean(secretValue);
  if (!key) throw new Error('credential_key is required');
  if (!secret) throw new Error('credential value is required');
  const bucket = getVaultBucket(chatId);
  if (!bucket) throw new Error('chatId is required');
  const now = new Date().toISOString();
  const entry = {
    credential_key: key,
    value: secret,
    source: clean(source) || 'telegram_command',
    delivery_method: clean(deliveryMethod) || 'session_vault',
    masked_value: maskSecret(secret),
    last4: secret.slice(-4),
    bound_at: now,
    updated_at: now,
  };
  bucket.set(key, entry);
  process.env[key] = secret;
  const metadata = normalizeBindingEntry(entry);
  sessionStore?.upsert?.(chatId, (session) => {
    const current = normalizeCredentialBindingState(session?.credential_binding_state || session?.credentialBindingState || {});
    const bindings = [
      metadata,
      ...current.bindings.filter((item) => normalizeKey(item.credential_key) !== key),
    ];
    return {
      ...session,
      credential_binding_state: normalizeCredentialBindingState({ bindings, updated_at: now }),
    };
  });
  return metadata;
}

export function clearCredentialForChat(sessionStore, chatId, credentialKey = '', { clearEnv = true } = {}) {
  const key = normalizeKey(credentialKey);
  if (!key) return null;
  const bucket = getVaultBucket(chatId);
  bucket?.delete?.(key);
  if (clearEnv && Object.prototype.hasOwnProperty.call(process.env, key)) delete process.env[key];
  sessionStore?.upsert?.(chatId, (session) => {
    const current = normalizeCredentialBindingState(session?.credential_binding_state || session?.credentialBindingState || {});
    return {
      ...session,
      credential_binding_state: normalizeCredentialBindingState({
        bindings: current.bindings.filter((item) => normalizeKey(item.credential_key) !== key),
      }),
    };
  });
  return key;
}

export function getCredentialBindingState(sessionStore, chatId) {
  const session = sessionStore?.get?.(chatId);
  return normalizeCredentialBindingState(session?.credential_binding_state || session?.credentialBindingState || {});
}

export function getCredentialCoverageForProposal(chatId, proposal = {}) {
  const credentialRequests = asArray(proposal?.actions?.credential_requests || proposal?.actions?.credentialRequests);
  const requestedKeys = [];
  const seen = new Set();
  for (const row of credentialRequests) {
    const key = normalizeKey(row?.credential_key || row?.credentialKey || row?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    requestedKeys.push(key);
  }
  const boundKeys = requestedKeys.filter((key) => hasBoundCredential(chatId, key));
  return {
    requested_keys: requestedKeys,
    bound_keys: boundKeys,
    missing_keys: requestedKeys.filter((key) => !boundKeys.includes(key)),
    all_satisfied: requestedKeys.every((key) => boundKeys.includes(key)),
  };
}
