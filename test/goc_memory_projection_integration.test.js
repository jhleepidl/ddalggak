import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveGocMemorySurfaceSpec,
  deriveGocMemoryNodePayload,
  formatGocProjectionContext,
} from '../src/application/telegram_chat_execution.js';
import {
  deriveKnowledgeBaseMemorySurfaceSpec,
  buildGocMemoryNodePayload,
  ensureKnowledgeBaseMemorySurfacesInGoc,
} from '../src/application/goc_memory_sync.js';

test('deriveGocMemorySurfaceSpec carries role targets into GoC surface policy', () => {
  const spec = deriveGocMemorySurfaceSpec({
    doc_id: 'progress',
    surface_id: 'implementation_notes',
    title: 'Implementation Notes',
    semantic_slots: ['progress'],
    target_roles: ['builder'],
    write_policy: 'append_only',
  });

  assert.equal(spec.surface_id, 'implementation_notes');
  assert.equal(spec.semantic_kind, 'progress');
  assert.equal(spec.visibility_scope, 'private');
  assert.equal(spec.write_mode, 'append_only');
  assert.deepEqual(spec.policy.target_roles, ['builder']);
});

test('deriveGocMemoryNodePayload maps write events to memory graph nodes without leaking fallback state', () => {
  const payload = deriveGocMemoryNodePayload({
    jobId: 'job-123',
    markdown: '## Final Answer\n\nPatched the bug and verified the flow.',
    provider: 'chatgpt',
    roleId: 'synthesizer',
    purpose: 'final',
    writeEvent: {
      status: 'allowed',
      requested_doc: 'final_answer',
      resolved_doc: 'final_answer.md',
      requested_surface_id: 'final_answer',
      target_surface_id: 'final_answer',
      event_type: 'routing_decision',
      actor_kind: 'planner',
      pipeline_stage: 'routing',
      semantic_kind: 'decisions',
    },
  });

  assert.equal(payload.surface_id, 'final_answer');
  assert.equal(payload.node_type, 'decision');
  assert.equal(payload.status, 'published');
  assert.equal(payload.owner_role_id, 'synthesizer');
  assert.equal(payload.provenance.job_id, 'job-123');
  assert.equal(payload.provenance.memory_write_status, 'allowed');
  assert.equal(payload.content.semantic_kind, 'decisions');
  assert.equal(payload.content.event_type, 'routing_decision');
  assert.equal(payload.provenance.actor_kind, 'planner');
  assert.equal(payload.provenance.pipeline_stage, 'routing');
  assert.match(payload.content.summary, /Patched the bug/);
});

test('formatGocProjectionContext summarizes visible and blocked nodes for prompts', () => {
  const formatted = formatGocProjectionContext({
    projection: {
      visible_surface_ids: ['mission_brief', 'working_memory'],
      blocked_surface_ids: ['critic_log'],
      visible_nodes: [
        {
          surface_id: 'mission_brief',
          content_preview: 'Implement projection-aware retrieval in the runtime path.',
          trust_tier: 'reported',
          confidence: 0.85,
          visibility_reason: 'visible',
        },
      ],
      blocked_nodes: [
        {
          surface_id: 'critic_log',
          content_preview: 'Conflicting review note',
          blocked_reason: 'role_not_allowed',
        },
      ],
    },
  });

  assert.equal(formatted.visibleNodeCount, 1);
  assert.equal(formatted.blockedNodeCount, 1);
  assert.match(formatted.text, /GOC ROLE-SCOPED MEMORY PROJECTION/);
  assert.match(formatted.text, /mission_brief/);
  assert.match(formatted.text, /role_not_allowed/);
});


test('ensureKnowledgeBaseMemorySurfacesInGoc skips duplicate surface sync for identical signatures', async () => {
  const created = [];
  const client = {
    async createMemorySurface(threadId, body) {
      created.push({ threadId, body });
      return { ok: true };
    },
  };
  const docs = [
    {
      doc_id: 'progress',
      surface_id: 'implementation_notes',
      title: 'Implementation Notes',
      semantic_slots: ['progress'],
      target_roles: ['builder'],
      write_policy: 'append_only',
    },
    {
      doc_id: 'decisions',
      surface_id: 'final_answer',
      title: 'Final Answer',
      semantic_slots: ['decisions'],
      target_roles: ['synthesizer'],
      write_policy: 'final',
    },
  ];

  const first = await ensureKnowledgeBaseMemorySurfacesInGoc({
    jobId: 'job-cache',
    client,
    threadId: 'thread-1',
    docs,
    deriveSpec: deriveKnowledgeBaseMemorySurfaceSpec,
  });
  const second = await ensureKnowledgeBaseMemorySurfacesInGoc({
    jobId: 'job-cache',
    client,
    threadId: 'thread-1',
    docs,
    deriveSpec: deriveKnowledgeBaseMemorySurfaceSpec,
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(created.length, 2);
});
