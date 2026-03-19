import test from 'node:test';
import assert from 'node:assert/strict';

import { createSupervisorRuntimeLoader } from '../src/application/supervisor_runtime_loader.js';

function createLoader() {
  return createSupervisorRuntimeLoader({
    composeCapabilitiesForRun: ({ jobId = '' } = {}) => ({
      authority: {
        mode: 'standalone',
        plan_source: 'local',
        context_source: 'local',
        agent_catalog_source: 'local',
        conversation_team_source: 'local',
        skill_catalog_source: 'local',
        degraded_mode: false,
        fallback_reason: null,
      },
      capabilities: {
        conversationTeamStore: {
          source: 'local',
          async ensureTeam({ jobId: targetJobId }) {
            return {
              target: { thread_id: `local:${targetJobId}`, conversation_id: `local:${targetJobId}`, source: 'local' },
              rows: [],
              warnings: [],
              preferences: {},
            };
          },
          async getPreferences() { return {}; },
        },
      },
    }),
    bindActor: () => () => {},
    refreshAgentRegistry: async () => ({ agents: [] }),
    normalizeSupervisorJobConfig: (raw = {}) => ({ configNormalized: raw, enabledAgentIds: [], enabledToolIds: [] }),
    pickBaselineConversationCatalogAgents: () => [],
    summarizeJobConfigDebug: () => '',
    summarizeSelectionState: () => ({ catalog_ids: [], enabled_ids: [], disabled_ids: [] }),
    loadLocalContextDocs: () => '',
    jobs: { baseDir: '/tmp/ddalggak-runtime-loader-test', jobDir(jobId = '') { return `/tmp/ddalggak-runtime-loader-test/${jobId}`; } },
    trackedDocNames: [],
  });
}

test('local supervisor runtime exposes job identifiers for downstream team sync', async () => {
  const loadSupervisorRuntime = createLoader();
  const runtime = await loadSupervisorRuntime('job-sync-1', { includeContext: false, includeGlobal: false });
  assert.equal(runtime.jobId, 'job-sync-1');
  assert.equal(runtime.currentJobId, 'job-sync-1');
  assert.equal(runtime.map.threadId, 'local:job-sync-1');
});
