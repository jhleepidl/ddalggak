#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
  const homeTmp = path.join(os.homedir(), 'tmp', 'ai_rooms_room_journeys');
  const options = {
    scenarioFiles: [],
    execute: false,
    syncGoc: false,
    allowSharedRoom: false,
    transport: 'headless',
    outputRoot: homeTmp,
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
    else if (arg === '--model-role-map') options.modelRoleMapPath = take(i++, arg);
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
    `Execute headless Room journeys (default, no Telegram or GoC Room required):\n  npm run room:journey-bench -- --suite scenarios/room_journeys/core_suite.json --execute --out /home/jhlee/tmp/ai_rooms_room_journeys\n\n` +
    `Execute model portfolio arms with an explicit role-to-model map:\n  npm run room:journey-bench -- --suite scenarios/room_journeys/model_portfolio_suite.json --execute --model-role-map /home/jhlee/tmp/model-role-map.json --judge-provider claude --out /home/jhlee/tmp/ai_rooms_room_journeys\n\n` +
    `Optional GoC command-path integration:\n  npm run room:journey-bench -- --transport goc --suite scenarios/room_journeys/core_suite.json --execute --room-map /home/jhlee/tmp/staging-room-map.json\n\n` +
    `Headless mode creates isolated synthetic Room/user identities, invokes the real Room runtime and provider CLIs, and preserves runtime/memory traces below the output directory.`;
}

const SUPPORTED_MODEL_ROLES = new Set([
  'concierge_router',
  'source_grounder',
  'code_executor',
  'verifier_critic',
  'idle_structurer',
  'delivery_synthesizer',
]);

function loadAndApplyModelRoleMap(filePath = '') {
  const resolvedPath = path.resolve(filePath);
  const bytes = fs.readFileSync(resolvedPath);
  const raw = JSON.parse(bytes.toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('--model-role-map must contain a JSON object');
  const normalized = {};
  for (const [rawRole, rawAssignment] of Object.entries(raw)) {
    if (rawRole.startsWith('_')) continue;
    const role = clean(rawRole).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!SUPPORTED_MODEL_ROLES.has(role)) throw new Error(`Unsupported model role in --model-role-map: ${rawRole}`);
    const assignment = rawAssignment && typeof rawAssignment === 'object' && !Array.isArray(rawAssignment) ? rawAssignment : {};
    const provider = clean(assignment.provider).toLowerCase();
    const model = clean(assignment.model);
    const nodeId = clean(assignment.node_id || assignment.nodeId);
    if (!provider && !model && !nodeId) throw new Error(`Model role ${role} requires provider, model, or node_id`);
    normalized[role] = { provider, model, node_id: nodeId };
    const prefix = `DDALGGAK_MODEL_ROLE_${role.toUpperCase()}_`;
    if (provider) process.env[`${prefix}PROVIDER`] = provider;
    if (model) process.env[`${prefix}MODEL`] = model;
    if (nodeId) process.env[`${prefix}NODE_ID`] = nodeId;
  }
  if (!Object.keys(normalized).length) throw new Error('--model-role-map contains no model-role assignments');
  return {
    path: resolvedPath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    assignments: normalized,
  };
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
  if (options.roomMapPath) {
    options.roomMap = JSON.parse(fs.readFileSync(path.resolve(options.roomMapPath), 'utf8'));
  }
  if (options.modelRoleMapPath) options.modelRoleMap = loadAndApplyModelRoleMap(options.modelRoleMapPath);
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
    model_role_map: options.modelRoleMap || null,
  };
  if (options.modelRoleMap) {
    fs.mkdirSync(options.outputRoot, { recursive: true });
    fs.writeFileSync(path.join(options.outputRoot, 'model_role_map.json'), `${JSON.stringify(options.modelRoleMap, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === 'completed_with_failures') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[room:journey-bench] ${error?.stack || error}`);
  process.exitCode = 1;
});
