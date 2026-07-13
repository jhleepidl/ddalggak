#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  discoverAntigravityCliModelNodes,
  discoverClaudeCliModelNodes,
  discoverCodexCliModelNodes,
  discoverGeminiCliModelNodes,
  discoverOllamaModelNodes,
  discoverOpenAICompatibleModelNodes,
} from '../src/application/model_node_discovery.js';
import { refreshModelCatalog } from '../src/application/model_catalog_refresh.js';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const exact = `--${name}`;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith(prefix)) return item.slice(prefix.length);
    if (item === exact) return argv[i + 1] || fallback;
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function boolArg(name, fallback = false) {
  const raw = arg(name, '');
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'trusted'].includes(String(raw).toLowerCase());
}

function outputPath() {
  const out = arg('output', '') || process.env.MODEL_NODES_DISCOVERED_CONFIG || process.env.MODEL_NODES_DISCOVERED_PATH || '';
  if (out) return path.resolve(out);
  return path.resolve(process.cwd(), 'config', 'model_nodes.discovered.json');
}

async function discoverOne(kind) {
  const baseUrl = arg('url', arg('base-url', kind === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') : (process.env.OPENAI_COMPATIBLE_BASE_URL || '')));
  const trustedContext = boolArg('trusted-context', kind === 'ollama');
  const timeoutMs = Number(arg('timeout-ms', process.env.MODEL_NODE_DISCOVERY_TIMEOUT_MS || process.env.CLI_MODEL_DISCOVERY_TIMEOUT_MS || 12000)) || 12000;
  const maxModels = Number(arg('max-models', 80)) || 80;
  const apiKey = arg('api-key', kind === 'ollama' ? (process.env.OLLAMA_API_KEY || '') : (process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY || ''));
  if (kind === 'ollama') return await discoverOllamaModelNodes({ baseUrl, trustedContext, timeoutMs, maxModels, apiKey });
  if (kind === 'codex') return await discoverCodexCliModelNodes({ timeoutMs, maxModels });
  if (kind === 'claude') return await discoverClaudeCliModelNodes({ timeoutMs, maxModels });
  if (kind === 'antigravity') return await discoverAntigravityCliModelNodes({ timeoutMs, maxModels });
  if (kind === 'gemini') return await discoverGeminiCliModelNodes({ timeoutMs, maxModels });
  return await discoverOpenAICompatibleModelNodes({ baseUrl, runtime: kind, trustedContext, timeoutMs, maxModels, apiKey });
}

async function main() {
  const kind = String(arg('kind', arg('provider', 'ollama')) || 'ollama').toLowerCase();
  if (kind === 'all' || hasFlag('refresh')) {
    const result = await refreshModelCatalog({ force: true, reason: 'cli_discover_model_nodes', outputPath: outputPath(), logger: console });
    if (!result.ok) process.exitCode = 1;
    if (hasFlag('stdout')) console.log(JSON.stringify(result.payload || {}, null, 2));
    return;
  }
  const result = await discoverOne(kind);

  if (!result.ok) {
    console.error(`Discovery failed: ${result.error || result.status || 'unknown_error'}`);
    process.exitCode = 1;
    return;
  }

  const payload = {
    version: 1,
    generated_at: new Date().toISOString(),
    source: { kind, base_url: result.base_url || '', discovery_source: result.discovery_source || result.runtime || kind },
    nodes: result.nodes,
  };
  if (hasFlag('stdout')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const out = outputPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Wrote ${result.nodes.length} model nodes to ${out}`);
  for (const node of result.nodes.slice(0, 20)) {
    console.log(`- ${node.id}: ${node.provider}/${node.model} · quality=${node.quality_profile?.tier || '-'} latency=${node.latency_profile?.tier || '-'} context=${node.limits?.context_tokens || '-'} privacy=${node.privacy_profile?.tier || '-'}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
