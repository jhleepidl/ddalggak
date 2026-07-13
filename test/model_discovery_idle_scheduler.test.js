import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listPendingModelBenchmarks,
  recordModelEvaluationObservation,
  refreshModelCatalog,
  startModelCatalogRefreshScheduler,
} from '../src/application/model_catalog_refresh.js';
import {
  discoverAntigravityCliModelNodes,
  discoverClaudeCliModelNodes,
  parseCliModelListOutput,
} from '../src/application/model_node_discovery.js';
import { inferProviderForModel, listSupportedModels, resolveSupportedModel } from '../src/catalog/model_catalog.js';

const ENV_KEYS = [
  'MODEL_NODES_DISCOVERED_CONFIG',
  'MODEL_CATALOG_REFRESH_STATE_PATH',
  'MODEL_DISCOVERY_REGISTRY_PATH',
  'MODEL_CAPABILITY_SNAPSHOT_PATH',
  'MODEL_CATALOG_REFRESH_ENABLED',
  'MODEL_CATALOG_REFRESH_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_CHECK_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS',
  'MODEL_CATALOG_REFRESH_IDLE_MIN_MS',
  'MODEL_CATALOG_REFRESH_CLI_VERSION_CHECK_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_ON_CLI_VERSION_CHANGE',
  'CODEX_CLI_MODEL_DISCOVERY_ENABLED',
  'CLAUDE_CLI_MODEL_DISCOVERY_ENABLED',
  'ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED',
  'GEMINI_CLI_MODEL_DISCOVERY_ENABLED',
  'OLLAMA_DISCOVERY_ENABLED',
  'OPENAI_COMPATIBLE_DISCOVERY_ENABLED',
  'MODEL_BENCHMARK_MIN_RUNS',
  'CLAUDE_MODEL_CANDIDATES',
  'CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES',
  'ANTIGRAVITY_MODEL_CANDIDATES',
  'ANTIGRAVITY_MODEL_DISCOVERY_ARGS',
  'MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT',
];

function withTempModelEnv(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-model-idle-'));
  const old = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.MODEL_NODES_DISCOVERED_CONFIG = path.join(dir, 'model_nodes.discovered.json');
  process.env.MODEL_CATALOG_REFRESH_STATE_PATH = path.join(dir, 'refresh_state.json');
  process.env.MODEL_DISCOVERY_REGISTRY_PATH = path.join(dir, 'model_discovery_registry.json');
  process.env.MODEL_CAPABILITY_SNAPSHOT_PATH = path.join(dir, 'provider_capabilities.json');
  process.env.MODEL_CATALOG_REFRESH_ENABLED = 'true';
  process.env.OLLAMA_DISCOVERY_ENABLED = 'false';
  process.env.OPENAI_COMPATIBLE_DISCOVERY_ENABLED = 'false';
  process.env.CODEX_CLI_MODEL_DISCOVERY_ENABLED = 'true';
  process.env.CLAUDE_CLI_MODEL_DISCOVERY_ENABLED = 'false';
  process.env.ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED = 'false';
  process.env.GEMINI_CLI_MODEL_DISCOVERY_ENABLED = 'false';
  const cleanup = () => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return Promise.resolve().then(() => fn(dir)).finally(cleanup);
}

test('Claude aliases and Antigravity configured/default candidates are non-interactive', async () => {
  const old = {
    CLAUDE_MODEL_CANDIDATES: process.env.CLAUDE_MODEL_CANDIDATES,
    CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES: process.env.CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES,
    ANTIGRAVITY_MODEL_CANDIDATES: process.env.ANTIGRAVITY_MODEL_CANDIDATES,
    MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT: process.env.MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT,
  };
  try {
    process.env.CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES = 'true';
    process.env.CLAUDE_MODEL_CANDIDATES = 'claude-opus-4-8,claude-sonnet-5';
    process.env.ANTIGRAVITY_MODEL_CANDIDATES = 'gemini-3.5-flash,gemini-3.1-pro';
    process.env.MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT = 'true';
    assert.deepEqual(parseCliModelListOutput({ provider: 'claude', text: 'Claude Opus 4.8\nsonnet\ngpt-5.6-sol' }), ['claude-opus-4-8', 'sonnet']);
    assert.deepEqual(parseCliModelListOutput({ provider: 'antigravity', text: 'Gemini 3.5 Flash\ngpt-5.6-sol' }), ['gemini-3.5-flash']);
    const claude = await discoverClaudeCliModelNodes();
    const antigravity = await discoverAntigravityCliModelNodes({ runner: async () => ({ ok: false, stdout: '', stderr: 'unavailable', exitCode: 1 }) });
    assert.equal(claude.ok, true);
    assert.equal(claude.nodes.some((node) => node.model === 'sonnet'), true);
    assert.equal(claude.nodes.some((node) => node.model === 'claude-opus-4-8'), true);
    assert.equal(antigravity.ok, true);
    assert.equal(antigravity.nodes.some((node) => node.model === 'gemini-3.5-flash'), true);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('newly discovered CLI models become cached supported models and benchmark candidates', async () => {
  await withTempModelEnv(async () => {
    const runner = async (command, args, options = {}) => {
      if (args?.includes('--version')) return { ok: true, stdout: 'codex-cli 0.144.0\n', stderr: '', exitCode: 0 };
      if (args?.[0] === 'debug' && args?.[1] === 'models') return { ok: true, stdout: JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }] }), stderr: '', exitCode: 0 };
      return { ok: false, stdout: '', stderr: 'unexpected', exitCode: 1 };
    };
    const first = await refreshModelCatalog({ force: true, reason: 'test_new_model', runner, logger: { log() {}, error() {} } });
    assert.equal(first.ok, true);
    assert.equal(first.registry.new_models.some((row) => row.model === 'gpt-5.6-sol'), true);
    assert.equal(listPendingModelBenchmarks().some((row) => row.model === 'gpt-5.6-sol' && row.benchmark_status === 'benchmark_pending'), true);
    assert.equal(resolveSupportedModel('gpt-5.6-sol'), 'gpt-5.6-sol');
    assert.equal(inferProviderForModel('gpt-5.6-sol'), 'codex');
    assert.equal(listSupportedModels().some((row) => row.id === 'gpt-5.6-terra' && row.discovered === true), true);

    const second = await refreshModelCatalog({ force: true, reason: 'test_repeat', runner, logger: { log() {}, error() {} } });
    assert.equal(second.registry.new_models.length, 0);
  });
});

