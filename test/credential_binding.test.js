import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatSessionStore } from '../src/chat/session.js';
import {
  bindCredentialForChat,
  bindCredentialReferenceForChat,
  clearCredentialForChat,
  getCredentialBindingState,
  getCredentialCoverageForProposal,
  resolveCredentialEnvForChat,
} from '../src/application/credential_binding.js';

function makeStore() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-cred-'));
  return new ChatSessionStore({ baseDir });
}

test('credential reference binding stores metadata only and never mutates process.env', () => {
  const store = makeStore();
  delete process.env.OPENAI_API_KEY;
  const meta = bindCredentialReferenceForChat(store, 'chat-1', 'OPENAI_API_KEY', {
    referenceType: 'env_var',
    reference: 'OPENAI_API_KEY',
  });
  assert.equal(meta.credential_key, 'OPENAI_API_KEY');
  assert.equal(meta.reference_type, 'env_var');
  assert.equal(meta.reference, 'OPENAI_API_KEY');
  const session = store.get('chat-1');
  assert.equal(session.credential_binding_state.summary.bound_count, 1);
  assert.equal(JSON.stringify(session).includes('sk-test-1234'), false);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});

test('credential coverage only counts resolved job-scoped bindings', () => {
  const store = makeStore();
  bindCredentialReferenceForChat(store, 'chat-2', 'OPENAI_API_KEY', {
    referenceType: 'env_var',
    reference: 'OPENAI_SOURCE_KEY',
  });
  const proposal = {
    actions: {
      credential_requests: [
        { credential_key: 'OPENAI_API_KEY', required_by: 'Builder' },
        { credential_key: 'GEMINI_API_KEY', required_by: 'Reviewer' },
      ],
    },
  };
  const unresolvedCoverage = getCredentialCoverageForProposal(store, 'chat-2', proposal, { env: {} });
  assert.deepEqual(unresolvedCoverage.bound_keys, []);
  assert.deepEqual(unresolvedCoverage.missing_keys, ['OPENAI_API_KEY', 'GEMINI_API_KEY']);

  const coverage = getCredentialCoverageForProposal(store, 'chat-2', proposal, {
    env: { OPENAI_SOURCE_KEY: 'sk-live-9999' },
  });
  assert.deepEqual(coverage.bound_keys, ['OPENAI_API_KEY']);
  assert.deepEqual(coverage.missing_keys, ['GEMINI_API_KEY']);

  const resolvedEnv = resolveCredentialEnvForChat(store, 'chat-2', {
    env: { OPENAI_SOURCE_KEY: 'sk-live-9999' },
  });
  assert.equal(resolvedEnv.OPENAI_API_KEY, 'sk-live-9999');

  clearCredentialForChat(store, 'chat-2', 'OPENAI_API_KEY');
  const state = getCredentialBindingState(store, 'chat-2');
  assert.equal(state.summary.bound_count, 0);
});

test('credential binding state surfaces resolved vs unresolved references', () => {
  const store = makeStore();
  bindCredentialReferenceForChat(store, 'chat-3', 'OPENAI_API_KEY', {
    referenceType: 'env_var',
    reference: 'OPENAI_SOURCE_KEY',
  });
  const unresolved = getCredentialBindingState(store, 'chat-3', { includeResolution: true, env: {} });
  assert.equal(unresolved.summary.resolved_count, 0);
  assert.equal(unresolved.bindings[0].resolved, false);

  const resolved = getCredentialBindingState(store, 'chat-3', { includeResolution: true, env: { OPENAI_SOURCE_KEY: 'sk-bound-1234' } });
  assert.equal(resolved.summary.resolved_count, 1);
  assert.equal(resolved.bindings[0].resolved, true);
});

test('telegram secret binding stores encrypted secret outside session and resolves only for same chat', () => {
  const store = makeStore();
  delete process.env.OPENAI_API_KEY;
  const meta = bindCredentialForChat(store, 'chat-4', 'OPENAI_API_KEY', 'sk-test-1234');
  assert.equal(meta.credential_key, 'OPENAI_API_KEY');
  assert.equal(meta.reference_type, 'secret_ref');

  const sessionText = fs.readFileSync(store.filePath, 'utf8');
  assert.equal(sessionText.includes('sk-test-1234'), false);

  const secretStorePath = path.join(path.dirname(store.filePath), 'credential_secrets.enc.json');
  const secretStoreText = fs.readFileSync(secretStorePath, 'utf8');
  assert.equal(secretStoreText.includes('sk-test-1234'), false);

  const resolvedEnv = resolveCredentialEnvForChat(store, 'chat-4');
  assert.equal(resolvedEnv.OPENAI_API_KEY, 'sk-test-1234');

  const wrongChatEnv = resolveCredentialEnvForChat(store, 'chat-other');
  assert.equal(wrongChatEnv.OPENAI_API_KEY, undefined);

  clearCredentialForChat(store, 'chat-4', 'OPENAI_API_KEY');
  const clearedEnv = resolveCredentialEnvForChat(store, 'chat-4');
  assert.equal(clearedEnv.OPENAI_API_KEY, undefined);
});
