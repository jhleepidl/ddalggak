import http from 'node:http';
import https from 'node:https';

import { runCommand } from '../proc.js';
import { applyModelCatalogToNode, inferModelCatalogEntry } from './model_node_catalog.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:\-\.]+/g, '_').replace(/^_+|_+$/g, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = [], { max = 100 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = clean(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= Math.max(1, Math.floor(Number(max) || 100))) break;
  }
  return out;
}

function splitEnvArgs(value = '') {
  return clean(value).split(/\s+/).map(clean).filter(Boolean);
}

function truthy(value = '') {
  return ['1', 'true', 'yes', 'on', 'trusted'].includes(clean(value).toLowerCase());
}

function joinUrl(base = '', suffix = '') {
  const root = clean(base).replace(/\/+$/, '');
  const tail = clean(suffix).replace(/^\/+/, '');
  return `${root}/${tail}`;
}

function ollamaApiBase(baseUrl = '') {
  const root = clean(baseUrl).replace(/\/+$/, '');
  if (!root) return '';
  return /\/api$/i.test(root) ? root : `${root}/api`;
}

function isLoopbackUrl(value = '') {
  const text = clean(value).toLowerCase();
  return text.includes('127.0.0.1') || text.includes('localhost') || text.includes('::1');
}

function requestJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 5000, maxChars = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    let timer = null;
    const req = transport.request(parsed, { method, headers }, (res) => {
      const chunks = [];
      let total = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total <= maxChars) chunks.push(chunk);
      });
      res.on('end', () => {
        if (timer) clearTimeout(timer);
        const text = chunks.join('');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode || 0, text, json });
      });
    });
    timer = Number(timeoutMs || 0) > 0 ? setTimeout(() => {
      req.destroy(new Error(`timeout after ${Math.floor(Number(timeoutMs))}ms`));
    }, Math.floor(Number(timeoutMs))) : null;
    req.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    if (body !== null && body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function modelNameToNodeId(prefix = 'model', base = '', model = '') {
  const host = (() => {
    try { return new URL(base).hostname; } catch { return prefix; }
  })();
  return cleanId(`${prefix}_${host}_${model}`).replace(/[:.]/g, '_');
}

function extractNumCtxFromShow(show = {}) {
  const modelfile = clean(show.modelfile || show.model_file || '');
  const match = modelfile.match(/PARAMETER\s+num_ctx\s+([0-9]+)/i);
  if (match) return Number(match[1]);
  const params = asObject(show.parameters);
  const n = Number(params.num_ctx || params.numCtx || show.num_ctx || show.context_length || show.contextLength || 0);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildOllamaNode({ baseUrl = '', modelRow = {}, show = {}, trustedContext = true, location = '' } = {}) {
  const model = clean(modelRow.model || modelRow.name || show.model || '');
  const details = { ...asObject(modelRow.details), ...asObject(show.details) };
  const contextTokens = extractNumCtxFromShow(show);
  const catalog = inferModelCatalogEntry({ model, runtime: 'ollama', base_url: baseUrl, details, context_tokens: contextTokens });
  const node = {
    id: modelNameToNodeId('ollama', baseUrl, model),
    label: model,
    provider: 'openai_compatible',
    runtime: 'ollama',
    base_url: baseUrl,
    model,
    location: clean(location || (() => { try { return new URL(baseUrl).hostname; } catch { return ''; } })()),
    enabled: true,
    capabilities: catalog.capabilities,
    limits: {
      context_tokens: contextTokens || catalog.limits?.context_tokens,
      max_concurrent: 1,
      timeout_ms: 90000,
    },
    permissions: {
      memory_read: 'project_scoped',
      memory_write: 'write_intent_only',
      workspace_read: true,
      workspace_write: false,
    },
    role_bias: ['reviewer', 'researcher', 'draft', 'local_private_reasoning'],
    tags: ['ollama', isLoopbackUrl(baseUrl) ? 'local' : 'remote'],
    privacy_profile: {
      tier: isLoopbackUrl(baseUrl) ? 'local_private' : (trustedContext ? 'trusted_private' : 'remote'),
      data_boundary: isLoopbackUrl(baseUrl) ? 'local_device' : (trustedContext ? 'user_controlled_remote' : 'remote_endpoint'),
      sends_context_off_device: !isLoopbackUrl(baseUrl),
      trusted_context: trustedContext || isLoopbackUrl(baseUrl),
      allow_private_context: trustedContext || isLoopbackUrl(baseUrl),
      network_scope: isLoopbackUrl(baseUrl) ? 'loopback' : 'remote',
    },
    cost_profile: { tier: 'free', billing: 'local_compute' },
    latency_profile: catalog.latency_profile,
    quality_profile: catalog.quality_profile,
    routing: { priority: trustedContext ? 60 : 40, prefer_for: trustedContext ? ['private_context', 'review', 'draft'] : ['draft'], avoid_for: trustedContext ? [] : ['private_context'] },
    account_profile: { mode: process.env.PROVIDER_ACCOUNT_MODE || 'deployment_owner', billing_owner: 'deployment_owner', credential_scope: 'none', isolation: 'model_endpoint' },
    model_catalog: {
      family: catalog.family || clean(details.family || ''),
      parameter_size: catalog.parameter_size || clean(details.parameter_size || ''),
      parameter_size_b: catalog.parameter_size_b,
      quantization_level: catalog.quantization_level || clean(details.quantization_level || ''),
      digest: clean(modelRow.digest || ''),
      size_bytes: Number(modelRow.size || 0) || undefined,
      discovered_from: 'ollama_api',
      confidence: catalog.catalog_confidence,
    },
  };
  return applyModelCatalogToNode(node);
}

export async function discoverOllamaModelNodes({ baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434', trustedContext = true, timeoutMs = 5000, maxModels = 50, includeShow = true, apiKey = '' } = {}) {
  const root = clean(baseUrl);
  if (!root) return { ok: false, nodes: [], error: 'missing baseUrl' };
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const tags = await requestJson(joinUrl(ollamaApiBase(root), '/tags'), { headers, timeoutMs });
  if (!tags.ok) return { ok: false, nodes: [], status: tags.status, error: tags.text.slice(0, 500) };
  const models = Array.isArray(tags.json?.models) ? tags.json.models : [];
  const nodes = [];
  for (const modelRow of models.slice(0, Math.max(1, Math.floor(Number(maxModels) || 50)))) {
    const model = clean(modelRow.model || modelRow.name || '');
    if (!model) continue;
    let show = {};
    if (includeShow) {
      try {
        const res = await requestJson(joinUrl(ollamaApiBase(root), '/show'), {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: { model },
          timeoutMs,
          maxChars: 1_000_000,
        });
        if (res.ok && res.json) show = res.json;
      } catch {}
    }
    nodes.push(buildOllamaNode({ baseUrl: root, modelRow, show, trustedContext }));
  }
  return { ok: true, base_url: root, runtime: 'ollama', count: nodes.length, nodes, discovery_source: 'ollama_api' };
}

export async function discoverOpenAICompatibleModelNodes({ baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL || '', runtime = 'openai_compatible', apiKey = process.env.OPENAI_COMPATIBLE_API_KEY || '', trustedContext = false, timeoutMs = 5000, maxModels = 50 } = {}) {
  const root = clean(baseUrl).replace(/\/+$/, '');
  if (!root) return { ok: false, nodes: [], error: 'missing baseUrl' };
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await requestJson(joinUrl(root, '/models'), { headers, timeoutMs });
  if (!res.ok) return { ok: false, nodes: [], status: res.status, error: res.text.slice(0, 500) };
  const rows = Array.isArray(res.json?.data) ? res.json.data : (Array.isArray(res.json?.models) ? res.json.models : []);
  const nodes = rows.slice(0, Math.max(1, Math.floor(Number(maxModels) || 50))).map((row) => {
    const model = clean(row.id || row.model || row.name || '');
    return applyModelCatalogToNode({
      id: cleanId(`${runtime}_${model}`),
      label: model,
      provider: 'openai_compatible',
      runtime,
      base_url: root,
      model,
      enabled: true,
      capabilities: { chat: true },
      limits: { max_concurrent: 1, timeout_ms: 90000 },
      permissions: { memory_read: 'project_scoped', memory_write: 'write_intent_only', workspace_read: false, workspace_write: false },
      privacy_profile: { tier: trustedContext ? 'trusted_private' : 'external_api', data_boundary: trustedContext ? 'user_controlled_remote' : 'external_provider', sends_context_off_device: true, trusted_context: trustedContext, allow_private_context: trustedContext },
      routing: { priority: trustedContext ? 55 : 35, prefer_for: trustedContext ? ['private_context', 'draft'] : ['draft'], avoid_for: trustedContext ? [] : ['private_context'] },
      account_profile: { mode: 'deployment_owner', billing_owner: 'deployment_owner', credential_scope: apiKey ? 'service' : 'none', isolation: 'service_process' },
      model_catalog: { discovered_from: `${runtime}_models_api`, confidence: 'provider_list' },
    });
  }).filter((node) => node.model);
  return { ok: true, base_url: root, runtime, count: nodes.length, nodes, discovery_source: `${runtime}_models_api` };
}

const MODEL_ID_RE = /\b(?:gpt-[a-z0-9][a-z0-9._:-]*|o[0-9][a-z0-9._:-]*|codex-[a-z0-9._:-]+|gemini-[a-z0-9][a-z0-9._:-]*|claude-[a-z0-9][a-z0-9._:-]*|llama[0-9._:-]*[a-z0-9._:-]*|qwen[0-9._:-]*[a-z0-9._:-]*|mistral[0-9._:-]*[a-z0-9._:-]*|deepseek-[a-z0-9._:-]*|gemma[0-9._:-]*[a-z0-9._:-]*)\b/gi;

const NOISE_MODEL_TOKENS = new Set([
  'gpt-oss',
]);

export const PROVIDER_DEFAULT_MODEL_SELECTOR = '@default';

function parseCandidateList(value = '') {
  const text = clean(value);
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return uniqueStrings(parsed.map(clean).filter(Boolean));
    } catch {}
  }
  return uniqueStrings(text.split(/[\n,;]+/g).map(clean).filter(Boolean));
}

function configuredRouteModels(provider = '', env = process.env) {
  const target = clean(provider).toLowerCase();
  const out = [];
  for (const prefix of ['FAST', 'SEARCH', 'WORK']) {
    const routeProvider = clean(env[`DDALGGAK_${prefix}_PROVIDER`]).toLowerCase();
    const routeModel = clean(env[`DDALGGAK_${prefix}_MODEL`]);
    if (routeProvider === target && routeModel) out.push(routeModel);
  }
  return out;
}

export function configuredCliModelCandidates({ provider = '', env = process.env, includeProviderDefaults = true } = {}) {
  const key = clean(provider).toLowerCase();
  let rows = [];
  if (key === 'codex') {
    rows = [
      ...parseCandidateList(env.CODEX_MODEL_CANDIDATES),
      clean(env.CODEX_MODEL),
      clean(env.CODEX_ASSIST_MODEL),
      ...configuredRouteModels('codex', env),
    ];
  } else if (key === 'claude') {
    const includeAliases = env.CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES === undefined
      ? true
      : truthy(env.CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES);
    rows = [
      ...(includeAliases ? ['sonnet', 'opus', 'haiku', 'fable'] : []),
      ...parseCandidateList(env.CLAUDE_MODEL_CANDIDATES),
      clean(env.CLAUDE_CLI_MODEL),
      clean(env.CLAUDE_MODEL),
      ...configuredRouteModels('claude', env),
    ];
  } else if (key === 'antigravity') {
    rows = [
      ...parseCandidateList(env.ANTIGRAVITY_MODEL_CANDIDATES),
      clean(env.ANTIGRAVITY_MODEL),
      clean(env.GOOGLE_AI_MODEL),
      ...configuredRouteModels('antigravity', env),
    ];
  }
  const candidates = uniqueStrings(rows.filter(Boolean));
  if (candidates.length || !includeProviderDefaults) return candidates;
  const allowDefault = env.MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT === undefined
    ? true
    : truthy(env.MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT);
  return allowDefault ? [PROVIDER_DEFAULT_MODEL_SELECTOR] : [];
}

function isProviderDefaultSelector(model = '') {
  return clean(model).toLowerCase() === PROVIDER_DEFAULT_MODEL_SELECTOR;
}

function normalizeDisplayModelCandidates(provider = '', raw = '') {
  const out = [];
  const key = clean(provider).toLowerCase();
  if (key === 'claude') {
    for (const match of raw.matchAll(/\b(?:claude[\s_-]+)?(opus|sonnet|haiku)[\s_-]+([0-9]+(?:\.[0-9]+)*)\b/gi)) {
      out.push(`claude-${match[1].toLowerCase()}-${match[2].replaceAll('.', '-')}`);
    }
    for (const line of raw.split(/\r?\n/g)) {
      const alias = clean(line).toLowerCase().replace(/^[>*•+\-\d.)\s]+/, '').split(/\s+/)[0];
      if (['best', 'opus', 'sonnet', 'haiku', 'fable'].includes(alias)) out.push(alias);
    }
  }
  if (key === 'antigravity' || key === 'gemini') {
    for (const match of raw.matchAll(/\bgemini[\s_-]+([0-9]+(?:\.[0-9]+)*)[\s_-]+(pro|flash|ultra|nano)(?:[\s_-]+(preview))?\b/gi)) {
      out.push(`gemini-${match[1]}-${match[2].toLowerCase()}${match[3] ? '-preview' : ''}`);
    }
  }
  return out;
}

