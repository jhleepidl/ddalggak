import test from 'node:test';
import assert from 'node:assert/strict';
import { getGeminiCliRuntimeEnvDefaults } from '../src/gemini.js';

test('Gemini CLI subprocess defaults to file storage and trusted workspace for headless runs', () => {
  const oldForce = process.env.GEMINI_FORCE_FILE_STORAGE;
  const oldTrust = process.env.GEMINI_CLI_TRUST_WORKSPACE;
  try {
    delete process.env.GEMINI_FORCE_FILE_STORAGE;
    delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
    const env = getGeminiCliRuntimeEnvDefaults();
    assert.equal(env.GEMINI_FORCE_FILE_STORAGE, 'true');
    assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
  } finally {
    if (typeof oldForce === 'undefined') delete process.env.GEMINI_FORCE_FILE_STORAGE;
    else process.env.GEMINI_FORCE_FILE_STORAGE = oldForce;
    if (typeof oldTrust === 'undefined') delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
    else process.env.GEMINI_CLI_TRUST_WORKSPACE = oldTrust;
  }
});

test('Gemini CLI subprocess env respects explicit overrides', () => {
  const oldForce = process.env.GEMINI_FORCE_FILE_STORAGE;
  const oldTrust = process.env.GEMINI_CLI_TRUST_WORKSPACE;
  try {
    process.env.GEMINI_FORCE_FILE_STORAGE = 'false';
    process.env.GEMINI_CLI_TRUST_WORKSPACE = '0';
    const env = getGeminiCliRuntimeEnvDefaults({ GEMINI_FORCE_FILE_STORAGE: 'custom' });
    assert.equal(env.GEMINI_FORCE_FILE_STORAGE, 'custom');
    assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, '0');
  } finally {
    if (typeof oldForce === 'undefined') delete process.env.GEMINI_FORCE_FILE_STORAGE;
    else process.env.GEMINI_FORCE_FILE_STORAGE = oldForce;
    if (typeof oldTrust === 'undefined') delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
    else process.env.GEMINI_CLI_TRUST_WORKSPACE = oldTrust;
  }
});
