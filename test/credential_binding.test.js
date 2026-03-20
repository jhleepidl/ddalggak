import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionStore } from '../src/chat/session.js';
import {
  bindCredentialForChat,
  clearCredentialForChat,
  getCredentialBindingState,
  getCredentialCoverageForProposal,
} from '../src/application/credential_binding.js';

test('credential binding stores masked metadata without exposing raw secrets in session', () => {
  const store = new ChatSessionStore({ persistPath: null });
  const meta = bindCredentialForChat(store, 'chat-1', 'OPENAI_API_KEY', 'sk-test-1234');
  assert.equal(meta.credential_key, 'OPENAI_API_KEY');
  assert.match(meta.masked_value, /1234$/);
  const session = store.get('chat-1');
  assert.equal(session.credential_binding_state.summary.bound_count, 1);
  assert.equal(JSON.stringify(session).includes('sk-test-1234'), false);
});

test('credential coverage reflects bound and missing keys for install proposal', () => {
  const store = new ChatSessionStore({ persistPath: null });
  bindCredentialForChat(store, 'chat-2', 'OPENAI_API_KEY', 'sk-live-9999');
  const coverage = getCredentialCoverageForProposal('chat-2', {
    actions: {
      credential_requests: [
        { credential_key: 'OPENAI_API_KEY', required_by: 'Builder' },
        { credential_key: 'GEMINI_API_KEY', required_by: 'Reviewer' },
      ],
    },
  });
  assert.deepEqual(coverage.bound_keys, ['OPENAI_API_KEY']);
  assert.deepEqual(coverage.missing_keys, ['GEMINI_API_KEY']);
  clearCredentialForChat(store, 'chat-2', 'OPENAI_API_KEY');
  const state = getCredentialBindingState(store, 'chat-2');
  assert.equal(state.summary.bound_count, 0);
});
