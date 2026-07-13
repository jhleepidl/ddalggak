#!/usr/bin/env node
import fs from 'node:fs';

import {
  listPendingModelBenchmarks,
  modelCatalogRefreshStatePath,
  modelCapabilitySnapshotPath,
  modelDiscoveryRegistryPath,
  modelNodesDiscoveredConfigPath,
  readJson,
} from '../src/application/model_catalog_refresh.js';

function exists(file) { try { return fs.existsSync(file); } catch { return false; } }
function line(label, value) { console.log(`${label}: ${value ?? '-'}`); }

const statePath = modelCatalogRefreshStatePath();
const registryPath = modelDiscoveryRegistryPath();
const capabilityPath = modelCapabilitySnapshotPath();
const catalogPath = modelNodesDiscoveredConfigPath();
const state = readJson(statePath) || {};
const registry = readJson(registryPath) || {};
const capabilities = readJson(capabilityPath) || {};
const catalog = readJson(catalogPath) || {};
const pending = listPendingModelBenchmarks({ registryPath });

console.log('Model discovery status');
line('catalog', exists(catalogPath) ? catalogPath : `${catalogPath} (missing)`);
line('last_completed_at', state.last_completed_at);
line('last_reason', state.reason);
line('nodes', Array.isArray(catalog.nodes) ? catalog.nodes.length : 0);
line('new_models_last_refresh', state.new_models ?? 0);
line('benchmark_candidates', pending.length);
console.log('');
console.log('Provider CLI versions:');
for (const row of Array.isArray(capabilities.items) ? capabilities.items : []) {
  console.log(`- ${row.provider}: ${row.cli_available ? 'available' : 'unavailable'} · ${row.cli_version || '-'}`);
}
console.log('');
console.log('Pending model benchmarks:');
if (!pending.length) console.log('- none');
for (const row of pending) {
  console.log(`- ${row.provider}/${row.model} · status=${row.benchmark_status} · cli=${row.discovered_cli_version || '-'} · first_seen=${row.first_seen_at || '-'}`);
}
void registry;
