import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAgentPackageFromSession,
  findAgentPackage,
  formatAgentPackage,
  installAgentPackageToSession,
  readAgentPackageRegistry,
  saveAgentPackageToRegistry,
} from '../src/application/agent_package_runtime.js';

function makeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: (key) => map.get(String(key)) || {},
    set: (key, value) => map.set(String(key), value),
    upsert: (key, patcher) => {
      const current = map.get(String(key)) || {};
      const next = typeof patcher === 'function' ? patcher(current) : { ...current, ...patcher };
      map.set(String(key), next);
      return next;
    },
  };
}

test('agent package export sanitizes private memory and keeps portable contracts', () => {
  const store = makeStore({
    source: {
      agent_room_profile: {
        kind: 'agent_room_profile_v1',
        name: 'Risk Webapp Room',
        default_agents: ['planner', 'builder', 'risk_reviewer'],
        default_workflow: 'bounded_review_improve_loop',
        memory_scope: 'room',
        current_goal: '국내 주식 리스크 웹앱을 계속 개선',
      },
      runtime_rules: [
        { id: 'r1', text: 'Do not present analysis as financial advice.', enabled: true, topic: 'finance' },
      ],
      team_config: {
        active_team: {
          team_name: 'risk_webapp_team',
          agents: [
            { agent_id: 'builder', name: 'Builder', role: 'builder', provider: 'codex', model: 'gpt-5-codex', skills: ['static_webapp_verification'] },
            { agent_id: 'risk_reviewer', name: 'Risk Reviewer', role: 'reviewer', provider: 'ollama', model: 'qwen2.5:14b' },
          ],
          interaction_spec: { execution_pattern: 'build_review_synthesize' },
        },
      },
    },
  });

  const pkg = buildAgentPackageFromSession({ sessionStore: store, chatId: 'source', packageId: 'risk-webapp-reviewer' });

  assert.equal(pkg.kind, 'agent_package_v1');
  assert.equal(pkg.package_id, 'risk-webapp-reviewer');
  assert.equal(pkg.memory_contract.copies_private_memory, false);
  assert.equal(pkg.clone_policy.credential_binding, 'never_copy');
  assert.equal(pkg.clone_policy.provider_state, 'never_copy');
  assert.deepEqual(pkg.agents.map((agent) => agent.agent_id), ['builder', 'risk_reviewer']);
  assert.equal(pkg.rule_refs[0].text, 'Do not present analysis as financial advice.');
  assert.match(formatAgentPackage(pkg), /copies_private_memory=false/);
});

test('agent package registry save/find and clone installs package into another chat', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-agent-pkg-'));
  const registryPath = path.join(tmp, 'agent_packages.json');
  const source = makeStore({
    a: {
      agent_room_profile: { kind: 'agent_room_profile_v1', name: 'Reusable Room', default_agents: ['planner', 'reviewer'], current_goal: 'Reusable review workflow' },
      team_config: { active_team: { team_name: 'reusable_team', agents: [{ agent_id: 'reviewer', name: 'Reviewer', role: 'reviewer' }] } },
    },
  });
  const target = makeStore();
  const pkg = buildAgentPackageFromSession({ sessionStore: source, chatId: 'a', packageId: 'reusable-reviewer' });
  const saved = saveAgentPackageToRegistry(pkg, { registryPath });
  const registry = readAgentPackageRegistry({ registryPath });

  assert.equal(saved.package.package_id, 'reusable-reviewer');
  assert.equal(registry.packages.length, 1);
  assert.equal(findAgentPackage('reusable-reviewer', { registryPath }).title, 'Reusable Room');

  await installAgentPackageToSession({ sessionStore: target, chatId: 'b', agentPackage: saved.package, applyState: 'pending' });
  const installed = target.get('b');
  assert.equal(installed.agent_room_profile.package_id, 'reusable-reviewer');
  assert.equal(installed.agent_room_profile.clone_policy.private_memory, 'fresh_on_clone');
  assert.equal(installed.team_config.pending_team.team_name, 'reusable_team');
  assert.equal(installed.installed_agent_packages[0].package_id, 'reusable-reviewer');
});
