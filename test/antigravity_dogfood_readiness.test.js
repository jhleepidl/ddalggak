import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {checkAntigravityDogfood,evaluateDogfoodEnvironment} from '../scripts/check_antigravity_dogfood_readiness.js';

function hybridEnv(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'room-native-readiness-'));
  return {
    _TEST_ROOT:root,
    ROOM_EXECUTION_ENGINE:'room_native_v2',
    ROOM_RUNTIME_ROOT:path.join(root,'runtime'),
    ROOM_WORKSPACES_ROOT:path.join(root,'runtime','workspaces'),
    ROOM_STATE_ROOT:path.join(root,'runtime','state'),
    DDALGGAK_CONTROL_ROOT:path.join(root,'control'),
    DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK:'true',
    DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT:path.join(root,'runtime','workspaces'),
    DDALGGAK_FAST_PROVIDER:'antigravity',
    DDALGGAK_SEARCH_PROVIDER:'antigravity',
    DDALGGAK_WORK_PROVIDER:'codex',
    CHAT_SUPERVISOR_PROVIDER:'antigravity',
    TEAM_PLANNER_PROVIDER:'antigravity',
    TEAM_CREATE_PLANNER_PROVIDER:'antigravity',
    TEAM_REFINE_PLANNER_PROVIDER:'antigravity',
    DDALGGAK_MODEL_ROLE_CONCIERGE_ROUTER_PROVIDER:'antigravity',
    DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_PROVIDER:'antigravity',
    DDALGGAK_MODEL_ROLE_CODE_EXECUTOR_PROVIDER:'codex',
    DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_PROVIDER:'antigravity',
    DDALGGAK_MODEL_ROLE_IDLE_STRUCTURER_PROVIDER:'antigravity',
    DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_PROVIDER:'antigravity',
    CLAUDE_CLI_MODEL_DISCOVERY_ENABLED:'false',
    CODEX_CLI_MODEL_DISCOVERY_ENABLED:'true',
    ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED:'true',
    ANTIGRAVITY_MODEL_ARG:'--model',
    ANTIGRAVITY_CLI_COMMAND:'agy',
    CODEX_CLI_COMMAND:'codex',
  };
}

test('dogfood readiness accepts hybrid Antigravity control/review and Codex implementation',async()=>{
  const env=hybridEnv();
  fs.mkdirSync(env.DDALGGAK_CONTROL_ROOT,{recursive:true});
  try{
    const runner=async(command,args)=> command==='agy'
      ? {ok:true,stdout:'Model A (Thinking)\nModel B (current)\n',stderr:'',exit_code:0}
      : {ok:true,stdout:'codex-cli 1.0\n',stderr:'',exit_code:0};
    const row=await checkAntigravityDogfood({env,runner});
    assert.equal(row.ready,true);
    assert.deepEqual(row.models,['Model A (Thinking)','Model B']);
    assert.equal(row.command,'agy');
    assert.equal(row.codex_check_ok,true);
    assert.equal(row.warnings.length,0);
  }finally{fs.rmSync(env._TEST_ROOT,{recursive:true,force:true});}
});

test('dogfood readiness rejects unavailable Claude routing and missing Codex',()=>{
  const env={...hybridEnv(),DDALGGAK_FAST_PROVIDER:'claude'};
  fs.mkdirSync(env.DDALGGAK_CONTROL_ROOT,{recursive:true});
  try{
    const row=evaluateDogfoodEnvironment(env,{models:['Model A'],codexAvailable:false});
    assert.equal(row.ready,false);
    assert.ok(row.errors.some(x=>x.includes('unavailable')));
    assert.ok(row.errors.some(x=>x.includes('Codex CLI')));
  }finally{fs.rmSync(env._TEST_ROOT,{recursive:true,force:true});}
});

test('dogfood readiness warns when all execution is accidentally assigned to Antigravity',()=>{
  const env={...hybridEnv(),DDALGGAK_WORK_PROVIDER:'antigravity',DDALGGAK_MODEL_ROLE_CODE_EXECUTOR_PROVIDER:'antigravity'};
  fs.mkdirSync(env.DDALGGAK_CONTROL_ROOT,{recursive:true});
  try{
    const row=evaluateDogfoodEnvironment(env,{models:['Model A'],codexAvailable:true});
    assert.equal(row.ready,true);
    assert.ok(row.warnings.some(x=>x.includes('DDALGGAK_WORK_PROVIDER')));
    assert.ok(row.warnings.some(x=>x.includes('CODE_EXECUTOR')));
  }finally{fs.rmSync(env._TEST_ROOT,{recursive:true,force:true});}
});
