#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  GocRoomJourneyTransport,
  HeadlessRoomJourneyTransport,
  loadRoomJourneyScenario,
  loadRoomJourneySuite,
  runRoomJourneySuite,
  scenarioArms,
} from '../src/evaluation/room_journey_runner.js';
import { GocClient } from '../src/goc_client.js';
import { applyModelRolePolicyToEnv, loadModelRolePolicyFile } from '../src/application/model_role_policy_config.js';


async function loadOptionalDotenv() {
  try {
    await import('dotenv/config');
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error?.message || '').includes("'dotenv")) throw error;
  }
}

function clean(value = '') { return String(value ?? '').trim(); }
function safe(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'; }
function looksPlaceholder(value = '') {
  const text = clean(value);
  return !text || /^<[^>]+>$/.test(text) || text.includes('{{') || text.includes('}}');
}

function parseArgs(argv = []) {
  const defaultExperimentRoot = path.resolve('experiments', 'room_journeys');
  const options = {
    scenarioFiles: [],
    execute: false,
    syncGoc: false,
    allowSharedRoom: false,
    transport: 'headless',
    outputRoot: defaultExperimentRoot,
    traceRoot: process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR || '',
    runtimeRoot: '',
    pollIntervalMs: 1000,
    commandTimeoutMs: 10 * 60 * 1000,
    responseTimeoutMs: 10 * 60 * 1000,
    judgeTimeoutMs: 180000,
    sessionId: `journey_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
  };
  const take = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--sync-goc') options.syncGoc = true;
    else if (arg === '--allow-shared-room') options.allowSharedRoom = true;
    else if (arg === '--suite') options.suiteFile = take(i++, arg);
    else if (arg === '--scenario') options.scenarioFiles.push(take(i++, arg));
    else if (arg === '--transport') options.transport = clean(take(i++, arg)).toLowerCase();
    else if (arg === '--out') options.outputRoot = take(i++, arg);
    else if (arg === '--trace-root') options.traceRoot = take(i++, arg);
    else if (arg === '--runtime-root') options.runtimeRoot = take(i++, arg);
    else if (arg === '--session-id') options.sessionId = safe(take(i++, arg));
    else if (arg === '--model-role-policy') options.modelRolePolicyPath = take(i++, arg);
    else if (arg === '--model-role-map') options.modelRolePolicyPath = take(i++, arg); // legacy alias
    else if (arg === '--room-map') options.roomMapPath = take(i++, arg);
    else if (arg === '--thread-id') options.threadId = take(i++, arg);
    else if (arg === '--chat-id') options.chatId = take(i++, arg);
    else if (arg === '--user-id') options.userId = take(i++, arg);
    else if (arg === '--thread-id-template') options.threadIdTemplate = take(i++, arg);
    else if (arg === '--chat-id-template') options.chatIdTemplate = take(i++, arg);
    else if (arg === '--restart-command') options.restartCommand = take(i++, arg);
    else if (arg === '--switch-model-command') options.switchModelCommand = take(i++, arg);
    else if (arg === '--replace-source-command') options.replaceSourceCommand = take(i++, arg);
    else if (arg === '--poll-interval-ms') options.pollIntervalMs = Number(take(i++, arg));
    else if (arg === '--command-timeout-ms') options.commandTimeoutMs = Number(take(i++, arg));
    else if (arg === '--response-timeout-ms') options.responseTimeoutMs = Number(take(i++, arg));
    else if (arg === '--judge-provider') options.judgeProvider = take(i++, arg);
    else if (arg === '--judge-model') options.judgeModel = take(i++, arg);
    else if (arg === '--judge-reasoning-effort') options.judgeReasoningEffort = take(i++, arg);
    else if (arg === '--judge-timeout-ms') options.judgeTimeoutMs = Number(take(i++, arg));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['headless', 'goc'].includes(options.transport)) throw new Error(`Unsupported --transport: ${options.transport}`);
  return options;
}

function usage() {
  return `AI Rooms user-journey and model-portfolio benchmark\n\n` +
    `Plan only:\n  npm run room:journey-bench -- --suite scenarios/room_journeys/core_suite.json\n\n` +
    `Execute headless Room journeys (default, no Telegram or GoC Room required):\n  npm run room:journey-bench -- --suite scenarios/room_journeys/core_suite.json --execute --out experiments/room_journeys/core\n\n` +
    `Execute model portfolio arms with the suite's repository policy (no external role map required):\n  npm run room:journey-bench -- --suite scenarios/room_journeys/model_portfolio_suite.json --execute --judge-provider claude --out experiments/room_journeys/portfolio\n\n` +
    `Optional policy override:\n  --model-role-policy config/model_roles/my_experiment.json\n\n` +
    `Optional GoC command-path integration:\n  npm run room:journey-bench -- --transport goc --suite scenarios/room_journeys/core_suite.json --execute --room-map /home/jhlee/tmp/staging-room-map.json\n\n` +
    `Headless mode creates isolated synthetic Room/user identities, invokes the real Room runtime and provider CLIs, and preserves runtime/memory traces below the output directory.`;
}

function resolveSuiteModelRolePolicyPath(suite = null, suiteFile = '') {
  const configured = clean(suite?.model_role_policy || suite?.modelRolePolicy || suite?.model_role_policy_file || suite?.modelRolePolicyFile);
  if (!configured) return '';
  const base = path.dirname(path.resolve(suiteFile || suite?.__file || '.'));
  return path.resolve(base, configured);
}

function renderTemplate(template = '', scenario = {}, arm = {}) {
  return clean(template)
    .replaceAll('{{scenario}}', clean(scenario.id))
    .replaceAll('{{arm}}', clean(arm.id));
}

function syntheticIdentity(options, scenario, arm) {
  const cell = safe(`${options.sessionId}_${scenario.id}_${arm.id}`);
  return {
    threadId: `headless_thread_${cell}`,
    chatId: `headless_room_${cell}`,
    userId: `headless_user_${safe(options.sessionId)}`,
  };
}

function resolveIdentity(options, scenario, arm) {
  if (options.transport === 'headless') return syntheticIdentity(options, scenario, arm);
  const metadata = arm?.metadata && typeof arm.metadata === 'object' ? arm.metadata : {};
  const map = options.roomMap && typeof options.roomMap === 'object' ? options.roomMap : {};
  const mapped = map[`${scenario.id}/${arm.id}`] || map[`${scenario.id}/*`] || map[scenario.id] || {};
  const threadId = clean(mapped.thread_id || mapped.threadId || metadata.thread_id || metadata.threadId || renderTemplate(options.threadIdTemplate, scenario, arm) || options.threadId);
  const chatId = clean(mapped.chat_id || mapped.chatId || metadata.chat_id || metadata.chatId || renderTemplate(options.chatIdTemplate, scenario, arm) || options.chatId);
  const userId = clean(mapped.user_id || mapped.userId || metadata.user_id || metadata.userId || options.userId || chatId);
  return { threadId, chatId, userId };
}

async function assertIsolation(options) {
  if (!options.execute || options.allowSharedRoom) return;
  const scenarioFiles = options.suiteFile ? loadRoomJourneySuite(options.suiteFile).scenario_files : options.scenarioFiles;
  const usedChatIds = new Map();
  const usedThreadIds = new Map();
  for (const file of scenarioFiles) {
    const scenario = loadRoomJourneyScenario(file);
    for (const arm of scenarioArms(scenario)) {
      const identity = resolveIdentity(options, scenario, arm);
      if (!identity.chatId) throw new Error(`Execution requires a Room identity for ${scenario.id}/${arm.id}`);
      if (options.transport === 'goc' && !identity.threadId) throw new Error(`GoC transport requires thread identity for ${scenario.id}/${arm.id}`);
      if (looksPlaceholder(identity.chatId) || (options.transport === 'goc' && looksPlaceholder(identity.threadId))) {
        throw new Error(`Replace placeholder Room identity for ${scenario.id}/${arm.id} before execution`);
      }
      if (usedChatIds.has(identity.chatId)) {
        throw new Error(`Journey runs share a Room state partition (${identity.chatId}): ${usedChatIds.get(identity.chatId)} and ${scenario.id}/${arm.id}`);
      }
      usedChatIds.set(identity.chatId, `${scenario.id}/${arm.id}`);
      if (options.transport === 'goc') {
        if (usedThreadIds.has(identity.threadId)) {
          throw new Error(`Journey runs share a GoC thread (${identity.threadId}): ${usedThreadIds.get(identity.threadId)} and ${scenario.id}/${arm.id}`);
        }
        usedThreadIds.set(identity.threadId, `${scenario.id}/${arm.id}`);
      }
    }
  }
}

async function main() {
  await loadOptionalDotenv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (!options.suiteFile && !options.scenarioFiles.length) throw new Error('Provide --suite or at least one --scenario');
  options.outputRoot = path.resolve(options.outputRoot);
  options.runtimeRoot = path.resolve(options.runtimeRoot || path.join(options.outputRoot, '_runtime'));
  options.traceRoot = path.resolve(options.traceRoot || path.join(options.outputRoot, '_trace'));
  options.suite = options.suiteFile ? loadRoomJourneySuite(options.suiteFile) : null;
  if (options.roomMapPath) {
    options.roomMap = JSON.parse(fs.readFileSync(path.resolve(options.roomMapPath), 'utf8'));
  }
  const suitePolicyPath = resolveSuiteModelRolePolicyPath(options.suite, options.suiteFile);
  const selectedPolicyPath = options.modelRolePolicyPath ? path.resolve(options.modelRolePolicyPath) : suitePolicyPath;
  if (selectedPolicyPath) {
    options.modelRoleMap = applyModelRolePolicyToEnv(loadModelRolePolicyFile(selectedPolicyPath));
    options.modelRolePolicySource = options.modelRolePolicyPath ? 'cli_override' : 'suite_default';
  }
  if (options.execute && (options.suite?.requires_model_role_policy === true || options.suite?.requires_model_role_map === true) && !options.modelRoleMap) {
    throw new Error('This suite requires a model-role policy; configure model_role_policy in the suite or pass --model-role-policy');
  }
  if (options.execute && options.transport === 'headless') {
    process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK = '1';
    process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT = options.outputRoot;
  }
  await assertIsolation(options);

  let sharedClient = null;
  if (options.transport === 'goc' || options.syncGoc) sharedClient = new GocClient();

  const transportFactory = async ({ scenario, arm }) => {
    const identity = resolveIdentity(options, scenario, arm);
    if (!options.execute) {
      return {
        ...identity,
        events: [],
        async initialize() {},
        async sendCommand() { return { ok: true }; },
        async sendMessage() { return { ok: true, output: '' }; },
      };
    }
    if (options.transport === 'headless') {
      return new HeadlessRoomJourneyTransport({
        ...identity,
        runtimeRoot: options.runtimeRoot,
        traceRoot: options.traceRoot,
        responseTimeoutMs: options.responseTimeoutMs,
        modelRoleMap: options.modelRoleMap,
      });
    }
    return new GocRoomJourneyTransport({
      client: sharedClient,
      ...identity,
      pollIntervalMs: options.pollIntervalMs,
      commandTimeoutMs: options.commandTimeoutMs,
      responseTimeoutMs: options.responseTimeoutMs,
    });
  };

  const summary = await runRoomJourneySuite({
    suiteFile: options.suiteFile ? path.resolve(options.suiteFile) : '',
    scenarioFiles: options.scenarioFiles.map((file) => path.resolve(file)),
    outputRoot: options.outputRoot,
    transportFactory,
    execute: options.execute,
    traceRoot: options.traceRoot,
    options,
    syncGoc: options.syncGoc,
    gocClient: sharedClient,
  });
  summary.execution_environment = {
    transport: options.transport,
    session_id: options.sessionId,
    output_root: options.outputRoot,
    runtime_root: options.transport === 'headless' ? options.runtimeRoot : null,
    trace_root: options.traceRoot,
    telegram_required: false,
    goc_room_required: options.transport === 'goc',
    model_role_policy: options.modelRoleMap || null,
    model_role_policy_source: options.modelRolePolicySource || null,
    model_role_map: options.modelRoleMap || null,
    codex_skip_git_repo_check: options.execute && options.transport === 'headless'
      ? {
          enabled: true,
          allowed_root: options.outputRoot,
          scope: 'headless_benchmark_only',
        }
      : { enabled: false },
  };
  if (options.modelRoleMap) {
    fs.mkdirSync(options.outputRoot, { recursive: true });
    fs.writeFileSync(path.join(options.outputRoot, 'model_role_policy.json'), `${JSON.stringify(options.modelRoleMap, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === 'completed_with_failures') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[room:journey-bench] ${error?.stack || error}`);
  process.exitCode = 1;
});
