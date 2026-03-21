import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

function normalizeReferenceType(value = '') {
  const key = clean(value).toLowerCase();
  if (['env', 'env_var', 'process_env', 'server_env'].includes(key)) return 'env_var';
  if (['secret_ref', 'secret_store', 'vault_ref', 'telegram_secret', 'inline_secret', 'session_vault'].includes(key)) return 'secret_ref';
  return 'env_var';
}

function normalizeDeliveryMethod(value = '') {
  const key = clean(value).toLowerCase();
  if (['job_env', 'scoped_env', 'subprocess_env'].includes(key)) return 'job_env';
  if (key === 'session_vault') return 'session_vault';
  return 'job_env';
}

function buildReferenceLabel({ referenceType = 'env_var', reference = '', credentialKey = '' } = {}) {
  const target = clean(reference) || normalizeKey(credentialKey);
  if (!target) return '';
  if (referenceType === 'secret_ref') return `telegram_secret:${normalizeKey(credentialKey) || 'SECRET'}`;
  return `env:${target}`;
}

function normalizeBindingEntry(raw = {}) {
  const row = asObject(raw);
  const credentialKey = normalizeKey(row.credential_key || row.credentialKey || row.key);
  if (!credentialKey) return null;
  const referenceType = normalizeReferenceType(row.reference_type || row.referenceType || row.binding_type || row.bindingType || row.delivery_method || row.deliveryMethod || 'env_var');
  const reference = clean(row.reference || row.binding_ref || row.bindingRef || row.source_env_key || row.sourceEnvKey || row.env_key || row.envKey || row.secret_ref || row.secretRef || row.ref || '');
  const boundAt = clean(row.bound_at || row.boundAt || row.updated_at || row.updatedAt || new Date().toISOString()) || new Date().toISOString();
  const maskedValue = clean(row.masked_value || row.maskedValue || '');
  const last4 = clean(row.last4 || '');
  return {
    credential_key: credentialKey,
    source: clean(row.source || (referenceType === 'env_var' ? 'server_env_binding' : 'credential_reference')) || (referenceType === 'env_var' ? 'server_env_binding' : 'credential_reference'),
    delivery_method: normalizeDeliveryMethod(row.delivery_method || row.deliveryMethod || 'job_env'),
    reference_type: referenceType,
    reference,
    reference_label: clean(row.reference_label || row.referenceLabel || buildReferenceLabel({ referenceType, reference, credentialKey })),
    last4,
    masked_value: maskedValue,
    bound_at: boundAt,
    updated_at: clean(row.updated_at || row.updatedAt || boundAt) || boundAt,
  };
}

function getCredentialStoreDir(sessionStore) {
  const filePath = clean(sessionStore?.filePath);
  if (filePath) return path.dirname(filePath);
  return process.cwd();
}

function getSecretStorePaths(sessionStore) {
  const dir = getCredentialStoreDir(sessionStore);
  return {
    dir,
    keyPath: path.join(dir, '.credential_store.key'),
    filePath: path.join(dir, 'credential_secrets.enc.json'),
  };
}

function decodeConfiguredMasterKey() {
  const raw = clean(process.env.DDALGGAK_SECRET_STORE_KEY || process.env.DDALGGAK_SECRET_MASTER_KEY);
  if (!raw) return null;
  const candidates = [];
  try { candidates.push(Buffer.from(raw, 'base64')); } catch {}
  try { candidates.push(Buffer.from(raw, 'hex')); } catch {}
  candidates.push(Buffer.from(raw, 'utf8'));
  return candidates.find((buf) => Buffer.isBuffer(buf) && buf.length >= 32)?.subarray(0, 32) || null;
}

function ensureSecretStoreKey(sessionStore) {
  const configured = decodeConfiguredMasterKey();
  if (configured) return configured;
  const { keyPath, dir } = getSecretStorePaths(sessionStore);
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, generated, { mode: 0o600 });
  return generated;
}

