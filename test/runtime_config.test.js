import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatRuntimeConfigForTelegram,
  auditDdalggakRuntimeEnv,
  formatRuntimeConfigDoctorForTelegram,
  resolveDdalggakRouteRuntimeConfig,
  resolveDdalggakRuntimeConfig,
} from '../src/application/runtime_config.js';

test('runtime config supports a one-line local_fast preset', () => {
  const config = resolveDdalggakRuntimeConfig({ env: { DDALGGAK_RUNTIME_PRESET: 'local_fast' } });
  assert.equal(config.preset, 'local_fast');
  assert.equal(config.fast.provider, 'antigravity');
  assert.equal(config.search.provider, 'antigravity');
  assert.equal(config.search.fallback_to_workbench, true);
});

test('simplified fast/search/work provider envs resolve without route-specific names', () => {
  const env = {
    DDALGGAK_FAST_PROVIDER: 'openai_compatible',
    DDALGGAK_FAST_MODEL: 'llama-fast',
    DDALGGAK_SEARCH_PROVIDER: 'antigravity',
    DDALGGAK_WORK_PROVIDER: 'codex',
    DDALGGAK_WORK_MODEL: 'gpt-5.5',
    DDALGGAK_LOCAL_BASE_URL: 'http://localhost:11434/v1',
  };
  const config = resolveDdalggakRuntimeConfig({ env });
  assert.equal(config.fast.provider, 'openai_compatible');
  assert.equal(config.fast.model, 'llama-fast');
  assert.equal(config.fast.openai_compatible.base_url, 'http://localhost:11434/v1');
  assert.equal(config.search.provider, 'antigravity');
  assert.equal(config.workbench.provider, 'codex');
  assert.equal(config.workbench.model, 'gpt-5.5');
});

test('context budget adjusts direct/search projection defaults', () => {
  const small = resolveDdalggakRuntimeConfig({ env: { DDALGGAK_CONTEXT_BUDGET: 'small' } });
  const large = resolveDdalggakRuntimeConfig({ env: { DDALGGAK_CONTEXT_BUDGET: 'large' } });
  assert.ok(small.fast.context_max_chars < large.fast.context_max_chars);
  assert.ok(small.search.context_turns < large.search.context_turns);
});

test('route runtime config returns the requested tier', () => {
  const env = { DDALGGAK_FAST_PROVIDER: 'antigravity', DDALGGAK_SEARCH_PROVIDER: 'codex', DDALGGAK_SEARCH_TIMEOUT_MS: '12345' };
  assert.equal(resolveDdalggakRouteRuntimeConfig('direct', { env }).provider, 'antigravity');
  assert.equal(resolveDdalggakRouteRuntimeConfig('search', { env }).provider, 'codex');
  assert.equal(resolveDdalggakRouteRuntimeConfig('search', { env }).timeout_ms, 12345);
});

test('runtime config formatter avoids secret values and shows minimal env examples', () => {
  const text = formatRuntimeConfigForTelegram(resolveDdalggakRuntimeConfig({ env: {
    DDALGGAK_FAST_PROVIDER: 'openai_compatible',
    DDALGGAK_FAST_MODEL: 'llama-fast',
    DDALGGAK_LOCAL_BASE_URL: 'http://localhost:11434/v1',
    DDALGGAK_LOCAL_API_KEY: 'secret-key',
  } }));
  assert.match(text, /runtime config/);
  assert.match(text, /DDALGGAK_RUNTIME_PRESET=local_fast/);
  assert.doesNotMatch(text, /secret-key/);
});

test('runtime config doctor flags legacy override conflicts and invalid values', () => {
  const report = auditDdalggakRuntimeEnv({
    sourceLabel: 'unit-test.env',
    configuredKeys: [
      'DDALGGAK_FAST_PROVIDER',
      'DDALGGAK_DIRECT_ASK_PROVIDER',
      'DDALGGAK_CONTEXT_BUDGET',
      'DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH',
      'DDALGGAK_NOT_A_REAL_SETTING',
    ],
    env: {
      DDALGGAK_FAST_PROVIDER: 'antigravity',
      DDALGGAK_DIRECT_ASK_PROVIDER: 'codex',
      DDALGGAK_CONTEXT_BUDGET: 'huge',
      DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH: 'maybe',
      DDALGGAK_NOT_A_REAL_SETTING: '1',
    },
  })
  assert.ok(report.errors.some((item) => item.code === 'invalid_enum'))
  assert.ok(report.errors.some((item) => item.code === 'invalid_boolean'))
  assert.ok(report.warnings.some((item) => item.code === 'legacy_override_conflict'))
  assert.ok(report.warnings.some((item) => item.code === 'unknown_project_env'))
})

test('runtime config doctor formatter redacts values and shows effective config', () => {
  const report = auditDdalggakRuntimeEnv({
    sourceLabel: 'unit-test.env',
    configuredKeys: ['DDALGGAK_FAST_PROVIDER', 'DDALGGAK_LOCAL_API_KEY'],
    env: {
      DDALGGAK_FAST_PROVIDER: 'openai_compatible',
      DDALGGAK_LOCAL_BASE_URL: 'http://localhost:11434/v1',
      DDALGGAK_LOCAL_API_KEY: 'super-secret',
    },
  })
  const text = formatRuntimeConfigDoctorForTelegram(report)
  assert.match(text, /config doctor/)
  assert.match(text, /fast: openai_compatible/)
  assert.doesNotMatch(text, /super-secret/)
})