export function parseCliModelListOutput({ provider = '', text = '', maxModels = 80 } = {}) {
  const raw = clean(text);
  if (!raw) return [];
  const matches = normalizeDisplayModelCandidates(provider, raw);
  for (const match of raw.matchAll(MODEL_ID_RE)) {
    const value = clean(match[0]).replace(/[),;]+$/g, '');
    const lower = value.toLowerCase();
    if (!value || NOISE_MODEL_TOKENS.has(lower)) continue;
    if (provider === 'gemini' && !lower.startsWith('gemini-')) continue;
    if (provider === 'codex' && (lower.startsWith('gemini-') || lower.startsWith('claude-'))) continue;
    if (provider === 'claude' && !lower.startsWith('claude-') && !['best', 'opus', 'sonnet', 'haiku', 'fable'].includes(lower)) continue;
    if (provider === 'antigravity' && !lower.startsWith('gemini-')) continue;
    matches.push(value);
  }
  return uniqueStrings(matches, { max: maxModels });
}

function buildCliNode({ provider = '', runtime = '', model = '', source = '', command = '' } = {}) {
  const p = cleanId(provider);
  const rt = cleanId(runtime || `${p}_cli`);
  const id = cleanId(`${p}_${model}`).replace(/[:.]/g, '_');
  const catalog = inferModelCatalogEntry({ model, runtime: rt, provider: p });
  const isCodex = p === 'codex';
  const isClaude = p === 'claude';
  const isAntigravity = p === 'antigravity';
  const isGemini = p === 'gemini' || isAntigravity;
  const canWriteWorkspace = isCodex || isClaude || isAntigravity;
  const node = {
    id,
    label: isProviderDefaultSelector(model) ? 'Provider default' : model,
    provider: p,
    runtime: rt,
    base_url: '',
    model,
    location: 'cli',
    enabled: true,
    capabilities: {
      chat: true,
      structured_json: true,
      tool_calling: true,
      code: true,
      vision: isGemini,
    },
    limits: {
      context_tokens: catalog.limits?.context_tokens,
      max_concurrent: 1,
      timeout_ms: isCodex ? 45 * 60 * 1000 : (isClaude ? 30 * 60 * 1000 : 15 * 60 * 1000),
    },
    permissions: {
      memory_read: 'project_scoped',
      memory_write: 'write_intent_only',
      workspace_read: true,
      workspace_write: canWriteWorkspace,
    },
    role_bias: isCodex
      ? ['builder', 'reviewer', 'verifier', 'code']
      : (isClaude
        ? ['planner', 'builder', 'reviewer', 'researcher', 'synthesizer']
        : (isAntigravity
          ? ['planner', 'builder', 'reviewer', 'researcher', 'code']
          : ['planner', 'researcher', 'reviewer', 'draft'])),
    tags: [p, 'cli', 'discovered', ...(isProviderDefaultSelector(model) ? ['provider-default'] : [])],
    cost_profile: catalog.cost_profile,
    latency_profile: catalog.latency_profile,
    quality_profile: catalog.quality_profile,
    privacy_profile: {
      tier: 'external_api',
      data_boundary: `${p}_account`,
      sends_context_off_device: true,
      trusted_context: false,
      allow_private_context: false,
      network_scope: 'provider_api',
    },
    account_profile: {
      mode: process.env.PROVIDER_ACCOUNT_MODE || 'deployment_owner',
      billing_owner: process.env.PROVIDER_ACCOUNT_MODE === 'per_user_isolated' ? 'end_user' : 'deployment_owner',
      credential_scope: process.env.PROVIDER_ACCOUNT_MODE === 'per_user_isolated' ? 'per_user' : 'service',
      isolation: process.env.PROVIDER_ACCOUNT_MODE === 'per_user_isolated' ? 'required' : 'service_process',
    },
    routing: {
      priority: isCodex ? 70 : 65,
      prefer_for: isCodex ? ['builder', 'code', 'reviewer'] : ['planner', 'researcher', 'draft', 'fast_summary'],
      avoid_for: ['private_context'],
    },
    model_catalog: {
      family: catalog.family || '',
      parameter_size: catalog.parameter_size || '',
      parameter_size_b: catalog.parameter_size_b,
      quantization_level: catalog.quantization_level || '',
      discovered_from: source,
      discovery_command: command,
      confidence: isProviderDefaultSelector(model) ? 'provider_default_unresolved' : (catalog.catalog_confidence === 'default_estimate' ? 'cli_model_list_name_only' : catalog.catalog_confidence),
      default_selector: isProviderDefaultSelector(model),
    },
  };
  return applyModelCatalogToNode(node);
}