function encryptSecretStorePayload(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptSecretStorePayload(wrapper, key) {
  if (!wrapper || typeof wrapper !== 'object') return { version: 1, secrets: {} };
  const iv = Buffer.from(clean(wrapper.iv), 'base64');
  const tag = Buffer.from(clean(wrapper.tag), 'base64');
  const data = Buffer.from(clean(wrapper.data), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(json);
  return parsed && typeof parsed === 'object' ? parsed : { version: 1, secrets: {} };
}

function loadSecretStoreState(sessionStore) {
  const { filePath } = getSecretStorePaths(sessionStore);
  try {
    const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return decryptSecretStorePayload(wrapper, ensureSecretStoreKey(sessionStore));
  } catch {
    return { version: 1, secrets: {} };
  }
}

function saveSecretStoreState(sessionStore, next = {}) {
  const { filePath, dir } = getSecretStorePaths(sessionStore);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: 1,
    secrets: asObject(next).secrets || {},
    updated_at: new Date().toISOString(),
  };
  const wrapper = encryptSecretStorePayload(payload, ensureSecretStoreKey(sessionStore));
  fs.writeFileSync(filePath, JSON.stringify(wrapper, null, 2), { encoding: 'utf8', mode: 0o600 });
  return payload;
}

function createInlineSecretReference(chatId = '', credentialKey = '') {
  const chatPart = clean(chatId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'chat';
  const keyPart = normalizeKey(credentialKey).replace(/[^A-Z0-9_]/g, '_').slice(0, 48) || 'SECRET';
  return `telegram:${chatPart}:${keyPart}:${crypto.randomBytes(8).toString('hex')}`;
}

function storeInlineSecret(sessionStore, chatId, credentialKey, secret) {
  const value = clean(secret);
  if (!value) throw new Error('credential secret is required');
  const state = loadSecretStoreState(sessionStore);
  const reference = createInlineSecretReference(chatId, credentialKey);
  state.secrets = {
    ...asObject(state.secrets),
    [reference]: {
      chat_id: clean(chatId),
      credential_key: normalizeKey(credentialKey),
      value,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
  saveSecretStoreState(sessionStore, state);
  return reference;
}

function deleteStoredSecretReference(sessionStore, reference = '') {
  const ref = clean(reference);
  if (!ref) return false;
  const state = loadSecretStoreState(sessionStore);
  if (!asObject(state.secrets)[ref]) return false;
  const nextSecrets = { ...asObject(state.secrets) };
  delete nextSecrets[ref];
  saveSecretStoreState(sessionStore, { ...state, secrets: nextSecrets });
  return true;
}

export function resolveStoredSecretReference(sessionStore, chatId = '', bindingOrReference = {}) {
  const reference = typeof bindingOrReference === 'string'
    ? clean(bindingOrReference)
    : clean(bindingOrReference?.reference || bindingOrReference?.secret_ref || bindingOrReference?.secretRef);
  if (!reference) return '';
  const state = loadSecretStoreState(sessionStore);
  const entry = asObject(state.secrets)[reference];
  if (!entry || typeof entry !== 'object') return '';
  if (clean(chatId) && clean(entry.chat_id) && clean(entry.chat_id) !== clean(chatId)) return '';
  return clean(entry.value);
}

function resolveBindingStateArgs(sessionStoreOrChatId, chatIdMaybe) {
  const looksLikeSessionStore = sessionStoreOrChatId && typeof sessionStoreOrChatId === 'object'
    && (typeof sessionStoreOrChatId.get === 'function' || typeof sessionStoreOrChatId.upsert === 'function');
  if (looksLikeSessionStore) {
    return {
      sessionStore: sessionStoreOrChatId,
      chatId: chatIdMaybe,
    };
  }
  return {
    sessionStore: null,
    chatId: sessionStoreOrChatId,
  };
}

function defaultSecretReferenceResolver(sessionStore, chatId, override = null) {
  if (typeof override === 'function') return override;
  if (!sessionStore) return null;
  return (binding) => resolveStoredSecretReference(sessionStore, chatId, binding);
}

function resolveCredentialValueFromBinding(entry = {}, {
  env = process.env,
  resolveSecretReference = null,
} = {}) {
  const binding = normalizeBindingEntry(entry);
  if (!binding) return '';
  const referenceType = binding.reference_type;
  if (referenceType === 'env_var') {
    const envKey = normalizeKey(binding.reference || binding.credential_key);
    return clean(asObject(env)[envKey]);
  }
  if (referenceType === 'secret_ref' && typeof resolveSecretReference === 'function') {
    return clean(resolveSecretReference(binding));
  }
  return '';
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
    version: 2,
    bindings,
    bound_keys: bindings.map((entry) => entry.credential_key),
    summary: {
      bound_count: bindings.length,
    },
    updated_at: clean(row.updated_at || row.updatedAt || new Date().toISOString()) || new Date().toISOString(),
  };
}

export function getCredentialBindingState(sessionStoreOrChatId, chatIdMaybe, {
  includeResolution = false,
  env = process.env,
  resolveSecretReference = null,
} = {}) {
  const { sessionStore, chatId } = resolveBindingStateArgs(sessionStoreOrChatId, chatIdMaybe);
  const session = sessionStore?.get?.(chatId);
  const state = normalizeCredentialBindingState(session?.credential_binding_state || session?.credentialBindingState || {});
  if (!includeResolution) return state;
  const secretResolver = defaultSecretReferenceResolver(sessionStore, chatId, resolveSecretReference);
  const bindings = state.bindings.map((entry) => {
    const resolvedValue = resolveCredentialValueFromBinding(entry, { env, resolveSecretReference: secretResolver });
    return {
      ...entry,
      resolved: !!resolvedValue,
    };
  });
  return {
    ...state,
    bindings,
    summary: {
      ...state.summary,
      resolved_count: bindings.filter((entry) => entry.resolved).length,
    },
  };
}

export function getBoundCredentialValue(sessionStoreOrChatId, chatIdOrCredentialKey = '', credentialKeyOrOptions = '', maybeOptions = {}) {
  const hasSessionStore = sessionStoreOrChatId && typeof sessionStoreOrChatId === 'object'
    && (typeof sessionStoreOrChatId.get === 'function' || typeof sessionStoreOrChatId.upsert === 'function');
  const sessionStore = hasSessionStore ? sessionStoreOrChatId : null;
  const chatId = hasSessionStore ? chatIdOrCredentialKey : sessionStoreOrChatId;
  const credentialKey = hasSessionStore ? credentialKeyOrOptions : chatIdOrCredentialKey;
  const options = hasSessionStore ? maybeOptions : credentialKeyOrOptions;
  const key = normalizeKey(credentialKey);
  if (!key) return '';
  const secretResolver = defaultSecretReferenceResolver(sessionStore, chatId, asObject(options)?.resolveSecretReference || null);
  const state = getCredentialBindingState(sessionStore, chatId, {
    includeResolution: false,
    env: asObject(options)?.env || process.env,
    resolveSecretReference: secretResolver,
  });
  const entry = state.bindings.find((row) => normalizeKey(row.credential_key) === key);
  if (!entry) return '';
  return resolveCredentialValueFromBinding(entry, {
    env: asObject(options)?.env || process.env,
    resolveSecretReference: secretResolver,
  });
}

export function hasBoundCredential(sessionStoreOrChatId, chatIdOrCredentialKey = '', credentialKeyOrOptions = '', maybeOptions = {}) {
  return !!getBoundCredentialValue(sessionStoreOrChatId, chatIdOrCredentialKey, credentialKeyOrOptions, maybeOptions);
}

export function bindCredentialReferenceForChat(
  sessionStore,
  chatId,
  credentialKey = '',
  {
    referenceType = 'env_var',
    reference = '',
    source = 'server_env_binding',
    deliveryMethod = 'job_env',
    maskedValue = '',
    last4 = '',
    referenceLabel = '',
  } = {}
) {
  const key = normalizeKey(credentialKey);
  const normalizedReference = clean(reference || key);
  if (!key) throw new Error('credential_key is required');
  if (!normalizedReference) throw new Error('credential reference is required');
  const current = getCredentialBindingState(sessionStore, chatId, { includeResolution: false });
  const previous = current.bindings.find((item) => normalizeKey(item.credential_key) === key);
  if (previous?.reference_type === 'secret_ref' && clean(previous.reference) && clean(previous.reference) !== normalizedReference) {
    deleteStoredSecretReference(sessionStore, previous.reference);
  }
  const now = new Date().toISOString();
  const metadata = normalizeBindingEntry({
    credential_key: key,
    source,
    delivery_method: deliveryMethod,
    reference_type: referenceType,
    reference: normalizedReference,
    reference_label: clean(referenceLabel || buildReferenceLabel({ referenceType, reference: normalizedReference, credentialKey: key })),
    masked_value: maskedValue,
    last4,
    bound_at: now,
    updated_at: now,
  });
  sessionStore?.upsert?.(chatId, (session) => {
    const currentState = normalizeCredentialBindingState(session?.credential_binding_state || session?.credentialBindingState || {});
    const bindings = [
      metadata,
      ...currentState.bindings.filter((item) => normalizeKey(item.credential_key) !== key),
    ];
    return {
      ...session,
      credential_binding_state: normalizeCredentialBindingState({ bindings, updated_at: now }),
    };
  });
  return metadata;
}

export function bindCredentialForChat(sessionStore, chatId, credentialKey = '', secret = '', {
  source = 'telegram_secret_binding',
  deliveryMethod = 'job_env',
} = {}) {
  const key = normalizeKey(credentialKey);
  const value = clean(secret);
  if (!key) throw new Error('credential_key is required');
  if (!value) throw new Error('credential secret is required');
  const reference = storeInlineSecret(sessionStore, chatId, key, value);
  return bindCredentialReferenceForChat(sessionStore, chatId, key, {
    referenceType: 'secret_ref',
    reference,
    referenceLabel: `telegram_secret:${key}`,
    source,
    deliveryMethod,
    maskedValue: maskSecret(value),
    last4: value.slice(-4),
  });
}

export function clearCredentialForChat(sessionStore, chatId, credentialKey = '') {
  const key = normalizeKey(credentialKey);
  if (!key) return null;
  const current = getCredentialBindingState(sessionStore, chatId, { includeResolution: false });
  const entry = current.bindings.find((item) => normalizeKey(item.credential_key) === key);
  if (entry?.reference_type === 'secret_ref') deleteStoredSecretReference(sessionStore, entry.reference);
  sessionStore?.upsert?.(chatId, (session) => {
    const currentState = normalizeCredentialBindingState(session?.credential_binding_state || session?.credentialBindingState || {});
    return {
      ...session,
      credential_binding_state: normalizeCredentialBindingState({
        bindings: currentState.bindings.filter((item) => normalizeKey(item.credential_key) !== key),
      }),
    };
  });
  return key;
}

export function resolveCredentialEnvForChat(sessionStoreOrChatId, chatIdMaybe, {
  onlyKeys = [],
  env = process.env,
  resolveSecretReference = null,
} = {}) {
  const { sessionStore, chatId } = resolveBindingStateArgs(sessionStoreOrChatId, chatIdMaybe);
  const allowed = new Set(asArray(onlyKeys).map((item) => normalizeKey(item)).filter(Boolean));
  const secretResolver = defaultSecretReferenceResolver(sessionStore, chatId, resolveSecretReference);
  const state = getCredentialBindingState(sessionStore, chatId, { includeResolution: false, env, resolveSecretReference: secretResolver });
  const out = {};
  for (const entry of state.bindings) {
    const key = normalizeKey(entry.credential_key);
    if (!key) continue;
    if (allowed.size > 0 && !allowed.has(key)) continue;
    const value = resolveCredentialValueFromBinding(entry, { env, resolveSecretReference: secretResolver });
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

export function getCredentialCoverageForProposal(sessionStoreOrChatId, chatIdOrProposal = {}, proposalMaybe = {}, options = {}) {
  const hasSessionStore = sessionStoreOrChatId && typeof sessionStoreOrChatId === 'object'
    && (typeof sessionStoreOrChatId.get === 'function' || typeof sessionStoreOrChatId.upsert === 'function');
  const sessionStore = hasSessionStore ? sessionStoreOrChatId : null;
  const chatId = hasSessionStore ? chatIdOrProposal : sessionStoreOrChatId;
  const proposal = hasSessionStore ? proposalMaybe : chatIdOrProposal;
  const opts = hasSessionStore ? options : proposalMaybe;
  const credentialRequests = asArray(proposal?.actions?.credential_requests || proposal?.actions?.credentialRequests);
  const requestedKeys = [];
  const seen = new Set();
  for (const row of credentialRequests) {
    const key = normalizeKey(row?.credential_key || row?.credentialKey || row?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    requestedKeys.push(key);
  }
  const resolvedEnv = resolveCredentialEnvForChat(sessionStore, chatId, {
    onlyKeys: requestedKeys,
    env: asObject(opts)?.env || process.env,
    resolveSecretReference: asObject(opts)?.resolveSecretReference || null,
  });
  const boundKeys = requestedKeys.filter((key) => !!clean(resolvedEnv[key]));
  return {
    requested_keys: requestedKeys,
    bound_keys: boundKeys,
    missing_keys: requestedKeys.filter((key) => !boundKeys.includes(key)),
    all_satisfied: requestedKeys.every((key) => boundKeys.includes(key)),
  };
}

export function describeCredentialBindingTarget(entry = {}) {
  const normalized = normalizeBindingEntry(entry);
  if (!normalized) return '';
  return normalized.reference_label || buildReferenceLabel({
    referenceType: normalized.reference_type,
    reference: normalized.reference,
    credentialKey: normalized.credential_key,
  });
}

export function maskCredentialPreview(value = '') {
  return maskSecret(value);
}
