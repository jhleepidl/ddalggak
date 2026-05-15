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
    cost_profile: { tier: 'free' },
    latency_profile: { tier: 'medium' },
    quality_profile: { tier: 'standard' },
    privacy_profile: { tier: 'local_private', data_boundary: 'local_device', sends_context_off_device: false },
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
    assert.equal(nodes[0].cost_profile.tier, 'free');
    assert.equal(nodes[0].privacy_profile.tier, 'local_private');
    assert.match(formatModelNodeInventoryForPlanner(), /cost=free/);
    assert.match(formatModelNodeInventoryForPlanner(), /privacy=local_private/);
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

test('model node registry exposes account profile for billing/credential boundaries', () => {
  const previous = {
    DDALGGAK_MODEL_NODES_CONFIG: process.env.DDALGGAK_MODEL_NODES_CONFIG,
    MODEL_NODES_CONFIG: process.env.MODEL_NODES_CONFIG,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    PROVIDER_ACCOUNT_MODE: process.env.PROVIDER_ACCOUNT_MODE,
  };
  delete process.env.DDALGGAK_MODEL_NODES_CONFIG;
  delete process.env.MODEL_NODES_CONFIG;
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  process.env.OLLAMA_MODEL = 'gemma3:12b';
  process.env.PROVIDER_ACCOUNT_MODE = 'deployment_owner';
  try {
    const node = listModelNodes({ includeDisabled: true }).find((row) => row.id === 'local_model');
    assert.equal(node.account_profile.mode, 'deployment_owner');
    assert.equal(node.account_profile.billing_owner, 'deployment_owner');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('remote Ollama env node is treated as user-controlled trusted private by default', () => {
  const previous = {
    DDALGGAK_MODEL_NODES_CONFIG: process.env.DDALGGAK_MODEL_NODES_CONFIG,
    MODEL_NODES_CONFIG: process.env.MODEL_NODES_CONFIG,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    OLLAMA_TRUSTED_CONTEXT: process.env.OLLAMA_TRUSTED_CONTEXT,
  };
  delete process.env.DDALGGAK_MODEL_NODES_CONFIG;
  delete process.env.MODEL_NODES_CONFIG;
  process.env.OLLAMA_BASE_URL = 'http://10.0.0.20:11434';
  process.env.OLLAMA_MODEL = 'qwen2.5-coder:32b';
  delete process.env.OLLAMA_TRUSTED_CONTEXT;
  try {
    const node = listModelNodes({ includeDisabled: true }).find((row) => row.id === 'local_model');
    assert.equal(node.privacy_profile.tier, 'trusted_private');
    assert.equal(node.privacy_profile.data_boundary, 'user_controlled_remote');
    assert.equal(node.privacy_profile.allow_private_context, true);
    assert.equal(node.cost_profile.tier, 'free');
    assert.equal(node.quality_profile.coding, 'strong');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
