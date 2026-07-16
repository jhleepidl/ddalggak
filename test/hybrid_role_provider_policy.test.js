import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRoomModelRolePolicyToAgent,
  formatEnvModelRolePolicyForPlanner,
  resolveRoomModelRole,
} from '../src/application/room_model_role_router.js';
import { createFreeformTeamConfigurationAdvanced } from '../src/application/team_configuration.js';
import { buildTeamSeedFromTaskArchetype } from '../src/application/team_blueprint_templates.js';
import { buildBenchmarkTeamTemplate } from '../src/application/benchmark_team_templates.js';

const env={
  TEAM_ROLE_PROVIDER_POLICY_MODE:'enforce_generated',
  DDALGGAK_MODEL_ROLE_CONCIERGE_ROUTER_PROVIDER:'antigravity',
  DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_PROVIDER:'antigravity',
  DDALGGAK_MODEL_ROLE_CODE_EXECUTOR_PROVIDER:'codex',
  DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_PROVIDER:'antigravity',
  DDALGGAK_MODEL_ROLE_IDLE_STRUCTURER_PROVIDER:'antigravity',
  DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_PROVIDER:'antigravity',
};

function withEnv(values, fn){
  const previous={};
  for(const [key,value] of Object.entries(values)){ previous[key]=process.env[key]; process.env[key]=value; }
  return Promise.resolve().then(fn).finally(()=>{
    for(const [key,value] of Object.entries(previous)){
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  });
}

test('generated role policy assigns Codex only to code execution and Antigravity to review/synthesis',()=>{
  const builder=applyRoomModelRolePolicyToAgent({role:'builder',provider:'chatgpt',model:'gpt-x'},{env,source:'test'});
  const reviewer=applyRoomModelRolePolicyToAgent({role:'reviewer',provider:'codex',model:'gpt-y'},{env,source:'test'});
  const synth=applyRoomModelRolePolicyToAgent({role:'synthesizer'},{env,source:'test'});
  assert.equal(builder.provider,'codex');
  assert.equal(builder.model,'');
  assert.equal(reviewer.provider,'antigravity');
  assert.equal(reviewer.model,'');
  assert.equal(synth.provider,'antigravity');
  assert.equal(resolveRoomModelRole({phase:'source',env}).provider,'antigravity');
});

test('planner policy summary exposes the hybrid split instead of one-provider monoculture',()=>{
  const text=formatEnvModelRolePolicyForPlanner(env);
  assert.match(text,/builder\/implementer\/test-fix: provider=codex/);
  assert.match(text,/reviewer\/critic\/adjudicator: provider=antigravity/);
  assert.match(text,/Do not assign every role to one provider/);
});

test('workspace delivery fast path produces Codex builder and Antigravity reviewer/synthesizer',async()=>{
  await withEnv(env,async()=>{
    const team=await createFreeformTeamConfigurationAdvanced({description:'이 저장소에 구현 패치를 적용하고 테스트 결과 파일을 만들어줘'});
    const byRole=new Map(team.agents.map(agent=>[agent.role,agent]));
    assert.equal(byRole.get('builder')?.provider,'codex');
    assert.equal(byRole.get('reviewer')?.provider,'antigravity');
    assert.equal(byRole.get('synthesizer')?.provider,'antigravity');
  });
});


test('generated task-archetype and benchmark templates also honor the hybrid role policy',async()=>{
  await withEnv(env,async()=>{
    const seed=buildTeamSeedFromTaskArchetype('iterative_improvement');
    const seedByRole=new Map(seed.agents.map(agent=>[agent.role,agent]));
    assert.equal(seedByRole.get('builder')?.provider,'codex');
    assert.equal(seedByRole.get('reviewer')?.provider,'antigravity');
    assert.equal(seedByRole.get('synthesizer')?.provider,'antigravity');

    const benchmark=buildBenchmarkTeamTemplate('repo_delivery_loop');
    const benchmarkByRole=new Map(benchmark.agents.map(agent=>[agent.role,agent]));
    assert.equal(benchmarkByRole.get('builder')?.provider,'codex');
    assert.equal(benchmarkByRole.get('researcher')?.provider,'antigravity');
    assert.equal(benchmarkByRole.get('reviewer')?.provider,'antigravity');
    assert.equal(benchmarkByRole.get('synthesizer')?.provider,'antigravity');
  });
});