async function runCliModelCommand({ command = '', args = [], input = undefined, timeoutMs = 12000, runner = runCommand, cwd = process.cwd(), env = {} } = {}) {
  const cmd = clean(command);
  if (!cmd) return { ok: false, stdout: '', stderr: 'missing command', exitCode: -1 };
  return await runner(cmd, args, {
    cwd,
    timeoutMs,
    ...(input === undefined ? {} : { input }),
    maxStdoutChars: 1_000_000,
    maxStderrChars: 300_000,
    env: {
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...env,
    },
  });
}

function nodesFromCandidates({ provider = '', runtime = '', candidates = [], source = '', command = '' } = {}) {
  return uniqueStrings(candidates).map((model) => buildCliNode({ provider, runtime, model, source, command }));
}

function discoveryFailureText(attempts = [], fallback = '') {
  const messages = attempts
    .map((row) => clean(row?.stderr || row?.stdout || row?.error))
    .filter(Boolean)
    .map((row) => row.slice(0, 300));
  return clean(messages.join(' | ') || fallback || 'no model candidates discovered').slice(0, 900);
}

export async function discoverCodexCliModelNodes({ command = process.env.CODEX_CLI_COMMAND || 'codex', args = splitEnvArgs(process.env.CODEX_MODEL_DISCOVERY_ARGS || ''), timeoutMs = Number(process.env.CLI_MODEL_DISCOVERY_TIMEOUT_MS || 12000) || 12000, maxModels = 80, runner = runCommand } = {}) {
  const attempts = [];
  const commandArgs = args.length ? args : ['debug', 'models'];
  const result = await runCliModelCommand({ command, args: commandArgs, timeoutMs, runner });
  attempts.push(result);
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const machineModels = parseCliModelListOutput({ provider: 'codex', text, maxModels });
  const configured = configuredCliModelCandidates({ provider: 'codex', includeProviderDefaults: false });
  const candidates = uniqueStrings([...machineModels, ...configured], { max: maxModels });
  const finalCandidates = candidates.length ? candidates : configuredCliModelCandidates({ provider: 'codex' });
  if (!finalCandidates.length) {
    return {
      ok: false,
      runtime: 'codex_cli',
      nodes: [],
      error: discoveryFailureText(attempts, 'codex debug models returned no model candidates'),
      exitCode: result.exitCode,
      discovery_source: 'codex_debug_models',
      discovery_attempts: [{ args: commandArgs, ok: result.ok === true, exit_code: result.exitCode }],
    };
  }
  const source = machineModels.length
    ? 'codex_debug_models'
    : (configured.length ? 'codex_configured_candidates' : 'codex_provider_default_fallback');
  const warning = machineModels.length ? '' : discoveryFailureText(attempts, 'Codex model catalog unavailable; using configured/default candidates.');
  const nodes = nodesFromCandidates({ provider: 'codex', runtime: 'codex_cli', candidates: finalCandidates, source, command });
  return {
    ok: true,
    runtime: 'codex_cli',
    count: nodes.length,
    nodes,
    raw_model_count: machineModels.length,
    warning,
    discovery_source: source,
    discovery_attempts: [{ args: commandArgs, ok: result.ok === true, exit_code: result.exitCode }],
  };
}

