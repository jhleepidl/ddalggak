import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverAntigravityCliModelNodes, discoverClaudeCliModelNodes, discoverCodexCliModelNodes, discoverGeminiCliModelNodes, parseAntigravityModelListOutput, parseCliModelListOutput } from '../src/application/model_node_discovery.js';
import { refreshModelCatalog } from '../src/application/model_catalog_refresh.js';
import { listModelNodes } from '../src/application/model_node_registry.js';

test('CLI /model output parser extracts Codex and Gemini model ids', () => {
  const codexText = 'Select a model\n  gpt-5.5\n  gpt-5-codex\n  o4-mini\n';
  assert.deepEqual(parseCliModelListOutput({ provider: 'codex', text: codexText }), ['gpt-5.5', 'gpt-5-codex', 'o4-mini']);
  const geminiText = 'Auto (Gemini 3): gemini-3.1-pro, gemini-3-flash\nManual: gemini-2.5-pro';
  assert.deepEqual(parseCliModelListOutput({ provider: 'gemini', text: geminiText }), ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro']);
});

test('Antigravity models output preserves display selectors and reasoning profiles', () => {
  const text = [
    '> Gemini 3.5 Flash (Medium)    (current)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ].join('\n');
  assert.deepEqual(parseAntigravityModelListOutput({ text }), [
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ]);
});

test('Antigravity discovery calls agy models and builds one node per listed selector', async () => {
  const fakeRunner = async (command, args, opts) => {
    assert.equal(command, 'agy');
    assert.deepEqual(args, ['models']);
    assert.equal(Object.prototype.hasOwnProperty.call(opts, 'input'), false);
    return {
      ok: true,
      stdout: 'Gemini 3.5 Flash (Medium)\nClaude Sonnet 4.6 (Thinking)\nGPT-OSS 120B (Medium)\n',
      stderr: '',
      exitCode: 0,
    };
  };
  const result = await discoverAntigravityCliModelNodes({ runner: fakeRunner, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.discovery_source, 'antigravity_cli_models_command');
  assert.equal(result.raw_model_count, 3);
  assert.deepEqual(result.nodes.map((node) => node.model), [
    'Gemini 3.5 Flash (Medium)',
    'Claude Sonnet 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ]);
  assert.equal(result.nodes.every((node) => node.model_catalog.discovered_from === 'antigravity_cli_models_command'), true);
});

test('Codex non-interactive discovery and Gemini legacy discovery build model nodes', async () => {
  const fakeRunner = async (command, args, opts) => {
    if (command === 'codex') {
      assert.deepEqual(args, ['debug', 'models']);
      assert.equal(Object.prototype.hasOwnProperty.call(opts, 'input'), false);
      return { ok: true, stdout: JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }] }), stderr: '', exitCode: 0 };
    }
    if (command === 'gemini') {
      assert.equal(opts.input.includes('/model'), true);
      return { ok: true, stdout: 'Select Model\n1. gemini-3.1-pro\n2. gemini-3-flash\n', stderr: '', exitCode: 0 };
    }
    return { ok: false, stdout: '', stderr: 'bad command', exitCode: 1 };
  };
  const codex = await discoverCodexCliModelNodes({ runner: fakeRunner, timeoutMs: 1000 });
  assert.equal(codex.ok, true);
  assert.equal(codex.nodes.some((node) => node.model === 'gpt-5.6-sol' && node.provider === 'codex'), true);
  assert.equal(codex.nodes.find((node) => node.model === 'gpt-5.6-terra').permissions.workspace_write, true);

  const gemini = await discoverGeminiCliModelNodes({ runner: fakeRunner, timeoutMs: 1000 });
  assert.equal(gemini.ok, true);
  assert.equal(gemini.nodes.some((node) => node.model === 'gemini-3.1-pro' && node.provider === 'gemini'), true);
  assert.equal(gemini.nodes.find((node) => node.model === 'gemini-3-flash').capabilities.vision, true);
});

test('Claude aliases and Antigravity provider-default fallback create benchmarkable nodes without a TTY', async () => {
  const old = {
    CLAUDE_MODEL_CANDIDATES: process.env.CLAUDE_MODEL_CANDIDATES,
    CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES: process.env.CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES,
    ANTIGRAVITY_MODEL_CANDIDATES: process.env.ANTIGRAVITY_MODEL_CANDIDATES,
    MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT: process.env.MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT,
  };
  try {
    process.env.CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES = 'true';
    process.env.CLAUDE_MODEL_CANDIDATES = 'claude-custom-test';
    delete process.env.ANTIGRAVITY_MODEL_CANDIDATES;
    process.env.MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT = 'true';
    const claude = await discoverClaudeCliModelNodes();
    assert.equal(claude.ok, true);
    assert.equal(claude.nodes.some((node) => node.model === 'sonnet'), true);
    assert.equal(claude.nodes.some((node) => node.model === 'fable'), true);
    assert.equal(claude.nodes.some((node) => node.model === 'claude-custom-test'), true);
    const antigravity = await discoverAntigravityCliModelNodes({ runner: async () => ({ ok: false, stdout: '', stderr: 'unavailable', exitCode: 1 }) });
    assert.equal(antigravity.ok, true);
    assert.equal(antigravity.nodes[0].model, '@default');
    assert.equal(antigravity.nodes[0].model_catalog.default_selector, true);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('refreshModelCatalog writes discovered nodes and registry reads them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-model-catalog-'));
  const old = {
    MODEL_NODES_CONFIG: process.env.MODEL_NODES_CONFIG,
    DDALGGAK_MODEL_NODES_CONFIG: process.env.DDALGGAK_MODEL_NODES_CONFIG,
    MODEL_NODES_DISCOVERED_CONFIG: process.env.MODEL_NODES_DISCOVERED_CONFIG,
    MODEL_CATALOG_REFRESH_STATE_PATH: process.env.MODEL_CATALOG_REFRESH_STATE_PATH,
    OLLAMA_DISCOVERY_ENABLED: process.env.OLLAMA_DISCOVERY_ENABLED,
    OPENAI_COMPATIBLE_DISCOVERY_ENABLED: process.env.OPENAI_COMPATIBLE_DISCOVERY_ENABLED,
    CODEX_CLI_MODEL_DISCOVERY_ENABLED: process.env.CODEX_CLI_MODEL_DISCOVERY_ENABLED,
    CLAUDE_CLI_MODEL_DISCOVERY_ENABLED: process.env.CLAUDE_CLI_MODEL_DISCOVERY_ENABLED,
    ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED: process.env.ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED,
    GEMINI_CLI_MODEL_DISCOVERY_ENABLED: process.env.GEMINI_CLI_MODEL_DISCOVERY_ENABLED,
  };
  try {
    process.env.MODEL_NODES_CONFIG = path.join(dir, 'model_nodes.json');
    process.env.DDALGGAK_MODEL_NODES_CONFIG = process.env.MODEL_NODES_CONFIG;
    process.env.MODEL_NODES_DISCOVERED_CONFIG = path.join(dir, 'model_nodes.discovered.json');
    process.env.MODEL_CATALOG_REFRESH_STATE_PATH = path.join(dir, 'state.json');
    process.env.OLLAMA_DISCOVERY_ENABLED = 'false';
    process.env.OPENAI_COMPATIBLE_DISCOVERY_ENABLED = 'false';
    process.env.CODEX_CLI_MODEL_DISCOVERY_ENABLED = 'true';
    process.env.CLAUDE_CLI_MODEL_DISCOVERY_ENABLED = 'false';
    process.env.ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED = 'false';
    process.env.GEMINI_CLI_MODEL_DISCOVERY_ENABLED = 'false';
    const fakeRunner = async () => ({ ok: true, stdout: JSON.stringify({ models: [{ slug: 'gpt-5.5' }, { slug: 'gpt-5-codex' }] }), stderr: '', exitCode: 0 });
    const result = await refreshModelCatalog({ force: true, reason: 'test', logger: { log() {}, error() {} }, runner: fakeRunner });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(process.env.MODEL_NODES_DISCOVERED_CONFIG), true);
    const nodes = listModelNodes({ includeDisabled: true });
    assert.equal(nodes.some((node) => node.id === 'codex_gpt-5_5'), true);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
