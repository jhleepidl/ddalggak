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


test('Gemini CLI subprocess env neutralizes GNU screen/tmux markers for non-interactive stdin runs', () => {
  const env = getGeminiCliRuntimeEnvDefaults();
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.CI, '1');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.FORCE_COLOR, '0');
  assert.equal(env.STY, '');
  assert.equal(env.TMUX, '');
});

test('Gemini CLI subprocess env allows explicit terminal overrides when needed', () => {
  const env = getGeminiCliRuntimeEnvDefaults({ TERM: 'xterm-256color', STY: 'custom-screen' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.STY, 'custom-screen');
});
