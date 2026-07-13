#!/usr/bin/env node
import path from 'node:path';

import {
  GocRoomJourneyTransport,
  loadRoomJourneyScenario,
  loadRoomJourneySuite,
  runRoomJourneySuite,
  scenarioArms,
} from '../src/evaluation/room_journey_runner.js';
import { GocClient } from '../src/goc_client.js';

function clean(value = '') { return String(value ?? '').trim(); }
function looksPlaceholder(value = '') {
  const text = clean(value);
  return !text || /^<[^>]+>$/.test(text) || text.includes('{{') || text.includes('}}');
}

function parseArgs(argv = []) {
  const options = {
    scenarioFiles: [],
    execute: false,
    syncGoc: false,
    allowSharedRoom: false,
    outputRoot: 'runs/room_journeys',
    traceRoot: process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR || '',
    pollIntervalMs: 1000,
    commandTimeoutMs: 10 * 60 * 1000,
    responseTimeoutMs: 10 * 60 * 1000,
    judgeTimeoutMs: 180000,
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
    else if (arg === '--out') options.outputRoot = take(i++, arg);
    else if (arg === '--trace-root') options.traceRoot = take(i++, arg);
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
  return options;
}

function usage() {
  return `AI Rooms user-journey and model-portfolio benchmark\n\n` +
    `Plan only:\n  npm run room:journey-bench -- --suite scenarios/room_journeys/core_suite.json\n\n` +
    `Execute one Room:\n  npm run room:journey-bench -- --suite scenarios/room_journeys/core_suite.json --execute --thread-id <goc-thread> --chat-id <telegram-chat>\n\n` +
    `Execute isolated portfolio arms:\n  npm run room:journey-bench -- --suite scenarios/room_journeys/model_portfolio_suite.json --execute --room-map ./staging-room-map.json --judge-provider claude\n\n` +
    `Important: portfolio arms must use isolated Rooms unless --allow-shared-room is explicitly supplied.`;
}

function renderTemplate(template = '', scenario = {}, arm = {}) {
  return clean(template)
    .replaceAll('{{scenario}}', clean(scenario.id))
    .replaceAll('{{arm}}', clean(arm.id));
}

function resolveIdentity(options, scenario, arm) {
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
  const used = new Map();
  for (const file of scenarioFiles) {
    const scenario = loadRoomJourneyScenario(file);
    for (const arm of scenarioArms(scenario)) {
      const identity = resolveIdentity(options, scenario, arm);
      if (!identity.threadId || !identity.chatId) throw new Error(`Execution requires thread/chat identity for ${scenario.id}/${arm.id}`);
      if (looksPlaceholder(identity.threadId) || looksPlaceholder(identity.chatId)) {
        throw new Error(`Replace placeholder Room identity for ${scenario.id}/${arm.id} before execution`);
      }
      const key = `${identity.threadId}::${identity.chatId}`;
      if (used.has(key)) throw new Error(`Journey runs share a Room (${key}): ${used.get(key)} and ${scenario.id}/${arm.id}. Use --room-map, templates/metadata, or --allow-shared-room.`);
      used.set(key, `${scenario.id}/${arm.id}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (!options.suiteFile && !options.scenarioFiles.length) throw new Error('Provide --suite or at least one --scenario');
  if (options.roomMapPath) {
    const fs = await import('node:fs');
    options.roomMap = JSON.parse(fs.readFileSync(path.resolve(options.roomMapPath), 'utf8'));
  }
  await assertIsolation(options);
  const sharedClient = options.execute ? new GocClient() : null;
  const transportFactory = async ({ scenario, arm }) => {
    const identity = resolveIdentity(options, scenario, arm);
    if (!options.execute) return { ...identity, events: [], async initialize() {}, async sendCommand() { return { ok: true }; }, async sendMessage() { return { ok: true, output: '' }; } };
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
    outputRoot: path.resolve(options.outputRoot),
    transportFactory,
    execute: options.execute,
    traceRoot: options.traceRoot ? path.resolve(options.traceRoot) : '',
    options,
    syncGoc: options.syncGoc,
    gocClient: sharedClient,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === 'completed_with_failures') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[room:journey-bench] ${error?.stack || error}`);
  process.exitCode = 1;
});
