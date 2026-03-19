import test from 'node:test';
import assert from 'node:assert/strict';

import { createSupervisorRuntimeLoader } from '../src/application/supervisor_runtime_loader.js';
import { normalizeJobConfig } from '../src/goc_mapping.js';

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
    normalizeSupervisorJobConfig: normalizeJobConfig,
    pickBaselineConversationCatalogAgents: () => [],
    summarizeJobConfigDebug: () => '',
    summarizeSelectionState: ({ catalog = [], enabled = [] } = {}) => ({
      catalog_ids: catalog.map((row) => row.id),
      enabled_ids: enabled.map((row) => row.id),
      disabled_ids: [],
    }),
    loadLocalContextDocs: () => '',
    jobs: { baseDir: '/tmp/ddalggak-runtime-loader-test', jobDir(jobId = '') { return `/tmp/ddalggak-runtime-loader-test/${jobId}`; } },
    trackedDocNames: [],
  });
}

test('local supervisor runtime exposes built-in tools for planning and execution', async () => {
  const loadSupervisorRuntime = createLoader();
  const runtime = await loadSupervisorRuntime('job-tools-1', { includeContext: false, includeGlobal: false });
  const toolIds = runtime.toolsCatalog.map((row) => row.id).sort();
  assert.ok(toolIds.includes('workspace_fs'));
  assert.ok(toolIds.includes('read_only_fs'));
  assert.ok(toolIds.includes('shell'));
  assert.ok(runtime.tools.some((row) => row.id === 'workspace_fs'));
});
