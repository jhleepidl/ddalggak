import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRecoveryAttemptEvent } from '../src/application/failure_recovery_policy.js';
import { ChatSessionStore } from '../src/chat/session.js';

test('chat session store preserves normalized recovery events', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-recovery-'));
  const store = new ChatSessionStore({ baseDir });
  const event = buildRecoveryAttemptEvent({
    action: { type: 'run_agent', agent_id: 'Builder' },
    failure: { category: 'implementation_failure', recovery_strategy: 'retry_once', summary: 'retry', message: 'boom' },
    attempt: 1,
    stage: 'retry_scheduled',
    status: 'retrying',
  });
  store.upsert('chat-1', {
    recovery_events: [event],
    last_recovery_event: event,
    recovery_state: { status: 'retrying', category: 'implementation_failure', recovery_strategy: 'retry_once' },
  });
  const session = store.get('chat-1');
  assert.equal(session.recovery_events.length, 1);
  assert.equal(session.last_recovery_event?.status, 'retrying');
  assert.equal(session.last_recovery_event?.agent_id, 'builder');
  assert.equal(session.recovery_state?.recovery_strategy, 'retry_once');
});