export async function discoverClaudeCliModelNodes({ command = process.env.CLAUDE_CLI_COMMAND || 'claude', maxModels = 80 } = {}) {
  // Claude Code exposes stable model aliases through --model but does not expose a
  // documented machine-readable "list models" command. Keep discovery non-billable:
  // seed official aliases plus operator-configured exact model IDs, then let the live
  // benchmark validate account availability and record the provider-resolved model.
  const candidates = configuredCliModelCandidates({ provider: 'claude' }).slice(0, maxModels);
  if (!candidates.length) {
    return {
      ok: false,
      runtime: 'claude_cli',
      nodes: [],
      error: 'No Claude model candidates configured and provider-default fallback disabled.',
      discovery_source: 'claude_cli_alias_catalog',
    };
  }
  const nodes = nodesFromCandidates({ provider: 'claude', runtime: 'claude_cli', candidates, source: 'claude_cli_alias_catalog', command });
  return {
    ok: true,
    runtime: 'claude_cli',
    count: nodes.length,
    nodes,
    raw_model_count: candidates.length,
    discovery_source: 'claude_cli_alias_catalog',
  };
}

export async function discoverAntigravityCliModelNodes({ command = process.env.ANTIGRAVITY_CLI_COMMAND || process.env.GOOGLE_AI_CLI_COMMAND || 'agy', maxModels = 80 } = {}) {
  // Antigravity versions do not consistently expose a non-interactive list command.
  // Use explicit candidates when supplied; otherwise retain a provider-default
  // benchmark selector so actual CLI scenarios can still validate the installed runtime.
  const configured = configuredCliModelCandidates({ provider: 'antigravity' }).slice(0, maxModels);
  if (!configured.length) {
    return {
      ok: false,
      runtime: 'antigravity_cli',
      nodes: [],
      error: 'No Antigravity model candidates configured and provider-default fallback disabled.',
      discovery_source: 'antigravity_configured_candidates',
    };
  }
  const source = configured.some(isProviderDefaultSelector)
    ? 'antigravity_provider_default_fallback'
    : 'antigravity_configured_candidates';
  const warning = configured.some(isProviderDefaultSelector)
    ? 'Named Antigravity models were not configured; benchmark will exercise the provider default. Set ANTIGRAVITY_MODEL_CANDIDATES to test exact model IDs.'
    : '';
  const nodes = nodesFromCandidates({ provider: 'antigravity', runtime: 'antigravity_cli', candidates: configured, source, command });
  return {
    ok: true,
    runtime: 'antigravity_cli',
    count: nodes.length,
    nodes,
    raw_model_count: configured.filter((item) => !isProviderDefaultSelector(item)).length,
    warning,
    discovery_source: source,
  };
}

