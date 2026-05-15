import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverCodexCliModelNodes, discoverGeminiCliModelNodes, parseCliModelListOutput } from '../src/application/model_node_discovery.js';
import { refreshModelCatalog } from '../src/application/model_catalog_refresh.js';
import { listModelNodes } from '../src/application/model_node_registry.js';

test('CLI /model output parser extracts Codex and Gemini model ids', () => {
  const codexText = 'Select a model\n  gpt-5.5\n  gpt-5-codex\n  o4-mini\n';
  assert.deepEqual(parseCliModelListOutput({ provider: 'codex', text: codexText }), ['gpt-5.5', 'gpt-5-codex', 'o4-mini']);
  const geminiText = 'Auto (Gemini 3): gemini-3.1-pro, gemini-3-flash\nManual: gemini-2.5-pro';
  assert.deepEqual(parseCliModelListOutput({ provider: 'gemini', text: geminiText }), ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro']);
});

test('Codex and Gemini CLI discovery build model nodes from /model output', async () => {
  const fakeRunner = async (command, args, opts) => {
    assert.equal(opts.input.includes('/model'), true);
    if (command === 'codex') return { ok: true, stdout: 'Models:\n* gpt-5.5\n* gpt-5-codex\n', stderr: '', exitCode: 0 };
    if (command === 'gemini') return { ok: true, stdout: 'Select Model\n1. gemini-3.1-pro\n2. gemini-3-flash\n', stderr: '', exitCode: 0 };
    return { ok: false, stdout: '', stderr: 'bad command', exitCode: 1 };
  };
  const codex = await discoverCodexCliModelNodes({ runner: fakeRunner, timeoutMs: 1000 });
  assert.equal(codex.ok, true);
  assert.equal(codex.nodes.some((node) => node.model === 'gpt-5.5' && node.provider === 'codex'), true);
  assert.equal(codex.nodes.find((node) => node.model === 'gpt-5-codex').permissions.workspace_write, true);

  const gemini = await discoverGeminiCliModelNodes({ runner: fakeRunner, timeoutMs: 1000 });
  assert.equal(gemini.ok, true);
  assert.equal(gemini.nodes.some((node) => node.model === 'gemini-3.1-pro' && node.provider === 'gemini'), true);
  assert.equal(gemini.nodes.find((node) => node.model === 'gemini-3-flash').capabilities.vision, true);
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
    process.env.GEMINI_CLI_MODEL_DISCOVERY_ENABLED = 'false';
    const fakeRunner = async () => ({ ok: true, stdout: 'gpt-5.5\ngpt-5-codex\n', stderr: '', exitCode: 0 });
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