test('live evaluation observations advance a discovered model from pending to evaluated', async () => {
  await withTempModelEnv(async () => {
    process.env.MODEL_BENCHMARK_MIN_RUNS = '3';
    const runner = async (command, args, options = {}) => {
      if (args?.includes('--version')) return { ok: true, stdout: 'codex-cli 0.144.0\n', stderr: '', exitCode: 0 };
      if (args?.[0] === 'debug' && args?.[1] === 'models') return { ok: true, stdout: JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }), stderr: '', exitCode: 0 };
      return { ok: false, stdout: '', stderr: 'unexpected', exitCode: 1 };
    };
    await refreshModelCatalog({ force: true, reason: 'test_benchmark', runner, logger: { log() {}, error() {} } });
    const one = recordModelEvaluationObservation({ provider: 'codex', model: 'gpt-5.6-sol', passed: true, score: 1, evaluationId: 'e1', runId: 'r1' });
    assert.equal(one.entry.benchmark_status, 'benchmark_running');
    recordModelEvaluationObservation({ provider: 'codex', model: 'gpt-5.6-sol', passed: true, score: 0.9, evaluationId: 'e1', runId: 'r2' });
    const three = recordModelEvaluationObservation({ provider: 'codex', model: 'gpt-5.6-sol', passed: false, score: 0.5, evaluationId: 'e1', runId: 'r3' });
    assert.equal(three.entry.benchmark_status, 'evaluated');
    assert.equal(three.entry.evaluation_observations.count, 3);
    assert.equal(three.entry.evaluation_observations.passed_count, 2);
  });
});

test('idle scheduler never performs discovery while runtime is busy', async () => {
  await withTempModelEnv(async () => {
    process.env.MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS = '999999';
    process.env.MODEL_CATALOG_REFRESH_CHECK_INTERVAL_MS = '999999';
    let calls = 0;
    const scheduler = startModelCatalogRefreshScheduler({
      logger: { log() {}, error() {} },
      getActivityState: () => ({ busy: true, active_runs: 1, pending_messages: 0, idle_for_ms: 0 }),
      runner: async () => { calls += 1; return { ok: true, stdout: 'should-not-run', stderr: '', exitCode: 0 }; },
    });
    try {
      const result = await scheduler.trigger({ reason: 'test_busy' });
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'runtime_busy');
      assert.equal(calls, 0);
    } finally {
      scheduler.stop();
    }
  });
});

test('idle scheduler refreshes early when the CLI version changes', async () => {
  await withTempModelEnv(async (dir) => {
    process.env.MODEL_CATALOG_REFRESH_INTERVAL_MS = String(24 * 60 * 60 * 1000);
    process.env.MODEL_CATALOG_REFRESH_CLI_VERSION_CHECK_INTERVAL_MS = '60000';
    process.env.MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS = '999999';
    process.env.MODEL_CATALOG_REFRESH_CHECK_INTERVAL_MS = '999999';
    process.env.MODEL_CATALOG_REFRESH_IDLE_MIN_MS = '1';
    process.env.MODEL_CATALOG_REFRESH_ON_CLI_VERSION_CHANGE = 'true';
    fs.writeFileSync(process.env.MODEL_CATALOG_REFRESH_STATE_PATH, JSON.stringify({
      last_completed_at: new Date().toISOString(),
      last_capability_probe_at: '2000-01-01T00:00:00.000Z',
    }));
    fs.writeFileSync(process.env.MODEL_CAPABILITY_SNAPSHOT_PATH, JSON.stringify({
      items: [{ provider: 'codex', cli_available: true, cli_version: 'codex-cli 0.142.3' }],
    }));
    const runner = async (command, args, options = {}) => {
      if (args?.includes('--version')) return { ok: true, stdout: 'codex-cli 0.144.0\n', stderr: '', exitCode: 0 };
      if (args?.[0] === 'debug' && args?.[1] === 'models') return { ok: true, stdout: JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }), stderr: '', exitCode: 0 };
      return { ok: false, stdout: '', stderr: 'unexpected', exitCode: 1 };
    };
    const scheduler = startModelCatalogRefreshScheduler({
      logger: { log() {}, error() {} },
      getActivityState: () => ({ busy: false, active_runs: 0, pending_messages: 0, idle_for_ms: 999999 }),
      runner,
    });
    try {
      const result = await scheduler.trigger({ reason: 'test_version_change' });
      assert.equal(result.skipped, false);
      assert.equal(result.state.cli_versions_changed.includes('codex'), true);
      assert.equal(result.payload.nodes.some((row) => row.model === 'gpt-5.6-sol'), true);
      assert.equal(fs.existsSync(path.join(dir, 'model_discovery_registry.json')), true);
    } finally {
      scheduler.stop();
    }
  });
});