export async function discoverGeminiCliModelNodes({ command = process.env.GEMINI_CLI_COMMAND || 'gemini', args = splitEnvArgs(process.env.GEMINI_MODEL_DISCOVERY_ARGS || ''), timeoutMs = Number(process.env.CLI_MODEL_DISCOVERY_TIMEOUT_MS || 12000) || 12000, maxModels = 80, runner = runCommand } = {}) {
  const input = process.env.GEMINI_MODEL_DISCOVERY_INPUT || '/model\n/quit\n';
  const result = await runCliModelCommand({ command, args, input, timeoutMs, runner });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const models = parseCliModelListOutput({ provider: 'gemini', text, maxModels });
  if (!models.length) {
    return { ok: false, runtime: 'gemini_cli', nodes: [], error: clean(result.stderr || result.stdout || 'no models parsed from Gemini CLI /model output').slice(0, 600), exitCode: result.exitCode, discovery_source: 'gemini_cli_slash_model' };
  }
  const nodes = models.map((model) => buildCliNode({ provider: 'gemini', runtime: 'gemini_cli', model, source: 'gemini_cli_slash_model', command }));
  return { ok: true, runtime: 'gemini_cli', count: nodes.length, nodes, raw_model_count: models.length, discovery_source: 'gemini_cli_slash_model' };
}
