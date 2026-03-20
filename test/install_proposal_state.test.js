import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionStore } from '../src/chat/session.js';
import {
  buildInstallProposalStateFromExecution,
  buildInstallProposalPrompt,
  setPendingInstallProposal,
  getPendingInstallProposal,
  archivePendingInstallProposal,
} from '../src/application/install_proposal_state.js';

test('buildInstallProposalStateFromExecution captures resume request and gap summary', () => {
  const state = buildInstallProposalStateFromExecution({
    team: {
      team_name: 'Notebook Team',
      agents: [
        { agent_id: 'builder', name: 'Builder', role: 'builder', recommended_tool_ids: ['workspace_fs'] },
      ],
    },
    runtime: { threadId: 'thread-1', availableToolIds: [] },
    execution: {
      outputs: [],
      results: [{ status: 'error', note: "Tool 'workspace_fs' not found" }],
    },
    resumeRequest: {
      message: 'notebook 만들어줘',
      input_kind: 'chat_message',
      force_mode: 'normal',
      telegram_message_id: 42,
      user_reply_to_message_id: 41,
    },
  });

  assert.equal(state.status, 'awaiting_install_approval');
  assert.equal(state.resume_request.message, 'notebook 만들어줘');
  assert.equal(state.proposal.kind, 'capability_install_proposal');
  assert.ok(Number(state.proposal.gap_count || 0) > 0);
});

test('session store can archive pending install proposal state', () => {
  const store = new ChatSessionStore({ persistPath: '' });
  const state = buildInstallProposalStateFromExecution({
    team: {
      team_name: 'Research Team',
      agents: [
        { agent_id: 'researcher', name: 'Researcher', role: 'researcher', recommended_tool_ids: ['web_search'] },
      ],
    },
    runtime: { threadId: 'thread-2', availableToolIds: [] },
    execution: {
      outputs: [],
      results: [{ status: 'error', note: "Tool 'web_search' not found" }],
    },
    resumeRequest: { message: '자료 조사해줘' },
  });
  setPendingInstallProposal(store, 'chat-1', state);
  const prompt = buildInstallProposalPrompt(getPendingInstallProposal(store, 'chat-1'), { hasPendingTeam: true });
  assert.ok(prompt.text.includes('Apply active + resume'));
  const archived = archivePendingInstallProposal(store, 'chat-1', 'applied_active', { apply_state: 'active' });
  assert.equal(archived.status, 'applied_active');
  assert.equal(store.get('chat-1').pending_install_proposal, null);
  assert.equal(store.get('chat-1').last_install_proposal.status, 'applied_active');
});
