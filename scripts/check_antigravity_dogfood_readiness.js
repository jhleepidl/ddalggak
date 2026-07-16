#!/usr/bin/env node
import { runCommand } from '../src/proc.js';
import { resolveAntigravityCliCommand } from '../src/antigravity.js';
import { pathToFileURL } from 'node:url';

const clean=(v)=>String(v??'').trim();
const lower=(v)=>clean(v).toLowerCase();
const expectedProviders={
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
};

export function evaluateDogfoodEnvironment(env=process.env,{models=[],codexAvailable=true}={}){
  const errors=[]; const warnings=[]; const providers={};
  for(const [key,expected] of Object.entries(expectedProviders)){
    const value=clean(env[key]);
    if(value) providers[key]=value;
    if(lower(value)==='claude') errors.push(`${key}=claude is unavailable for this deployment`);
    if(value && lower(value)!==expected) warnings.push(`${key}=${value}; recommended hybrid profile uses ${expected}`);
    if(!value) warnings.push(`${key} is unset; recommended hybrid role routing is not fully pinned`);
  }
  if(lower(env.CLAUDE_CLI_MODEL_DISCOVERY_ENABLED)!=='false') warnings.push('Set CLAUDE_CLI_MODEL_DISCOVERY_ENABLED=false to avoid unavailable Claude discovery.');
  if(lower(env.CODEX_CLI_MODEL_DISCOVERY_ENABLED)==='false') warnings.push('Codex discovery is disabled even though Codex is the work/code executor.');
  if(lower(env.ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED)==='false') warnings.push('Antigravity discovery is disabled even though Antigravity serves routing/research/review.');
  if(!clean(env.ANTIGRAVITY_MODEL_ARG)) warnings.push('ANTIGRAVITY_MODEL_ARG is unset; source default --model will be used.');
  if(!models.length) errors.push('Antigravity model discovery returned no selectors.');
  if(!codexAvailable) errors.push('Codex CLI is unavailable but DDALGGAK_WORK_PROVIDER/code_executor requires it.');
  return {ready:errors.length===0,errors,warnings,providers,models,codex_available:Boolean(codexAvailable)};
}

export async function checkAntigravityDogfood({env=process.env,runner=runCommand}={}){
  const command=resolveAntigravityCliCommand(env);
  const discoveryArgs=clean(env.ANTIGRAVITY_MODEL_DISCOVERY_ARGS||'models').split(/\s+/).filter(Boolean);
  const discovery=await runner(command,discoveryArgs,{cwd:process.cwd(),timeoutMs:Number(env.ANTIGRAVITY_DISCOVERY_TIMEOUT_MS||15000),env:{CI:'1',NO_COLOR:'1',FORCE_COLOR:'0'}});
  const models=discovery.ok?String(discovery.stdout||'').split(/\r?\n/).map(clean).filter(Boolean).map(x=>x.replace(/\s*\(current\)\s*$/i,'').trim()):[];
  const codexCommand=clean(env.CODEX_CLI_COMMAND||'codex');
  const codex=await runner(codexCommand,['--version'],{cwd:process.cwd(),timeoutMs:Number(env.CODEX_DISCOVERY_TIMEOUT_MS||15000),env:{CI:'1',NO_COLOR:'1',FORCE_COLOR:'0'}});
  const evaluation=evaluateDogfoodEnvironment(env,{models,codexAvailable:codex.ok});
  if(!discovery.ok) evaluation.errors.unshift(`Antigravity discovery failed: command=${command} exit_code=${discovery.exit_code}`);
  if(!codex.ok) evaluation.errors.push(`Codex check failed: command=${codexCommand} exit_code=${codex.exit_code}`);
  evaluation.ready=evaluation.errors.length===0;
  return {schema_version:'ddalggak.hybrid_dogfood_readiness/v2',command,discovery_args:discoveryArgs,discovery_ok:discovery.ok,exit_code:discovery.exit_code,codex_command:codexCommand,codex_check_ok:codex.ok,codex_exit_code:codex.exit_code,...evaluation};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const output=await checkAntigravityDogfood();
  console.log(JSON.stringify(output,null,2));
  process.exit(output.ready?0:1);
}
