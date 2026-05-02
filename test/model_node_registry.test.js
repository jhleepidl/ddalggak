import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatModelNodeInventoryForPlanner, getModelNode, listModelNodes } from '../src/application/model_node_registry.js';
import { createFreeformTeamConfigurationAdvanced } from '../src/application/team_configuration.js';

test('model node registry loads OpenAI-compatible local nodes from config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-nodes-'));
  const config = path.join(dir, 'model_nodes.json');
  fs.writeFileSync(config, JSON.stringify({ nodes: [{
    id: 'local_gemma4',
    label: 'Local Gemma 4',
    provider: 'openai_compatible',
    runtime: 'ollama',
    base_url: 'http://localhost:11434/v1',
    model: 'gemma4:31b',
    enabled: true,
    capabilities: { chat: true, code: true, structured_json: true },
    permissions: { memory_read: 'project_scoped', memory_write: 'write_intent_only', workspace_read: true },
    role_bias: ['review', 'draft'],
  }] }), 'utf8');
  const old = process.env.MODEL_NODES_CONFIG;
  process.env.MODEL_NODES_CONFIG = config;
  try {
    const nodes = listModelNodes();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].provider, 'openai_compatible');
    assert.equal(nodes[0].model, 'gemma4:31b');
    assert.equal(getModelNode('local_gemma4').model, 'gemma4:31b');
    assert.match(formatModelNodeInventoryForPlanner(), /local_gemma4/);
  } finally {
    if (old === undefined) delete process.env.MODEL_NODES_CONFIG;
    else process.env.MODEL_NODES_CONFIG = old;
  }
});

test('planner-driven team preserves local model node provider/model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-nodes-team-'));
  const config = path.join(dir, 'model_nodes.json');
  fs.writeFileSync(config, JSON.stringify({ nodes: [{
    id: 'local_gemma4',
    label: 'Local Gemma 4',
    provider: 'openai_compatible',
    runtime: 'ollama',
    base_url: 'http://localhost:11434/v1',
    model: 'gemma4:31b',
    enabled: true,
  }] }), 'utf8');
  const old = process.env.MODEL_NODES_CONFIG;
  process.env.MODEL_NODES_CONFIG = config;
  try {
    const planner = async () => ({ ok: true, plan: {
      team_name: 'local_model_review_team',
      agents: [
        { name: 'Local Context Reviewer', role: 'reviewer', provider: 'openai_compatible', model: 'gemma4:31b', purpose: 'Review projected context privately.' },
        { name: 'Delivery Synthesizer', role: 'synthesizer', provider: 'chatgpt', model: 'gpt-5.4', purpose: 'Summarize for Telegram.' },
      ],
      interaction_spec: { execution_pattern: 'sequential_pipeline', final_answer_owner: 'Delivery Synthesizer' },
    }, planner_metadata: { planner_type: 'test_llm', planning_source: 'unit' } });
    const team = await createFreeformTeamConfigurationAdvanced({ description: '로컬 모델과 API LLM이 대화하는 팀', planner });
    const local = team.agents.find((agent) => agent.name === 'Local Context Reviewer');
    assert.equal(local.provider, 'openai_compatible');
    assert.equal(local.model, 'gemma4:31b');
  } finally {
    if (old === undefined) delete process.env.MODEL_NODES_CONFIG;
    else process.env.MODEL_NODES_CONFIG = old;
  }
});
