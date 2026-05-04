import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGeminiModelCandidates } from '../src/gemini.js';

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (typeof patch[key] === 'undefined') delete process.env[key];
    else process.env[key] = patch[key];
  }
  try { return fn(); }
  finally {
    for (const key of Object.keys(patch)) {
      if (typeof previous[key] === 'undefined') delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('Gemini auto expands to ddalggak model pool before native CLI auto', () => {
  withEnv({
    GEMINI_MODEL: 'auto',
    GEMINI_MODEL_PRIMARY: undefined,
    GEMINI_MODEL_AUTO_MODE: 'pool',
    GEMINI_MODEL_POOL: 'gemini-2.5-flash, gemini-2.5-pro, gemini-3.1-pro-preview, auto',
    GEMINI_MODEL_FALLBACKS: 'auto',
  }, () => {
    assert.deepEqual(resolveGeminiModelCandidates(''), [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3.1-pro-preview',
      'auto',
    ]);
  });
});

test('explicit Gemini model is tried first but still receives pool fallbacks', () => {
  withEnv({
    GEMINI_MODEL_AUTO_MODE: 'pool',
    GEMINI_MODEL_POOL: 'gemini-2.5-flash,auto',
    GEMINI_MODEL_FALLBACKS: 'gemini-2.5-flash,auto',
  }, () => {
    assert.deepEqual(resolveGeminiModelCandidates('gemini-3-flash-preview'), [
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'auto',
    ]);
  });
});

test('native Gemini CLI auto can be requested explicitly', () => {
  withEnv({
    GEMINI_MODEL: 'auto',
    GEMINI_MODEL_PRIMARY: undefined,
    GEMINI_MODEL_AUTO_MODE: 'cli',
    GEMINI_MODEL_POOL: 'gemini-2.5-flash,auto',
    GEMINI_MODEL_FALLBACKS: 'auto',
  }, () => {
    assert.deepEqual(resolveGeminiModelCandidates(''), ['auto']);
  });
});
