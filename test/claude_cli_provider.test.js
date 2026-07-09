import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeAgentTelemetryRow, parseClaudeCliJsonOutput } from '../src/claude_cli.js';
import { normalizeRuntimeProvider } from '../src/provider_migration.js';
import { deriveAgentTelemetry, extractAgentExecutionTelemetry } from '../src/application/room_agent_policy.js';

const SAMPLE_JSON = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4212,
  duration_api_ms: 3900,
  num_turns: 1,
  result: '검증 결과: 근거가 충분합니다.',
  session_id: 'sess_abc',
  total_cost_usd: 0.0042,
  usage: { input_tokens: 12, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 250 },
  modelUsage: { 'claude-sonnet-5': { input_tokens: 12, output_tokens: 250 } },
});

test('parses claude headless JSON output with measured usage and cost', () => {
  const parsed = parseClaudeCliJsonOutput(SAMPLE_JSON);
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.is_error, false);
  assert.equal(parsed.result_text, '검증 결과: 근거가 충분합니다.');
  assert.equal(parsed.model, 'claude-sonnet-5');
  assert.equal(parsed.cost_usd, 0.0042);
  assert.equal(parsed.duration_ms, 4212);
  assert.equal(parsed.usage.output_tokens, 250);
  assert.equal(parsed.usage.cache_read_input_tokens, 2000);
});

test('marks error results and tolerates non-JSON output', () => {
  const errorParsed = parseClaudeCliJsonOutput(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }));
  assert.equal(errorParsed.is_error, true);
  const garbage = parseClaudeCliJsonOutput('plain text answer without json');
  assert.equal(garbage.parsed, false);
  assert.equal(garbage.result_text, 'plain text answer without json');
  const prefixed = parseClaudeCliJsonOutput(`warning: something\n${SAMPLE_JSON}`);
  assert.equal(prefixed.parsed, true);
  assert.equal(prefixed.model, 'claude-sonnet-5');
});

test('telemetry row from claude result flows into agent execution telemetry', () => {
  const parsed = parseClaudeCliJsonOutput(SAMPLE_JSON);
  const row = buildClaudeAgentTelemetryRow({
    result: { used_model: parsed.model, usage: parsed.usage, cost_usd: parsed.cost_usd, duration_ms: parsed.duration_ms, num_turns: parsed.num_turns },
    agentId: 'verifier_critic_agent',
    roleId: 'reviewer',
    modelRole: 'verifier_critic',
    phase: 'verification',
  });
  assert.equal(row.provider, 'claude');
  assert.equal(row.input_tokens, 12 + 100 + 2000);
  assert.equal(row.output_tokens, 250);
  assert.equal(row.latency_ms, 4212);
  const extracted = extractAgentExecutionTelemetry([
    { event_type: 'agent_provider_call', ts: new Date().toISOString(), extra: { agent_telemetry: row } },
  ]);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].agent, 'verifier_critic_agent');
  assert.equal(extracted[0].provider, 'claude');
  assert.equal(extracted[0].total_tokens, 2112 + 250);
  assert.equal(extracted[0].latency_ms, 4212);
  const telemetry = deriveAgentTelemetry({
    events: [{ event_type: 'agent_provider_call', ts: new Date().toISOString(), extra: { agent_telemetry: row } }],
    policy: { roster: [{ agent: 'verifier_critic_agent', state: 'required' }] },
  });
  const agentRow = telemetry.find((entry) => entry.agent === 'verifier_critic_agent');
  assert.ok(agentRow);
  assert.equal(agentRow.call_count, 1);
  assert.equal(agentRow.total_tokens, 2362);
  assert.equal(agentRow.telemetry_quality, 'per_agent_execution_telemetry');
  assert.equal(agentRow.observed_providers.claude, 1);
});

test('claude provider aliases normalize to claude', () => {
  for (const alias of ['claude', 'claude-code', 'claude_code', 'claude_cli', 'anthropic']) {
    assert.equal(normalizeRuntimeProvider(alias), 'claude');
  }
  assert.equal(normalizeRuntimeProvider('codex'), 'codex');
  assert.equal(normalizeRuntimeProvider('antigravity'), 'antigravity');
});
